import { describe, it, expect } from "vitest";
import { resolveWikilink } from "../src/index.ts";

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
