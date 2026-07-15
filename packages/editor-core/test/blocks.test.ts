import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitBlocks, findBlocksInRange } from "../src/index.ts";

const fixturesDir = fileURLToPath(new URL("../../../prototypes/mirror/fixtures/", import.meta.url));
const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: f, source: readFileSync(fixturesDir + f, "utf8") }));

describe("splitBlocks", () => {
  it("所有 fixture:區塊範圍連續且覆蓋全文(位元組級)", () => {
    for (const { name, source } of fixtures) {
      const blocks = splitBlocks(source);
      expect(blocks.length, name).toBeGreaterThan(0);
      expect(blocks[0]!.from, name).toBe(0);
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i]!.from, `${name} 區塊 ${i} 與前塊相接`).toBe(blocks[i - 1]!.to);
      }
      expect(blocks.at(-1)!.to, name).toBe(source.length);
      const rejoined = blocks.map((b) => source.slice(b.from, b.to)).join("");
      expect(rejoined, name).toBe(source);
    }
  });

  it("frontmatter 是單一區塊", () => {
    const source = readFileSync(fixturesDir + "obsidian.md", "utf8");
    const first = splitBlocks(source)[0]!;
    expect(source.slice(first.from, first.to)).toMatch(/^---\n[\s\S]*?\n---\n/);
    expect(first.type).toBe("yaml");
  });

  it("含空行的圍欄程式碼是單一區塊", () => {
    const source = "前段。\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n後段。\n";
    const blocks = splitBlocks(source);
    const code = blocks.find((b) => b.type === "code");
    expect(code).toBeDefined();
    expect(source.slice(code!.from, code!.to)).toContain("const a = 1;\n\nconst b = 2;");
    expect(blocks).toHaveLength(3);
  });

  it("callout 引用塊是單一區塊", () => {
    const source = "> [!note] 標題\n> 第一行\n> 第二行\n\n下一段。\n";
    const blocks = splitBlocks(source);
    expect(blocks[0]!.type).toBe("blockquote");
    expect(source.slice(blocks[0]!.from, blocks[0]!.to)).toContain("第二行");
  });

  it("空文件回傳單一空區塊", () => {
    expect(splitBlocks("")).toEqual([{ type: "empty", from: 0, to: 0 }]);
  });
});

describe("findBlocksInRange", () => {
  const source = "# 標題\n\n第一段。\n\n第二段。\n";
  const blocks = splitBlocks(source);

  it("單點變更命中所在區塊", () => {
    const hit = findBlocksInRange(blocks, source.indexOf("第一段"), source.indexOf("第一段") + 1);
    expect(hit).toEqual([1]);
  });

  it("跨區塊範圍命中多個區塊", () => {
    const hit = findBlocksInRange(blocks, 2, source.indexOf("第二段") + 1);
    expect(hit).toEqual([0, 1, 2]);
  });

  it("文末插入命中最後區塊", () => {
    expect(findBlocksInRange(blocks, source.length, source.length)).toEqual([blocks.length - 1]);
  });
});
