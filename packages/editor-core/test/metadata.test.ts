import { describe, it, expect } from "vitest";
import { parseFrontmatter, extractTags, pageMetadata } from "../src/index.ts";

/**
 * 查詢視圖的資料層:把一篇筆記讀成「可查詢的欄位」。
 * frontmatter 走真正的 YAML(使用者的 frontmatter 會有清單、巢狀、引號,自己刻必然在奇怪的地方出錯);
 * tag 的萃取規則比照 wikilink——**不碰 code fence、行內 code 與 frontmatter 內文**。
 */

describe("parseFrontmatter", () => {
  it("解析出欄位與型別(字串/數字/布林/日期/清單)", () => {
    const md = ["---", "title: 我的筆記", "count: 42", "done: true", "tags:", "  - 工作", "  - 重要", "---", "", "內文"].join("\n");
    expect(parseFrontmatter(md)).toEqual({ title: "我的筆記", count: 42, done: true, tags: ["工作", "重要"] });
  });

  it("沒有 frontmatter 回空物件", () => {
    expect(parseFrontmatter("# 標題\n\n內文\n")).toEqual({});
  });

  it("frontmatter 必須在檔案最前面(中間出現的 --- 不算)", () => {
    expect(parseFrontmatter("內文\n\n---\ntitle: 不算\n---\n")).toEqual({});
  });

  it("YAML 壞掉時回空物件,不拋(一篇筆記寫壞不該讓整個查詢炸掉)", () => {
    expect(parseFrontmatter("---\ntitle: [未收尾\n---\n內文")).toEqual({});
  });

  it("非物件的 YAML(純量、陣列)一律視為沒有欄位", () => {
    expect(parseFrontmatter("---\n- 只是一個清單\n---\n")).toEqual({});
    expect(parseFrontmatter("---\n就一個字串\n---\n")).toEqual({});
  });

  it("空 frontmatter 回空物件", () => {
    expect(parseFrontmatter("---\n---\n內文")).toEqual({});
  });
});

describe("extractTags", () => {
  it("抓出內文的 #tag,去重且保留原大小寫", () => {
    expect(extractTags("今天讀了 #讀書 與 #專案/Stele,還有 #讀書")).toEqual(["讀書", "專案/Stele"]);
  });

  it("frontmatter 的 tags 欄位也算(兩種寫法並存是常態)", () => {
    const md = ["---", "tags: [工作, 會議]", "---", "", "內文有 #靈感"].join("\n");
    expect(extractTags(md).sort()).toEqual(["工作", "會議", "靈感"].sort());
  });

  it("不碰 code fence 與行內 code 裡的 #", () => {
    const md = ["內文 #真標籤", "", "```sh", "# 這是註解不是標籤", "echo '#也不是'", "```", "", "行內 `#也不算` 結束"].join("\n");
    expect(extractTags(md)).toEqual(["真標籤"]);
  });

  it("標題的 # 不是標籤", () => {
    expect(extractTags("# 標題\n\n## 小節\n\n內文 #標籤")).toEqual(["標籤"]);
  });

  it("純數字與空的 # 不算標籤(#1 通常是議題編號)", () => {
    expect(extractTags("修好了 #123 與 # 還有 #正常")).toEqual(["正常"]);
  });
});

describe("pageMetadata", () => {
  it("組出可查詢的一頁:隱含欄位 + frontmatter 欄位 + 標籤", () => {
    const md = ["---", "status: 進行中", "priority: 3", "---", "", "# 專案 A", "", "內容 #工作"].join("\n");
    const page = pageMetadata("專案/A.md", md, 1_800_000_000_000);
    expect(page.path).toBe("專案/A.md");
    expect(page.name).toBe("A");
    expect(page.folder).toBe("專案");
    expect(page.tags).toEqual(["工作"]);
    expect(page.mtime).toBe(1_800_000_000_000);
    expect(page.fields["status"]).toBe("進行中");
    expect(page.fields["priority"]).toBe(3);
  });

  it("根目錄筆記的 folder 是空字串", () => {
    expect(pageMetadata("散記.md", "內容", 0).folder).toBe("");
  });
});
