import { ed25519 } from "@noble/curves/ed25519.js";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { memberIdFromPubSign } from "./role-credential.ts";

/**
 * 組織委任鏈(Slice 3a):把信任錨從 per-vault 的 ownerPubSign **上提**到組織根公鑰。
 *
 *   orgRootPubSign
 *     └─(簽)→ orgAdminCert{adminPubSign, notAfter}       # 日常管理委任,root 可離線保管
 *           └─(簽)→ orgTeamCert{vaultId, ownerPubSign, serial}
 *                 └─ 既有鏈不動:memberCert / roleCred / vaultPolicy / key envelope
 *
 * 買到的能力:團隊的**當代 owner 由組織指派且成員端可驗**——owner 離職可撤換,不必重建 vault、
 * 不必重發邀請。沒買到的:新 owner 仍須持有 root 才能真的加人/輪換(金鑰平面,見 spec §3)。
 *
 * orgId = hex(sha256(orgRootPubSign)):自我認證,不需伺服器背書;跨組織挪用天然不可能
 * (別的組織是別把 root 金鑰),故簽章位元組不再重複綁 orgId。
 *
 * 邊界:這驗的是「誰是這個 vault 當代的合法 owner」,不是 owner 的每筆寫入(那是 update 簽章),
 * 也不給組織任何內容金鑰——治理平面與金鑰平面分離是本 slice 的核心取捨(託管另見 3c)。
 */

const ADMIN_CERT_VERSION = 1;
const TEAM_CERT_VERSION = 1;
const SIG_LEN = 64;
const PUBSIGN_LEN = 32;
/** 簽章域分隔:各自綁死協議與版本,防跨憑證重用簽章(與 role/member/policy 的 domain 互異) */
const ADMIN_DOMAIN = new TextEncoder().encode("stele-org-admin-v1");
const TEAM_DOMAIN = new TextEncoder().encode("stele-org-team-v1");

/** orgId = hex(sha256(orgRootPubSign));與 memberId 同一套導出規則 */
export function orgIdFromRootPubSign(rootPubSign: Uint8Array): string {
  return memberIdFromPubSign(rootPubSign);
}

export interface OrgAdminClaims {
  adminPubSign: Uint8Array;
  /** unix 秒;0 = 永久(root 仍可靠撤銷清單/重簽沖洗,3b) */
  notAfter: number;
}

export interface VerifiedOrgAdmin {
  adminMemberId: string;
  adminPubSign: Uint8Array;
  notAfter: number;
}

function adminBytes(c: OrgAdminClaims): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, ADMIN_DOMAIN);
  encoding.writeVarUint8Array(enc, c.adminPubSign);
  encoding.writeVarUint(enc, c.notAfter);
  return encoding.toUint8Array(enc);
}

/**
 * org root 簽發管理員委任。
 * blob 格式:[版本 varuint][notAfter varuint][adminPubSign 32B][root 簽章 64B]
 */
export function signOrgAdminCert(rootSign: (message: Uint8Array) => Uint8Array, claims: OrgAdminClaims): Uint8Array {
  if (claims.adminPubSign.length !== PUBSIGN_LEN) throw new Error("adminPubSign 長度須為 32");
  if (!Number.isInteger(claims.notAfter) || claims.notAfter < 0) throw new Error("notAfter 須為非負整數(unix 秒,0=永久)");
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, ADMIN_CERT_VERSION);
  encoding.writeVarUint(enc, claims.notAfter);
  const head = encoding.toUint8Array(enc);
  const sig = rootSign(adminBytes(claims));
  const out = new Uint8Array(head.length + PUBSIGN_LEN + SIG_LEN);
  out.set(head, 0);
  out.set(claims.adminPubSign, head.length);
  out.set(sig, head.length + PUBSIGN_LEN);
  return out;
}

