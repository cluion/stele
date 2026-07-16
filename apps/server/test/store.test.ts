import { describe, it, expect } from "vitest";
import { SyncStore } from "../src/store.ts";

const bytes = (...v: number[]) => new Uint8Array(v);

function makeStore(): SyncStore {
  return new SyncStore(":memory:");
}

describe("SyncStore", () => {
  it("appendUpdate 依 doc 遞增配發 seq,內容位元組不失真", () => {
    const store = makeStore();
    expect(store.appendUpdate("v1", "d1", "dev1", 1, bytes(1, 255))).toBe(1);
    expect(store.appendUpdate("v1", "d1", "dev1", 2, bytes(2))).toBe(2);
    expect(store.appendUpdate("v1", "d2", "dev1", 3, bytes(3))).toBe(1);
    const updates = store.updatesSince("v1", "d1", 0);
    expect(updates.map((u) => u.seq)).toEqual([1, 2]);
    expect(Array.from(updates[0]!.payload)).toEqual([1, 255]);
  });

  it("同一 device+counter 重送回傳既有 seq,不重複入庫", () => {
    const store = makeStore();
    const seq = store.appendUpdate("v1", "d1", "dev1", 7, bytes(1));
    expect(store.appendUpdate("v1", "d1", "dev1", 7, bytes(1))).toBe(seq);
    expect(store.updatesSince("v1", "d1", 0)).toHaveLength(1);
  });

  it("updatesSince 只回傳 fromSeq 之後的增量", () => {
    const store = makeStore();
    for (let i = 1; i <= 5; i++) store.appendUpdate("v1", "d1", "dev1", i, bytes(i));
    expect(store.updatesSince("v1", "d1", 3).map((u) => u.seq)).toEqual([4, 5]);
  });

  it("saveSnapshot 截斷涵蓋的增量,之後的 seq 接續不回捲", () => {
    const store = makeStore();
    for (let i = 1; i <= 4; i++) store.appendUpdate("v1", "d1", "dev1", i, bytes(i));
    store.saveSnapshot("v1", "d1", 3, bytes(99));
    expect(store.updatesSince("v1", "d1", 0).map((u) => u.seq)).toEqual([4]);
    expect(store.appendUpdate("v1", "d1", "dev1", 5, bytes(5))).toBe(5);
    const snap = store.snapshot("v1", "d1");
    expect(snap?.uptoSeq).toBe(3);
    expect(snap && Array.from(snap.payload)).toEqual([99]);
  });

  it("全部增量都被快照涵蓋後,seq 仍從快照點接續", () => {
    const store = makeStore();
    store.appendUpdate("v1", "d1", "dev1", 1, bytes(1));
    store.appendUpdate("v1", "d1", "dev1", 2, bytes(2));
    store.saveSnapshot("v1", "d1", 2, bytes(9));
    expect(store.appendUpdate("v1", "d1", "dev1", 3, bytes(3))).toBe(3);
  });

  it("舊快照不覆蓋新快照", () => {
    const store = makeStore();
    for (let i = 1; i <= 3; i++) store.appendUpdate("v1", "d1", "dev1", i, bytes(i));
    store.saveSnapshot("v1", "d1", 3, bytes(3));
    store.saveSnapshot("v1", "d1", 2, bytes(2));
    expect(store.snapshot("v1", "d1")?.uptoSeq).toBe(3);
  });

  it("headSeqs 列出 vault 內所有 doc 的最新 seq 與快照點", () => {
    const store = makeStore();
    store.appendUpdate("v1", "d1", "dev1", 1, bytes(1));
    store.appendUpdate("v1", "d1", "dev1", 2, bytes(2));
    store.appendUpdate("v1", "d2", "dev1", 3, bytes(3));
    store.appendUpdate("v2", "其他 vault", "dev1", 4, bytes(4));
    store.saveSnapshot("v1", "d1", 2, bytes(9));
    expect(store.headSeqs("v1")).toEqual([
      { docId: "d1", headSeq: 2, snapshotSeq: 2 },
      { docId: "d2", headSeq: 1, snapshotSeq: 0 },
    ]);
  });

  it("doc 隸屬 vault:跨 vault 存取同一 doc id 被拒", () => {
    const store = makeStore();
    store.appendUpdate("v1", "d1", "dev1", 1, bytes(1));
    expect(() => store.appendUpdate("v2", "d1", "dev1", 2, bytes(2))).toThrow(/vault/);
    expect(store.updatesSince("v2", "d1", 0)).toEqual([]);
    expect(store.snapshot("v2", "d1")).toBeUndefined();
    expect(() => store.saveSnapshot("v2", "d1", 1, bytes(1))).toThrow(/vault/);
  });

  it("沒有資料的 doc:updatesSince 空陣列、snapshot undefined", () => {
    const store = makeStore();
    expect(store.updatesSince("v1", "沒有", 0)).toEqual([]);
    expect(store.snapshot("v1", "沒有")).toBeUndefined();
    expect(store.headSeqs("v1")).toEqual([]);
  });
});
