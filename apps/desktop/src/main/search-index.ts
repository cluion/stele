import MiniSearch from "minisearch";

export interface SearchHit {
  file: string;
  score: number;
}

const CJK = /[㐀-䶿一-鿿]/u;

/** CJK 逐字 + bigram、拉丁詞整詞小寫;索引與查詢共用同一套切詞 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (const part of match[0].match(/[㐀-䶿一-鿿]+|[^㐀-䶿一-鿿]+/gu) ?? []) {
      if (CJK.test(part)) {
        for (let i = 0; i < part.length; i++) {
          tokens.push(part[i]!);
          if (i + 1 < part.length) tokens.push(part.slice(i, i + 2));
        }
      } else {
        tokens.push(part.toLowerCase());
      }
    }
  }
  return tokens;
}

/** 全文搜尋索引:純記憶體,內容由呼叫端餵入;AND 查詢 + 標題加權 */
export class SearchIndex {
  private readonly mini = new MiniSearch<{ id: string; title: string; content: string }>({
    fields: ["title", "content"],
    tokenize,
    searchOptions: {
      combineWith: "AND",
      prefix: true,
      boost: { title: 3 },
    },
  });
  private readonly present = new Set<string>();

  update(rel: string, content: string): void {
    if (this.present.has(rel)) this.mini.discard(rel);
    const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const h1 = /^#{1,6}\s+(.+)$/m.exec(content)?.[1] ?? "";
    this.mini.add({ id: rel, title: `${base} ${h1}`.trim(), content });
    this.present.add(rel);
  }

  remove(rel: string): void {
    if (!this.present.has(rel)) return;
    this.mini.discard(rel);
    this.present.delete(rel);
  }

  search(query: string, limit = 20): SearchHit[] {
    if (query.trim().length === 0) return [];
    return this.mini
      .search(query)
      .slice(0, limit)
      .map((r) => ({ file: String(r.id), score: r.score }));
  }
}
