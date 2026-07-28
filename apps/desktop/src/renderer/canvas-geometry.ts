import type { CanvasNode, CanvasSide } from "@stele/editor-core";

/**
 * 白板的幾何:世界座標 ↔ 螢幕座標、邊的路徑、命中測試。
 *
 * 全部是純函式,與 React 無關——白板的難處幾乎都在這裡(縮放時該以游標為錨、
 * 邊該從哪一側出去、群組該不該擋住底下的節點),把它們留在元件裡就沒有一項測得到。
 *
 * 座標系:world 是白板自己的無限平面(.canvas 檔存的就是它),screen 是畫布容器內的像素。
 * `screen = world * zoom + offset`,對應 CSS 的 `translate(x,y) scale(zoom)` + `transform-origin: 0 0`。
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewTransform {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** 對齊格線;拖曳中即時吸附,讓隨手擺的節點自然對齊 */
export const GRID = 10;
/** 節點最小尺寸:再小就點不到、也讀不到內容 */
export const MIN_NODE_SIZE = 60;

/** 新節點的預設尺寸,與 Obsidian 的手感接近 */
export const DEFAULT_SIZE: Record<CanvasNode["type"], { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  file: { width: 400, height: 400 },
  link: { width: 400, height: 320 },
  group: { width: 520, height: 400 },
};

export const IDENTITY_VIEW: ViewTransform = { x: 0, y: 0, zoom: 1 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const snap = (value: number, grid: number = GRID): number => Math.round(value / grid) * grid;

export function screenToWorld(view: ViewTransform, p: Point): Point {
  return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
}

export function worldToScreen(view: ViewTransform, p: Point): Point {
  return { x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y };
}

/** 以 `at`(螢幕座標)為錨縮放:游標底下的那一點在縮放前後停在原地,否則畫面會從指尖跑掉 */
export function zoomAt(view: ViewTransform, factor: number, at: Point): ViewTransform {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (zoom === view.zoom) return view;
  const world = screenToWorld(view, at);
  return { zoom, x: at.x - world.x * zoom, y: at.y - world.y * zoom };
}

export function nodeRect(node: CanvasNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** 一組節點的外接矩形;空集合回 undefined */
export function boundsOf(nodes: readonly CanvasNode[]): Rect | undefined {
  if (nodes.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 「全部顯示」:把整張白板塞進視窗並置中;空白板回到原點 1:1 */
export function fitView(nodes: readonly CanvasNode[], viewport: { width: number; height: number }, padding = 60): ViewTransform {
  const bounds = boundsOf(nodes);
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) {
    return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
  }
  const zoom = clamp(
    Math.min((viewport.width - padding * 2) / Math.max(bounds.width, 1), (viewport.height - padding * 2) / Math.max(bounds.height, 1)),
    MIN_ZOOM,
    1, // 不放大:只有兩個節點的白板不該被撐成滿版
  );
  return {
    zoom,
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** 節點某一側的中點(世界座標),即邊的接點 */
export function anchorPoint(node: CanvasNode, side: CanvasSide): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

const NORMALS: Record<CanvasSide, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * 邊沒指定 side 時自行挑一組:誰在誰的哪一邊,就從那一邊出去。
 * spec 允許省略 fromSide/toSide,而畫面上總得選一個——選錯的話線會繞過整個節點。
 */
export function autoSides(from: CanvasNode, to: CanvasNode): { from: CanvasSide; to: CanvasSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }
  return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

/**
 * 邊的三次貝茲路徑:控制點沿著出入側的法線外推,線才會「垂直地」離開節點,
 * 而不是從節點邊緣斜切出去。外推距離跟著兩點距離走並設上下限,近距離不打結、遠距離不過彎。
 */
export function edgePath(from: Point, fromSide: CanvasSide, to: Point, toSide: CanvasSide): string {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const pull = clamp(dist * 0.4, 30, 200);
  const n1 = NORMALS[fromSide];
  const n2 = NORMALS[toSide];
  const c1 = { x: from.x + n1.x * pull, y: from.y + n1.y * pull };
  const c2 = { x: to.x + n2.x * pull, y: to.y + n2.y * pull };
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/** 貝茲中點(t=0.5),邊的標籤掛在這裡 */
export function edgeMidpoint(from: Point, fromSide: CanvasSide, to: Point, toSide: CanvasSide): Point {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const pull = clamp(dist * 0.4, 30, 200);
  const n1 = NORMALS[fromSide];
  const n2 = NORMALS[toSide];
  const c1 = { x: from.x + n1.x * pull, y: from.y + n1.y * pull };
  const c2 = { x: to.x + n2.x * pull, y: to.y + n2.y * pull };
  // B(0.5) = (P0 + 3C1 + 3C2 + P3) / 8
  return {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
}

/** 箭頭三角形的三個頂點(世界座標);尖端落在接點上、朝節點內指 */
export function arrowPoints(at: Point, side: CanvasSide, size = 10): string {
  const n = NORMALS[side];
  // 尖端在接點,底邊往外(法線方向)退一個 size
  const backX = at.x + n.x * size;
  const backY = at.y + n.y * size;
  const half = size * 0.5;
  const perp = { x: -n.y, y: n.x };
  const p1 = `${backX + perp.x * half},${backY + perp.y * half}`;
  const p2 = `${backX - perp.x * half},${backY - perp.y * half}`;
  return `${at.x},${at.y} ${p1} ${p2}`;
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

const contains = (r: Rect, p: Point): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** 群組可命中的範圍:邊框帶與頂部標題列。中間是「透明」的,否則群組會蓋住裡頭的節點 */
const GROUP_BAND = 14;
const GROUP_HEADER = 32;

function hitsNode(node: CanvasNode, p: Point): boolean {
  const rect = nodeRect(node);
  if (!contains(rect, p)) return false;
  if (node.type !== "group") return true;
  const inHeader = p.y <= rect.y + GROUP_HEADER;
  const inBand =
    p.x <= rect.x + GROUP_BAND ||
    p.x >= rect.x + rect.width - GROUP_BAND ||
    p.y <= rect.y + GROUP_BAND ||
    p.y >= rect.y + rect.height - GROUP_BAND;
  return inHeader || inBand;
}

/** 命中最上層的節點;陣列後面的畫在上面,因此由後往前找 */
export function hitNode(nodes: readonly CanvasNode[], p: Point): CanvasNode | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (hitsNode(node, p)) return node;
  }
  return undefined;
}

/** 框選:與選取框相交就算(要求完全包住的話,大節點永遠選不到) */
export function nodesInRect(nodes: readonly CanvasNode[], rect: Rect): CanvasNode[] {
  return nodes.filter((n) => rectsIntersect(nodeRect(n), rect));
}

/** 調整大小時被拖的角/邊 */
export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/** 依拖曳位移算出新矩形;對角固定不動,並確保不會被拖成負尺寸 */
export function resizedRect(start: Rect, handle: ResizeHandle, dx: number, dy: number, min = MIN_NODE_SIZE): Rect {
  const left = handle === "nw" || handle === "sw";
  const top = handle === "nw" || handle === "ne";
  const rawX = left ? snap(start.x + dx) : start.x;
  const rawY = top ? snap(start.y + dy) : start.y;
  const right = left ? start.x + start.width : snap(start.x + start.width + dx);
  const bottom = top ? start.y + start.height : snap(start.y + start.height + dy);
  const x = left ? Math.min(rawX, right - min) : rawX;
  const y = top ? Math.min(rawY, bottom - min) : rawY;
  return { x, y, width: Math.max(min, right - x), height: Math.max(min, bottom - y) };
}
