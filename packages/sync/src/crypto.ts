import { scryptAsync } from "@noble/hashes/scrypt.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import * as encoding from "lib0/encoding";
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
const SPACE_KEY_SALT = utf8("stele-space-key");
/** 金鑰包裝(空間 root 信封)的獨立域分隔,別跟 doc/space/identity 的 HKDF 混 */
const KEYWRAP_SALT = utf8("stele-keywrap-v1");

const WRAP_VERSION = 1;
const EPH_PUB_LEN = 32;
const OWNER_SIG_LEN = 64;

/**
 * 預設空間的 id 哨兵:未指派筆記的落點。
 * 其空間金鑰 = 主金鑰本身,故 HKDF(空間金鑰, docId) 與舊 HKDF(主金鑰, docId) 位元組相同 → 既有 vault 零遷移。
 */
export const DEFAULT_SPACE_ID = "default";

/** salt 綁 vaultId:跨裝置同密語可重現,不同 vault 金鑰互異 */
export async function deriveVaultKey(passphrase: string, vaultId: string, workFactor = DEFAULT_WORK_FACTOR): Promise<Uint8Array> {
  return scryptAsync(utf8(passphrase.normalize("NFC")), utf8(`stele-vault:${vaultId}`), {
    N: 2 ** workFactor,
    r: 8,
    p: 1,
    dkLen: 32,
  });
}

/**
 * 空間金鑰:「空間 = 帶金鑰單元」的根金鑰,再往下 HKDF(空間金鑰, docId) 衍生每篇筆記金鑰。
 * 預設空間 → 主金鑰本身(零遷移);其餘空間 → 從主金鑰單向衍生,知其一不反推主金鑰或他空間。
 * (團隊空間之後改由「隨機生成 + 成員公鑰包裝」取得,接同一條「空間金鑰 → 筆記金鑰」路徑,不動下游。)
 */
export async function deriveSpaceKey(masterKey: Uint8Array, spaceId: string): Promise<Uint8Array> {
  if (spaceId === DEFAULT_SPACE_ID) return masterKey.slice();
  const hkdf = await crypto.subtle.importKey("raw", masterKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SPACE_KEY_SALT as BufferSource, info: utf8(spaceId) as BufferSource },
    hkdf,
    256,
  );
  return new Uint8Array(bits);
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

/**
 * 空間金鑰信封(2b 團隊層):owner 用收件人 X25519 公鑰把一把原始金鑰(root/space key)包起來,
 * 經全盲伺服器中繼分發給成員。收件人以自己的 xSecret 解出,伺服器只見不透明密文。
 *
 * 格式:[版本 1B][ephPub 32B][ownerSig 64B][sealed…](sealed = seal() 的 AES-GCM 封裝)
 *
 * 兩道防線:
 *  - **owner Ed25519 簽章**(涵蓋 ephPub‖sealed‖context):不可信中繼無 owner 私鑰,無法偽造信封,
 *    故無法拿假 root 餵新成員去解一個伺服器捏造的假 vault。收件人以 out-of-band 已知的 owner pubSign 驗簽。
 *  - **context 綁進 HKDF info**(vaultId‖keyId‖epoch‖recipientMemberId,再折入 ephPub‖recipientPubWrap):
 *    ECDH 已綁 recipient(換 xSecret 解不出);context 綁死跨 vault/keyId/epoch 挪用重放——不符則導出金鑰不同、
 *    GCM tag 驗不過而乾淨拒絕,不必改 seal/open 格式。
 */
export interface WrapContext {
  vaultId: string;
  keyId: string;
  epoch: number;
  recipientMemberId: string;
}

/** context 的確定性編碼(lib0 length-prefixed,無歧義) */
function wrapContextBytes(ctx: WrapContext): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, ctx.vaultId);
  encoding.writeVarString(enc, ctx.keyId);
  encoding.writeVarUint(enc, ctx.epoch);
  encoding.writeVarString(enc, ctx.recipientMemberId);
  return encoding.toUint8Array(enc);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function isAllZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/** 由 ECDH shared secret + context info 導一把一次性 AES-GCM 金鑰(每信封新 ephemeral → 每金鑰只用一次) */
