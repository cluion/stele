import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * 同步協議 v1:二進位訊框,client 與伺服器共用
 * 伺服器是 blind relay,payload 一律視為不透明密文,協議層不認識 Yjs
 */

/** 分享權限:唯讀連線的 push 一律被伺服器拒絕,可編輯連線才准寫 */
export type SharePermission = "read" | "write";

/** 團隊成員角色(2c):owner 全權 + 管理;editor 可讀寫 doc;viewer 只讀 */
export type MemberRole = "owner" | "editor" | "viewer";

export interface ShareInfo {
  shareId: string;
  docId: string;
  permission: SharePermission;
  revoked: boolean;
}

/** 一封空間金鑰信封(2b):owner 用某成員 pubWrap 包裝的原始金鑰密文,伺服器只中繼不解讀 */
export interface KeyEnvelope {
  keyId: string;
  epoch: number;
  blob: Uint8Array;
}

/** 一位成員的公開資料(owner 查對方 pubWrap 以包裝金鑰)+ 角色(2c) */
export interface MemberInfo {
  memberId: string;
  pubSign: Uint8Array;
  pubWrap: Uint8Array;
  role: MemberRole;
  /** 是否已持有金鑰信封(2c-2):輪換只重包已核准成員,pending 成員仍待 owner 核對指紋後 approve */
  approved: boolean;
}

export type ClientMessage =
  | { type: "auth"; token: string; vaultId: string }
  // 帶身分認證(Slice 2a):token 准入 + 宣稱成員身分與公鑰,伺服器回 challenge
  // enrollmentToken(2b):加入 team vault 的新成員憑一次性邀請碼准入;個人 vault / 已註冊成員留空字串
  | {
      type: "authId";
      token: string;
      vaultId: string;
      memberId: string;
      pubSign: Uint8Array;
      pubWrap: Uint8Array;
      enrollmentToken: string;
    }
  // 對 challenge nonce 的 Ed25519 簽章,證明持有身分私鑰
  | { type: "authProof"; signature: Uint8Array }
  // 團隊金鑰分發與成員管理(2b);reqId 供 client 對應回覆。授權由伺服器按 owner/self 把關
  | { type: "claimOwner"; reqId: number }
  | { type: "envelopePush"; reqId: number; keyId: string; memberId: string; epoch: number; blob: Uint8Array }
  | { type: "envelopePull"; reqId: number }
  | { type: "memberList"; reqId: number }
  | { type: "memberRemove"; reqId: number; memberId: string }
  // enrollCreate 帶 role(2c):owner 產邀請碼時就決定被邀者加入後的角色(editor/viewer)
  | { type: "enrollCreate"; reqId: number; ttlSec: number; role: MemberRole }
  // 改成員角色(2c,owner-only);降級/移除會踢對方活躍連線
  | { type: "memberSetRole"; reqId: number; memberId: string; role: MemberRole }
  // 金鑰輪換 commit(2c-2,owner-only):bump vault epoch 至指定值(須恰為當前+1),
  // 伺服器隨即以 epoch 柵欄拒舊 epoch 寫入並廣播 keyRotated 給該 vault 全連線
  | { type: "rotateKey"; reqId: number; epoch: number }
  // doc 寫入帶 client epoch(2c-2 寫入柵欄):team vault 上伺服器拒 epoch≠當前,
  // 防止輪換窗口內舊 root 密文污染共享日誌;個人 vault/share 連線恆送 0(不套柵欄)
  | { type: "push"; docId: string; deviceId: string; counter: number; epoch: number; payload: Uint8Array }
  | { type: "pull"; docId: string; fromSeq: number }
  | { type: "snapshotPush"; docId: string; uptoSeq: number; epoch: number; payload: Uint8Array }
  | { type: "snapshotPull"; docId: string }
  // awareness:游標/選取/在線,加密後轉發不落盤(ephemeral),伺服器只轉不存
  | { type: "awareness"; docId: string; payload: Uint8Array }
  // 分享管理:由已認證的 vault 擁有者發出,reqId 供 client 對應回覆
  | { type: "shareCreate"; reqId: number; docId: string; permission: SharePermission }
  | { type: "shareList"; reqId: number }
  | { type: "shareRevoke"; reqId: number; shareId: string }
  // 分享認證:收件人以 shareId 取代 auth,連線被鎖定在該分享的單一 doc 與權限
  | { type: "shareAuth"; shareId: string };

