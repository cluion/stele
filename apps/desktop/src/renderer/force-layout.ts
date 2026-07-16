/**
 * 極簡力導向佈局:斥力 + 彈簧 + 向心 + 阻尼
 * 全程確定性(黃金角螺旋佈點、無亂數),vault 級節點數 O(n²) 綽綽有餘
 */

export interface LayoutNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  repulsion?: number;
  spring?: number;
  springLength?: number;
  damping?: number;
}

const GOLDEN_ANGLE = 2.399963229728653;
const MAX_VELOCITY = 40;

export function initLayout(count: number, width: number, height: number): LayoutNode[] {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  return Array.from({ length: count }, (_, i) => {
    const angle = i * GOLDEN_ANGLE;
    const r = count > 1 ? radius * Math.sqrt((i + 1) / count) : 0;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), vx: 0, vy: 0 };
  });
}

export function tickLayout(
  nodes: LayoutNode[],
  edges: ReadonlyArray<readonly [number, number]>,
  opts: LayoutOptions,
): void {
  const { width, height, repulsion = 8000, spring = 0.02, springLength = 90, damping = 0.85 } = opts;
  const cx = width / 2;
  const cy = height / 2;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = 0.5 + (i % 3) * 0.3; // 重合時確定性推開
        dy = 0.5 - (j % 3) * 0.3;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const f = repulsion / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const [si, ti] of edges) {
    const a = nodes[si];
    const b = nodes[ti];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = spring * (d - springLength);
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const n of nodes) {
    n.vx += (cx - n.x) * 0.005;
    n.vy += (cy - n.y) * 0.005;
    n.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, n.vx * damping));
    n.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, n.vy * damping));
    n.x += n.vx;
    n.y += n.vy;
  }
}
