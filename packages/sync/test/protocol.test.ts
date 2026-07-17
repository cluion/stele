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