export interface DocHead {
  docId: string;
  headSeq: number;
  snapshotSeq: number;
}

export type ServerMessage =
  // epoch(2c-2):vault 當前金鑰紀元;client 若低於它表示錯過輪換,須重跑 bootstrap 取新 root。個人 vault 恆 0
  | { type: "authOk"; docs: DocHead[]; epoch: number }
  // 身分認證第一階段:伺服器給每連線新生的 nonce,client 據此簽章
  | { type: "authChallenge"; nonce: Uint8Array }
  | { type: "update"; docId: string; seq: number; payload: Uint8Array }
  | { type: "ack"; docId: string; counter: number; seq: number }
  | { type: "snapshot"; docId: string; uptoSeq: number; payload: Uint8Array }
  | { type: "snapshotAck"; docId: string; uptoSeq: number }
  | { type: "error"; code: string; message: string }
  // 轉發自其他參與者的加密 awareness
  | { type: "awareness"; docId: string; payload: Uint8Array }
  | { type: "shareCreated"; reqId: number; shareId: string }
  | { type: "shareCatalog"; reqId: number; shares: ShareInfo[] }
  // 分享認證成功:告知收件人此分享對應的 doc、權限與同步進度
  | { type: "shareAuthOk"; docId: string; permission: SharePermission; headSeq: number; snapshotSeq: number }
  // 團隊金鑰分發與成員管理的回覆(2b)
  | { type: "envelopeList"; reqId: number; envelopes: KeyEnvelope[] }
  | { type: "memberCatalog"; reqId: number; members: MemberInfo[] }
  | { type: "enrollCreated"; reqId: number; token: string }
  // 通用成功回執(envelopePush / memberRemove / claimOwner / rotateKey)
  | { type: "ok"; reqId: number }
  // 金鑰輪換廣播(2c-2):vault epoch 已 bump,成員應暫停推送、重跑 bootstrap 取新 root 後 repull
  | { type: "keyRotated"; epoch: number };

const CLIENT_TAG = {
  auth: 0,
  push: 1,
  pull: 2,
  snapshotPush: 3,
  snapshotPull: 4,
  awareness: 5,
  shareCreate: 6,
  shareList: 7,
  shareRevoke: 8,
  shareAuth: 9,
  authId: 10,
  authProof: 11,
  claimOwner: 12,
  envelopePush: 13,
  envelopePull: 14,
  memberList: 15,
  memberRemove: 16,
  enrollCreate: 17,
  memberSetRole: 18,
  rotateKey: 19,
} as const;
const SERVER_TAG = {
  authOk: 0,
  update: 1,
  ack: 2,
  snapshot: 3,
  snapshotAck: 4,
  error: 5,
  awareness: 6,
  shareCreated: 7,
  shareCatalog: 8,
  shareAuthOk: 9,
  authChallenge: 10,
  envelopeList: 11,
  memberCatalog: 12,
  enrollCreated: 13,
  ok: 14,
  keyRotated: 15,
} as const;

const PERM_TAG: Record<SharePermission, number> = { read: 0, write: 1 };
const permFromTag = (tag: number): SharePermission => (tag === 1 ? "write" : "read");

const ROLE_TAG: Record<MemberRole, number> = { owner: 0, editor: 1, viewer: 2 };
const roleFromTag = (tag: number): MemberRole => (tag === 0 ? "owner" : tag === 1 ? "editor" : "viewer");

