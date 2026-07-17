import { describe, it, expect } from "vitest";
import { parseDoc, splitBlocks, findBlocksInRange } from "@stele/editor-core";
import { EditorState } from "prosemirror-state";
import { remoteCursorPlugin, remoteCursorKey, type BlockCursor } from "../src/renderer/wysiwyg-cursors.ts";

const SOURCE = "# 標題\n\n第一段\n\n第二段\n\n第三段\n";

function stateFor(source: string): EditorState {
  const { doc } = parseDoc(source);
  return EditorState.create({ doc, plugins: [remoteCursorPlugin()] });
}

describe("WYSIWYG 塊級遠端游標", () => {
  it("Y.Text offset 對到正確的 block index", () => {
    const blocks = splitBlocks(SOURCE);
    // 「第二段」在原文的位置
    const off = SOURCE.indexOf("第二段") + 1;
    const idx = findBlocksInRange(blocks, off, off)[0] ?? 0;
    expect(blocks[idx]).toBeDefined();
    expect(SOURCE.slice(blocks[idx]!.from, blocks[idx]!.to)).toContain("第二段");
  });

  it("setMeta 後對應段落產生 node 與 label decoration", () => {
    let state = stateFor(SOURCE);
    const cursors: BlockCursor[] = [{ clientId: 7, block: 2, color: "#0e7b93", name: "甲" }];
    state = state.apply(state.tr.setMeta(remoteCursorKey, cursors));
    const set = remoteCursorKey.getState(state)!;
    // block 2 對應第 3 個頂層子節點,decoration 落在其範圍內
    const found = set.find();
    expect(found.length).toBe(2); // node + widget label
  });

  it("超出範圍的 block index 被 clamp,不崩潰", () => {
    let state = stateFor(SOURCE);
    state = state.apply(state.tr.setMeta(remoteCursorKey, [{ clientId: 1, block: 999, color: "#000", name: "X" }]));
    expect(remoteCursorKey.getState(state)!.find().length).toBe(2);
  });

  it("空 cursor 陣列清掉所有 decoration", () => {
    let state = stateFor(SOURCE);
    state = state.apply(state.tr.setMeta(remoteCursorKey, [{ clientId: 1, block: 0, color: "#000", name: "X" }]));
    expect(remoteCursorKey.getState(state)!.find().length).toBe(2);
    state = state.apply(state.tr.setMeta(remoteCursorKey, []));
    expect(remoteCursorKey.getState(state)!.find().length).toBe(0);
  });
});
