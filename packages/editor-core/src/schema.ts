import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";
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

/**
 * 連結淨化:prosemirror-markdown 的 link mark 把 href 原樣搬進 DOM,不做任何檢查。
 * markdown 路徑有 markdown-it 的 validateLink 擋 javascript:/data: 等,但它擋不到不經 markdown 的入口——
 * 貼上 HTML 走 DOMParser,link 的 parseDOM 收下任意 href,javascript: 就成了可點連結;
 * 渲染器主世界有 contextBridge 暴露的 window.stele,點下去等於把整個 IPC 面交出去。
 * 故在 schema 這層自己保證,不倚賴上游解析器的設定:
 * 只放行 http/https/mailto 與無 scheme 的相對連結,其餘剝掉 href(仍渲染文字,只是不可點)。
 * 這只影響 DOM 呈現,Markdown 序列化仍輸出原文,位元組不變。
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);
/** 瀏覽器解析 URL 前會丟掉 C0 控制字元與空白,偵測 scheme 前先照做,擋 "java\nscript:" */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function sanitizeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const scheme = SCHEME_RE.exec(href.replace(/[\u0000-\u0020]/g, ""));
  if (!scheme) return href; // 無 scheme=相對連結,安全
  return SAFE_SCHEMES.has(scheme[0].toLowerCase()) ? href : null;
}

const linkSpec = mdSchema.spec.marks.get("link")!;
const safeLink: MarkSpec = {
  ...linkSpec,
  toDOM: (mark) => ["a", { ...mark.attrs, href: sanitizeHref(mark.attrs["href"]) }, 0],
};

/** 清單符號記在節點上:解析保留原檔的 -/+/*,新建預設 -(Obsidian 慣例) */
const bulletSpec = mdSchema.spec.nodes.get("bullet_list")!;
const bulletWithMarker: NodeSpec = {
  ...bulletSpec,
  attrs: { ...bulletSpec.attrs, bullet: { default: "-" } },
};

export const steleSchema = new Schema({
  nodes: mdSchema.spec.nodes
    .update("bullet_list", bulletWithMarker)
    .addToEnd("stele_raw", steleRaw)
    .addToEnd("wikilink", wikilink),
  marks: mdSchema.spec.marks.update("link", safeLink),
});
