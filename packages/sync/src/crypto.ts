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

/** salt 綁 vaultId:跨裝置同密語可重現,不同 vault 金鑰互異 */
export async function deriveVaultKey(passphrase: string, vaultId: string, workFactor = DEFAULT_WORK_FACTOR): Promise<Uint8Array> {
  return scryptAsync(utf8(passphrase.normalize("NFC")), utf8(`stele-vault:${vaultId}`), {
    N: 2 ** workFactor,
    r: 8,
    p: 1,
    dkLen: 32,
  });
}

export class VaultCipher implements Cipher {
  private readonly docKeys = new Map<string, Promise<CryptoKey>>();

  constructor(private readonly masterKey: Uint8Array) {}

  async encrypt(docId: string, plain: Uint8Array): Promise<Uint8Array> {
    const key = await this.docKey(docId);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain as BufferSource),
    );
    const out = new Uint8Array(1 + NONCE_LENGTH + sealed.length);
    out[0] = FORMAT_VERSION;
    out.set(nonce, 1);
    out.set(sealed, 1 + NONCE_LENGTH);
    return out;
  }

  async decrypt(docId: string, data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 1 + NONCE_LENGTH + 16) throw new Error("密文不完整");
    if (data[0] !== FORMAT_VERSION) throw new Error(`未知的密文版本:${data[0]}`);
    const key = await this.docKey(docId);
    const nonce = data.slice(1, 1 + NONCE_LENGTH);
    const sealed = data.slice(1 + NONCE_LENGTH);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed);
    return new Uint8Array(plain);
  }

  private docKey(docId: string): Promise<CryptoKey> {
    let key = this.docKeys.get(docId);
    if (!key) {
      key = (async () => {
        const hkdf = await crypto.subtle.importKey("raw", this.masterKey as BufferSource, "HKDF", false, [
          "deriveKey",
        ]);
        return crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: utf8("stele-doc-key") as BufferSource, info: utf8(docId) as BufferSource },
          hkdf,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      })();
      this.docKeys.set(docId, key);
    }
    return key;
  }
}
