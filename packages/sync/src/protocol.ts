import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * 同步協議 v1:二進位訊框,client 與伺服器共用
 * 伺服器是 blind relay,payload 一律視為不透明密文,協議層不認識 Yjs
 */

/** 分享權限:唯讀連線的 push 一律被伺服器拒絕,可編輯連線才准寫 */
export type SharePermission = "read" | "write";

export interface ShareInfo {
  shareId: string;
  docId: string;
  permission: SharePermission;
  revoked: boolean;
}

export type ClientMessage =
  | { type: "auth"; token: string; vaultId: string }
  | { type: "push"; docId: string; deviceId: string; counter: number; payload: Uint8Array }
  | { type: "pull"; docId: string; fromSeq: number }
  | { type: "snapshotPush"; docId: string; uptoSeq: number; payload: Uint8Array }
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
  | { type: "authOk"; docs: DocHead[] }
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
  | { type: "shareAuthOk"; docId: string; permission: SharePermission; headSeq: number; snapshotSeq: number };

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
} as const;

const PERM_TAG: Record<SharePermission, number> = { read: 0, write: 1 };
const permFromTag = (tag: number): SharePermission => (tag === 1 ? "write" : "read");

export function encodeClientMessage(msg: ClientMessage): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, CLIENT_TAG[msg.type]);
  switch (msg.type) {
    case "auth":
      encoding.writeVarString(enc, msg.token);
      encoding.writeVarString(enc, msg.vaultId);
      break;
    case "push":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarString(enc, msg.deviceId);
      encoding.writeVarUint(enc, msg.counter);
      encoding.writeVarUint8Array(enc, msg.payload);
      break;
    case "pull":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.fromSeq);
      break;
    case "snapshotPush":
      encoding.writeVarString(enc, msg.docId);
      encoding.writeVarUint(enc, msg.uptoSeq);
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
    case CLIENT_TAG.push:
      return {
        type: "push",
        docId: decoding.readVarString(dec),
        deviceId: decoding.readVarString(dec),
        counter: decoding.readVarUint(dec),
        payload: readPayload(dec),
      };
    case CLIENT_TAG.pull:
      return { type: "pull", docId: decoding.readVarString(dec), fromSeq: decoding.readVarUint(dec) };
    case CLIENT_TAG.snapshotPush:
      return {
        type: "snapshotPush",
        docId: decoding.readVarString(dec),
        uptoSeq: decoding.readVarUint(dec),
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
      return { type: "authOk", docs };
    }
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
