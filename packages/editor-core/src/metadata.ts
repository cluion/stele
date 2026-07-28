import { load } from "js-yaml";
import { splitBlocks } from "./blocks.ts";

/**
 * 查詢視圖的資料層:把一篇筆記讀成「可查詢的欄位」。
 *
 * frontmatter 走真正的 YAML 解析器而非自己刻——使用者的 frontmatter 會有清單、巢狀、引號、
 * 日期,手寫的子集解析器必然在某個奇怪的地方給出錯誤答案,而錯誤的查詢結果比查不到更糟。
 */

/** 一頁筆記的可查詢中繼資料 */
export interface PageMetadata {
  /** vault 相對路徑,如 `專案/A.md` */
  path: string;
  /** 不含副檔名的檔名 */
  name: string;
  /** 所在資料夾;根目錄為空字串 */
  folder: string;
  /** frontmatter 的 tags 欄位 + 內文的 #tag,去重 */
  tags: string[];
  /** 檔案修改時間(unix 毫秒) */
  mtime: number;
  /** frontmatter 的全部欄位 */
  fields: Record<string, unknown>;
}

/** frontmatter 必須在檔案最前面;中途出現的 `---` 是分隔線,不是 frontmatter */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

/**
 * 解析 frontmatter 欄位。沒有、格式壞掉、或不是物件(純量/陣列)一律回空物件——
 * 一篇筆記的 frontmatter 寫壞,不該讓整個 vault 的查詢炸掉。
 */
export function parseFrontmatter(source: string): Record<string, unknown> {
  const m = FRONTMATTER.exec(source);
  if (!m) return {};
  try {
    const parsed = load(m[1]!);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {}; // YAML 壞掉:當作沒有欄位
  }
}

/** `#標籤`:允許中日韓、拉丁、數字、底線、連字號與 `/` 階層;純數字不算(那通常是議題編號) */
const TAG_PATTERN = /(^|[\s(（[{【>,,、;;:：])#([\p{L}\p{N}_/-]+)/gu;

/**
 * 萃取標籤:frontmatter 的 `tags` 欄位 + 內文的 `#tag`,去重並保留原大小寫。
 * 跳過 code fence、行內 code 與 frontmatter 內文——規則比照 `extractWikilinks`,
 * 否則 shell 註解 `# foo` 與 Markdown 標題都會被當成標籤。
 */
export function extractTags(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (tag: string): void => {
    const t = tag.trim();
    if (t.length === 0 || seen.has(t) || /^\d+$/.test(t)) return;
    seen.add(t);
    out.push(t);
  };

  const fm = parseFrontmatter(source)["tags"];
  if (typeof fm === "string") for (const t of fm.split(/[,,\s]+/)) add(t.replace(/^#/, ""));
  else if (Array.isArray(fm)) for (const t of fm) if (typeof t === "string") add(t.replace(/^#/, ""));

  for (const block of splitBlocks(source)) {
    if (block.type === "code" || block.type === "yaml") continue;
    for (const line of source.slice(block.from, block.to).split("\n")) {
      // 行首的 # 是 Markdown 標題;行內 code 先剝掉
      const scannable = line.replace(/`[^`]*`/g, "").replace(/^\s*#{1,6}\s/, " ");
      for (const match of scannable.matchAll(TAG_PATTERN)) add(match[2]!);
    }
  }
  return out;
}

/** 把一篇筆記組成可查詢的一頁 */
export function pageMetadata(path: string, source: string, mtime: number): PageMetadata {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return {
    path,
    name: file.replace(/\.md$/, ""),
    folder: slash === -1 ? "" : path.slice(0, slash),
    tags: extractTags(source),
    mtime,
    fields: parseFrontmatter(source),
  };
}
