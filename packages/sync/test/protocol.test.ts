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
  { type: "push", docId: "doc-1", deviceId: "dev-1", counter: 42, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([0, 1, 255, 128]) },
  { type: "push", docId: "doc-1", deviceId: "dev-1", counter: 0, epoch: 3, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array() },
  { type: "pull", docId: "doc-1", fromSeq: 0 },
  { type: "pull", docId: "中文檔名也是合法 id", fromSeq: 123456789 },
  { type: "snapshotPush", docId: "doc-2", uptoSeq: 7, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array(1024).fill(9) },
  { type: "snapshotPush", docId: "doc-2", uptoSeq: 9, epoch: 5, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) },
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
  { type: "rotateKey", reqId: 15, epoch: 1 },
  { type: "rotateKey", reqId: 16, epoch: 42 },
  { type: "credPush", reqId: 17, memberId: "b".repeat(64), blob: new Uint8Array(67).fill(3) },
  { type: "memberCertPush", reqId: 18, memberId: "c".repeat(64), blob: new Uint8Array(99).fill(5) },
  { type: "memberCertPull", reqId: 19 },
  { type: "policyPush", reqId: 20, requireSigned: true, blob: new Uint8Array(67).fill(8) },
  { type: "policyPush", reqId: 21, requireSigned: false, blob: new Uint8Array() },
  { type: "orgCertPush", reqId: 22, vaultId: "team-v", orgRootPubSign: new Uint8Array(32).fill(9), cert: new Uint8Array(101).fill(4) },
  { type: "authOrg", token: "祕密-token-1234567890", orgId: "d".repeat(64), adminPubSign: new Uint8Array(32).fill(3), adminCert: new Uint8Array() },
  { type: "authOrg", token: "祕密-token-1234567890", orgId: "e".repeat(64), adminPubSign: new Uint8Array(32).fill(4), adminCert: new Uint8Array(99).fill(2) },
  { type: "orgMemberCertPush", reqId: 23, memberId: "a".repeat(64), blob: new Uint8Array(120).fill(6) },
  { type: "orgMemberCertPull", reqId: 24 },
  { type: "orgVaultList", reqId: 25 },
  { type: "orgMemberList", reqId: 26, vaultId: "team-v" },
  { type: "orgRevoke", reqId: 31, memberId: "c".repeat(64) },
  { type: "orgPolicyPush", reqId: 32, requireSigned: true, blob: new Uint8Array(70).fill(3) },
  { type: "orgEventPull", reqId: 35, vaultId: "", limit: 100 },
  { type: "orgEventPull", reqId: 36, vaultId: "team-v", limit: 0 },
  { type: "orgEnrollCreate", reqId: 39, vaultIds: [], role: "viewer", ttlSec: 3600 },
  { type: "orgEnrollCreate", reqId: 40, vaultIds: ["t1", "t2", "t3"], role: "editor", ttlSec: 86400 },
];

const serverCases: ServerMessage[] = [
  { type: "authOk", docs: [], epoch: 0 },
  {
    type: "authOk",
    docs: [
      { docId: "doc-1", headSeq: 5, snapshotSeq: 3 },
      { docId: "doc-2", headSeq: 0, snapshotSeq: 0 },
    ],
    epoch: 2,
  },
  { type: "update", docId: "doc-1", seq: 6, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([7, 7, 7]) },
  { type: "ack", docId: "doc-1", counter: 42, seq: 6 },
  { type: "snapshot", docId: "doc-2", uptoSeq: 7, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) },
  { type: "snapshot", docId: "沒有快照", uptoSeq: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array() },
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
  { type: "envelopeList", reqId: 8, envelopes: [], roleCred: new Uint8Array(), restrictedSpaceIds: [], policy: new Uint8Array(), orgTeamCert: new Uint8Array(), orgPolicy: new Uint8Array(), rotationRequested: false },
  {
    type: "envelopeList",
    reqId: 8,
    envelopes: [
      { keyId: "root", epoch: 0, blob: new Uint8Array([9, 9, 9, 0, 255]) },
      { keyId: "root", epoch: 1, blob: new Uint8Array(200).fill(4) },
    ],
    roleCred: new Uint8Array(67).fill(6),
    restrictedSpaceIds: ["space-1", "space-2"],
    policy: new Uint8Array(68).fill(7),
    orgTeamCert: new Uint8Array(101).fill(4),
    orgPolicy: new Uint8Array(70).fill(3),
    rotationRequested: true,
  },
  { type: "memberCatalog", reqId: 9, members: [] },
  {
    type: "memberCatalog",
    reqId: 9,
    members: [
      { memberId: "a".repeat(64), pubSign: new Uint8Array(32).fill(11), pubWrap: new Uint8Array(32).fill(22), role: "owner", approved: true },
      { memberId: "b".repeat(64), pubSign: new Uint8Array(32).fill(1), pubWrap: new Uint8Array(32).fill(2), role: "editor", approved: false },
    ],
  },
  { type: "enrollCreated", reqId: 11, token: "enroll-xyz-一次性" },
  { type: "ok", reqId: 6 },
  { type: "keyRotated", epoch: 1 },
  { type: "keyRotated", epoch: 7 },
  { type: "memberCertList", reqId: 20, certs: [] },
  { type: "memberCertList", reqId: 21, certs: [new Uint8Array(99).fill(5), new Uint8Array(99).fill(9)] },
  { type: "orgAuthOk", orgId: "f".repeat(64) },
  { type: "orgMemberCertList", reqId: 27, entries: [] },
  {
    type: "orgMemberCertList",
    reqId: 28,
    entries: [
      { memberId: "a".repeat(64), blob: new Uint8Array(120).fill(6) },
      { memberId: "b".repeat(64), blob: new Uint8Array(88).fill(1) },
    ],
  },
  { type: "orgVaultCatalog", reqId: 29, vaults: [] },
  { type: "orgNotice", rotationRequested: true },
  { type: "orgNotice", rotationRequested: false },
  { type: "orgRevokeResult", reqId: 33, removed: [], skippedOwner: [] },
  { type: "orgRevokeResult", reqId: 34, removed: ["t1", "t2"], skippedOwner: ["t3"] },
  {
    type: "orgVaultCatalog",
    reqId: 30,
    vaults: [
      { vaultId: "t1", ownerMemberId: "a".repeat(64), memberCount: 3, serial: 2 },
      { vaultId: "t2", ownerMemberId: "b".repeat(64), memberCount: 1, serial: 0 },
    ],
  },
  { type: "orgEnrollTokens", reqId: 41, entries: [] },
  {
    type: "orgEnrollTokens",
    reqId: 42,
    entries: [
      { vaultId: "t1", token: "tok-1", ownerPubSign: new Uint8Array(32).fill(7) },
      { vaultId: "t2", token: "tok-2", ownerPubSign: new Uint8Array(32).fill(9) },
    ],
  },
  { type: "orgEventList", reqId: 37, events: [] },
  {
    type: "orgEventList",
    reqId: 38,
    events: [
      { id: 2, vaultId: "t1", ts: 1769000000, kind: "role-changed", actor: "a".repeat(64), target: "b".repeat(64), detail: "editor" },
      { id: 1, vaultId: "t1", ts: 1768999999, kind: "key-rotated", actor: "a".repeat(64), target: "", detail: "" },
    ],
  },
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
      epoch: 0,
      authorMemberId: "",
      sig: new Uint8Array(),
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(() => decodeClientMessage(full.slice(0, full.length - 2))).toThrow();
  });
});
