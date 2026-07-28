import { newCanvasId, type Canvas, type CanvasEdge, type CanvasNode, type CanvasSide } from "@stele/editor-core";
import { DEFAULT_SIZE, nodeRect, rectsIntersect, snap, type Point, type Rect } from "./canvas-geometry.ts";

/**
 * 白板的編輯操作:全部是 Canvas → Canvas 的純函式,不碰 DOM 也不碰 Y.Doc。
 *
 * 元件只負責「手勢結束時呼叫哪一個」,狀態怎麼變在這裡決定並被測到。
 * 一律回新物件:白板同時是 CRDT 文字的投影,就地改動會讓「這次要寫回什麼」失去單一答案。
 *
 * 陣列順序即 z 序(後面的畫在上面),與 JSON Canvas 檔案裡的順序一致。
 */

type NodePatch = Partial<Omit<CanvasNode, "type">> & { readonly type?: never };

/** 拿掉一個欄位:JSON Canvas 的選用欄位「沒有」與「空字串」意義不同,清除就該是不寫這一欄 */
function omit<T extends object>(obj: T, key: string): T {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as T;
}

/** 對單一節點套用修改;找不到 id 就原樣返回 */
export function updateNode(canvas: Canvas, id: string, patch: NodePatch): Canvas {
  let hit = false;
  const nodes = canvas.nodes.map((n) => {
    if (n.id !== id) return n;
    hit = true;
    return { ...n, ...patch };
  });
  return hit ? { ...canvas, nodes } : canvas;
}

/** 位移一組節點;dx/dy 是世界座標的增量,落點對齊格線 */
export function moveNodes(canvas: Canvas, ids: ReadonlySet<string>, dx: number, dy: number): Canvas {
  if (ids.size === 0 || (dx === 0 && dy === 0)) return canvas;
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => (ids.has(n.id) ? { ...n, x: snap(n.x + dx), y: snap(n.y + dy) } : n)),
  };
}

export function resizeNode(canvas: Canvas, id: string, rect: Rect): Canvas {
  return updateNode(canvas, id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

/**
 * 刪除節點,連同任一端接在上面的邊——留著就是懸空邊,下次讀檔會被解析層丟掉,
 * 使用者只會看到「線莫名其妙不見了」。
 */
export function removeNodes(canvas: Canvas, ids: ReadonlySet<string>): Canvas {
  if (ids.size === 0) return canvas;
  return {
    ...canvas,
    nodes: canvas.nodes.filter((n) => !ids.has(n.id)),
    edges: canvas.edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode)),
  };
}

export function removeEdges(canvas: Canvas, ids: ReadonlySet<string>): Canvas {
  if (ids.size === 0) return canvas;
  return { ...canvas, edges: canvas.edges.filter((e) => !ids.has(e.id)) };
}

/** 新節點附在最後:z 序最高,剛建立的東西該在最上面 */
export function addNode(canvas: Canvas, node: CanvasNode): Canvas {
  return { ...canvas, nodes: [...canvas.nodes, node] };
}

/** 以某個世界座標為中心建立節點(通常是視窗中央或按右鍵的位置) */
export function nodeAt(kind: CanvasNode["type"], center: Point, content: { text?: string; file?: string; url?: string; label?: string }): CanvasNode {
  const { width, height } = DEFAULT_SIZE[kind];
  const base = { id: newCanvasId(), x: snap(center.x - width / 2), y: snap(center.y - height / 2), width, height };
  switch (kind) {
    case "text":
      return { ...base, type: "text", text: content.text ?? "" };
    case "file":
      return { ...base, type: "file", file: content.file ?? "" };
    case "link":
      return { ...base, type: "link", url: content.url ?? "" };
    case "group":
      return { ...base, type: "group", ...(content.label === undefined ? {} : { label: content.label }) };
  }
}

/**
 * 連一條邊。同方向的重複連線直接忽略(回原 canvas)——拖兩次同一對節點是常見的手滑,
 * 兩條完全重疊的線在畫面上看不出來,卻會讓刪除變成要刪兩次。
 */
export function connect(canvas: Canvas, from: { node: string; side: CanvasSide }, to: { node: string; side: CanvasSide }): Canvas {
  const exists = canvas.edges.some((e) => e.fromNode === from.node && e.toNode === to.node);
  if (exists) return canvas;
  const edge: CanvasEdge = {
    id: newCanvasId(),
    fromNode: from.node,
    fromSide: from.side,
    toNode: to.node,
    toSide: to.side,
  };
  return { ...canvas, edges: [...canvas.edges, edge] };
}

/** 設定選取項目的顏色;color 省略即清除(回到預設外觀) */
export function colorize(canvas: Canvas, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>, color?: string): Canvas {
  const paint = <T extends { id: string; color?: string }>(item: T, ids: ReadonlySet<string>): T => {
    if (!ids.has(item.id)) return item;
    return color === undefined ? omit(item, "color") : { ...item, color };
  };
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => paint(n, nodeIds)),
    edges: canvas.edges.map((e) => paint(e, edgeIds)),
  };
}

export function setEdgeLabel(canvas: Canvas, id: string, label: string): Canvas {
  return {
    ...canvas,
    edges: canvas.edges.map((e) => (e.id !== id ? e : label.trim().length === 0 ? omit(e, "label") : { ...e, label })),
  };
}

/**
 * 群組裡的節點:完全落在群組矩形內才算。拖群組時要帶著它們一起走——
 * 群組若只是一個框,使用者搬動它時裡面的東西留在原地,那這個框就沒有意義了。
 */
export function groupMembers(canvas: Canvas, groupId: string): string[] {
  const group = canvas.nodes.find((n) => n.id === groupId);
  if (!group || group.type !== "group") return [];
  const rect = nodeRect(group);
  return canvas.nodes
    .filter((n) => n.id !== groupId && n.x >= rect.x && n.y >= rect.y && n.x + n.width <= rect.x + rect.width && n.y + n.height <= rect.y + rect.height)
    .map((n) => n.id);
}

/** 拖曳實際要移動的節點集合:選取項目 + 被選中群組的成員 */
export function dragSet(canvas: Canvas, selected: ReadonlySet<string>): Set<string> {
  const out = new Set(selected);
  for (const id of selected) for (const member of groupMembers(canvas, id)) out.add(member);
  return out;
}

/** 提到最上層:被點到的節點應該蓋過別人,而不是躲在後面 */
export function bringToFront(canvas: Canvas, ids: ReadonlySet<string>): Canvas {
  if (ids.size === 0) return canvas;
  const stay = canvas.nodes.filter((n) => !ids.has(n.id));
  const lift = canvas.nodes.filter((n) => ids.has(n.id));
  if (lift.length === 0) return canvas;
  return { ...canvas, nodes: [...stay, ...lift] };
}

/** 選取框選到的節點與邊(邊只在兩端都被選時才算,免得「刪除選取」順手刪掉半條關係) */
export function selectionInRect(canvas: Canvas, rect: Rect): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set(canvas.nodes.filter((n) => rectsIntersect(nodeRect(n), rect)).map((n) => n.id));
  const edges = new Set(canvas.edges.filter((e) => nodes.has(e.fromNode) && nodes.has(e.toNode)).map((e) => e.id));
  return { nodes, edges };
}
