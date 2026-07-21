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

  // 註:server 層 H1 綁定 memberId==sha256(pubSign) 後,「同 memberId 換 pubSign」在正常協議不可達;
  // 此處直測 store 的 conflict 分支,是萬一綁定被繞過的防禦深度保險。
  it("enrollMember TOFU:首見入表、同公鑰更新、換公鑰 conflict、按 vault 隔離", () => {
    const store = makeStore();
    const sign1 = bytes(1, 1, 1);
    const wrap1 = bytes(2, 2, 2);
    expect(store.enrollMember("v1", "m1", sign1, wrap1, "viewer")).toBe("ok");
    expect(store.enrollMember("v1", "m1", sign1, wrap1, "viewer")).toBe("ok"); // 同公鑰再連,更新 last_seen
    expect(store.enrollMember("v1", "m1", bytes(9, 9, 9), wrap1, "viewer")).toBe("conflict"); // 換 pubSign 被釘選擋下

    const rec = store.getMember("v1", "m1");
    expect(rec).toBeDefined();
    expect([...rec!.pubSign]).toEqual([1, 1, 1]); // conflict 不改原列
    expect([...rec!.pubWrap]).toEqual([2, 2, 2]);

    // 同 memberId 在別的 vault 是全新一列(複合鍵隔離),互不影響
    expect(store.enrollMember("v2", "m1", bytes(9, 9, 9), wrap1, "viewer")).toBe("ok");
    expect([...store.getMember("v1", "m1")!.pubSign]).toEqual([1, 1, 1]); // v1 的 m1 不受 v2 影響
    expect([...store.getMember("v2", "m1")!.pubSign]).toEqual([9, 9, 9]);
    expect(store.listMembers("v1").map((m) => m.memberId)).toEqual(["m1"]);
    expect(store.listMembers("v2").map((m) => m.memberId)).toEqual(["m1"]);
  });

  it("claimOwner TOFU:首位認領釘選,後續認領回既有 owner 不覆蓋;ownerOf 反映狀態", () => {
    const store = makeStore();
    expect(store.ownerOf("team1")).toBeUndefined(); // 未認領 = 非 team vault
    expect(store.claimOwner("team1", "owner-A")).toBe("owner-A");
    expect(store.claimOwner("team1", "usurper-B")).toBe("owner-A"); // 不覆蓋
    expect(store.ownerOf("team1")).toBe("owner-A");
    expect(store.ownerOf("team2")).toBeUndefined(); // 按 vault 隔離
  });

  it("putEnvelope upsert 冪等 + envelopesFor 只回自己、每 keyId 取最新 epoch", () => {
    const store = makeStore();
    store.putEnvelope("t", "root", "mA", 0, bytes(1, 1));
    store.putEnvelope("t", "root", "mB", 0, bytes(2, 2));
    // 同鍵重 push 覆蓋(冪等)
    store.putEnvelope("t", "root", "mA", 0, bytes(9, 9));
    // 輪換:同 key 較高 epoch 並存,envelopesFor 取最新
    store.putEnvelope("t", "root", "mA", 1, bytes(7, 7));

    const a = store.envelopesFor("t", "mA");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ keyId: "root", epoch: 1 });
    expect([...a[0]!.blob]).toEqual([7, 7]);
    // 只回自己:A 拉不到 B
    expect(store.envelopesFor("t", "mB").map((e) => [...e.blob])).toEqual([[2, 2]]);
    expect(store.envelopesFor("t", "nobody")).toEqual([]);
  });

  it("removeMember 刪 member 列 + 其信封,不動他人", () => {
    const store = makeStore();
    store.enrollMember("t", "mA", bytes(1), bytes(1), "editor");
    store.enrollMember("t", "mB", bytes(2), bytes(2), "viewer");
    store.putEnvelope("t", "root", "mA", 0, bytes(1));
    store.putEnvelope("t", "root", "mB", 0, bytes(2));
    store.removeMember("t", "mA");
    expect(store.getMember("t", "mA")).toBeUndefined();
    expect(store.envelopesFor("t", "mA")).toEqual([]);
    expect(store.getMember("t", "mB")).toBeDefined();
    expect(store.envelopesFor("t", "mB")).toHaveLength(1);
  });

  it("enrollment token:單次、綁 vault、過期各自失效,消耗回其角色", () => {
    const store = makeStore();
    const future = Math.floor(Date.now() / 1000) + 3600;
    store.createEnrollmentToken("tok-1", "team1", "editor", future);
    // 跨 vault 不認
    expect(store.consumeEnrollmentToken("tok-1", "team2")).toBeUndefined();
    // 正確 vault:第一次成功,回該碼指定角色
    expect(store.consumeEnrollmentToken("tok-1", "team1")).toBe("editor");
    // 單次:第二次失敗
    expect(store.consumeEnrollmentToken("tok-1", "team1")).toBeUndefined();
    // 不存在的 token
    expect(store.consumeEnrollmentToken("nope", "team1")).toBeUndefined();
    // 已過期
    store.createEnrollmentToken("tok-2", "team1", "viewer", Math.floor(Date.now() / 1000) - 1);
    expect(store.consumeEnrollmentToken("tok-2", "team1")).toBeUndefined();
  });

  it("角色:claimOwner 升 owner、enroll 帶角色、setRole 改角色、roleOf 查詢", () => {
    const store = makeStore();
    // 創建者 enroll 時預設 viewer,claimOwner 升 owner
    store.enrollMember("t", "owner", bytes(1), bytes(1), "viewer");
    expect(store.roleOf("t", "owner")).toBe("viewer");
    store.claimOwner("t", "owner");
    expect(store.roleOf("t", "owner")).toBe("owner");
    // 邀請碼帶角色 → enroll 套用
    store.enrollMember("t", "ed", bytes(2), bytes(2), "editor");
    expect(store.roleOf("t", "ed")).toBe("editor");
    // 既有成員再 enroll 不改角色(改角色走 setRole)
    store.enrollMember("t", "ed", bytes(2), bytes(2), "viewer");
    expect(store.roleOf("t", "ed")).toBe("editor");
    // setRole 降級
    expect(store.setRole("t", "ed", "viewer")).toBe(true);
    expect(store.roleOf("t", "ed")).toBe("viewer");
    expect(store.getMember("t", "ed")!.role).toBe("viewer");
    // setRole 查無成員
    expect(store.setRole("t", "nobody", "editor")).toBe(false);
    expect(store.roleOf("t", "nobody")).toBeUndefined();
    // listMembers 帶角色
    expect(store.listMembers("t").find((m) => m.memberId === "owner")!.role).toBe("owner");
  });
});
