import { splitBlocks } from "./blocks.ts";

export interface WikilinkRef {
  /** 連結目標,保留 #錨點、不含別名 */
  target: string;
  embed: boolean;
  /** 連結所在行的文字,供反向連結面板顯示上下文 */
  line: string;
}

const LINK_PATTERN = /(!?)\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

/** 萃取全文的 wikilink 參照;跳過 frontmatter、code fence 與行內 code */
export function extractWikilinks(source: string): WikilinkRef[] {
  const refs: WikilinkRef[] = [];
  for (const block of splitBlocks(source)) {
    if (block.type === "code" || block.type === "yaml") continue;
    for (const line of source.slice(block.from, block.to).split("\n")) {
      const scannable = line.replace(/`[^`]*`/g, "");
      for (const match of scannable.matchAll(LINK_PATTERN)) {
        refs.push({ target: match[2]!.trim(), embed: match[1] === "!", line: line.trim() });
      }
    }
  }
  return refs;
}