/** 驗管理員委任:對 orgRootPubSign 驗章 + 檢查有效期。偽簽、竄改、過期、截斷一律拋 */
export function verifyOrgAdminCert(blob: Uint8Array, orgRootPubSign: Uint8Array, nowSec: number): VerifiedOrgAdmin {
  const dec = decoding.createDecoder(blob);
  let notAfter: number;
  try {
    const version = decoding.readVarUint(dec);
    if (version !== ADMIN_CERT_VERSION) throw new Error(`未知的組織委任版本:${version}`);
    notAfter = decoding.readVarUint(dec);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("未知的組織委任版本") ? err : new Error("組織委任不完整");
  }
  const rest = blob.slice(dec.pos);
  if (rest.length !== PUBSIGN_LEN + SIG_LEN) throw new Error("組織委任不完整");
  const adminPubSign = rest.slice(0, PUBSIGN_LEN);
  const sig = rest.slice(PUBSIGN_LEN);
  if (!verifyEd(sig, adminBytes({ adminPubSign, notAfter }), orgRootPubSign)) throw new Error("組織委任簽章驗證失敗");
  // 先驗簽再驗期:過期訊息只在真簽時才有意義,避免偽造 blob 誘導出誤導性錯誤
  if (notAfter !== 0 && nowSec > notAfter) throw new Error("組織委任已過期");
  return { adminMemberId: memberIdFromPubSign(adminPubSign), adminPubSign, notAfter };
}

export interface OrgTeamClaims {
  vaultId: string;
  /** 這個 vault 當代的合法 owner 簽章公鑰 */
  ownerPubSign: Uint8Array;
  /**
   * 憑證序號:單調遞增,**與金鑰紀元解耦**。成員端 pin 已見過的最大 serial 並拒收較小者
   * (反回滾,同 0.18.0 政策 pin),擋惡意伺服器重放舊憑證把 owner 指回離職者。
   * 不綁 epoch 是刻意的:綁了就會「轉手 owner → 新 owner 輪換 → 憑證失效」死結,而簽新憑證只有組織能做。
   */
  serial: number;
  /**
   * 前任 owner 公鑰(交接過渡用,選配)。撤換當下,成員(含新 owner 自己)手上的 root 信封還是前任簽的,
   * 若只認當代 owner,連新 owner 都 bootstrap 不了、整團隊鎖死。組織以此**明示背書**前任簽的金鑰信封
   * 在接管完成前仍可採信——範圍嚴格限於信封(前任本就知道 root,不擴大任何權限);
   * 角色/成員憑證與政策一律只認當代 owner,過渡期缺席即 fallback 本地既知,不被前任左右。
   */
  prevOwnerPubSign?: Uint8Array;
}

export interface VerifiedOrgTeam {
  ownerMemberId: string;
  ownerPubSign: Uint8Array;
  serial: number;
  /** 組織背書的前任 owner(交接過渡);無 = 不接受任何非當代簽章 */
  prevOwnerPubSign?: Uint8Array;
  /** 簽發者(root 直簽時即 root 自己);供稽核「是誰指派的」 */
  issuerMemberId: string;
}

function teamBytes(c: OrgTeamClaims): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, TEAM_DOMAIN);
  encoding.writeVarString(enc, c.vaultId);
  encoding.writeVarUint8Array(enc, c.ownerPubSign);
  encoding.writeVarUint(enc, c.serial);
  encoding.writeVarUint8Array(enc, c.prevOwnerPubSign ?? new Uint8Array());
  return encoding.toUint8Array(enc);
}

/**
 * 簽發團隊憑證。adminCert 省略 = org root 直簽;帶入 = 由該委任的 admin 簽(簽章者須與委任內公鑰相符)。
 * blob 格式:[版本 varuint][serial varuint][ownerPubSign 32B][prevOwnerPubSign 長度前綴][adminCert 長度前綴][簽發者簽章 64B]
 */
export function signOrgTeamCert(
  issuerSign: (message: Uint8Array) => Uint8Array,
  claims: OrgTeamClaims,
  adminCert: Uint8Array | undefined,
): Uint8Array {
  if (claims.ownerPubSign.length !== PUBSIGN_LEN) throw new Error("ownerPubSign 長度須為 32");
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, TEAM_CERT_VERSION);
  encoding.writeVarUint(enc, claims.serial);
  encoding.writeUint8Array(enc, claims.ownerPubSign);
  encoding.writeVarUint8Array(enc, claims.prevOwnerPubSign ?? new Uint8Array());
  encoding.writeVarUint8Array(enc, adminCert ?? new Uint8Array());
  const head = encoding.toUint8Array(enc);
  const sig = issuerSign(teamBytes(claims));
  const out = new Uint8Array(head.length + SIG_LEN);
  out.set(head, 0);
  out.set(sig, head.length);
  return out;
}

