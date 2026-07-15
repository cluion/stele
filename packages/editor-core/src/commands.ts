import { TextSelection, type Command } from "prosemirror-state";

/**
 * 文末 code block 的逃生口:游標已在區塊底部再按 ↓,在文件尾建段落並跳出
 * gap cursor 只適用 atom 節點,code block 是 textblock,需要這條指令
 */
export const downOutOfTrailingCode: Command = (state, dispatch, view) => {
  const { $head, empty } = state.selection;
  if (!empty || !$head.parent.type.spec.code) return false;
  if ($head.index(0) !== state.doc.childCount - 1) return false; // 不在最後一個頂層節點
  if (view && !view.endOfTextblock("down")) return false; // 區塊內還有下一行,交給預設行為
  if (dispatch) {
    const paragraph = state.schema.nodes["paragraph"]!.createAndFill()!;
    const end = state.doc.content.size;
    const tr = state.tr.insert(end, paragraph);
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};
