import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { MemberRole } from "./protocol.ts";

/**
 * 角色憑證(2c 補完,§9.5):owner 對 {vaultId, memberId, role, epoch} 的 Ed25519 簽章,
 * 經盲中繼分發、成員以 out-of-band 信任錨 ownerPubSign 驗證——讓 role **指派**防竄改:
 * 惡意伺服器無法捏造或跨 vault/成員/紀元挪用角色(vaultId/memberId 綁進簽章卻不佔 blob,由收件人自證)。
 *
 * blob 格式:[版本 1B][role tag varuint][epoch varuint][簽章 64B]
 *
 * 邊界:這驗的是「指派」,不是每筆寫入的作者真實性(留更後);同紀元內改角色後,
 * 惡意伺服器仍可重放舊憑證(兩者皆 owner 真簽)——輪換金鑰即作廢整代憑證,是 owner 的沖洗手段。
 */

const CRED_VERSION = 1;
const SIG_LEN = 64;
/** 簽章域分隔:綁死此協議與版本,防跨協議重用簽章(與 keywrap/auth 的 domain 互異) */
const CRED_DOMAIN = new TextEncoder().encode("stele-role-cred-v1");

const ROLE_TAG: Record<MemberRole, number> = { owner: 0, editor: 1, viewer: 2 };
const roleFromTag = (tag: number): MemberRole | undefined => (tag === 0 ? "owner" : tag === 1 ? "editor" : tag === 2 ? "viewer" : undefined);

export interface RoleCredentialClaims {
  vaultId: string;
  memberId: string;
  role: MemberRole;
  epoch: number;
}

/** 待簽位元組(lib0 length-prefixed,無歧義);簽驗兩端共用保位元組一致 */
function credentialBytes(c: RoleCredentialClaims): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, CRED_DOMAIN);
  encoding.writeVarString(enc, c.vaultId);
  encoding.writeVarString(enc, c.memberId);
  encoding.writeVarUint(enc, ROLE_TAG[c.role]);
  encoding.writeVarUint(enc, c.epoch);
  return encoding.toUint8Array(enc);
}

/** owner 簽發角色憑證;ownerSign 傳入既有 identity.sign,不外露私鑰 */
export function signRoleCredential(ownerSign: (message: Uint8Array) => Uint8Array, claims: RoleCredentialClaims): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, CRED_VERSION);
  encoding.writeVarUint(enc, ROLE_TAG[claims.role]);
  encoding.writeVarUint(enc, claims.epoch);
  const head = encoding.toUint8Array(enc);
  const sig = ownerSign(credentialBytes(claims));
  const out = new Uint8Array(head.length + SIG_LEN);
  out.set(head, 0);
  out.set(sig, head.length);
  return out;
}

/**
 * 成員驗證自己的角色憑證:以 blob 宣稱的 role/epoch 重組待簽位元組、對 ownerPubSign 驗章。
 * vaultId/memberId 由收件人自帶(不是信 blob)——挪用他人或他 vault 的憑證必然驗不過。任一不符即拋。
 */
export function verifyRoleCredential(
  blob: Uint8Array,
  ownerPubSign: Uint8Array,
  vaultId: string,
  memberId: string,
): { role: MemberRole; epoch: number } {
  const dec = decoding.createDecoder(blob);
  let role: MemberRole | undefined;
  let epoch: number;
  try {
    const version = decoding.readVarUint(dec);
    if (version !== CRED_VERSION) throw new Error(`未知的角色憑證版本:${version}`);
    role = roleFromTag(decoding.readVarUint(dec));
    epoch = decoding.readVarUint(dec);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("未知的角色憑證版本") ? err : new Error("角色憑證不完整");
  }
  if (role === undefined) throw new Error("角色憑證含未知角色");
  const sig = blob.slice(dec.pos);
  if (sig.length !== SIG_LEN) throw new Error("角色憑證不完整");
  const ok = (() => {
    try {
      return ed25519.verify(sig, credentialBytes({ vaultId, memberId, role, epoch }), ownerPubSign);
    } catch {
      return false;
    }
  })();
  if (!ok) throw new Error("角色憑證簽章驗證失敗");
  return { role, epoch };
}

