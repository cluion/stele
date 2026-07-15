import type { Node } from "prosemirror-model";
import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer } from "prosemirror-markdown";
import { steleSchema } from "./schema.ts";
import { splitBlocks, type Block } from "./blocks.ts";

/** 已有對應 PM 節點的 mdast 區塊型別;其餘一律走 stele_raw 原文節點 */
const SUPPORTED = new Set(["paragraph", "heading", "blockquote", "list", "code", "thematicBreak"]);

/** Obsidian callout 尚無專屬節點,先視為 opaque 以免序列化損傷 [!type] 標記 */
const CALLOUT = /^>\s*\[!/;

/** markdown-it 內嵌規則:在 link/image 之前攔截 [[target|alias]] 與 ![[embed]] */
function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const embed = src.startsWith("![[", state.pos);
  const open = embed ? state.pos + 1 : state.pos;
  if (!src.startsWith("[[", open)) return false;
  const close = src.indexOf("]]", open + 2);
  if (close === -1) return false;
  const inner = src.slice(open + 2, close);
  if (inner.length === 0 || /[[\]\n]/.test(inner)) return false;

  if (!silent) {
    const token = state.push("wikilink", "", 0);
    const pipe = inner.indexOf("|");
    token.meta = {
      target: pipe === -1 ? inner : inner.slice(0, pipe),
      alias: pipe === -1 ? null : inner.slice(pipe + 1),
      embed,
    };
  }
  state.pos = close + 2;
  return true;
}

const tokenizer = new MarkdownIt("commonmark", { html: false });
tokenizer.inline.ruler.before("link", "wikilink", wikilinkRule);

const parser = new MarkdownParser(steleSchema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  wikilink: { node: "wikilink", getAttrs: (tok) => tok.meta as Record<string, unknown> },
});

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    stele_raw: () => {
      throw new Error("stele_raw 不經序列化器,serializeBlock 會直接回傳原文");
    },
    wikilink: (state, node) => {
      const alias = node.attrs["alias"] === null ? "" : `|${String(node.attrs["alias"])}`;
      state.write(`${node.attrs["embed"] ? "!" : ""}[[${String(node.attrs["target"])}${alias}]]`);
    },
  },
  defaultMarkdownSerializer.marks,
);

export interface ParsedBlock {
  node: Node;
  /** 區塊尾端的空白(空行),序列化時原樣補回 */
  gap: string;
}

/** 單一區塊原文 → PM 節點;不支援或解析結果非單一節點時退為 stele_raw */
export function parseBlock(text: string, mdastType: string): ParsedBlock {
  if (SUPPORTED.has(mdastType) && !(mdastType === "blockquote" && CALLOUT.test(text))) {
    const doc = parser.parse(text);
    if (doc.childCount === 1) {
      return { node: doc.child(0), gap: text.slice(text.trimEnd().length) };
    }
  }
  return { node: steleSchema.nodes.stele_raw!.create({ raw: text }), gap: "" };
}

/** PM 節點 → 區塊原文;stele_raw 原樣回傳,其餘經序列化器再補回 gap */
export function serializeBlock(node: Node, gap: string): string {
  if (node.type.name === "stele_raw") return String(node.attrs.raw);
  const md = serializer.serialize(steleSchema.node("doc", null, [node]));
  return md.replace(/\n+$/, "") + gap;
}

export interface ParsedDoc {
  doc: Node;
  blocks: Block[];
  gaps: string[];
}

/** 全文 → PM 文件,頂層子節點與 blocks 保證 1:1 對應 */
export function parseDoc(source: string): ParsedDoc {
  const blocks = splitBlocks(source);
  const parsed = blocks.map((b) => parseBlock(source.slice(b.from, b.to), b.type));
  return {
    doc: steleSchema.node("doc", null, parsed.map((p) => p.node)),
    blocks,
    gaps: parsed.map((p) => p.gap),
  };
}
