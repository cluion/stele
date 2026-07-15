import { describe, it, expect } from "vitest";
import { fuzzyScore, rankFiles } from "../src/index.ts";

const files = [
  "靈感箱.md",
  "日記/2026-07-15.md",
  "專案/Stele/立項.md",
  "專案/立項.md",
  "深層/巢/靈感箱.md",
];

describe("fuzzyScore", () => {
  it("有序子序列符合回傳分數", () => {
    expect(fuzzyScore("日記", "日記/2026-07-15")).not.toBeNull();
    expect(fuzzyScore("立項", "專案/Stele/立項")).not.toBeNull();
  });

  it("非子序列回傳 null", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
    expect(fuzzyScore("記日", "日記")).toBeNull(); // 順序顛倒不算
    expect(fuzzyScore("日記記", "日記")).toBeNull(); // query 比 candidate 長
  });

  it("空 query 視為全符合，回傳 0", () => {
    expect(fuzzyScore("", "任何路徑")).toBe(0);
  });

  it("latin 字元不分大小寫", () => {
    expect(fuzzyScore("inbox", "Notes/Inbox")).not.toBeNull();
    expect(fuzzyScore("INBOX", "notes/inbox")).not.toBeNull();
  });

  it("連續符合分數高於分散符合", () => {
    const consecutive = fuzzyScore("立項", "專案/立項")!;
    const scattered = fuzzyScore("立項", "立志的項目")!;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("surrogate pair（emoji）不拆半、可符合", () => {
    expect(fuzzyScore("💡", "靈感💡箱")).not.toBeNull();
    expect(fuzzyScore("💡", "靈感箱")).toBeNull();
    // 💡 = U+1F4A1 = 💡;單看低半 surrogate 不得誤中
    expect(fuzzyScore("\uDCA1", "靈感💡箱")).toBeNull();
  });
});

describe("rankFiles", () => {
  it("CJK 查詢:同分時短路徑優先", () => {
    expect(rankFiles(files, "立項")).toEqual(["專案/立項.md", "專案/Stele/立項.md"]);
  });

  it("basename 命中排在路徑段命中之前", () => {
    const ranked = rankFiles(["立項/會議.md", "專案/立項.md"], "立項");
    expect(ranked).toEqual(["專案/立項.md", "立項/會議.md"]);
  });

  it("比對時忽略 .md 副檔名", () => {
    // 若把 .md 算進 candidate,「靈感箱m」會意外符合;正確行為是不符合
    expect(rankFiles(files, "靈感箱m")).toEqual([]);
    expect(rankFiles(files, "靈感箱")).toContain("靈感箱.md");
  });

  it("不符合的檔案被濾掉", () => {
    expect(rankFiles(files, "zzz不存在")).toEqual([]);
  });

  it("空查詢回傳原序前 limit 個", () => {
    expect(rankFiles(files, "")).toEqual(files);
    expect(rankFiles(files, "  ")).toEqual(files);
    expect(rankFiles(files, "", 2)).toEqual(files.slice(0, 2));
  });

  it("limit 限制結果數", () => {
    const many = ["a/靈.md", "b/靈.md", "c/靈.md"];
    expect(rankFiles(many, "靈", 2)).toHaveLength(2);
  });

  it("回傳的是含 .md 的原始路徑", () => {
    expect(rankFiles(files, "日記")).toEqual(["日記/2026-07-15.md"]);
  });
});
