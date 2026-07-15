import { Schema, type NodeSpec } from "prosemirror-model";
import { schema as mdSchema } from "prosemirror-markdown";

/**
 * stele_raw:不支援語法的 opaque 原文節點
 * raw 保存區塊原文含尾端空行,序列化時原樣輸出,保證位元組不變
 */
const steleRaw: NodeSpec = {
  attrs: { raw: {} },
  group: "block",
  atom: true,
  selectable: true,
  toDOM: (node) => ["pre", { "data-stele-raw": "" }, String(node.attrs.raw)],
  parseDOM: [{ tag: "pre[data-stele-raw]", getAttrs: (dom) => ({ raw: dom.textContent ?? "" }) }],
};

export const steleSchema = new Schema({
  nodes: mdSchema.spec.nodes.addToEnd("stele_raw", steleRaw),
  marks: mdSchema.spec.marks,
});
