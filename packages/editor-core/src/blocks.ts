import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";

/** 一個頂層 Markdown 區塊在原文中的範圍;[from, to) 半開區間,含區塊後方的空行 */
export interface Block {
  type: string;
  from: number;
  to: number;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"]);

/**
 * 把 Markdown 原文切成連續、無縫覆蓋全文的區塊序列
 * 不變量:blocks[0].from === 0、相鄰區塊首尾相接、最後一塊到 source.length
 */
export function splitBlocks(source: string): Block[] {
  if (source.length === 0) return [{ type: "empty", from: 0, to: 0 }];
  const tree = parser.parse(source);
  if (tree.children.length === 0) return [{ type: "empty", from: 0, to: source.length }];

  const blocks: Block[] = [];
  for (let i = 0; i < tree.children.length; i++) {
    const from = i === 0 ? 0 : blocks[i - 1]!.to;
    const next = tree.children[i + 1];
    const to = next ? (next.position?.start.offset ?? source.length) : source.length;
    blocks.push({ type: tree.children[i]!.type, from, to });
  }
  return blocks;
}

/** 回傳與 [from, to) 範圍相交的區塊索引;插入點 from === to 回傳所在區塊,文末回傳最後一塊 */
export function findBlocksInRange(blocks: Block[], from: number, to: number): number[] {
  const hits: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const overlaps = from === to ? from >= b.from && from < b.to : from < b.to && to > b.from;
    if (overlaps) hits.push(i);
  }
  if (hits.length === 0 && blocks.length > 0 && from >= blocks.at(-1)!.to) {
    hits.push(blocks.length - 1);
  }
  return hits;
}
