import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { splitBlocks, applyBlockEdits, parseDoc, parseBlock, serializeBlock, steleSchema } from "../src/index.ts";

const fixturesDir = fileURLToPath(new URL("../../../prototypes/mirror/fixtures/", import.meta.url));
const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: f, source: readFileSync(fixturesDir + f, "utf8") }));
const obsidianMd = fixtures.find((f) => f.name === "obsidian.md")!.source;

describe("parseDoc:區塊 ↔ PM 頂層子節點 1:1", () => {
  it("所有 fixture:doc.childCount 等於區塊數", () => {
    for (const { name, source } of fixtures) {
      const { doc, blocks } = parseDoc(source);
      expect(doc.childCount, name).toBe(blocks.length);
    }
  });
});

describe("opaque 原文節點:不支援的語法位元組不變", () => {
  const cases: Array<{ label: string; pick: (src: string) => number; src?: string }> = [
    { label: "frontmatter", pick: () => 0 },
    { label: "callout 引用塊", pick: (s) => splitBlocks(s).findIndex((b) => s.slice(b.from, b.to).startsWith("> [!note]")) },
  ];
  for (const { label, pick } of cases) {
    it(`${label} → stele_raw,序列化位元組一致`, () => {
      const blocks = splitBlocks(obsidianMd);
      const i = pick(obsidianMd);
      const text = obsidianMd.slice(blocks[i]!.from, blocks[i]!.to);
      const parsed = parseBlock(text, blocks[i]!.type);
      expect(parsed.node.type.name).toBe("stele_raw");
      expect(serializeBlock(parsed.node, parsed.gap)).toBe(text);
    });
  }

  it("GFM 表格 → stele_raw,序列化位元組一致", () => {
    const src = fixtures.find((f) => f.name === "gfm.md")!.source;
    const blocks = splitBlocks(src);
    const i = blocks.findIndex((b) => b.type === "table");
    expect(i).toBeGreaterThan(-1);
    const text = src.slice(blocks[i]!.from, blocks[i]!.to);
    const parsed = parseBlock(text, "table");
    expect(parsed.node.type.name).toBe("stele_raw");
    expect(serializeBlock(parsed.node, parsed.gap)).toBe(text);
  });
});

describe("支援的區塊:parse ↔ serialize", () => {
  it("純中文段落與 ATX 標題:位元組級往返", () => {
    for (const text of ["這是一個純文字段落,包含中文標點。\n\n", "## 二級標題\n\n", "最後一段沒有結尾空行"]) {
      const parsed = parseBlock(text, text.startsWith("#") ? "heading" : "paragraph");
      expect(parsed.node.type.name).not.toBe("stele_raw");
      expect(serializeBlock(parsed.node, parsed.gap)).toBe(text);
    }
  });

  it("粗體與行內碼的段落:語意保留", () => {
    const parsed = parseBlock("含 **粗體** 與 `code` 的段落。\n\n", "paragraph");
    expect(parsed.node.type.name).toBe("paragraph");
    const out = serializeBlock(parsed.node, parsed.gap);
    expect(out).toContain("**粗體**");
    expect(out).toContain("`code`");
  });
});

describe("整條編輯迴路:PM 節點 → 塊級寫回 Y.Text", () => {
  it("改一個段落節點,其他區塊位元組不動", () => {
    const doc = new Y.Doc();
    doc.getText("md").insert(0, obsidianMd);
    const { blocks } = parseDoc(obsidianMd);
    const target = blocks.findIndex((b) => obsidianMd.slice(b.from, b.to).includes("行內標籤"));

    const newNode = steleSchema.nodes.paragraph!.create(null, steleSchema.text("整段被 WYSIWYG 改寫"));
    const gap = "\n\n";
    applyBlockEdits(doc.getText("md"), blocks, [{ index: target, newText: serializeBlock(newNode, gap) }]);

    const after = doc.getText("md").toString();
    expect(after).toContain("整段被 WYSIWYG 改寫");
    const afterBlocks = splitBlocks(after);
    for (let i = 0; i < blocks.length; i++) {
      if (i === target) continue;
      expect(after.slice(afterBlocks[i]!.from, afterBlocks[i]!.to), `區塊 ${i}`).toBe(
        obsidianMd.slice(blocks[i]!.from, blocks[i]!.to),
      );
    }
  });
});
