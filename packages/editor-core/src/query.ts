import type { PageMetadata } from "./metadata.ts";

/**
 * 查詢視圖(對標 Dataview 的實用子集)。
 *
 * ```
 * LIST | TABLE 欄位 [AS 別名], …
 * [FROM #標籤 | "資料夾" | -否定 (AND|OR …)]
 * [WHERE 條件 (AND|OR …)]
 * [SORT 欄位 [ASC|DESC]]
 * [LIMIT n]
 * ```
 *
 * 刻意只做這些:涵蓋日常九成用途,而且每一條的行為都說得清楚。與其半套地假裝相容整個
 * Dataview(它還有 TASK、CALENDAR、函式、inline field、運算式…),不如語法少而準——
 * 查詢給出**看似合理但錯誤**的結果,比查不到更糟。
 */

export interface QueryColumn {
  field: string;
  label: string;
}

type SourceNode =
  | { op: "tag"; value: string }
  | { op: "folder"; value: string }
  | { op: "not"; node: SourceNode }
  | { op: "and" | "or"; left: SourceNode; right: SourceNode };

type Comparison = "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains";

type WhereNode =
  | { op: "cmp"; field: string; cmp: Comparison; value: string | number | boolean }
  | { op: "truthy"; field: string }
  | { op: "and" | "or"; left: WhereNode; right: WhereNode };

export interface Query {
  kind: "list" | "table";
  columns: QueryColumn[];
  from?: SourceNode;
  where?: WhereNode;
  sort: { field: string; dir: "asc" | "desc" };
  limit?: number;
}

export interface QueryResult {
  /** TABLE 的欄位標題;LIST 為空 */
  columns: string[];
  rows: Array<{ path: string; name: string; cells: unknown[] }>;
}

/** 解析失敗回 { error },不拋——查詢是使用者輸入,錯字是常態,UI 要顯示原因 */
export type ParseOutcome = Query | { error: string };

// ── 詞法 ────────────────────────────────────────────────
type Token = { kind: "word" | "string" | "number" | "punct"; text: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?)\b|(>=|<=|!=|=|>|<|,)|([^\s",]+))/y;
  let pos = 0;
  while (pos < input.length) {
    re.lastIndex = pos;
    const m = re.exec(input);
    if (!m) break;
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ kind: "string", text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "number", text: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: "punct", text: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: "word", text: m[4] });
  }
  return tokens;
}

class ParseError extends Error {}

/** 手寫遞迴下降:語法夠小,不值得引入 parser generator */
class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }
  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t?.kind === "word" && t.text.toUpperCase() === word;
  }
  private eatKeyword(word: string): boolean {
    if (!this.isKeyword(word)) return false;
    this.i++;
    return true;
  }
  private next(): Token {
    const t = this.tokens[this.i];
    if (!t) throw new ParseError("查詢語句不完整");
    this.i++;
    return t;
  }
  private atEnd(): boolean {
    return this.i >= this.tokens.length;
  }

  parse(): Query {
    const head = this.peek();
    if (!head) throw new ParseError("查詢是空的;請以 LIST 或 TABLE 開頭");
    const kind = head.text.toUpperCase();
    if (kind !== "LIST" && kind !== "TABLE") throw new ParseError(`查詢須以 LIST 或 TABLE 開頭,而不是「${head.text}」`);
    this.i++;

    const query: Query = {
      kind: kind === "TABLE" ? "table" : "list",
      columns: kind === "TABLE" ? this.parseColumns() : [],
      sort: { field: "file.mtime", dir: "desc" }, // 預設由新到舊,符合筆記工具的直覺
    };

    if (this.eatKeyword("FROM")) query.from = this.parseSource();
    if (this.eatKeyword("WHERE")) query.where = this.parseWhere();
    if (this.eatKeyword("SORT")) {
      const field = this.parseFieldName();
      const asc = this.eatKeyword("ASC");
      if (!asc) this.eatKeyword("DESC"); // DESC 是預設,寫出來也吃掉
      query.sort = { field, dir: asc ? "asc" : "desc" };
    }
    if (this.eatKeyword("LIMIT")) {
      const t = this.next();
      if (t.kind !== "number") throw new ParseError(`LIMIT 後面要接數字,而不是「${t.text}」`);
      query.limit = Math.max(0, Math.trunc(Number(t.text)));
    }
    if (!this.atEnd()) throw new ParseError(`看不懂的內容:「${this.peek()!.text}」`);
    return query;
  }

  private parseColumns(): QueryColumn[] {
    const cols: QueryColumn[] = [];
    for (;;) {
      const field = this.parseFieldName();
      const label = this.eatKeyword("AS") ? this.next().text : field;
      cols.push({ field, label });
      const t = this.peek();
      if (t?.kind === "punct" && t.text === ",") {
        this.i++;
        continue;
      }
      return cols;
    }
  }

  private parseFieldName(): string {
    const t = this.next();
    if (t.kind !== "word" && t.kind !== "string") throw new ParseError(`這裡需要欄位名,而不是「${t.text}」`);
    return t.text;
  }

  private parseSource(): SourceNode {
    let left = this.parseSourceTerm();
    for (;;) {
      if (this.eatKeyword("AND")) left = { op: "and", left, right: this.parseSourceTerm() };
      else if (this.eatKeyword("OR")) left = { op: "or", left, right: this.parseSourceTerm() };
      else return left;
    }
  }

  private parseSourceTerm(): SourceNode {
    const t = this.next();
    if (t.kind === "string") return { op: "folder", value: t.text };
    if (t.kind === "word") {
      if (t.text.startsWith("-")) return { op: "not", node: this.sourceFromWord(t.text.slice(1)) };
      return this.sourceFromWord(t.text);
    }
    throw new ParseError(`FROM 後面要接 #標籤 或 "資料夾",而不是「${t.text}」`);
  }

  private sourceFromWord(word: string): SourceNode {
    if (word.startsWith("#")) return { op: "tag", value: word.slice(1) };
    throw new ParseError(`FROM 的來源要是 #標籤 或 "資料夾",而不是「${word}」`);
  }

  private parseWhere(): WhereNode {
    let left = this.parseCondition();
    for (;;) {
      if (this.eatKeyword("AND")) left = { op: "and", left, right: this.parseCondition() };
      else if (this.eatKeyword("OR")) left = { op: "or", left, right: this.parseCondition() };
      else return left;
    }
  }

  private parseCondition(): WhereNode {
    const field = this.parseFieldName();
    const t = this.peek();
    const isOp = t && ((t.kind === "punct" && t.text !== ",") || (t.kind === "word" && t.text.toLowerCase() === "contains"));
    if (!isOp) return { op: "truthy", field };
    this.i++;
    const cmp = (t.kind === "word" ? "contains" : t.text) as Comparison;
    const v = this.next();
    const value =
      v.kind === "number"
        ? Number(v.text)
        : v.kind === "string"
          ? v.text
          : v.text.toLowerCase() === "true"
            ? true
            : v.text.toLowerCase() === "false"
              ? false
              : v.text;
    return { op: "cmp", field, cmp, value };
  }
}

