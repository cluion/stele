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

/** Obsidian 雙鏈:[[target]]、[[target|alias]]、![[embed]] 的一級內嵌節點 */
const wikilink: NodeSpec = {
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  attrs: { target: {}, alias: { default: null }, embed: { default: false } },
  toDOM: (node) => [
    "span",
    {
      class: node.attrs["embed"] ? "wikilink wikilink-embed" : "wikilink",
      "data-target": String(node.attrs["target"]),
    },
    String(node.attrs["alias"] ?? node.attrs["target"]),
  ],
  parseDOM: [
    {
      tag: "span.wikilink",
      getAttrs: (dom) => ({
        target: dom.getAttribute("data-target") ?? "",
        alias: dom.textContent !== dom.getAttribute("data-target") ? dom.textContent : null,
        embed: dom.classList.contains("wikilink-embed"),
      }),
    },
  ],
};

export const steleSchema = new Schema({
  nodes: mdSchema.spec.nodes.addToEnd("stele_raw", steleRaw).addToEnd("wikilink", wikilink),
  marks: mdSchema.spec.marks,
});
