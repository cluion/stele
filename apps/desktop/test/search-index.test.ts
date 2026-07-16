import { describe, it, expect } from "vitest";
import { SearchIndex } from "../src/main/search-index.ts";

function make(): SearchIndex {
  const index = new SearchIndex();
  index.update("羅馬/水道.md", "# 羅馬水道的重力課\n\n每公里 34 公分的坡度。\n");
  index.update("靈感箱.md", "# 靈感箱\n\n引用鐵律與其他想法。\n");
  index.update("english/notes.md", "# Meeting Notes\n\nDiscuss the aqueduct gradient design.\n");
  return index;
}

describe("SearchIndex", () => {
  it("中文詞查詢:相鄰字才命中,不誤報散落的單字", () => {
    const index = make();
    index.update("散落.md", "水很多,道路也很多,但沒有相鄰。\n");
    const files = index.search("水道").map((r) => r.file);
    expect(files).toContain("羅馬/水道.md");
    expect(files).not.toContain("散落.md");
  });

  it("中文單字查詢可命中", () => {
    expect(make().search("鐵").map((r) => r.file)).toContain("靈感箱.md");
  });

  it("英文查詢不分大小寫且支援前綴", () => {
    const files = make().search("aque").map((r) => r.file);
    expect(files).toContain("english/notes.md");
  });

  it("標題命中排序優於內文命中", () => {
    const index = new SearchIndex();
    index.update("標題命中.md", "# 水道\n\n別的內容。\n");
    index.update("內文命中.md", "# 別的標題\n\n水道出現在內文。\n");
    expect(index.search("水道")[0]!.file).toBe("標題命中.md");
  });

  it("更新內容後舊詞不再命中,新詞命中", () => {
    const index = make();
    index.update("靈感箱.md", "# 靈感箱\n\n完全換掉的內容。\n");
    expect(index.search("鐵律").map((r) => r.file)).not.toContain("靈感箱.md");
    expect(index.search("換掉").map((r) => r.file)).toContain("靈感箱.md");
  });

  it("移除檔案後不再出現;空查詢回空", () => {
    const index = make();
    index.remove("羅馬/水道.md");
    expect(index.search("水道")).toEqual([]);
    expect(index.search("  ")).toEqual([]);
    expect(() => index.remove("不存在.md")).not.toThrow();
  });

  it("檔名本身可被搜到", () => {
    expect(make().search("靈感箱").map((r) => r.file)).toContain("靈感箱.md");
  });
});
