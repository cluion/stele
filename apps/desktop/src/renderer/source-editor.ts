/**
 * 源碼模式:CodeMirror 6 經 y-codemirror.next 直連 Y.Text
 * 真相仍是 Y.Text,CM 的編輯自動成為 Y.Doc 更新,走既有 IPC → 鏡像鏈
 */
import * as Y from "yjs";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { splitBlocks, findBlocksInRange } from "@stele/editor-core";
import type { RemoteCursor } from "./remote-cursors.ts";

/** 遠端游標的插入符 widget:一根彩色細線,hover 顯示名字 */
class CaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
  ) {
    super();
  }
  eq(other: CaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "remote-caret";
    el.style.borderColor = this.color;
    el.setAttribute("data-name", this.name);
    el.style.setProperty("--caret-color", this.color);
    return el;
  }
}

const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

/** 留言錨定範圍(Y.Text offset);resolved 用較淡的樣式 */
export interface CommentRange {
  from: number;
  to: number;
  resolved: boolean;
}
const setCommentRanges = StateEffect.define<CommentRange[]>();

const commentHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setCommentRanges)) continue;
      const len = tr.state.doc.length;
      const ranges = [];
      for (const c of e.value) {
        const from = Math.min(Math.max(0, c.from), len);
        const to = Math.min(Math.max(0, c.to), len);
        if (to > from) {
          ranges.push(Decoration.mark({ class: c.resolved ? "comment-highlight resolved" : "comment-highlight" }).range(from, to));
        }
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setRemoteCursors)) continue;
      const len = tr.state.doc.length;
      const ranges = [];
      for (const c of e.value) {
        const from = Math.min(Math.max(0, Math.min(c.anchor, c.head)), len);
        const to = Math.min(Math.max(0, Math.max(c.anchor, c.head)), len);
        if (to > from) {
          ranges.push(
            Decoration.mark({ class: "remote-selection", attributes: { style: `background:${c.color}33` } }).range(
              from,
              to,
            ),
          );
        }
        const caretAt = Math.min(Math.max(0, c.head), len);
        ranges.push(Decoration.widget({ widget: new CaretWidget(c.color, c.name), side: 1 }).range(caretAt));
      }
      next = Decoration.set(ranges, true); // 第二參數 sort=true,交給 RangeSet 排序
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Markdown 語法高亮,顏色全走 design tokens */
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--text)", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.monospace, color: "var(--warn)" },
  { tag: tags.quote, color: "var(--text-muted)" },
  { tag: tags.meta, color: "var(--text-faint)" },
  { tag: tags.processingInstruction, color: "var(--text-faint)" },
  { tag: tags.contentSeparator, color: "var(--border-strong)" },
]);

export interface SourceView {
  view: EditorView;
  /** 推入遠端游標(呼叫端已解析成 Y.Text offset) */
  setRemoteCursors(cursors: RemoteCursor[]): void;
  /** 推入留言錨定範圍高亮(字元級) */
  setCommentRanges(ranges: CommentRange[]): void;
  /** 捲動到某 Y.Text offset(點面板留言時定位) */
  scrollToOffset(offset: number): void;
  /** view 與 undoManager 必須一起銷毀:UndoManager 在共享的 Y.Doc 上掛有 afterTransaction listener */
  destroy(): void;
}

export function createSourceView(
  parent: HTMLElement,
  ytext: Y.Text,
  onCursor?: (anchor: number, head: number) => void,
  /** 唯讀(viewer 角色):禁編輯但保留閱讀、選取與游標回報 */
  readOnly = false,
): SourceView {
  const undoManager = new Y.UndoManager(ytext);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
        markdown(),
        EditorView.lineWrapping,
        syntaxHighlighting(mdHighlight),
        yCollab(ytext, null, { undoManager }),
        remoteCursorField,
        commentHighlightField,
        EditorView.updateListener.of((u) => {
          if (onCursor && (u.selectionSet || u.focusChanged)) {
            const sel = u.state.selection.main;
            onCursor(sel.anchor, sel.head);
          }
        }),
      ],
    }),
  });
  return {
    view,
    setRemoteCursors(cursors) {
      view.dispatch({ effects: setRemoteCursors.of(cursors) });
    },
    setCommentRanges(ranges) {
      view.dispatch({ effects: setCommentRanges.of(ranges) });
    },
    scrollToOffset(offset) {
      const at = Math.min(Math.max(0, offset), view.state.doc.length);
      view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
    },
    destroy() {
      view.destroy();
      undoManager.destroy();
    },
  };
}

/** 目前捲動位置最上方可見的 Markdown 區塊索引;pane 是實際的捲動容器 */
export function topBlockCM(view: EditorView, pane: HTMLElement, source: string): number {
  const rect = pane.getBoundingClientRect();
  const pos = view.posAtCoords({ x: rect.left + 8, y: rect.top + 8 }, false);
  const blocks = splitBlocks(source);
  return findBlocksInRange(blocks, pos, pos)[0] ?? 0;
}

/** 捲動到第 index 個 Markdown 區塊的開頭 */
export function scrollToBlockCM(view: EditorView, source: string, index: number): void {
  if (index <= 0) return;
  const blocks = splitBlocks(source);
  const block = blocks[Math.min(index, blocks.length - 1)]!;
  view.dispatch({ effects: EditorView.scrollIntoView(block.from, { y: "start" }) });
}
