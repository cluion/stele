import { describe, it, expect } from "vitest";
import type { CanvasNode } from "@stele/editor-core";
import {
  screenToWorld,
  worldToScreen,
  zoomAt,
  fitView,
  boundsOf,
  anchorPoint,
  autoSides,
  edgePath,
  edgeMidpoint,
  hitNode,
  nodesInRect,
  rectFromPoints,
  resizedRect,
  snap,
  MIN_ZOOM,
  MAX_ZOOM,
  MIN_NODE_SIZE,
} from "../src/renderer/canvas-geometry.ts";

/**
 * 白板幾何。這裡的每一條規則在畫面上都有對應的手感:
 * 縮放要以游標為錨(否則畫面從指尖跑掉)、邊要從正確的側邊垂直離開、
 * 群組中間要「透明」(否則框住的節點就再也點不到)。
 */

const text = (id: string, x: number, y: number, width = 100, height = 100): CanvasNode => ({ id, type: "text", x, y, width, height, text: "" });
const group = (id: string, x: number, y: number, width: number, height: number): CanvasNode => ({ id, type: "group", x, y, width, height });

describe("座標換算", () => {
  it("world ↔ screen 互為逆運算", () => {
    const view = { x: 120, y: -40, zoom: 1.75 };
    const p = { x: 33, y: -7 };
    const back = screenToWorld(view, worldToScreen(view, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it("縮放以游標為錨:游標底下的世界座標原地不動", () => {
    const view = { x: 10, y: 20, zoom: 1 };
    const cursor = { x: 300, y: 200 };
    const before = screenToWorld(view, cursor);
    const after = screenToWorld(zoomAt(view, 1.6, cursor), cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("縮放有上下限,到頂就不再變(也不會抖動)", () => {
    const zoomedOut = zoomAt({ x: 0, y: 0, zoom: MIN_ZOOM }, 0.5, { x: 0, y: 0 });
    expect(zoomedOut.zoom).toBe(MIN_ZOOM);
    const zoomedIn = zoomAt({ x: 0, y: 0, zoom: MAX_ZOOM }, 2, { x: 0, y: 0 });
    expect(zoomedIn.zoom).toBe(MAX_ZOOM);
  });
});

describe("全部顯示", () => {
  it("把整張白板置中", () => {
    const nodes = [text("a", 0, 0, 200, 200), text("b", 800, 600, 200, 200)];
    const view = fitView(nodes, { width: 1000, height: 800 });
    const center = worldToScreen(view, { x: 500, y: 400 });
    expect(center.x).toBeCloseTo(500);
    expect(center.y).toBeCloseTo(400);
  });

  it("不放大:兩個節點的白板不該被撐成滿版", () => {
    expect(fitView([text("a", 0, 0, 50, 50)], { width: 1000, height: 800 }).zoom).toBe(1);
  });

  it("空白板回到原點,視窗中央就是世界原點", () => {
    const view = fitView([], { width: 800, height: 600 });
    const origin = worldToScreen(view, { x: 0, y: 0 });
    expect([origin.x, origin.y, view.zoom]).toEqual([400, 300, 1]);
  });

  it("節點跨越原點時外接矩形仍然正確", () => {
    expect(boundsOf([text("a", -100, -50, 100, 100), text("b", 200, 100, 100, 100)])).toEqual({
      x: -100,
      y: -50,
      width: 400,
      height: 250,
    });
  });
});

describe("邊的接點與路徑", () => {
  it("四側接點都是該邊的中點", () => {
    const n = text("a", 0, 0, 200, 100);
    expect(anchorPoint(n, "top")).toEqual({ x: 100, y: 0 });
    expect(anchorPoint(n, "bottom")).toEqual({ x: 100, y: 100 });
    expect(anchorPoint(n, "left")).toEqual({ x: 0, y: 50 });
    expect(anchorPoint(n, "right")).toEqual({ x: 200, y: 50 });
  });

  it("自動選側:誰在誰的哪一邊就從那邊出去", () => {
    const origin = text("a", 0, 0);
    expect(autoSides(origin, text("b", 500, 0))).toEqual({ from: "right", to: "left" });
    expect(autoSides(origin, text("b", -500, 0))).toEqual({ from: "left", to: "right" });
    expect(autoSides(origin, text("b", 0, 500))).toEqual({ from: "bottom", to: "top" });
    expect(autoSides(origin, text("b", 0, -500))).toEqual({ from: "top", to: "bottom" });
  });

  it("路徑從起點出發、在終點結束,控制點沿法線外推", () => {
    const d = edgePath({ x: 0, y: 0 }, "right", { x: 400, y: 0 }, "left");
    expect(d.startsWith("M 0 0 C ")).toBe(true);
    expect(d.endsWith("400 0")).toBe(true);
    // 右側出去的控制點必在起點右方,否則線會先往回鑽
    const c1x = Number(/C ([-\d.]+)/.exec(d)![1]);
    expect(c1x).toBeGreaterThan(0);
  });

  it("水平對接時中點落在兩點連線的中央", () => {
    const mid = edgeMidpoint({ x: 0, y: 0 }, "right", { x: 400, y: 0 }, "left");
    expect(mid.x).toBeCloseTo(200);
    expect(mid.y).toBeCloseTo(0);
  });
});

describe("命中測試", () => {
  it("點在節點內就命中,上層(陣列後面)優先", () => {
    const nodes = [text("底", 0, 0, 200, 200), text("上", 50, 50, 200, 200)];
    expect(hitNode(nodes, { x: 100, y: 100 })?.id).toBe("上");
    expect(hitNode(nodes, { x: 10, y: 10 })?.id).toBe("底");
    expect(hitNode(nodes, { x: 999, y: 999 })).toBeUndefined();
  });

  it("群組只有邊框與標題列可點,中間讓給裡面的節點", () => {
    const nodes = [group("g", 0, 0, 400, 400)];
    expect(hitNode(nodes, { x: 200, y: 4 })?.id).toBe("g"); // 標題列
    expect(hitNode(nodes, { x: 2, y: 200 })?.id).toBe("g"); // 左邊框
    expect(hitNode(nodes, { x: 200, y: 200 })).toBeUndefined(); // 中間是透明的
  });

  it("群組裡的節點點得到,不會被群組蓋住", () => {
    const nodes = [group("g", 0, 0, 400, 400), text("內", 150, 150, 100, 100)];
    expect(hitNode(nodes, { x: 200, y: 200 })?.id).toBe("內");
  });

  it("框選取相交的節點,不要求完全包住(否則大節點永遠選不到)", () => {
    const nodes = [text("a", 0, 0, 100, 100), text("b", 500, 500, 100, 100)];
    const rect = rectFromPoints({ x: 50, y: 50 }, { x: -200, y: -200 });
    expect(nodesInRect(nodes, rect).map((n) => n.id)).toEqual(["a"]);
  });
});

describe("調整大小", () => {
  it("拖右下角:左上角不動", () => {
    expect(resizedRect({ x: 100, y: 100, width: 200, height: 200 }, "se", 50, 30)).toEqual({ x: 100, y: 100, width: 250, height: 230 });
  });

  it("拖左上角:右下角不動", () => {
    expect(resizedRect({ x: 100, y: 100, width: 200, height: 200 }, "nw", 50, 50)).toEqual({ x: 150, y: 150, width: 150, height: 150 });
  });

  it("拖過頭不會翻面或變成負尺寸", () => {
    const r = resizedRect({ x: 100, y: 100, width: 200, height: 200 }, "nw", 9999, 9999);
    expect(r.width).toBe(MIN_NODE_SIZE);
    expect(r.height).toBe(MIN_NODE_SIZE);
    expect(r.x).toBeLessThanOrEqual(300 - MIN_NODE_SIZE);
  });

  it("落點對齊格線", () => {
    expect(snap(103)).toBe(100);
    expect(snap(-103)).toBe(-100);
    expect(resizedRect({ x: 0, y: 0, width: 200, height: 200 }, "se", 13, 27).width).toBe(210);
  });
});
