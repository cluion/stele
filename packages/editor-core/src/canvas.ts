/**
 * JSON Canvas 1.0(jsoncanvas.org)的讀寫層:白板檔 `.canvas` 的唯一真相。
 *
 * 兩條設計原則貫穿整個檔案:
 *
 * 1. **看不懂的欄位原封帶回**。JSON Canvas 是開放格式,同一份檔案可能先被 Obsidian
 *    或別的工具寫過。我們不認識的欄位(乃至於型別不合我們預期的已知欄位)一律收進 `extra`,
 *    序列化時照樣寫出去——否則使用者只是在 Stele 裡拖了一下節點,回到別的 app 就發現資料沒了。
 *
 * 2. **壞資料丟到節點為止**。單一節點缺座標、型別沒見過,丟那一個節點;
 *    只有「整份根本不是 JSON 物件」才回 error。一張白板不該因為一個爛節點而打不開。
 *
 * 白板走的是既有的文字 CRDT 管線(整份 JSON 存在 Y.Text),因此協作合併的中途有機會
 * 讀到語法半成品——`parseCanvas` 回 `{ error }` 而非拋例外,呼叫端據此保留上一個可用狀態。
 */

/** `"1"`–`"6"` 為 spec 預設色號(紅橙黃綠青紫),或 `"#RRGGBB"` */
export type CanvasColor = string;
export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";
export type CanvasBackgroundStyle = "cover" | "ratio" | "repeat";

const SIDES: readonly string[] = ["top", "right", "bottom", "left"];
const ENDS: readonly string[] = ["none", "arrow"];
const BACKGROUND_STYLES: readonly string[] = ["cover", "ratio", "repeat"];

interface CanvasNodeBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: CanvasColor;
  /** 解析時未收進結構欄位的原始資料,序列化時原封寫回 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface CanvasTextNode extends CanvasNodeBase {
  readonly type: "text";
  /** Markdown 純文字 */
  readonly text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  readonly type: "file";
  /** vault 相對路徑 */
  readonly file: string;
  /** `#` 開頭的標題或區塊連結 */
  readonly subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  readonly type: "link";
  readonly url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  readonly type: "group";
  readonly label?: string;
  readonly background?: string;
  readonly backgroundStyle?: CanvasBackgroundStyle;
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly fromSide?: CanvasSide;
  /** 預設 `none` */
  readonly fromEnd?: CanvasEnd;
  readonly toNode: string;
  readonly toSide?: CanvasSide;
  /** 預設 `arrow` */
  readonly toEnd?: CanvasEnd;
  readonly color?: CanvasColor;
  readonly label?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface Canvas {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  /** 頂層的未知欄位(例如某些工具寫的 `metadata`) */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export function emptyCanvas(): Canvas {
  return { nodes: [], edges: [] };
}

/** 節點/邊的 id:16 個十六進位字元,與 Obsidian 產生的形狀一致 */
export function newCanvasId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** JSON 沒有 Infinity/NaN,但 `x: null` 或 `x: 1e999` 進來就會讓版面計算全毀 */
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const oneOf = (v: unknown, allowed: readonly string[]): string | undefined =>
  typeof v === "string" && allowed.includes(v) ? v : undefined;

/**
 * 把原始物件拆成「收下的已知欄位」與「其餘原封保留的欄位」。
 * 型別不合預期的已知欄位會留在 rest 裡——資料不歸我們,不理解就別動它。
 */
function rest(raw: Record<string, unknown>, taken: readonly string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(raw)) {
    if (taken.includes(key)) continue;
    out[key] = value;
    any = true;
  }
  return any ? out : undefined;
}

/** 有值才放進物件;用來避免寫出 `"color": undefined` 這種噪音 */
const put = <T>(key: string, value: T | undefined): Record<string, T> => (value === undefined ? {} : { [key]: value });

