import { describe, it, expect } from "vitest";
import { extractWikilinks, rewriteWikilinks } from "../src/index.ts";

describe("extractWikilinks", () => {
  it("萃取一般連結、別名連結與嵌入,含所在行文字", () => {
    const src = "連到 [[筆記A]] 和 [[路徑/筆記B|別名]]。\n\n嵌入:![[圖.png]]\n";
    expect(extractWikilinks(src)).toEqual([
      { target: "筆記A", embed: false, line: "連到 [[筆記A]] 和 [[路徑/筆記B|別名]]。" },
      { target: "路徑/筆記B", embed: false, line: "連到 [[筆記A]] 和 [[路徑/筆記B|別名]]。" },
      { target: "圖.png", embed: true, line: "嵌入:![[圖.png]]" },
    ]);
  });

  it("跳過 code fence 與 frontmatter", () => {
    const src = "---\ntitle: 有 [[假連結]]\n---\n\n```\n[[碼裡的假連結]]\n```\n\n真的 [[連結]]。\n";
    const targets = extractWikilinks(src).map((r) => r.target);
    expect(targets).toEqual(["連結"]);
  });

  it("跳過行內 code", () => {
    const src = "行內 `[[假的]]` 但 [[真的]] 算。\n";
    expect(extractWikilinks(src).map((r) => r.target)).toEqual(["真的"]);
  });

  it("剝除別名但保留 #錨點於 target", () => {
    const src = "引用 ![[筆記#^block-1]]\n";
    expect(extractWikilinks(src)[0]).toMatchObject({ target: "筆記#^block-1", embed: true });
  });

  it("沒有連結回傳空陣列", () => {
    expect(extractWikilinks("# 只有標題\n\n普通段落。\n")).toEqual([]);
  });
});

describe("rewriteWikilinks", () => {
  const rename = (target: string) => {
    const [base, ...anchor] = target.split("#");
    if (base!.trim() !== "舊名") return null;
    return ["資料夾/新名", ...anchor].join("#");
  };

  it("改寫目標並保留別名、錨點與嵌入符號", () => {
    const src = "連 [[舊名]] 和 [[舊名|顯示字]] 和 ![[舊名#^b1]]。\n";
    expect(rewriteWikilinks(src, rename)).toBe(
      "連 [[資料夾/新名]] 和 [[資料夾/新名|顯示字]] 和 ![[資料夾/新名#^b1]]。\n",
    );
  });

  it("不相關的連結與純文字不動", () => {
    const src = "別的 [[其他筆記]] 與 [[舊名之外]] 不動。\n";
    expect(rewriteWikilinks(src, rename)).toBe(src);
  });

  it("code fence 與行內 code 裡的不改", () => {
    const src = "```\n[[舊名]]\n```\n\n行內 `[[舊名]]` 不改,但 [[舊名]] 要改。\n";
    expect(rewriteWikilinks(src, rename)).toBe(
      "```\n[[舊名]]\n```\n\n行內 `[[舊名]]` 不改,但 [[資料夾/新名]] 要改。\n",
    );
  });

  it("frontmatter 不改,全文其他位元組不動", () => {
    const src = "---\ntitle: 提到 [[舊名]]\n---\n\n內文 [[舊名]]。\n";
    const out = rewriteWikilinks(src, rename);
    expect(out).toContain("title: 提到 [[舊名]]");
    expect(out).toContain("內文 [[資料夾/新名]]。");
  });

  it("沒有任何改動時回傳原字串", () => {
    const src = "# 標題\n\n沒連結。\n";
    expect(rewriteWikilinks(src, () => null)).toBe(src);
  });
});
