import { describe, it, expect } from "vitest";
import {
  encodeClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../src/index.ts";

const clientCases: ClientMessage[] = [
  { type: "auth", token: "祕密-token-1234567890", vaultId: "vault-uuid-1" },
  { type: "push", docId: "doc-1", deviceId: "dev-1", counter: 42, payload: new Uint8Array([0, 1, 255, 128]) },
  { type: "push", docId: "doc-1", deviceId: "dev-1", counter: 0, payload: new Uint8Array() },
  { type: "pull", docId: "doc-1", fromSeq: 0 },
  { type: "pull", docId: "中文檔名也是合法 id", fromSeq: 123456789 },
  { type: "snapshotPush", docId: "doc-2", uptoSeq: 7, payload: new Uint8Array(1024).fill(9) },
  { type: "snapshotPull", docId: "doc-2" },
  { type: "awareness", docId: "doc-1", payload: new Uint8Array([3, 1, 4, 1, 5]) },
  { type: "shareCreate", reqId: 1, docId: "doc-1", permission: "read" },
  { type: "shareCreate", reqId: 99, docId: "doc-2", permission: "write" },
  { type: "shareList", reqId: 2 },
  { type: "shareRevoke", reqId: 3, shareId: "AbC123xyz" },
  { type: "shareAuth", shareId: "AbC123xyz" },
  {
    type: "authId",
    token: "祕密-token-1234567890",
    vaultId: "vault-uuid-1",
    memberId: "a".repeat(64),
    pubSign: new Uint8Array(32).fill(11),
    pubWrap: new Uint8Array(32).fill(22),
    enrollmentToken: "",
  },
  {
    type: "authId",
    token: "祕密-token-1234567890",
    vaultId: "team-vault-2",
    memberId: "b".repeat(64),
    pubSign: new Uint8Array(32).fill(1),
    pubWrap: new Uint8Array(32).fill(2),
    enrollmentToken: "enroll-abc-一次性邀請碼",
  },
  { type: "authProof", signature: new Uint8Array(64).fill(7) },
  { type: "claimOwner", reqId: 5 },
  { type: "envelopePush", reqId: 6, keyId: "root", memberId: "c".repeat(64), epoch: 0, blob: new Uint8Array([1, 2, 3, 255]) },
  { type: "envelopePush", reqId: 7, keyId: "root", memberId: "d".repeat(64), epoch: 2, blob: new Uint8Array() },
  { type: "envelopePull", reqId: 8 },
  { type: "memberList", reqId: 9 },
  { type: "memberRemove", reqId: 10, memberId: "e".repeat(64) },
  { type: "enrollCreate", reqId: 11, ttlSec: 3600, role: "editor" },
  { type: "enrollCreate", reqId: 12, ttlSec: 60, role: "viewer" },
  { type: "memberSetRole", reqId: 13, memberId: "f".repeat(64), role: "viewer" },
  { type: "memberSetRole", reqId: 14, memberId: "a".repeat(64), role: "editor" },
];

const serverCases: ServerMessage[] = [
  { type: "authOk", docs: [] },
  {
    type: "authOk",
    docs: [
      { docId: "doc-1", headSeq: 5, snapshotSeq: 3 },
      { docId: "doc-2", headSeq: 0, snapshotSeq: 0 },
    ],
  },
  { type: "update", docId: "doc-1", seq: 6, payload: new Uint8Array([7, 7, 7]) },
  { type: "ack", docId: "doc-1", counter: 42, seq: 6 },
  { type: "snapshot", docId: "doc-2", uptoSeq: 7, payload: new Uint8Array([1]) },
  { type: "snapshot", docId: "沒有快照", uptoSeq: 0, payload: new Uint8Array() },
  { type: "snapshotAck", docId: "doc-2", uptoSeq: 7 },
  { type: "error", code: "bad-token", message: "token 錯誤" },
  { type: "awareness", docId: "doc-1", payload: new Uint8Array([9, 8, 7]) },
  { type: "shareCreated", reqId: 1, shareId: "AbC123xyz" },
  { type: "shareCatalog", reqId: 2, shares: [] },
  {
    type: "shareCatalog",
    reqId: 2,
    shares: [
      { shareId: "s1", docId: "doc-1", permission: "read", revoked: false },
      { shareId: "s2", docId: "doc-2", permission: "write", revoked: true },
    ],
  },
  { type: "shareAuthOk", docId: "doc-1", permission: "read", headSeq: 5, snapshotSeq: 3 },
  { type: "shareAuthOk", docId: "doc-2", permission: "write", headSeq: 0, snapshotSeq: 0 },
  { type: "authChallenge", nonce: new Uint8Array(32).fill(5) },
  { type: "envelopeList", reqId: 8, envelopes: [] },
  {
    type: "envelopeList",
    reqId: 8,
    envelopes: [
      { keyId: "root", epoch: 0, blob: new Uint8Array([9, 9, 9, 0, 255]) },
      { keyId: "root", epoch: 1, blob: new Uint8Array(200).fill(4) },
    ],
  },
  { type: "memberCatalog", reqId: 9, members: [] },
  {
    type: "memberCatalog",
    reqId: 9,
    members: [
      { memberId: "a".repeat(64), pubSign: new Uint8Array(32).fill(11), pubWrap: new Uint8Array(32).fill(22), role: "owner" },
      { memberId: "b".repeat(64), pubSign: new Uint8Array(32).fill(1), pubWrap: new Uint8Array(32).fill(2), role: "editor" },
    ],
  },
  { type: "enrollCreated", reqId: 11, token: "enroll-xyz-一次性" },
  { type: "ok", reqId: 6 },
];

describe("同步協議編解碼", () => {
  it.each(clientCases.map((m) => [m.type, m] as const))("client %s 往返不失真", (_type, msg) => {
    expect(decodeClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it.each(serverCases.map((m) => [m.type, m] as const))("server %s 往返不失真", (_type, msg) => {
    expect(decodeServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it("未知訊息類型拋錯而不是靜默", () => {
    expect(() => decodeClientMessage(new Uint8Array([200, 1]))).toThrow(/未知/);
    expect(() => decodeServerMessage(new Uint8Array([200, 1]))).toThrow(/未知/);
    expect(() => decodeClientMessage(new Uint8Array())).toThrow();
  });

  it("截斷的訊息拋錯", () => {
    const full = encodeClientMessage({
      type: "push",
      docId: "doc-1",
      deviceId: "dev-1",
      counter: 1,
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(() => decodeClientMessage(full.slice(0, full.length - 2))).toThrow();
  });
});