export function encodeClientMessage(msg: ClientMessage): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, CLIENT_TAG[msg.type]);
  switch (msg.type) {
    case "auth":
      encoding.writeVarString(enc, msg.token);
      encoding.writeVarString(enc, msg.vaultId);
      break;
    case "authId":
      encoding.writeVarString(enc, msg.token);
      encoding.writeVarString(enc, msg.vaultId);
      encoding.writeVarString(enc, msg.memberId);
      encoding.writeVarUint8Array(enc, msg.pubSign);
      encoding.writeVarUint8Array(enc, msg.pubWrap);
      encoding.writeVarString(enc, msg.enrollmentToken);
      break;
    case "authProof":
      encoding.writeVarUint8Array(enc, msg.signature);
      break;
    case "claimOwner":
      encoding.writeVarUint(enc, msg.reqId);
      break;
    case "envelopePush":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.keyId);
      encoding.writeVarString(enc, msg.memberId);
      encoding.writeVarUint(enc, msg.epoch);
      encoding.writeVarUint8Array(enc, msg.blob);
      break;
    case "envelopePull":
      encoding.writeVarUint(enc, msg.reqId);
      break;
    case "memberList":
      encoding.writeVarUint(enc, msg.reqId);
      break;
    case "memberRemove":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.memberId);
      break;
    case "enrollCreate":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarUint(enc, msg.ttlSec);
      encoding.writeVarUint(enc, ROLE_TAG[msg.role]);
      break;
    case "memberSetRole":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.memberId);
      encoding.writeVarUint(enc, ROLE_TAG[msg.role]);
      break;
    case "rotateKey":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarUint(enc, msg.epoch);
      break;
    case "push":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarString(enc, msg.deviceId);
      encoding.writeVarUint(enc, msg.counter);
      encoding.writeVarUint(enc, msg.epoch);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "pull":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.fromSeq);
      break;
    case "snapshotPush":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.uptoSeq);
      encoding.writeVarUint(enc, msg.epoch);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "snapshotPull":
      encoding.writeVarString(enc, msg.docId);
      break;
    case "awareness":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "shareCreate":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, PERM_TAG[msg.permission]);
      break;
    case "shareList":
      encoding.writeVarUint(enc, msg.reqId);
      break;
    case "shareRevoke":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.shareId);
      break;
    case "shareAuth":
      encoding.writeVarString(enc, msg.shareId);
      break;
  }
  return encoding.toUint8Array(enc);
}

export function decodeClientMessage(data: Uint8Array): ClientMessage {
  const dec = decoding.createDecoder(data);
  const tag = decoding.readVarUint(dec);
  switch (tag) {
    case CLIENT_TAG.auth:
      return { type: "auth", token: decoding.readVarString(dec), vaultId: decoding.readVarString(dec) };
    case CLIENT_TAG.authId:
      return {
        type: "authId",
        token: decoding.readVarString(dec),
        vaultId: decoding.readVarString(dec),
        memberId: decoding.readVarString(dec),
        pubSign: readPayload(dec),
        pubWrap: readPayload(dec),
        enrollmentToken: decoding.readVarString(dec),
      };
    case CLIENT_TAG.authProof:
      return { type: "authProof", signature: readPayload(dec) };
    case CLIENT_TAG.claimOwner:
      return { type: "claimOwner", reqId: decoding.readVarUint(dec) };
    case CLIENT_TAG.envelopePush:
      return {
        type: "envelopePush",
        reqId: decoding.readVarUint(dec),
        keyId: decoding.readVarString(dec),
        memberId: decoding.readVarString(dec),
        epoch: decoding.readVarUint(dec),
        blob: readPayload(dec),
      };
    case CLIENT_TAG.envelopePull:
      return { type: "envelopePull", reqId: decoding.readVarUint(dec) };
    case CLIENT_TAG.memberList:
      return { type: "memberList", reqId: decoding.readVarUint(dec) };
    case CLIENT_TAG.memberRemove:
      return { type: "memberRemove", reqId: decoding.readVarUint(dec), memberId: decoding.readVarString(dec) };
    case CLIENT_TAG.enrollCreate:
      return {
        type: "enrollCreate",
        reqId: decoding.readVarUint(dec),
        ttlSec: decoding.readVarUint(dec),
        role: roleFromTag(decoding.readVarUint(dec)),
      };
    case CLIENT_TAG.memberSetRole:
      return {
        type: "memberSetRole",
        reqId: decoding.readVarUint(dec),
        memberId: decoding.readVarString(dec),
        role: roleFromTag(decoding.readVarUint(dec)),
      };
    case CLIENT_TAG.rotateKey:
      return { type: "rotateKey", reqId: decoding.readVarUint(dec), epoch: decoding.readVarUint(dec) };
    case CLIENT_TAG.push:
      return {
        type: "push",
        docId: decoding.readVarString(dec),
        deviceId: decoding.readVarString(dec),
        counter: decoding.readVarUint(dec),
        epoch: decoding.readVarUint(dec),
        payload: readPayload(dec),
      };
    case CLIENT_TAG.pull:
      return { type: "pull", docId: decoding.readVarString(dec), fromSeq: decoding.readVarUint(dec) };
    case CLIENT_TAG.snapshotPush:
      return {
        type: "snapshotPush",
        docId: decoding.readVarString(dec),
        uptoSeq: decoding.readVarUint(dec),
        epoch: decoding.readVarUint(dec),
        payload: readPayload(dec),
      };
    case CLIENT_TAG.snapshotPull:
      return { type: "snapshotPull", docId: decoding.readVarString(dec) };
    case CLIENT_TAG.awareness:
      return { type: "awareness", docId: decoding.readVarString(dec), payload: readPayload(dec) };
    case CLIENT_TAG.shareCreate:
      return {
        type: "shareCreate",
        reqId: decoding.readVarUint(dec),
        docId: decoding.readVarString(dec),
        permission: permFromTag(decoding.readVarUint(dec)),
      };
    case CLIENT_TAG.shareList:
      return { type: "shareList", reqId: decoding.readVarUint(dec) };
    case CLIENT_TAG.shareRevoke:
      return { type: "shareRevoke", reqId: decoding.readVarUint(dec), shareId: decoding.readVarString(dec) };
    case CLIENT_TAG.shareAuth:
      return { type: "shareAuth", shareId: decoding.readVarString(dec) };
    default:
      throw new Error(`未知的 client 訊息類型:${tag}`);
  }
}