function parseNode(raw: unknown): CanvasNode | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw["id"]);
  const x = num(raw["x"]);
  const y = num(raw["y"]);
  const width = num(raw["width"]);
  const height = num(raw["height"]);
  if (id === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;

  const color = str(raw["color"]);
  const taken = ["id", "type", "x", "y", "width", "height", ...(color === undefined ? [] : ["color"])];
  const base = { id, x, y, width, height, ...put("color", color) };

  switch (raw["type"]) {
    case "text": {
      const text = str(raw["text"]);
      if (text === undefined) return undefined;
      return { ...base, type: "text", text, ...put("extra", rest(raw, [...taken, "text"])) };
    }
    case "file": {
      const file = str(raw["file"]);
      if (file === undefined) return undefined;
      const subpath = str(raw["subpath"]);
      const extra = rest(raw, [...taken, "file", ...(subpath === undefined ? [] : ["subpath"])]);
      return { ...base, type: "file", file, ...put("subpath", subpath), ...put("extra", extra) };
    }
    case "link": {
      const url = str(raw["url"]);
      if (url === undefined) return undefined;
      return { ...base, type: "link", url, ...put("extra", rest(raw, [...taken, "url"])) };
    }
    case "group": {
      const label = str(raw["label"]);
      const background = str(raw["background"]);
      const backgroundStyle = oneOf(raw["backgroundStyle"], BACKGROUND_STYLES) as CanvasBackgroundStyle | undefined;
      const extra = rest(raw, [
        ...taken,
        ...(label === undefined ? [] : ["label"]),
        ...(background === undefined ? [] : ["background"]),
        ...(backgroundStyle === undefined ? [] : ["backgroundStyle"]),
      ]);
      return {
        ...base,
        type: "group",
        ...put("label", label),
        ...put("background", background),
        ...put("backgroundStyle", backgroundStyle),
        ...put("extra", extra),
      };
    }
    default:
      return undefined; // 沒見過的 type:整個節點交給別的工具處理,我們不冒充懂它
  }
}

function parseEdge(raw: unknown, nodeIds: ReadonlySet<string>): CanvasEdge | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw["id"]);
  const fromNode = str(raw["fromNode"]);
  const toNode = str(raw["toNode"]);
  // 懸空的邊在渲染時沒有起點或終點可算;丟掉比畫出一條指向虛空的線誠實
  if (id === undefined || fromNode === undefined || toNode === undefined) return undefined;
  if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) return undefined;

  const fromSide = oneOf(raw["fromSide"], SIDES) as CanvasSide | undefined;
  const fromEnd = oneOf(raw["fromEnd"], ENDS) as CanvasEnd | undefined;
  const toSide = oneOf(raw["toSide"], SIDES) as CanvasSide | undefined;
  const toEnd = oneOf(raw["toEnd"], ENDS) as CanvasEnd | undefined;
  const color = str(raw["color"]);
  const label = str(raw["label"]);
  const optional: Array<[string, unknown]> = [
    ["fromSide", fromSide],
    ["fromEnd", fromEnd],
    ["toSide", toSide],
    ["toEnd", toEnd],
    ["color", color],
    ["label", label],
  ];
  const extra = rest(raw, ["id", "fromNode", "toNode", ...optional.filter(([, v]) => v !== undefined).map(([k]) => k)]);
  return {
    id,
    fromNode,
    ...put("fromSide", fromSide),
    ...put("fromEnd", fromEnd),
    toNode,
    ...put("toSide", toSide),
    ...put("toEnd", toEnd),
    ...put("color", color),
    ...put("label", label),
    ...put("extra", extra),
  };
}

/**
 * 讀一份 `.canvas`。空字串視為空白板(剛建立的檔案),語法壞掉回 `{ error }`。
 * 節點 id 重複時只留第一個:邊靠 id 定位,重複 id 會讓「連到哪一個」變成擲骰子。
 */
