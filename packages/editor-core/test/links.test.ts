import { describe, it, expect } from "vitest";
import { extractWikilinks } from "../src/index.ts";

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
