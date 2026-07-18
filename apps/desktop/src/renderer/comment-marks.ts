/**
 * WYSIWYG 留言高亮:塊級。留言錨定的 Y.Text offset 由呼叫端經 binding 轉成 block index,
 * 這裡在對應的 PM 頂層段落畫留言底色左標。字元級精確高亮留待映射層升級(與遠端游標同一課題)
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface CommentBlock {
  block: number;
  resolved: boolean;
}

export const commentMarkKey = new PluginKey<DecorationSet>("stele-comment-marks");

function build(doc: PMNode, marks: CommentBlock[]): DecorationSet {
  const count = doc.childCount;
  if (count === 0) return DecorationSet.empty;
  const starts: number[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    starts.push(pos);
    pos += doc.child(i).nodeSize;
  }
  const seen = new Set<number>();
  const decos: Decoration[] = [];
  for (const m of marks) {
    const i = Math.min(Math.max(0, m.block), count - 1);
    if (seen.has(i)) continue; // 同段多則留言只畫一次
    seen.add(i);
    const from = starts[i]!;
    const to = from + doc.child(i).nodeSize;
    decos.push(Decoration.node(from, to, { class: m.resolved ? "comment-block resolved" : "comment-block" }));
  }
  return DecorationSet.create(doc, decos);
}

/** 掛在 binding.state 上的 plugin;透過 setMeta(commentMarkKey, marks) 更新 */
export function commentMarkPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: commentMarkKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, deco) {
        const next = tr.getMeta(commentMarkKey) as CommentBlock[] | undefined;
        if (next) return build(tr.doc, next);
        return deco.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return commentMarkKey.getState(state);
      },
    },
  });
}