export function parseCanvas(source: string): Canvas | { error: string } {
  const trimmed = source.trim();
  if (trimmed.length === 0) return emptyCanvas();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(raw)) return { error: "白板檔的頂層必須是物件" };

  const nodes: CanvasNode[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw["nodes"])) {
    for (const item of raw["nodes"]) {
      const node = parseNode(item);
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  if (Array.isArray(raw["edges"])) {
    for (const item of raw["edges"]) {
      const edge = parseEdge(item, seen);
      if (!edge || edgeIds.has(edge.id)) continue;
      edgeIds.add(edge.id);
      edges.push(edge);
    }
  }

  return { nodes, edges, ...put("extra", rest(raw, ["nodes", "edges"])) };
}

function nodeToJson(node: CanvasNode): Record<string, unknown> {
  const common = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...put("color", node.color),
  };
  const specific =
    node.type === "text"
      ? { text: node.text }
      : node.type === "file"
        ? { file: node.file, ...put("subpath", node.subpath) }
        : node.type === "link"
          ? { url: node.url }
          : { ...put("label", node.label), ...put("background", node.background), ...put("backgroundStyle", node.backgroundStyle) };
  // 已知欄位在前:白板檔是給人看的 diff,id/type 應該一眼可辨
  return { ...common, ...specific, ...node.extra };
}

function edgeToJson(edge: CanvasEdge): Record<string, unknown> {
  return {
    id: edge.id,
    fromNode: edge.fromNode,
    ...put("fromSide", edge.fromSide),
    ...put("fromEnd", edge.fromEnd),
    toNode: edge.toNode,
    ...put("toSide", edge.toSide),
    ...put("toEnd", edge.toEnd),
    ...put("color", edge.color),
    ...put("label", edge.label),
    ...edge.extra,
  };
}

/** 寫回 `.canvas`:兩格縮排、結尾換行,讓白板檔在 git diff 裡讀得懂 */
export function serializeCanvas(canvas: Canvas): string {
  const json = {
    nodes: canvas.nodes.map(nodeToJson),
    edges: canvas.edges.map(edgeToJson),
    ...canvas.extra,
  };
  return JSON.stringify(json, null, 2) + "\n";
}

/** 白板指向的筆記/附件路徑,去重後照出現順序;白板壞掉時回空陣列(索引重建不該被一份壞檔擋下) */
export function canvasFileLinks(source: string): string[] {
  const canvas = parseCanvas(source);
  if ("error" in canvas) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of canvas.nodes) {
    if (node.type !== "file" || seen.has(node.file)) continue;
    seen.add(node.file);
    out.push(node.file);
  }
  return out;
}

/**
 * 筆記改名時跟著改白板的 `file` 欄位。`rename` 回 null 表示不動。
 * 沒有任何命中就回傳原字串本身——不改就不寫檔,省下一趟同步流量與一版歷史。
 * 白板壞掉時同樣原樣返回:改名不是修檔的時機。
 */
export function rewriteCanvasFiles(source: string, rename: (file: string) => string | null): string {
  const canvas = parseCanvas(source);
  if ("error" in canvas) return source;
  let changed = false;
  const nodes = canvas.nodes.map((node) => {
    if (node.type !== "file") return node;
    const next = rename(node.file);
    if (next === null || next === node.file) return node;
    changed = true;
    return { ...node, file: next };
  });
  return changed ? serializeCanvas({ ...canvas, nodes }) : source;
}

/** 白板的可搜尋文字:節點內容、群組標籤、邊標籤、連結與檔名 */
export function canvasText(source: string): string {
  const canvas = parseCanvas(source);
  if ("error" in canvas) return "";
  const parts: string[] = [];
  for (const node of canvas.nodes) {
    if (node.type === "text") parts.push(node.text);
    else if (node.type === "file") parts.push(node.file + (node.subpath ?? ""));
    else if (node.type === "link") parts.push(node.url);
    else if (node.label !== undefined) parts.push(node.label);
  }
  for (const edge of canvas.edges) if (edge.label !== undefined) parts.push(edge.label);
  return parts.join("\n");
}