/**
 * 驗團隊憑證:先確立簽發者(root 自己,或經 root 驗過且未過期的 admin),再以其公鑰驗團隊簽章。
 * vaultId 由驗證者自帶(防跨 vault 挪用);鏈上任一環不成立即拋,絕不降級回舊錨。
 */
export function verifyOrgTeamCert(
  blob: Uint8Array,
  orgRootPubSign: Uint8Array,
  vaultId: string,
  nowSec: number,
): VerifiedOrgTeam {
  const dec = decoding.createDecoder(blob);
  let serial: number;
  let ownerPubSign: Uint8Array;
  let prevOwnerPubSign: Uint8Array;
  let adminCert: Uint8Array;
  try {
    const version = decoding.readVarUint(dec);
    if (version !== TEAM_CERT_VERSION) throw new Error(`未知的團隊憑證版本:${version}`);
    serial = decoding.readVarUint(dec);
    ownerPubSign = decoding.readUint8Array(dec, PUBSIGN_LEN);
    prevOwnerPubSign = decoding.readVarUint8Array(dec);
    adminCert = decoding.readVarUint8Array(dec);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("未知的團隊憑證版本") ? err : new Error("團隊憑證不完整");
  }
  const sig = blob.slice(dec.pos);
  if (sig.length !== SIG_LEN) throw new Error("團隊憑證不完整");
  // 簽發者:無委任 = root 直簽;有委任 = 先對 root 驗委任(含有效期),再用委任內的公鑰驗此章
  const issuer = adminCert.length === 0 ? { pubSign: orgRootPubSign, memberId: memberIdFromPubSign(orgRootPubSign) } : (() => {
    const v = verifyOrgAdminCert(adminCert, orgRootPubSign, nowSec);
    return { pubSign: v.adminPubSign, memberId: v.adminMemberId };
  })();
  const prev = prevOwnerPubSign.length > 0 ? prevOwnerPubSign : undefined;
  if (!verifyEd(sig, teamBytes({ vaultId, ownerPubSign, serial, prevOwnerPubSign: prev }), issuer.pubSign)) {
    throw new Error("團隊憑證簽章驗證失敗");
  }
  return {
    ownerMemberId: memberIdFromPubSign(ownerPubSign),
    ownerPubSign,
    serial,
    ...(prev ? { prevOwnerPubSign: prev } : {}),
    issuerMemberId: issuer.memberId,
  };
}

/** 組織管理連線的 challenge 域:與 vault 的 stele-auth-v1 分開,擋「對某 vault 的證明被挪用為組織管理權」 */
const ORG_AUTH_DOMAIN = new TextEncoder().encode("stele-org-auth-v1");

/** 組織管理連線 challenge-response 的待簽位元組;length-prefixed 無歧義,兩端共用 */
export function orgChallengeBytes(nonce: Uint8Array, orgId: string, adminMemberId: string): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, ORG_AUTH_DOMAIN);
  encoding.writeVarUint8Array(enc, nonce);
  encoding.writeVarString(enc, orgId);
  encoding.writeVarString(enc, adminMemberId);
  return encoding.toUint8Array(enc);
}

/** 伺服器端驗組織管理連線的 challenge 簽章 */
export function verifyOrgChallenge(
  signature: Uint8Array,
  nonce: Uint8Array,
  orgId: string,
  adminMemberId: string,
  adminPubSign: Uint8Array,
): boolean {
  return verifyEd(signature, orgChallengeBytes(nonce, orgId, adminMemberId), adminPubSign);
}

function verifyEd(sig: Uint8Array, message: Uint8Array, pubSign: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, pubSign);
  } catch {
    return false;
  }
}
