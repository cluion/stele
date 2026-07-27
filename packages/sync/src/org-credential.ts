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

/**
 * 組織名冊條目(3b-1):組織為「memberId ↔ 顯示名」背書。
 *
 * 為何需要:協作游標與留言上的名字目前來自成員自選的 `displayName`(sync.json),
 * 任何人都能自稱任何名字——名字是社交層最容易被冒用的東西,卻完全沒有驗證。
 * 名冊讓組織對它背書:驗得過才顯示為組織名並標示來源,驗不過就回退成員自選名,絕不顯示偽造的名字。
 *
 * blob 格式:[版本 varuint][serial varuint][顯示名 varString][部門 varString][adminCert 長度前綴][簽發者簽章 64B]
 * memberId 不進 blob:由驗證者自帶(從協定/目錄的鍵取得),挪用他人條目必然驗不過。
 */

const ORG_MEMBER_CERT_VERSION = 1;
const ORG_MEMBER_DOMAIN = new TextEncoder().encode("stele-org-member-v1");
/** 顯示名長度上限:名字會進側欄與游標標籤,過長會灌爆版面(且沒有正當用途) */
const MAX_DISPLAY_NAME = 64;
const MAX_DEPARTMENT = 64;

export interface OrgMemberClaims {
  memberId: string;
  displayName: string;
  department?: string;
  /** 單調序號:名冊條目的反回滾水位,與團隊憑證各自獨立 */
  serial: number;
}

export interface VerifiedOrgMember {
  memberId: string;
  displayName: string;
  department?: string;
  serial: number;
  /** 簽發者(root 直簽即 root 自己),供稽核 */
  issuerMemberId: string;
}

function orgMemberBytes(c: OrgMemberClaims): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, ORG_MEMBER_DOMAIN);
  encoding.writeVarString(enc, c.memberId);
  encoding.writeVarString(enc, c.displayName);
  encoding.writeVarString(enc, c.department ?? "");
  encoding.writeVarUint(enc, c.serial);
  return encoding.toUint8Array(enc);
}

/** 簽發名冊條目;adminCert 省略 = org root 直簽,帶入 = 由該委任的 admin 簽 */
export function signOrgMemberCert(
  issuerSign: (message: Uint8Array) => Uint8Array,
  claims: OrgMemberClaims,
  adminCert: Uint8Array | undefined,
): Uint8Array {
  if (claims.displayName.length === 0 || claims.displayName.length > MAX_DISPLAY_NAME) {
    throw new Error(`顯示名長度須為 1..${MAX_DISPLAY_NAME}`);
  }
  if ((claims.department ?? "").length > MAX_DEPARTMENT) throw new Error(`部門長度上限 ${MAX_DEPARTMENT}`);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, ORG_MEMBER_CERT_VERSION);
  encoding.writeVarUint(enc, claims.serial);
  encoding.writeVarString(enc, claims.displayName);
  encoding.writeVarString(enc, claims.department ?? "");
  encoding.writeVarUint8Array(enc, adminCert ?? new Uint8Array());
  const head = encoding.toUint8Array(enc);
  const sig = issuerSign(orgMemberBytes(claims));
  const out = new Uint8Array(head.length + SIG_LEN);
  out.set(head, 0);
  out.set(sig, head.length);
  return out;
}

/**
 * 只取名冊條目的序號,不驗簽(供伺服器做單調把關用)。
 * 伺服器本來就不該懂憑證真偽——真偽由成員端對組織根驗;它只需要序號來擋回放,
 * 格式知識因此留在本模組,不外流到伺服器。格式不符回 undefined。
 */
export function orgMemberCertSerial(blob: Uint8Array): number | undefined {
  try {
    const dec = decoding.createDecoder(blob);
    if (decoding.readVarUint(dec) !== ORG_MEMBER_CERT_VERSION) return undefined;
    return decoding.readVarUint(dec);
  } catch {
    return undefined;
  }
}

/**
 * 驗一筆名冊條目:確立簽發者(root 或未過期的委任 admin)後驗簽。
 * memberId 由驗證者自帶(防挪用);偽簽、竄改、過期委任、截斷一律拋——呼叫端據此**濾掉**該筆,
 * 回退成員自選名,絕不採信驗不過的名字。
 */
export function verifyOrgMemberCert(blob: Uint8Array, orgRootPubSign: Uint8Array, memberId: string, nowSec: number): VerifiedOrgMember {
  const dec = decoding.createDecoder(blob);
  let serial: number;
  let displayName: string;
  let department: string;
  let adminCert: Uint8Array;
  try {
    const version = decoding.readVarUint(dec);
    if (version !== ORG_MEMBER_CERT_VERSION) throw new Error(`未知的名冊條目版本:${version}`);
    serial = decoding.readVarUint(dec);
    displayName = decoding.readVarString(dec);
    department = decoding.readVarString(dec);
    adminCert = decoding.readVarUint8Array(dec);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("未知的名冊條目版本") ? err : new Error("名冊條目不完整");
  }
  const sig = blob.slice(dec.pos);
  if (sig.length !== SIG_LEN) throw new Error("名冊條目不完整");
  const issuer =
    adminCert.length === 0
      ? { pubSign: orgRootPubSign, memberId: memberIdFromPubSign(orgRootPubSign) }
      : (() => {
          const v = verifyOrgAdminCert(adminCert, orgRootPubSign, nowSec);
          return { pubSign: v.adminPubSign, memberId: v.adminMemberId };
        })();
  if (!verifyEd(sig, orgMemberBytes({ memberId, displayName, department, serial }), issuer.pubSign)) {
    throw new Error("名冊條目簽章驗證失敗");
  }
  return {
    memberId,
    displayName,
    ...(department.length > 0 ? { department } : {}),
    serial,
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