/**
 * 成員憑證(P4 寫入真實性,第一階段):owner 對 {vaultId, pubSign, role, epoch} 的 Ed25519 簽章,
 * **背書 memberId↔pubSign 綁定**——讓任一成員能安全取得他人的可信簽章公鑰,是逐 update 作者驗證的前置。
 * 與角色憑證(§9.5,發回本人驗自己角色)並存:memberCert 進「全員目錄」,供成員驗他人的寫入作者。
 *
 * blob 格式:[版本 1B][role tag varuint][epoch varuint][pubSign 32B][owner 簽章 64B]
 *
 * memberId 不單獨簽:memberId = hex(sha256(pubSign)),已被 pubSign 綁死;驗證者自算,不信 blob。
 * vaultId 驗證者自帶(防跨 vault);pubSign 由 owner 簽章背書(惡意中繼改 pubSign → 驗不過)。
 */

const MEMBER_CERT_VERSION = 1;
const MEMBER_CERT_DOMAIN = new TextEncoder().encode("stele-member-cert-v1");
const PUBSIGN_LEN = 32;

export interface MemberCredentialClaims {
  vaultId: string;
  pubSign: Uint8Array;
  role: MemberRole;
  epoch: number;
}

export interface VerifiedMember {
  /** hex(sha256(pubSign)),由 pubSign 導出,不信 blob */
  memberId: string;
  pubSign: Uint8Array;
  role: MemberRole;
  epoch: number;
}

function memberBytes(c: { vaultId: string; pubSign: Uint8Array; role: MemberRole; epoch: number }): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, MEMBER_CERT_DOMAIN);
  encoding.writeVarString(enc, c.vaultId);
  encoding.writeVarUint8Array(enc, c.pubSign);
  encoding.writeVarUint(enc, ROLE_TAG[c.role]);
  encoding.writeVarUint(enc, c.epoch);
  return encoding.toUint8Array(enc);
}

/** memberId = hex(sha256(pubSign));與 identity 的 memberId 一致(同步版,供憑證層) */
export function memberIdFromPubSign(pubSign: Uint8Array): string {
  return Array.from(sha256(pubSign), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** owner 簽發成員憑證(approve/setRole/輪換時,與角色憑證同一趟) */
export function signMemberCredential(ownerSign: (message: Uint8Array) => Uint8Array, claims: MemberCredentialClaims): Uint8Array {
  if (claims.pubSign.length !== PUBSIGN_LEN) throw new Error("pubSign 長度須為 32");
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MEMBER_CERT_VERSION);
  encoding.writeVarUint(enc, ROLE_TAG[claims.role]);
  encoding.writeVarUint(enc, claims.epoch);
  const head = encoding.toUint8Array(enc);
  const sig = ownerSign(memberBytes(claims));
  const out = new Uint8Array(head.length + PUBSIGN_LEN + SIG_LEN);
  out.set(head, 0);
  out.set(claims.pubSign, head.length);
  out.set(sig, head.length + PUBSIGN_LEN);
  return out;
}

/**
 * 驗證一筆成員憑證:對 ownerPubSign 驗章,回傳可信的 {memberId, pubSign, role, epoch}。
 * vaultId 驗證者自帶(防跨 vault 挪用);偽簽、pubSign 竄改、跨 vault、截斷一律拋。
 */
export function verifyMemberCredential(blob: Uint8Array, ownerPubSign: Uint8Array, vaultId: string): VerifiedMember {
  const dec = decoding.createDecoder(blob);
  let role: MemberRole | undefined;
  let epoch: number;
  try {
    const version = decoding.readVarUint(dec);
    if (version !== MEMBER_CERT_VERSION) throw new Error(`未知的成員憑證版本:${version}`);
    role = roleFromTag(decoding.readVarUint(dec));
    epoch = decoding.readVarUint(dec);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("未知的成員憑證版本") ? err : new Error("成員憑證不完整");
  }
  if (role === undefined) throw new Error("成員憑證含未知角色");
  const rest = blob.slice(dec.pos);
  if (rest.length !== PUBSIGN_LEN + SIG_LEN) throw new Error("成員憑證不完整");
  const pubSign = rest.slice(0, PUBSIGN_LEN);
  const sig = rest.slice(PUBSIGN_LEN);
  const ok = (() => {
    try {
      return ed25519.verify(sig, memberBytes({ vaultId, pubSign, role, epoch }), ownerPubSign);
    } catch {
      return false;
    }
  })();
  if (!ok) throw new Error("成員憑證簽章驗證失敗");
  return { memberId: memberIdFromPubSign(pubSign), pubSign, role, epoch };
}
