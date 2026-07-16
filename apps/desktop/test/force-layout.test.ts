import { describe, it, expect } from "vitest";
import { initLayout, tickLayout } from "../src/renderer/force-layout.ts";

const W = 800;
const H = 600;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("force-layout", () => {
  it("300 tick 後所有座標有限,不會 NaN 或爆炸", () => {
    const nodes = initLayout(30, W, H);
    const edges: Array<[number, number]> = Array.from({ length: 29 }, (_, i) => [i, i + 1]);
    for (let t = 0; t < 300; t++) tickLayout(nodes, edges, { width: W, height: H });
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(Math.abs(n.x - W / 2)).toBeLessThan(W * 3);
      expect(Math.abs(n.y - H / 2)).toBeLessThan(H * 3);
    }
  });

  it("有連線的節點比沒連線的靠得近", () => {
    const nodes = initLayout(3, W, H);
    const edges: Array<[number, number]> = [[0, 1]];
    for (let t = 0; t < 300; t++) tickLayout(nodes, edges, { width: W, height: H });
    expect(dist(nodes[0]!, nodes[1]!)).toBeLessThan(dist(nodes[0]!, nodes[2]!));
    expect(dist(nodes[0]!, nodes[1]!)).toBeLessThan(dist(nodes[1]!, nodes[2]!));
  });

  it("節點重合時被確定性推開", () => {
    const nodes = initLayout(2, W, H).map(() => ({ x: 100, y: 100, vx: 0, vy: 0 }));
    for (let t = 0; t < 50; t++) tickLayout(nodes, [], { width: W, height: H });
    expect(dist(nodes[0]!, nodes[1]!)).toBeGreaterThan(10);
  });

  it("空圖與單節點不出錯", () => {
    expect(() => tickLayout([], [], { width: W, height: H })).not.toThrow();
    const single = initLayout(1, W, H);
    tickLayout(single, [], { width: W, height: H });
    expect(Number.isFinite(single[0]!.x)).toBe(true);
  });
});
