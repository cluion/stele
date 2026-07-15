import type * as Y from "yjs";
import type { Node } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { splitBlocks, type Block } from "./blocks.ts";
import { applyRangeEdit } from "./apply.ts";
import { parseDoc, serializeBlock } from "./convert.ts";

interface ChildSpan {
  start: number;
  endOld: number;
  endNew: number;
}

/** 找出兩份 PM 文件頂層子節點的變更範圍;eq 決定比較方式 */
function diffChildren(oldDoc: Node, newDoc: Node, eq: (a: Node, b: Node) => boolean): ChildSpan {
  const min = Math.min(oldDoc.childCount, newDoc.childCount);
  let start = 0;
  while (start < min && eq(oldDoc.child(start), newDoc.child(start))) start++;
  let endOld = oldDoc.childCount;
  let endNew = newDoc.childCount;
  while (endOld > start && endNew > start && eq(oldDoc.child(endOld - 1), newDoc.child(endNew - 1))) {
    endOld--;
    endNew--;
  }
  return { start, endOld, endNew };
}

/** 頂層第 i 個子節點前緣的 PM 位置 */
function childOffset(doc: Node, i: number): number {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return pos;
}

/**
 * PM ↔ Y.Text 的活綁定,真相永遠是 Y.Text
 * 本地:dispatch 的 transaction 找出變更的頂層子節點範圍,序列化後以最小 diff 寫回
 * 遠端:observe 到非自己 origin 的變更,重建受影響範圍的 PM 節點
 */
export class SteleBinding {
  state: EditorState;
  onStateChange: ((state: EditorState) => void) | undefined;

  private readonly ytext: Y.Text;
  private blocks: Block[];
  private gaps: string[];
  private readonly observer: (e: Y.YTextEvent, tr: Y.Transaction) => void;

  constructor(ytext: Y.Text, onStateChange?: (state: EditorState) => void) {
    this.ytext = ytext;
    this.onStateChange = onStateChange;
    const source = ytext.toString();
    const { doc, blocks, gaps } = parseDoc(source);
    this.blocks = blocks;
    this.gaps = gaps;
    this.state = EditorState.create({ doc });

    this.observer = (_e, tr) => {
      if (tr.origin === this) this.refresh();
      else this.onRemoteChange();
    };
    ytext.observe(this.observer);
  }

  /** 套用本地 transaction,必要時寫回 Y.Text,回傳新 state */
  dispatch(tr: Transaction): EditorState {
    const oldDoc = this.state.doc;
    this.state = this.state.apply(tr);
    if (tr.docChanged) this.writeBack(oldDoc, this.state.doc);
    this.onStateChange?.(this.state);
    return this.state;
  }

  destroy(): void {
    this.ytext.unobserve(this.observer);
  }

  private writeBack(oldDoc: Node, newDoc: Node): void {
    const { start, endOld, endNew } = diffChildren(oldDoc, newDoc, (a, b) => a === b);
    if (start === endOld && start === endNew) return;

    const source = this.ytext.toString();
    const sameCount = endOld - start === endNew - start;
    const pieces: string[] = [];
    for (let i = start; i < endNew; i++) {
      const gap = sameCount
        ? this.gaps[start + (i - start)]!
        : i < endNew - 1
          ? "\n\n"
          : endOld > start
            ? this.gaps[endOld - 1]!
            : "\n\n";
      pieces.push(serializeBlock(newDoc.child(i), gap));
    }
    const from = start < this.blocks.length ? this.blocks[start]!.from : source.length;
    const to = endOld > start ? this.blocks[endOld - 1]!.to : from;
    applyRangeEdit(this.ytext, from, to, pieces.join(""), this);
    // origin 是自己 → observer 只 refresh,不回音
  }

  private onRemoteChange(): void {
    const { doc: newDoc } = parseDoc(this.ytext.toString());
    const { start, endOld, endNew } = diffChildren(this.state.doc, newDoc, (a, b) => a.eq(b));
    if (start !== endOld || start !== endNew) {
      const from = childOffset(this.state.doc, start);
      const to = childOffset(this.state.doc, endOld);
      const replacement: Node[] = [];
      for (let i = start; i < endNew; i++) replacement.push(newDoc.child(i));
      const tr = this.state.tr.replaceWith(from, to, replacement).setMeta("stele-remote", true);
      this.state = this.state.apply(tr);
      this.onStateChange?.(this.state);
    }
    this.refresh();
  }

  private refresh(): void {
    const source = this.ytext.toString();
    this.blocks = splitBlocks(source);
    this.gaps = this.blocks.map((b) => {
      const text = source.slice(b.from, b.to);
      return text.slice(text.trimEnd().length);
    });
  }
}
