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

  it("doc 命名空間按 vault 隔離:同名 doc 互不相干", () => {
    const store = makeStore();
    store.appendUpdate("v1", "d1", "dev1", 1, bytes(1));
    expect(store.appendUpdate("v2", "d1", "dev1", 1, bytes(2))).toBe(1); // v2 自己的 d1,從 1 起算
    expect(store.updatesSince("v2", "d1", 0).map((u) => Array.from(u.payload))).toEqual([[2]]);
    expect(store.updatesSince("v1", "d1", 0).map((u) => Array.from(u.payload))).toEqual([[1]]);
    store.saveSnapshot("v2", "d1", 1, bytes(9));
    expect(store.snapshot("v1", "d1")).toBeUndefined(); // v1 看不到 v2 的快照
    expect(store.headSeqs("v1")).toEqual([{ docId: "d1", headSeq: 1, snapshotSeq: 0 }]);
  });

  it("沒有資料的 doc:updatesSince 空陣列、snapshot undefined", () => {
    const store = makeStore();
    expect(store.updatesSince("v1", "沒有", 0)).toEqual([]);
    expect(store.snapshot("v1", "沒有")).toBeUndefined();
    expect(store.headSeqs("v1")).toEqual([]);
  });

  it("enrollMember TOFU:首見入表、同公鑰更新、換公鑰 conflict、按 vault 隔離", () => {
    const store = makeStore();
    const sign1 = bytes(1, 1, 1);
    const wrap1 = bytes(2, 2, 2);
    expect(store.enrollMember("v1", "m1", sign1, wrap1)).toBe("ok");
    expect(store.enrollMember("v1", "m1", sign1, wrap1)).toBe("ok"); // 同公鑰再連,更新 last_seen
    expect(store.enrollMember("v1", "m1", bytes(9, 9, 9), wrap1)).toBe("conflict"); // 換 pubSign 被釘選擋下

    const rec = store.getMember("v1", "m1");
    expect(rec).toBeDefined();
    expect([...rec!.pubSign]).toEqual([1, 1, 1]); // conflict 不改原列
    expect([...rec!.pubWrap]).toEqual([2, 2, 2]);

    // 同 memberId 在別的 vault 是全新一列(複合鍵隔離),互不影響
    expect(store.enrollMember("v2", "m1", bytes(9, 9, 9), wrap1)).toBe("ok");
    expect([...store.getMember("v1", "m1")!.pubSign]).toEqual([1, 1, 1]); // v1 的 m1 不受 v2 影響
    expect([...store.getMember("v2", "m1")!.pubSign]).toEqual([9, 9, 9]);
    expect(store.listMembers("v1").map((m) => m.memberId)).toEqual(["m1"]);
    expect(store.listMembers("v2").map((m) => m.memberId)).toEqual(["m1"]);
  });
});
