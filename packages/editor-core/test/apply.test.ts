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

describe("applyBlockEdits 批次編輯", () => {
  it("前面區塊變長後,後面區塊的編輯位置自動校正", async () => {
    const { applyBlockEdits } = await import("../src/index.ts");
    const source = "第一段。\n\n第二段。\n\n第三段。\n";
    const doc = makeDoc(source);
    const blocks = splitBlocks(source);
    applyBlockEdits(doc.getText("md"), blocks, [
      { index: 0, newText: "第一段加長很多的內容。\n\n" },
      { index: 2, newText: "第三段改。\n" },
    ]);
    expect(doc.getText("md").toString()).toBe("第一段加長很多的內容。\n\n第二段。\n\n第三段改。\n");
  });

  it("未排序的編輯也正確套用,且全部在單一 transaction", async () => {
    const { applyBlockEdits } = await import("../src/index.ts");
    const source = "甲。\n\n乙。\n\n丙。\n";
    const doc = makeDoc(source);
    let updates = 0;
    doc.on("update", () => { updates++; });
    applyBlockEdits(doc.getText("md"), splitBlocks(source), [
      { index: 2, newText: "丙改。\n" },
      { index: 0, newText: "甲改很長。\n\n" },
    ]);
    expect(doc.getText("md").toString()).toBe("甲改很長。\n\n乙。\n\n丙改。\n");
    expect(updates).toBe(1);
  });

  it("重複的區塊索引直接拋錯", async () => {
    const { applyBlockEdits } = await import("../src/index.ts");
    const source = "甲。\n";
    const doc = makeDoc(source);
    const blocks = splitBlocks(source);
    expect(() =>
      applyBlockEdits(doc.getText("md"), blocks, [
        { index: 0, newText: "a\n" },
        { index: 0, newText: "b\n" },
      ]),
    ).toThrow(RangeError);
  });
});

describe("applyBlockEdit 陳舊陣列防護", () => {
  it("blocks 範圍超出 ytext 現況時拋錯而非靜默寫壞", () => {
    const source = "很長的第一段內容在這裡。\n\n第二段。\n";
    const doc = makeDoc(source);
    const blocks = splitBlocks(source);
    doc.getText("md").delete(0, 14);
    expect(() => applyBlockEdit(doc.getText("md"), blocks, 1, "第二段改。\n")).toThrow(RangeError);
  });
});
