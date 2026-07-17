import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { Cipher } from "./cipher.ts";

/**
 * E2EE 實作:passphrase → scrypt → vault 主金鑰;每 doc 以 HKDF 衍生 AES-256-GCM 子金鑰
 * 密文格式:[版本 1B][nonce 12B][ciphertext+tag]
 * 主金鑰永不離開裝置,伺服器只見密文;內容加密走 WebCrypto,金鑰衍生用審計過的 @noble scrypt
 */

const FORMAT_VERSION = 1;
const NONCE_LENGTH = 12;
/**
 * N=2^18 約 256MB 記憶體,只在開/切 vault 時跑一次
 * 這把金鑰保護整個 vault 且伺服器端密文外洩後離線暴破無速率限制,scrypt 工作因子是唯一防線
 * OWASP 最低建議 2^17,檔案加密場景取更高的 2^18;測試以 workFactor 降參數避免拖慢
 */
const DEFAULT_WORK_FACTOR = 18;

const utf8 = (s: string) => new TextEncoder().encode(s);
const DOC_KEY_SALT = utf8("stele-doc-key");

/** salt 綁 vaultId:跨裝置同密語可重現,不同 vault 金鑰互異 */
export async function deriveVaultKey(passphrase: string, vaultId: string, workFactor = DEFAULT_WORK_FACTOR): Promise<Uint8Array> {
  return scryptAsync(utf8(passphrase.normalize("NFC")), utf8(`stele-vault:${vaultId}`), {
    N: 2 ** workFactor,
    r: 8,
    p: 1,
    dkLen: 32,
  });
}

/** AES-GCM 封裝:[版本 1B][nonce 12B][ciphertext+tag],VaultCipher 與 ShareCipher 共用 */
async function seal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain as BufferSource));
  const out = new Uint8Array(1 + NONCE_LENGTH + sealed.length);
  out[0] = FORMAT_VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_LENGTH);
  return out;
}

async function open(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 1 + NONCE_LENGTH + 16) throw new Error("密文不完整");
  if (data[0] !== FORMAT_VERSION) throw new Error(`未知的密文版本:${data[0]}`);
  const nonce = data.slice(1, 1 + NONCE_LENGTH);
  const sealed = data.slice(1 + NONCE_LENGTH);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
}

/** 用 vault 主金鑰對某 doc 衍生 32 bytes 原始子金鑰;deriveKey 走同樣 HKDF 參數會得到同一把 */
async function deriveDocKeyBytes(masterKey: Uint8Array, docId: string): Promise<Uint8Array> {
  const hkdf = await crypto.subtle.importKey("raw", masterKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: DOC_KEY_SALT as BufferSource, info: utf8(docId) as BufferSource },
    hkdf,
    256,
  );
  return new Uint8Array(bits);
}

export class VaultCipher implements Cipher {
  private readonly docKeys = new Map<string, Promise<CryptoKey>>();

  constructor(private readonly masterKey: Uint8Array) {}

  encrypt(docId: string, plain: Uint8Array): Promise<Uint8Array> {
    return this.docKey(docId).then((key) => seal(key, plain));
  }

  decrypt(docId: string, data: Uint8Array): Promise<Uint8Array> {
    return this.docKey(docId).then((key) => open(key, data));
  }

  /** 匯出某 doc 的原始金鑰:分享連結把它放進 URL fragment,收件人以此解密,主金鑰不外洩(HKDF 單向) */
  exportDocKey(docId: string): Promise<Uint8Array> {
    return deriveDocKeyBytes(this.masterKey, docId);
  }

  private docKey(docId: string): Promise<CryptoKey> {
    let key = this.docKeys.get(docId);
    if (!key) {
      key = crypto.subtle.importKey("raw", this.masterKey as BufferSource, "HKDF", false, ["deriveKey"]).then((hkdf) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: DOC_KEY_SALT as BufferSource, info: utf8(docId) as BufferSource },
          hkdf,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
      this.docKeys.set(docId, key);
    }
    return key;
  }
}

/**
 * 單 doc 密碼器:收件人只握一把 doc 金鑰(從分享連結 fragment 取得),無 vault 主金鑰
 * 密文格式與 VaultCipher 完全相同,故能互解;docId 參數在此無作用(金鑰已固定為那一把)
 */
export class ShareCipher implements Cipher {
  private readonly key: Promise<CryptoKey>;

  constructor(rawDocKey: Uint8Array) {
    this.key = crypto.subtle.importKey("raw", rawDocKey as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  encrypt(_docId: string, plain: Uint8Array): Promise<Uint8Array> {
    return this.key.then((key) => seal(key, plain));
  }

  decrypt(_docId: string, data: Uint8Array): Promise<Uint8Array> {
    return this.key.then((key) => open(key, data));
  }
}