export function encodeServerMessage(msg: ServerMessage): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, SERVER_TAG[msg.type]);
  switch (msg.type) {
    case "authOk":
      encoding.writeVarUint(enc, msg.docs.length);
      for (const doc of msg.docs) {
        encoding.writeVarString(enc, doc.docId);
        encoding.writeVarUint(enc, doc.headSeq);
        encoding.writeVarUint(enc, doc.snapshotSeq);
      }
      encoding.writeVarUint(enc, msg.epoch);
      break;
    case "authChallenge":
      encoding.writeVarUint8Array(enc, msg.nonce);
      break;
    case "update":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.seq);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "ack":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.counter);
      encoding.writeVarUint(enc, msg.seq);
      break;
    case "snapshot":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.uptoSeq);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "snapshotAck":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.uptoSeq);
      break;
    case "error":
      encoding.writeVarString(enc, msg.code);
      encoding.writeVarString(enc, msg.message);
      break;
    case "awareness":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "shareCreated":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.shareId);
      break;
    case "shareCatalog":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarUint(enc, msg.shares.length);
      for (const s of msg.shares) {
        encoding.writeVarString(enc, s.shareId);
        encoding.writeVarString(enc, s.docId);
        encoding.writeVarUint(enc, PERM_TAG[s.permission]);
        encoding.writeVarUint(enc, s.revoked ? 1 : 0);
      }
      break;
    case "shareAuthOk":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, PERM_TAG[msg.permission]);
      encoding.writeVarUint(enc, msg.headSeq);
      encoding.writeVarUint(enc, msg.snapshotSeq);
      break;
    case "envelopeList":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarUint(enc, msg.envelopes.length);
      for (const e of msg.envelopes) {
        encoding.writeVarString(enc, e.keyId);
        encoding.writeVarUint(enc, e.epoch);
        encoding.writeVarUint8Array(enc, e.blob);
      }
      break;
    case "memberCatalog":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarUint(enc, msg.members.length);
      for (const m of msg.members) {
        encoding.writeVarString(enc, m.memberId);
        encoding.writeVarUint8Array(enc, m.pubSign);
        encoding.writeVarUint8Array(enc, m.pubWrap);
        encoding.writeVarUint(enc, ROLE_TAG[m.role]);
        encoding.writeVarUint(enc, m.approved ? 1 : 0);
      }
      break;
    case "enrollCreated":
      encoding.writeVarUint(enc, msg.reqId);
      encoding.writeVarString(enc, msg.token);
      break;
    case "ok":
      encoding.writeVarUint(enc, msg.reqId);
      break;
    case "keyRotated":
      encoding.writeVarUint(enc, msg.epoch);
      break;
  }
  return encoding.toUint8Array(enc);
}

