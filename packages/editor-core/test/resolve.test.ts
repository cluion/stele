import { describe, it, expect } from "vitest";
import { resolveWikilink, createWikilinkResolver } from "../src/index.ts";

const files = [
  "靈感箱.md",
  "日記/2026-07-15.md",
  "專案/Stele/立項.md",
  "專案/立項.md",
  "深層/巢/靈感箱.md",
];

describe("resolveWikilink", () => {
  it("完整相對路徑精確符合", () => {
    expect(resolveWikilink(files, "專案/Stele/立項")).toBe("專案/Stele/立項.md");
  });

  it("basename 符合時取路徑最短者", () => {
    expect(resolveWikilink(files, "立項")).toBe("專案/立項.md");
    expect(resolveWikilink(files, "靈感箱")).toBe("靈感箱.md");
  });

  it("剝除 #標題 與 #^塊參照 錨點", () => {
    expect(resolveWikilink(files, "立項#^rule-1")).toBe("專案/立項.md");
    expect(resolveWikilink(files, "靈感箱#某標題")).toBe("靈感箱.md");
  });

  it("basename 比對不分大小寫", () => {
    expect(resolveWikilink(["Notes/Inbox.md"], "inbox")).toBe("Notes/Inbox.md");
  });

  it("找不到回傳 undefined", () => {
    expect(resolveWikilink(files, "不存在的筆記")).toBeUndefined();
    expect(resolveWikilink(files, "附件/圖.png")).toBeUndefined();
    expect(resolveWikilink(files, "")).toBeUndefined();
    expect(resolveWikilink(files, "#只有錨點")).toBeUndefined();
  });
});

/**
 * 預建索引版:反向連結與關聯圖要對**全庫每一個 wikilink** 解析一次,
 * 逐次線性搜尋會變成 O(檔案數 × 連結數)——1000 篇實測 183ms,10000 篇會到十幾秒。
 * 語意必須與 resolveWikilink 完全一致,否則兩條路徑會對同一個連結給出不同答案。
 */
describe("createWikilinkResolver", () => {
  it("與 resolveWikilink 對各種目標給出相同結果", () => {
    const resolve = createWikilinkResolver(files);
    const targets = [
      "專案/Stele/立項",
      "立項",
      "靈感箱",
      "靈感箱.md",
      "深層/巢/靈感箱",
      "日記/2026-07-15",
      "不存在的筆記",
      "",
      "   ",
      "靈感箱#某段落",
      "立項#小節",
    ];
    for (const t of targets) {
      expect(resolve(t), `目標「${t}」兩種解析不一致`).toBe(resolveWikilink(files, t));
    }
  });

  it("空 vault 一律回 undefined", () => {
    const resolve = createWikilinkResolver([]);
    expect(resolve("任何東西")).toBeUndefined();
  });

  it("同名檔案取路徑最短者(與逐次解析同一條 tie-break 規則)", () => {
    const resolve = createWikilinkResolver(["深/巢/x.md", "x.md", "中/x.md"]);
    expect(resolve("x")).toBe("x.md");
  });
});