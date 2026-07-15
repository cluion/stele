import type * as Y from "yjs";
import diff from "fast-diff";
import type { Block } from "./blocks.ts";

/**
 * 把區塊的新內容以最小 diff 寫進 Y.Text,只觸碰該區塊範圍內的位元組
 * origin 標記為 "editor",供鏡像層與同步層辨識變更來源
 */
export function applyBlockEdit(ytext: Y.Text, blocks: Block[], index: number, newText: string): void {
  const block = blocks[index];
  if (!block) throw new RangeError(`區塊索引超出範圍:${index}(共 ${blocks.length} 塊)`);

  const oldText = ytext.toString().slice(block.from, block.to);
  if (oldText === newText) return;

  const apply = () => {
    let pos = block.from;
    for (const [kind, text] of diff(oldText, newText)) {
      if (kind === diff.EQUAL) pos += text.length;
      else if (kind === diff.DELETE) ytext.delete(pos, text.length);
      else {
        ytext.insert(pos, text);
        pos += text.length;
      }
    }
  };
  if (ytext.doc) ytext.doc.transact(apply, "editor");
  else apply();
}
