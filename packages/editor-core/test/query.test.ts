import { describe, it, expect } from "vitest";
import { parseQuery, runQuery, type PageMetadata } from "../src/index.ts";

/**
 * 查詢視圖(對標 Dataview 的實用子集)。
 * 刻意只做 LIST / TABLE + FROM / WHERE / SORT / LIMIT——涵蓋日常九成用途,
 * 而且每一條都能明確說出行為。寧可語法少而準,不要半套地假裝相容整個 Dataview。
 */

const page = (path: string, over: Partial<PageMetadata> = {}): PageMetadata => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  tags: [],
  mtime: 0,
  fields: {},
  ...over,
});

const pages: PageMetadata[] = [
  page("專案/A.md", { tags: ["工作"], mtime: 300, fields: { status: "進行中", priority: 3 } }),
  page("專案/B.md", { tags: ["工作", "重要"], mtime: 200, fields: { status: "已完成", priority: 1 } }),
  page("讀書/C.md", { tags: ["讀書"], mtime: 100, fields: { status: "進行中" } }),
  page("散記.md", { mtime: 400 }),
];

const run = (q: string) => {
  const parsed = parseQuery(q);
  if ("error" in parsed) throw new Error(`解析失敗:${parsed.error}`);
  return runQuery(parsed, pages);
};
const paths = (q: string) => run(q).rows.map((r) => r.path);

describe("parseQuery", () => {
  it("最小查詢:只有 LIST", () => {
    expect(parseQuery("LIST")).toMatchObject({ kind: "list" });
  });

  it("關鍵字不分大小寫,多餘空白與換行都容忍", () => {
    expect(parseQuery("  list\n  from #工作\n  limit 2 ")).toMatchObject({ kind: "list", limit: 2 });
  });

  it("TABLE 欄位與 AS 別名", () => {
    const q = parseQuery("TABLE status, priority AS 優先度");
    expect(q).toMatchObject({ kind: "table" });
    if ("error" in q) throw new Error("不該解析失敗");
    expect(q.columns).toEqual([
      { field: "status", label: "status" },
      { field: "priority", label: "優先度" },
    ]);
  });

  it("空查詢與未知開頭給明確錯誤,不是靜默失敗", () => {
    expect(parseQuery("")).toMatchObject({ error: "查詢是空的;請以 LIST 或 TABLE 開頭" });
    const bad = parseQuery("SELECT * FROM notes");
    expect("error" in bad && bad.error).toContain("LIST 或 TABLE");
  });

  it("語法錯誤帶得出原因", () => {
    for (const q of ["LIST WHERE", "LIST LIMIT abc", "LIST SORT"]) {
      const out = parseQuery(q);
      expect("error" in out, `「${q}」應該解析失敗`).toBe(true);
      expect("error" in out && out.error.length).toBeGreaterThan(0);
    }
  });
});

describe("FROM", () => {
  it("依標籤", () => {
    expect(paths("LIST FROM #工作").sort()).toEqual(["專案/A.md", "專案/B.md"]);
  });

  it("依資料夾(含子資料夾)", () => {
    expect(paths('LIST FROM "專案"').sort()).toEqual(["專案/A.md", "專案/B.md"]);
  });

  it("AND / OR 組合", () => {
    expect(paths("LIST FROM #工作 AND #重要")).toEqual(["專案/B.md"]);
    expect(paths("LIST FROM #讀書 OR #重要").sort()).toEqual(["專案/B.md", "讀書/C.md"]);
  });

  it("否定", () => {
    expect(paths("LIST FROM -#工作").sort()).toEqual(["散記.md", "讀書/C.md"]);
  });

  it("沒有 FROM 就是全庫", () => {
    expect(paths("LIST")).toHaveLength(4);
  });
});

