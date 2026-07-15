import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { splitBlocks, applyBlockEdit } from "../src/index.ts";

const fixturesDir = fileURLToPath(new URL("../../../prototypes/mirror/fixtures/", import.meta.url));
const obsidianMd = readFileSync(fixturesDir + "obsidian.md", "utf8");

function makeDoc(source: string) {
  const doc = new Y.Doc();
  doc.getText("md").insert(0, source);
  return doc;
}

describe("applyBlockEdit", () => {
  it("只改目標區塊,其他區塊位元組不動", () => {
    const doc = makeDoc(obsidianMd);
    const ytext = doc.getText("md");
    const blocks = splitBlocks(obsidianMd);
    const target = blocks.findIndex((b) => obsidianMd.slice(b.from, b.to).includes("==螢光標記=="));
    expect(target).toBeGreaterThan(-1);

    const oldBlock = obsidianMd.slice(blocks[target]!.from, blocks[target]!.to);
    const newBlock = oldBlock.replace("==螢光標記==", "==改寫過的螢光標記==");
    applyBlockEdit(ytext, blocks, target, newBlock);

    const after = ytext.toString();
    const afterBlocks = splitBlocks(after);
    expect(after).toContain("==改寫過的螢光標記==");
    for (let i = 0; i < blocks.length; i++) {
      if (i === target) continue;
      expect(
        after.slice(afterBlocks[i]!.from, afterBlocks[i]!.to),
        `區塊 ${i} 不應被動到`,
      ).toBe(obsidianMd.slice(blocks[i]!.from, blocks[i]!.to));
    }
  });

  it("塊級編輯與另一端的併發編輯可合併,兩端收斂", () => {
    const docA = makeDoc(obsidianMd);
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // A:塊級編輯 callout 區塊
    const blocksA = splitBlocks(docA.getText("md").toString());
    const calloutIdx = blocksA.findIndex((b) =>
      docA.getText("md").toString().slice(b.from, b.to).startsWith("> [!note]"),
    );
    const oldCallout = obsidianMd.slice(blocksA[calloutIdx]!.from, blocksA[calloutIdx]!.to);
    applyBlockEdit(docA.getText("md"), blocksA, calloutIdx, oldCallout.replace("內容第一行", "內容第一行由A改寫"));

    // B:同時在別的區塊直接打字
    const bText = docB.getText("md");
    const pos = bText.toString().indexOf("#待辦。");
    bText.insert(pos + "#待辦。".length, "\n\nB 併發新增的段落。");

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    const finalA = docA.getText("md").toString();
    expect(finalA).toBe(docB.getText("md").toString());
    expect(finalA).toContain("內容第一行由A改寫");
    expect(finalA).toContain("B 併發新增的段落。");
  });

  it("編輯產生最小 diff:共同前後綴不動", () => {
    const source = "# 標題\n\n一二三四五六七八九十。\n";
    const doc = makeDoc(source);
    const blocks = splitBlocks(source);
    const changes: Array<{ index: number; insert?: string; delete?: number; retain?: number }> = [];
    doc.getText("md").observe((e) => {
      let index = 0;
      for (const d of e.delta) {
        if (d.retain) index += d.retain;
        if (d.insert) changes.push({ index, insert: d.insert as string });
        if (d.delete) changes.push({ index, delete: d.delete });
      }
    });
    applyBlockEdit(doc.getText("md"), blocks, 1, "一二三【插入】四五六七八九十。\n");
    expect(changes).toEqual([{ index: source.indexOf("四"), insert: "【插入】" }]);
  });

  it("origin 標記為 editor,供鏡像層辨識來源", () => {
    const doc = makeDoc("段落。\n");
    let origin: unknown;
    doc.on("update", (_u: Uint8Array, o: unknown) => { origin = o; });
    applyBlockEdit(doc.getText("md"), splitBlocks("段落。\n"), 0, "段落改。\n");
    expect(origin).toBe("editor");
  });
});