export function decodeServerMessage(data: Uint8Array): ServerMessage {
  const dec = decoding.createDecoder(data);
  const tag = decoding.readVarUint(dec);
  switch (tag) {
    case SERVER_TAG.authOk: {
      const count = decoding.readVarUint(dec);
      const docs: DocHead[] = [];
      for (let i = 0; i < count; i++) {
        docs.push({
          docId: decoding.readVarString(dec),
          headSeq: decoding.readVarUint(dec),
          snapshotSeq: decoding.readVarUint(dec),
        });
      }
      return { type: "authOk", docs, epoch: decoding.readVarUint(dec) };
    }
    case SERVER_TAG.authChallenge:
      return { type: "authChallenge", nonce: readPayload(dec) };
    case SERVER_TAG.update:
      return {
        type: "update",
        docId: decoding.readVarString(dec),
        seq: decoding.readVarUint(dec),
        payload: readPayload(dec),
      };
    case SERVER_TAG.ack:
      return {
        type: "ack",
        docId: decoding.readVarString(dec),
        counter: decoding.readVarUint(dec),
        seq: decoding.readVarUint(dec),
      };
    case SERVER_TAG.snapshot:
      return {
        type: "snapshot",
        docId: decoding.readVarString(dec),
        uptoSeq: decoding.readVarUint(dec),
        payload: readPayload(dec),
      };
    case SERVER_TAG.snapshotAck:
      return { type: "snapshotAck", docId: decoding.readVarString(dec), uptoSeq: decoding.readVarUint(dec) };
    case SERVER_TAG.error:
      return { type: "error", code: decoding.readVarString(dec), message: decoding.readVarString(dec) };
    case SERVER_TAG.awareness:
      return { type: "awareness", docId: decoding.readVarString(dec), payload: readPayload(dec) };
    case SERVER_TAG.shareCreated:
      return { type: "shareCreated", reqId: decoding.readVarUint(dec), shareId: decoding.readVarString(dec) };
    case SERVER_TAG.shareCatalog: {
      const reqId = decoding.readVarUint(dec);
      const count = decoding.readVarUint(dec);
      const shares: ShareInfo[] = [];
      for (let i = 0; i < count; i++) {
        shares.push({
          shareId: decoding.readVarString(dec),
          docId: decoding.readVarString(dec),
          permission: permFromTag(decoding.readVarUint(dec)),
          revoked: decoding.readVarUint(dec) === 1,
        });
      }
      return { type: "shareCatalog", reqId, shares };
    }
    case SERVER_TAG.shareAuthOk:
      return {
        type: "shareAuthOk",
        docId: decoding.readVarString(dec),
        permission: permFromTag(decoding.readVarUint(dec)),
        headSeq: decoding.readVarUint(dec),
        snapshotSeq: decoding.readVarUint(dec),
      };
    case SERVER_TAG.envelopeList: {
      const reqId = decoding.readVarUint(dec);
      const count = decoding.readVarUint(dec);
      const envelopes: KeyEnvelope[] = [];
      for (let i = 0; i < count; i++) {
        envelopes.push({
          keyId: decoding.readVarString(dec),
          epoch: decoding.readVarUint(dec),
          blob: readPayload(dec),
        });
      }
      return { type: "envelopeList", reqId, envelopes };
    }
    case SERVER_TAG.memberCatalog: {
      const reqId = decoding.readVarUint(dec);
      const count = decoding.readVarUint(dec);
      const members: MemberInfo[] = [];
      for (let i = 0; i < count; i++) {
        members.push({
          memberId: decoding.readVarString(dec),
          pubSign: readPayload(dec),
          pubWrap: readPayload(dec),
          role: roleFromTag(decoding.readVarUint(dec)),
          approved: decoding.readVarUint(dec) === 1,
        });
      }
      return { type: "memberCatalog", reqId, members };
    }
    case SERVER_TAG.enrollCreated:
      return { type: "enrollCreated", reqId: decoding.readVarUint(dec), token: decoding.readVarString(dec) };
    case SERVER_TAG.ok:
      return { type: "ok", reqId: decoding.readVarUint(dec) };
    case SERVER_TAG.keyRotated:
      return { type: "keyRotated", epoch: decoding.readVarUint(dec) };
    default:
      throw new Error(`未知的 server 訊息類型:${tag}`);
  }
}

/** lib0 的 readVarUint8Array 回傳底層 view;複製一份並驗證長度,截斷的訊息在此拋錯 */
function readPayload(dec: decoding.Decoder): Uint8Array {
  const len = decoding.readVarUint(dec);
  if (dec.pos + len > dec.arr.length) throw new Error("訊息不完整");
  return new Uint8Array(decoding.readUint8Array(dec, len));
}
