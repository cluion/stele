import type * as Y from "yjs";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { textOffsetAt, posAtTextOffset, mapTextOffset } from "./remote-selection.ts";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, exitCode } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { gapCursor } from "prosemirror-gapcursor";
import { splitListItem, sinkListItem, liftListItem } from "prosemirror-schema-list";
import { markdownInputRules } from "./input-rules.ts";
import { downOutOfTrailingCode } from "./commands.ts";
import { steleSchema } from "./schema.ts";
import { splitBlocks, findBlocksInRange, type Block } from "./blocks.ts";
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
    // Enter/Backspace 等編輯指令與 undo 都來自 plugin,沒掛 = 視圖按了沒反應
    this.state = EditorState.create({
      doc,
      plugins: [
        markdownInputRules,
        history(),
        keymap({
          "Mod-z": undo,
          "Shift-Mod-z": redo,
          "Mod-y": redo,
          Backspace: undoInputRule,
          // 清單:Enter 接續下一項(空項跳出)、Tab 縮排、Shift-Tab 升層;清單外回 false 交給 baseKeymap
          Enter: splitListItem(steleSchema.nodes["list_item"]!),
          Tab: sinkListItem(steleSchema.nodes["list_item"]!),
          "Shift-Tab": liftListItem(steleSchema.nodes["list_item"]!),
          // 跳出 code block:在區塊後建新段落
          "Shift-Enter": exitCode,
          "Mod-Enter": exitCode,
          ArrowDown: downOutOfTrailingCode,
        }),
        keymap(baseKeymap),
        gapCursor(),
      ],
    });

    this.observer = (_e, tr) => {
      // 自己的寫回在 writeBack 內就地維護 blocks/gaps,這裡只處理遠端
      if (tr.origin !== this) this.onRemoteChange();
    };
    ytext.observe(this.observer);
  }

  /** 頂層子節點 index → 其在 Y.Text 的起始 offset(協作游標塊級定位;用已增量維護的 blocks,免整份重 parse) */
  blockStart(index: number): number {
    return this.blocks[index]?.from ?? 0;
  }

  /** Y.Text offset 落在第幾個頂層區塊 */
  blockIndexAt(offset: number): number {
    return findBlocksInRange(this.blocks, offset, offset)[0] ?? 0;
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
    const newGaps: string[] = [];
    for (let i = start; i < endNew; i++) {
      const gap = sameCount
        ? this.gaps[start + (i - start)]!
        : i < endNew - 1
          ? "\n\n"
          : endOld > start
            ? this.gaps[endOld - 1]!
            : "\n\n";
      newGaps.push(gap);
      pieces.push(serializeBlock(newDoc.child(i), gap));
    }
    const from = start < this.blocks.length ? this.blocks[start]!.from : source.length;
    const to = endOld > start ? this.blocks[endOld - 1]!.to : from;
    applyRangeEdit(this.ytext, from, to, pieces.join(""), this);

    // 就地重建映射,維持與 PM 頂層子節點 1:1
    // 不可從文字重新解析:空段落序列化為空字串,重解析會漏掉它,映射一歪之後每次寫回都寫錯範圍
    const blocks: Block[] = this.blocks.slice(0, start);
    let pos = from;
    for (const piece of pieces) {
      blocks.push({ type: "block", from: pos, to: pos + piece.length });
      pos += piece.length;
    }
    const delta = pieces.join("").length - (to - from);
    for (let i = endOld; i < oldDoc.childCount; i++) {
      const b = this.blocks[i]!;
      blocks.push({ type: b.type, from: b.from + delta, to: b.to + delta });
    }
    this.blocks = blocks;
    this.gaps = [...this.gaps.slice(0, start), ...newGaps, ...this.gaps.slice(endOld)];
  }

  private onRemoteChange(): void {
    const { doc: newDoc } = parseDoc(this.ytext.toString());
    const { start, endOld, endNew } = diffChildren(this.state.doc, newDoc, (a, b) => a.eq(b));
    if (start !== endOld || start !== endNew) {
      const oldDoc = this.state.doc;
      const from = childOffset(oldDoc, start);
      const to = childOffset(oldDoc, endOld);
      const replacement: Node[] = [];
      for (let i = start; i < endNew; i++) replacement.push(newDoc.child(i));
      const { anchor, head } = this.state.selection;

      // addToHistory=false:遠端(協作者/外部檔案)的變更不進本地 undo 歷史
      const tr = this.state.tr
        .replaceWith(from, to, replacement)
        .setMeta("stele-remote", true)
        .setMeta("addToHistory", false);

      // selection mapping:端點在重建範圍外走 PM 步驟映射(精確);
      // 在範圍內以 textContent diff 映射回語意上的原位(近似,誤差僅在標記緊鄰處)
      const newSpanTo = from + replacement.reduce((size, node) => size + node.nodeSize, 0);
      const oldSpanText = oldDoc.textBetween(from, to, "\n", " ");
      const newSpanText = tr.doc.textBetween(from, newSpanTo, "\n", " ");
      const mapPoint = (pos: number): number => {
        if (pos < from || pos > to) return tr.mapping.map(pos);
        const offset = mapTextOffset(oldSpanText, newSpanText, textOffsetAt(oldDoc, from, pos));
        return posAtTextOffset(tr.doc, from, newSpanTo, offset);
      };
      tr.setSelection(TextSelection.between(tr.doc.resolve(mapPoint(anchor)), tr.doc.resolve(mapPoint(head))));

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
