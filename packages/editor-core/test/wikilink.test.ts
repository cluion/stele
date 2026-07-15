import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { parseBlock, serializeBlock, splitBlocks, SteleBinding } from "../src/index.ts";

const fixturesDir = fileURLToPath(new URL("../../../prototypes/mirror/fixtures/", import.meta.url));
const obsidianMd = readFileSync(fixturesDir + "obsidian.md", "utf8");

function firstInlineOfType(node: import("prosemirror-model").Node, type: string) {
  let found: import("prosemirror-model").Node | undefined;
  node.descendants((n) => {
    if (!found && n.type.name === type) found = n;
    return !found;
  });
  return found;
}

describe("wikilink 解析", () => {
  it("[[目標]] 解析為 wikilink 節點", () => {
    const { node } = parseBlock("連到 [[另一篇筆記]] 收尾。\n\n", "paragraph");
    const link = firstInlineOfType(node, "wikilink");
    expect(link).toBeDefined();
    expect(link!.attrs["target"]).toBe("另一篇筆記");
    expect(link!.attrs["alias"]).toBeNull();
    expect(link!.attrs["embed"]).toBe(false);
  });

  it("[[目標|別名]] 與 ![[嵌入]] 的屬性正確", () => {
    const { node } = parseBlock("看 [[資料夾/筆記|顯示別名]] 和 ![[附件/圖.png]]\n\n", "paragraph");
    const links: Array<Record<string, unknown>> = [];
    node.descendants((n) => {
      if (n.type.name === "wikilink") links.push(n.attrs);
      return true;
    });
    expect(links).toEqual([
      { target: "資料夾/筆記", alias: "顯示別名", embed: false },
      { target: "附件/圖.png", alias: null, embed: true },
    ]);
  });

  it("未閉合的 [[ 不誤判,維持純文字", () => {
    const { node } = parseBlock("只有 [[ 沒關起來\n\n", "paragraph");
    expect(firstInlineOfType(node, "wikilink")).toBeUndefined();
  });
});

describe("wikilink 序列化:位元組級往返", () => {
  const cases = [
    "連到 [[另一篇筆記]] 和 [[資料夾/筆記|顯示別名]]。\n\n",
    "嵌入筆記:![[被嵌入的筆記]]\n\n",
    "引用塊參照:![[另一篇筆記#^block-id-123]]\n\n",
    "開頭 [[連結]] 中間 **粗體** 結尾。\n",
  ];
  for (const text of cases) {
    it(JSON.stringify(text.slice(0, 18)) + "…", () => {
      const parsed = parseBlock(text, "paragraph");
      expect(parsed.node.type.name).toBe("paragraph");
      expect(serializeBlock(parsed.node, parsed.gap)).toBe(text);
    });
  }
});

describe("wikilink 在編輯迴路中不受損", () => {
  it("編輯含 wikilink 的段落,連結語法位元組不變", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("md");
    ytext.insert(0, obsidianMd);
    const binding = new SteleBinding(ytext);

    // 找到 wikilink 段落節點,在段落開頭打字
    let pos = 0;
    let hit = -1;
    for (let i = 0; i < binding.state.doc.childCount; i++) {
      const child = binding.state.doc.child(i);
      if (hit === -1 && child.textContent.includes("連到")) { hit = i; break; }
      pos += child.nodeSize;
    }
    expect(hit).toBeGreaterThan(-1);
    binding.dispatch(binding.state.tr.insertText("改", pos + 1));

    const after = ytext.toString();
    expect(after).toContain("改連到 [[另一篇筆記]] 和 [[資料夾/筆記|顯示別名]]。");
    // 其他區塊原樣
    const blocks = splitBlocks(obsidianMd);
    expect(after.startsWith(obsidianMd.slice(blocks[0]!.from, blocks[0]!.to))).toBe(true);
  });
});
