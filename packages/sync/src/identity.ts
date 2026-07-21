import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { toBase64UrlEncoded, fromBase64UrlEncoded } from "lib0/buffer";
import { digest } from "./cipher.ts";
import { unwrapKey, type WrapContext } from "./crypto.ts";

/**
 * 成員身分:一把長期非對稱金鑰,證明「我是誰」給伺服器(challenge-response),
 * 並(2b 起)供他人用公鑰把團隊空間金鑰包給我。獨立於任何 vault 密語。
 *
 * 單一 32B 隨機種子 → HKDF 衍生兩把獨立子金鑰:
 *   - Ed25519 簽章金鑰(auth challenge-response)
 *   - X25519 wrap 金鑰(2b 用成員公鑰包裝空間金鑰;2a 只生成+攜帶+註冊,不做運算)
 * 不共用同一 scalar 當簽章又當 DH(Ed25519↔X25519 硬轉有交叉協議爭議),
 * 用 HKDF 不同 info label 衍生兩把,成本為零。跨裝置匯入只搬 32B 種子,兩把公鑰確定性重生不會錯配。
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const IDENTITY_SALT = utf8("stele-identity");
/** 簽章綁定的域分隔符:綁死此協議與版本,防跨協議/跨版本重用簽章 */
const CHALLENGE_DOMAIN = utf8("stele-auth-v1");
const SEED_LENGTH = 32;

export const IDENTITY_FORMAT = "stele-identity-v1";

/** 身分檔的版本化信封(存本機、可匯出匯入);seed 是唯一秘密,兩把子金鑰皆由它重生 */
export interface IdentityFile {
  format: typeof IDENTITY_FORMAT;
  memberId: string;
  /** 32 bytes 種子的 base64url */
  seed: string;
  /** 預留:未來 OS keychain / passphrase 包裝;null = 明文 */
  enc: null;
}

/** 一個成員的公開資料 + 簽章/解封能力(兩把私鑰皆留閉包,不外露) */
export interface SyncIdentity {
  /** hex(SHA-256(pubSign)):確定性、過 server validId 的 charset */
  memberId: string;
  pubSign: Uint8Array;
  pubWrap: Uint8Array;
  /** 以 Ed25519 私鑰簽一段位元組(challenge;owner 也用它簽空間金鑰信封)。閉包屬性,可安全當 callback 傳遞 */
  sign: (message: Uint8Array) => Uint8Array;
  /**
   * 解一個包給自己的空間金鑰信封(2b):以 X25519 私鑰 ECDH 還原,先驗 owner 簽章。
   * xSecret 留閉包不外洩;expectedOwnerPubSign 是 out-of-band 已知的 owner 信任錨。
   */
  unwrap: (wrapped: Uint8Array, expectedOwnerPubSign: Uint8Array, context: WrapContext) => Promise<Uint8Array>;
}

/** 新成員:隨機 32B 種子 */
export function generateSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_LENGTH));
}

async function hkdf(seed: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", seed as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: IDENTITY_SALT as BufferSource, info: utf8(info) as BufferSource },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 由種子衍生身分:同種子必得同 memberId/公鑰(跨裝置匯入語義的根) */
export async function deriveIdentity(seed: Uint8Array): Promise<SyncIdentity> {
  if (seed.length !== SEED_LENGTH) throw new Error(`身分種子長度須為 ${SEED_LENGTH}`);
  const edSeed = await hkdf(seed, "sign");
  const xSecret = await hkdf(seed, "wrap");
  const pubSign = ed25519.getPublicKey(edSeed);
  const pubWrap = x25519.getPublicKey(xSecret);
  const memberId = await digest(pubSign);
  return {
    memberId,
    pubSign,
    pubWrap,
    sign: (message) => ed25519.sign(message, edSeed),
    unwrap: (wrapped, expectedOwnerPubSign, context) => unwrapKey(wrapped, xSecret, expectedOwnerPubSign, context),
  };
}

/**
 * challenge-response 的待簽位元組,client 與 server 都呼叫此函式組出、保兩端位元組一致。
 * 綁 domain(防跨協議)+ server nonce(防重放)+ vaultId(防跨 vault 挪用)+ memberId(綁定宣稱身分)。
 *
 * 拼接無長度分隔卻無歧義:domain(13B)與 nonce(32B)固定長,且 server 強制 memberId==hex(sha256(pubSign))
 * = 永遠 64 hex 固定長(見 server handleAuthId),故從尾部倒數 64 即 memberId、中間即 vaultId,無切分歧義。
 */
export function identityChallengeBytes(nonce: Uint8Array, vaultId: string, memberId: string): Uint8Array {
  const parts = [CHALLENGE_DOMAIN, nonce, utf8(vaultId), utf8(memberId)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 伺服器端驗章:對宣稱的 memberId 用其 pubSign 驗證 challenge 簽名 */
export function verifyChallenge(
  signature: Uint8Array,
  nonce: Uint8Array,
  vaultId: string,
  memberId: string,
  pubSign: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, identityChallengeBytes(nonce, vaultId, memberId), pubSign);
  } catch {
    return false;
  }
}

/** 種子 → 版本化信封(供 identity-store 落盤與匯出) */
export function exportIdentity(seed: Uint8Array, memberId: string): IdentityFile {
  return { format: IDENTITY_FORMAT, memberId, seed: toBase64UrlEncoded(seed), enc: null };
}

/** 信封 → 種子(供讀檔與匯入);格式/長度不符即拋,呼叫端據此重生身分 */
export function importIdentity(file: unknown): Uint8Array {
  if (typeof file !== "object" || file === null) throw new Error("身分檔格式錯誤");
  const f = file as Record<string, unknown>;
  if (f["format"] !== IDENTITY_FORMAT) throw new Error(`未知的身分檔版本:${String(f["format"])}`);
  if (typeof f["seed"] !== "string") throw new Error("身分檔缺 seed");
  const seed = fromBase64UrlEncoded(f["seed"]);
  if (seed.length !== SEED_LENGTH) throw new Error("身分種子長度不符");
  return seed;
}
