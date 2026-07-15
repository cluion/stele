import type * as Y from "yjs";
import diff from "fast-diff";
import type { Block } from "./blocks.ts";

export interface BlockEdit {
  index: number;
  newText: string;
}

/** 以最小 diff 把 oldText → newText 寫進 ytext 的 at 位置起 */
function applyDiffAt(ytext: Y.Text, oldText: string, newText: string, at: number): void {
  let pos = at;
  for (const [kind, text] of diff(oldText, newText)) {
    if (kind === diff.EQUAL) pos += text.length;
    else if (kind === diff.DELETE) ytext.delete(pos, text.length);
    else {
      ytext.insert(pos, text);
      pos += text.length;
    }
  }
}

function inTransaction(ytext: Y.Text, run: () => void): void {
  if (ytext.doc) ytext.doc.transact(run, "editor");
  else run();
}

/** 以最小 diff 把 [from, to) 範圍替換為 newText;origin 供迴圈防護辨識來源 */
export function applyRangeEdit(ytext: Y.Text, from: number, to: number, newText: string, origin: unknown = "editor"): void {
  const oldText = ytext.toString().slice(from, to);
  if (oldText === newText) return;
  const run = () => applyDiffAt(ytext, oldText, newText, from);
  if (ytext.doc) ytext.doc.transact(run, origin);
  else run();
}

/**
 * 把單一區塊的新內容以最小 diff 寫進 Y.Text,只觸碰該區塊範圍內的位元組
 * origin 標記為 "editor",供鏡像層與同步層辨識變更來源
 *
 * 注意:任何編輯後 blocks 陣列即失效,再次編輯前必須重新 splitBlocks;
 * 一次要改多個區塊請用 applyBlockEdits,它會自動校正位移
 */
export function applyBlockEdit(ytext: Y.Text, blocks: Block[], index: number, newText: string): void {
  applyBlockEdits(ytext, blocks, [{ index, newText }]);
}

/**
 * 批次套用多個區塊的新內容:依索引排序、以累積位移校正各區塊位置,全部在單一 transaction
 * blocks 必須是對 ytext 現況呼叫 splitBlocks 的結果,範圍對不上時拋 RangeError 而非靜默寫壞
 */
export function applyBlockEdits(ytext: Y.Text, blocks: Block[], edits: readonly BlockEdit[]): void {
  if (edits.length === 0) return;

  const sorted = [...edits].sort((a, b) => a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.index === sorted[i - 1]!.index) {
      throw new RangeError(`重複的區塊索引:${sorted[i]!.index}`);
    }
  }
  const last = blocks[sorted.at(-1)!.index];
  if (!last) throw new RangeError(`區塊索引超出範圍:${sorted.at(-1)!.index}(共 ${blocks.length} 塊)`);

  const source = ytext.toString();
  if (blocks.at(-1)!.to !== source.length) {
    throw new RangeError("blocks 與 ytext 現況不符:請對最新內容重新 splitBlocks 後再編輯");
  }

  inTransaction(ytext, () => {
    let delta = 0;
    for (const { index, newText } of sorted) {
      const block = blocks[index]!;
      const oldText = source.slice(block.from, block.to);
      if (oldText !== newText) {
        applyDiffAt(ytext, oldText, newText, block.from + delta);
        delta += newText.length - oldText.length;
      }
    }
  });
}
