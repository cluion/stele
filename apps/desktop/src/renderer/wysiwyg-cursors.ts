/**
 * WYSIWYG 遠端游標:塊級。Y.Text offset 對到 block index(splitBlocks),
 * 再對到 PM 頂層子節點(1:1 不變量),在該段落畫彩色左標 + 名字
 * 字元級精確定位留待映射層升級;塊級已能表達「誰在編哪一段」
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface BlockCursor {
  clientId: number;
  block: number;
  color: string;
  name: string;
}

export const remoteCursorKey = new PluginKey<DecorationSet>("stele-remote-cursors");

function labelDOM(color: string, name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "remote-block-label";
  el.textContent = name;
  el.style.background = color;
  return el;
}

function build(doc: PMNode, cursors: BlockCursor[]): DecorationSet {
  const decos: Decoration[] = [];
  const count = doc.childCount;
  if (count === 0) return DecorationSet.empty;
  // 每段的起始 PM 位置
  const starts: number[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    starts.push(pos);
    pos += doc.child(i).nodeSize;
  }
  for (const c of cursors) {
    const i = Math.min(Math.max(0, c.block), count - 1);
    const from = starts[i]!;
    const to = from + doc.child(i).nodeSize;
    decos.push(
      Decoration.node(from, to, { class: "remote-block", style: `box-shadow: -3px 0 0 ${c.color}` }),
      Decoration.widget(from + 1, () => labelDOM(c.color, c.name), {
        side: -1,
        key: `rc-${c.clientId}`,
        ignoreSelection: true,
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

/** 掛在 binding.state 上的 plugin;透過 setMeta(remoteCursorKey, cursors) 更新 */
export function remoteCursorPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: remoteCursorKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, deco) {
        const next = tr.getMeta(remoteCursorKey) as BlockCursor[] | undefined;
        if (next) return build(tr.doc, next);
        return deco.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return remoteCursorKey.getState(state);
      },
    },
  });
}
