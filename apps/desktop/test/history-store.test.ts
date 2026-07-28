import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore, thinVersions, MIN_GAP_MS, MAX_VERSIONS_PER_DOC } from "../src/main/history-store.ts";

/**
 * 筆記版本回溯的儲存層。版本存**純 Markdown 快照**而非 CRDT 二進位:
 * 使用者用檔案總管就能翻歷史,即使 Stele 不在了也讀得懂——這是 local-first 的承諾,
 * 也是為什麼不走 Yjs 快照(那需要關掉 gc,既有筆記的歷史早已被回收,且會無限膨脹)。
 */

const DOC = "5f8e0000-0000-4000-8000-00000000aaaa";
const dirs: string[] = [];
const makeStore = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stele-hist-"));
  dirs.push(root);
  return new HistoryStore(root);
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("版本稀釋", () => {
  // 近期密集、久遠稀疏:使用者要的是「上週那版」,不是上週的每一次存檔
  it("一小時內的版本全部保留", () => {
    const now = 1_800_000_000_000;
    const ts = [now - 5 * 60_000, now - 30 * 60_000, now - 59 * 60_000];
    expect(thinVersions(ts, now)).toEqual([]);
  });

  it("一小時到一天:每小時只留最新的一個", () => {
    const now = 1_800_000_000_000;
    const base = now - 5 * HOUR;
    const ts = [base, base + 60_000, base + 120_000]; // 同一小時內三個
    const drop = thinVersions(ts, now);
    expect(drop).toHaveLength(2);
    expect(drop).not.toContain(base + 120_000); // 留最新那個
  });

  it("一天以上:每天只留最新的一個", () => {
    const now = 1_800_000_000_000;
    const base = now - 5 * DAY;
    const ts = [base, base + HOUR, base + 2 * HOUR];
    const drop = thinVersions(ts, now);
    expect(drop).toHaveLength(2);
    expect(drop).not.toContain(base + 2 * HOUR);
  });

  it("超過硬上限時從最舊的開始刪(即使分層規則想留)", () => {
    const now = 1_800_000_000_000;
    // 全部落在一小時內 → 分層規則一個都不刪,但數量超過上限
    const ts = Array.from({ length: MAX_VERSIONS_PER_DOC + 10 }, (_, i) => now - i * 1000);
    const drop = thinVersions(ts, now);
    expect(drop).toHaveLength(10);
    expect(drop).toContain(now - (MAX_VERSIONS_PER_DOC + 9) * 1000); // 最舊的被刪
    expect(drop).not.toContain(now); // 最新的留著
  });

  it("空清單不炸", () => {
    expect(thinVersions([], Date.now())).toEqual([]);
  });
});

describe("HistoryStore", () => {
  it("record 寫入版本,list 由新到舊,read 取回原文", () => {
    const store = makeStore();
    const t0 = 1_800_000_000_000;
    expect(store.record(DOC, "第一版", t0)).toBe(true);
    expect(store.record(DOC, "第二版", t0 + MIN_GAP_MS + 1000)).toBe(true);

    const list = store.list(DOC);
    expect(list).toHaveLength(2);
    expect(list[0]!.ts).toBeGreaterThan(list[1]!.ts); // 新到舊
    expect(store.read(DOC, list[0]!.ts)).toBe("第二版");
    expect(store.read(DOC, list[1]!.ts)).toBe("第一版");
  });

  it("內容沒變就不記(不因為存檔節奏產生一堆一模一樣的版本)", () => {
    const store = makeStore();
    const t0 = 1_800_000_000_000;
    store.record(DOC, "一樣的內容", t0);
    expect(store.record(DOC, "一樣的內容", t0 + MIN_GAP_MS + 1000)).toBe(false);
    expect(store.list(DOC)).toHaveLength(1);
  });

  it("距上次太近就不記,除非明確要求(關檔時要捕捉最後狀態)", () => {
    const store = makeStore();
    const t0 = 1_800_000_000_000;
    store.record(DOC, "第一版", t0);
    expect(store.record(DOC, "改了", t0 + 1000)).toBe(false); // 才過 1 秒
    expect(store.list(DOC)).toHaveLength(1);
    expect(store.record(DOC, "改了", t0 + 2000, true)).toBe(true); // force
    expect(store.list(DOC)).toHaveLength(2);
  });

  it("空內容不記(剛建立的空筆記不值得一個版本)", () => {
    const store = makeStore();
    expect(store.record(DOC, "   \n  ", 1_800_000_000_000)).toBe(false);
    expect(store.list(DOC)).toHaveLength(0);
  });

  it("寫入時順帶稀釋:老舊的密集版本會被收斂", () => {
    const store = makeStore();
    const now = 1_800_000_000_000;
    const old = now - 5 * DAY;
    // 同一天內塞三個(每次都 force,繞過節流)
    store.record(DOC, "舊 A", old, true);
    store.record(DOC, "舊 B", old + HOUR, true);
    store.record(DOC, "舊 C", old + 2 * HOUR, true);
    expect(store.list(DOC)).toHaveLength(3);
    // 寫一個「現在」的版本 → 觸發稀釋,那一天只該留最新的「舊 C」
    store.record(DOC, "新的", now, true);
    const kept = store.list(DOC).map((v) => store.read(DOC, v.ts));
    expect(kept).toContain("新的");
    expect(kept).toContain("舊 C");
    expect(kept).not.toContain("舊 A");
    expect(kept).not.toContain("舊 B");
  });

  it("檔名是可排序、人看得懂的時間戳(檔案總管裡也能自己翻)", () => {
    const store = makeStore();
    store.record(DOC, "內容", Date.UTC(2026, 6, 28, 15, 30, 45));
    const files = readdirSync(path.join(store.dirFor(DOC)));
    expect(files).toEqual(["20260728T153045Z.md"]);
  });

  it("未知 doc 或未知時間戳:回空與 undefined,不拋", () => {
    const store = makeStore();
    expect(store.list("沒這個 doc")).toEqual([]);
    expect(store.read(DOC, 123)).toBeUndefined();
  });

  it("docId 非法時一律拒絕(它會組進檔案路徑)", () => {
    const store = makeStore();
    expect(() => store.record("../../etc/passwd", "x", Date.now(), true)).toThrow();
    expect(store.list("../../etc")).toEqual([]);
  });

  it("remove 清掉某篇筆記的全部歷史", () => {
    const store = makeStore();
    store.record(DOC, "內容", 1_800_000_000_000);
    expect(store.list(DOC)).toHaveLength(1);
    store.remove(DOC);
    expect(store.list(DOC)).toHaveLength(0);
  });
});
