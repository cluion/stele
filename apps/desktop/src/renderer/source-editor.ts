/**
 * 源碼模式:CodeMirror 6 經 y-codemirror.next 直連 Y.Text
 * 真相仍是 Y.Text,CM 的編輯自動成為 Y.Doc 更新,走既有 IPC → 鏡像鏈
 */
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { splitBlocks, findBlocksInRange } from "@stele/editor-core";

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
  /** view 與 undoManager 必須一起銷毀:UndoManager 在共享的 Y.Doc 上掛有 afterTransaction listener */
  destroy(): void;
}

export function createSourceView(parent: HTMLElement, ytext: Y.Text): SourceView {
  const undoManager = new Y.UndoManager(ytext);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
        markdown(),
        EditorView.lineWrapping,
        syntaxHighlighting(mdHighlight),
        yCollab(ytext, null, { undoManager }),
      ],
    }),
  });
  return {
    view,
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