async function wrapAesKey(shared: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const hkdf = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KEYWRAP_SALT as BufferSource, info: info as BufferSource },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** owner 用收件人 pubWrap 把 rawKey 包成簽章信封;ownerSign 傳入既有 identity.sign,不外露私鑰 */
export async function wrapKey(
  rawKey: Uint8Array,
  recipientPubWrap: Uint8Array,
  ownerSign: (message: Uint8Array) => Uint8Array,
  context: WrapContext,
): Promise<Uint8Array> {
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientPubWrap);
  if (isAllZero(shared)) throw new Error("wrap:非法收件人公鑰(shared secret 全零)");
  const ctxBytes = wrapContextBytes(context);
  const aesKey = await wrapAesKey(shared, concatBytes(ctxBytes, ephPub, recipientPubWrap));
  const sealed = await seal(aesKey, rawKey);
  const ownerSig = ownerSign(concatBytes(ephPub, sealed, ctxBytes));
  const out = new Uint8Array(1 + EPH_PUB_LEN + OWNER_SIG_LEN + sealed.length);
  out[0] = WRAP_VERSION;
  out.set(ephPub, 1);
  out.set(ownerSig, 1 + EPH_PUB_LEN);
  out.set(sealed, 1 + EPH_PUB_LEN + OWNER_SIG_LEN);
  return out;
}

/** 解信封:先驗 owner 簽章(擋偽造)、ECDH 導金鑰(綁 context)再解出原始金鑰;任一不符即拋 */
export async function unwrapKey(
  wrapped: Uint8Array,
  recipientXSecret: Uint8Array,
  ownerPubSign: Uint8Array,
  context: WrapContext,
): Promise<Uint8Array> {
  const headLen = 1 + EPH_PUB_LEN + OWNER_SIG_LEN;
  if (wrapped.length < headLen + 1 + NONCE_LENGTH + 16) throw new Error("unwrap:信封不完整");
  if (wrapped[0] !== WRAP_VERSION) throw new Error(`unwrap:未知信封版本 ${wrapped[0]}`);
  const ephPub = wrapped.slice(1, 1 + EPH_PUB_LEN);
  const ownerSig = wrapped.slice(1 + EPH_PUB_LEN, headLen);
  const sealed = wrapped.slice(headLen);
  const ctxBytes = wrapContextBytes(context);
  if (!verifyOwnerSig(ownerSig, concatBytes(ephPub, sealed, ctxBytes), ownerPubSign)) {
    throw new Error("unwrap:owner 簽章驗證失敗");
  }
  const shared = x25519.getSharedSecret(recipientXSecret, ephPub);
  if (isAllZero(shared)) throw new Error("unwrap:非法 ephemeral 公鑰(shared secret 全零)");
  const recipientPubWrap = x25519.getPublicKey(recipientXSecret);
  const aesKey = await wrapAesKey(shared, concatBytes(ctxBytes, ephPub, recipientPubWrap));
  return open(aesKey, sealed);
}

function verifyOwnerSig(signature: Uint8Array, message: Uint8Array, pubSign: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, pubSign);
  } catch {
    return false;
  }
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

/**
 * 空間金鑰來源抽象:給一個 spaceId,取得那個空間的密碼器。
 * Slice 1(個人 vault)只有「從主金鑰衍生」一種實作;Slice 2 團隊層再加「從成員包裝解出」實作,下游不動。
 */
export interface SpaceKeySource {
  /** 該空間的原始根金鑰(32 bytes) */
  spaceKey(spaceId: string): Promise<Uint8Array>;
  /** 該空間的密碼器,內部再依 docId 衍生每篇筆記金鑰(可 exportDocKey 供分享連結用) */
  cipher(spaceId: string): Promise<VaultCipher>;
  /** 金鑰輪換(2c-2,團隊 vault):原地換 root,後續 cipher 全走新金鑰;不支援輪換的實作可缺席 */
  rotate?(newMasterKey: Uint8Array): void;
}

/** Slice 1 實作:個人 vault,所有空間金鑰皆由主金鑰衍生(預設空間 = 主金鑰,零遷移) */
export class MasterKeySpaces implements SpaceKeySource {
  private readonly ciphers = new Map<string, Promise<VaultCipher>>();
  private masterKey: Uint8Array;

  constructor(masterKey: Uint8Array) {
    this.masterKey = masterKey.slice();
  }

  /**
   * 原地換 root(2c-2 金鑰輪換):清 cipher 快取,後續衍生全走新金鑰。
   * 刻意 mutate 而非重建實例:SyncManager 的 routingCipher 閉包每次現算 cipher(spaceId),
   * 換 root 自動生效,session/loose/awareness 全保留,不必拆重建 SyncManager。
   */
  rotate(newMasterKey: Uint8Array): void {
    this.masterKey = newMasterKey.slice();
    this.ciphers.clear();
  }

  spaceKey(spaceId: string): Promise<Uint8Array> {
    return deriveSpaceKey(this.masterKey, spaceId);
  }

  cipher(spaceId: string): Promise<VaultCipher> {
    let c = this.ciphers.get(spaceId);
    if (!c) {
      c = this.spaceKey(spaceId).then((key) => new VaultCipher(key));
      this.ciphers.set(spaceId, c);
    }
    return c;
  }
}