export function parseQuery(text: string): ParseOutcome {
  try {
    return new Parser(tokenize(text)).parse();
  } catch (err) {
    return { error: err instanceof ParseError ? err.message : "查詢解析失敗" };
  }
}

// ── 執行 ────────────────────────────────────────────────

/** 取欄位值:file.* 是隱含欄位,其餘查 frontmatter */
function fieldValue(page: PageMetadata, field: string): unknown {
  switch (field.toLowerCase()) {
    case "file.path":
      return page.path;
    case "file.name":
      return page.name;
    case "file.folder":
      return page.folder;
    case "file.mtime":
      return page.mtime;
    case "file.tags":
      return page.tags;
    default:
      return page.fields[field];
  }
}

function matchSource(page: PageMetadata, node: SourceNode): boolean {
  switch (node.op) {
    case "tag":
      // 子標籤也算:FROM #專案 命中 #專案/Stele
      return page.tags.some((t) => t === node.value || t.startsWith(`${node.value}/`));
    case "folder":
      return page.folder === node.value || page.folder.startsWith(`${node.value}/`);
    case "not":
      return !matchSource(page, node.node);
    case "and":
      return matchSource(page, node.left) && matchSource(page, node.right);
    case "or":
      return matchSource(page, node.left) || matchSource(page, node.right);
  }
}

/**
 * 欄位值轉可比較/可顯示的文字。frontmatter 什麼型別都可能有,直接 String() 會把物件變成
 * `[object Object]`——那既比不出東西,顯示在表格裡也是噪音。
 */
export function fieldText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => fieldText(v)).join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return ""; // 循環參照等:當作沒有值
    }
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return ""; // symbol / function:YAML 產不出來,保守當空值
}

/** 缺席的欄位一律讓比較不成立——沒有那個欄位的頁面不該悄悄混進結果 */
function compare(actual: unknown, cmp: Comparison, expected: string | number | boolean): boolean {
  if (actual === undefined || actual === null) return false;
  const want = fieldText(expected);
  if (cmp === "contains") {
    if (Array.isArray(actual)) return actual.some((x) => fieldText(x) === want);
    return fieldText(actual).includes(want);
  }
  if (cmp === "=") return fieldText(actual) === want;
  if (cmp === "!=") return fieldText(actual) !== want;
  const a = typeof actual === "number" ? actual : Number(actual);
  const b = typeof expected === "number" ? expected : Number(expected);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return cmp === ">" ? a > b : cmp === "<" ? a < b : cmp === ">=" ? a >= b : a <= b;
}

function matchWhere(page: PageMetadata, node: WhereNode): boolean {
  switch (node.op) {
    case "cmp":
      return compare(fieldValue(page, node.field), node.cmp, node.value);
    case "truthy": {
      const v = fieldValue(page, node.field);
      if (v === undefined || v === null || v === false || v === "") return false;
      return !(Array.isArray(v) && v.length === 0);
    }
    case "and":
      return matchWhere(page, node.left) && matchWhere(page, node.right);
    case "or":
      return matchWhere(page, node.left) || matchWhere(page, node.right);
  }
}

export function runQuery(query: Query, pages: readonly PageMetadata[]): QueryResult {
  const matched = pages.filter((p) => (query.from ? matchSource(p, query.from) : true) && (query.where ? matchWhere(p, query.where) : true));

  const dir = query.sort.dir === "asc" ? 1 : -1;
  const sorted = [...matched].sort((x, y) => {
    const a = fieldValue(x, query.sort.field);
    const b = fieldValue(y, query.sort.field);
    // 缺值一律沉底,不論升冪降冪——排序是為了看重點,空值不該佔據開頭
    const aMissing = a === undefined || a === null;
    const bMissing = b === undefined || b === null;
    if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
    return fieldText(a).localeCompare(fieldText(b)) * dir;
  });

  const limited = query.limit === undefined ? sorted : sorted.slice(0, query.limit);
  return {
    columns: query.columns.map((c) => c.label),
    rows: limited.map((p) => ({ path: p.path, name: p.name, cells: query.columns.map((c) => fieldValue(p, c.field)) })),
  };
}