describe("WHERE", () => {
  it("字串等值與不等", () => {
    expect(paths('LIST WHERE status = "進行中"').sort()).toEqual(["專案/A.md", "讀書/C.md"]);
    expect(paths('LIST WHERE status != "進行中"')).toEqual(["專案/B.md"]);
  });

  it("數值比較", () => {
    expect(paths("LIST WHERE priority > 2")).toEqual(["專案/A.md"]);
    expect(paths("LIST WHERE priority <= 3").sort()).toEqual(["專案/A.md", "專案/B.md"]);
  });

  it("contains 子字串", () => {
    expect(paths('LIST WHERE file.path contains "專案"').sort()).toEqual(["專案/A.md", "專案/B.md"]);
  });

  it("單獨欄位名 = 該欄位存在且不是空值", () => {
    expect(paths("LIST WHERE priority").sort()).toEqual(["專案/A.md", "專案/B.md"]);
  });

  it("AND / OR", () => {
    expect(paths('LIST WHERE status = "進行中" AND priority > 2')).toEqual(["專案/A.md"]);
    expect(paths('LIST WHERE priority = 1 OR file.name = "C"').sort()).toEqual(["專案/B.md", "讀書/C.md"]);
  });

  it("缺欄位的頁面不會誤入結果(比較缺席欄位一律不成立)", () => {
    expect(paths("LIST WHERE priority > 0")).not.toContain("散記.md");
    expect(paths('LIST WHERE status != "進行中"')).not.toContain("散記.md");
  });

  it("隱含欄位:file.name / file.folder / file.tags", () => {
    expect(paths('LIST WHERE file.name = "散記"')).toEqual(["散記.md"]);
    expect(paths('LIST WHERE file.folder = "讀書"')).toEqual(["讀書/C.md"]);
    expect(paths('LIST WHERE file.tags contains "重要"')).toEqual(["專案/B.md"]);
  });
});

describe("SORT 與 LIMIT", () => {
  it("預設由新到舊(mtime 遞減),與筆記工具的直覺一致", () => {
    expect(paths("LIST")).toEqual(["散記.md", "專案/A.md", "專案/B.md", "讀書/C.md"]);
  });

  it("指定欄位排序,ASC/DESC", () => {
    // 字串排序走 localeCompare(跟隨系統慣例),所以只斷言同一書寫系統內的相對順序——
    // CJK 與拉丁誰在前取決於 locale,不該寫死在測試裡
    const byName = paths("LIST SORT file.name ASC");
    expect(byName.indexOf("專案/A.md")).toBeLessThan(byName.indexOf("專案/B.md"));
    expect(byName.indexOf("專案/B.md")).toBeLessThan(byName.indexOf("讀書/C.md"));
    expect(paths("LIST SORT file.name DESC").indexOf("讀書/C.md")).toBeLessThan(paths("LIST SORT file.name DESC").indexOf("專案/A.md"));
    // 數值排序沒有這個問題,可以完整斷言
    expect(paths("LIST SORT file.mtime ASC")).toEqual(["讀書/C.md", "專案/B.md", "專案/A.md", "散記.md"]);
  });

  it("缺欄位的排在最後,不會跑到最前面", () => {
    expect(paths("LIST SORT priority ASC").slice(-1)).toEqual(["散記.md"]);
  });

  it("LIMIT 截斷", () => {
    expect(paths("LIST LIMIT 2")).toHaveLength(2);
    expect(paths("LIST LIMIT 0")).toHaveLength(0);
  });
});

describe("TABLE 輸出", () => {
  it("欄位取值,缺值為 undefined", () => {
    const out = run('TABLE status, priority FROM "專案" SORT file.name ASC');
    expect(out.columns).toEqual(["status", "priority"]);
    expect(out.rows.map((r) => r.cells)).toEqual([
      ["進行中", 3],
      ["已完成", 1],
    ]);
  });

  it("LIST 沒有欄位,只有路徑", () => {
    const out = run("LIST LIMIT 1");
    expect(out.columns).toEqual([]);
    expect(out.rows[0]).toMatchObject({ path: "散記.md", name: "散記" });
  });

  it("空結果是正常結果,不是錯誤", () => {
    const out = run('LIST WHERE status = "不存在的狀態"');
    expect(out.rows).toEqual([]);
  });
});
