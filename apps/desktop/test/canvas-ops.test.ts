import { describe, it, expect } from "vitest";
import { parseCanvas, serializeCanvas, type Canvas } from "@stele/editor-core";
import {
  moveNodes,
  resizeNode,
  removeNodes,
  removeEdges,
  addNode,
  nodeAt,
  connect,
  colorize,
  setEdgeLabel,
  groupMembers,
  dragSet,
  bringToFront,
  selectionInRect,
  updateNode,
} from "../src/renderer/canvas-ops.ts";

/**
 * 白板的編輯操作。全部是 Canvas → Canvas 的純函式:元件只決定「手勢結束時呼叫哪一個」,
 * 狀態怎麼變在這裡被測到。也因為是純函式,「改了之後存回檔案長什麼樣」可以直接驗。
 */

const canvas: Canvas = {
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100, text: "甲" },
    { id: "b", type: "text", x: 300, y: 0, width: 100, height: 100, text: "乙" },
    { id: "g", type: "group", x: -50, y: -50, width: 300, height: 300, label: "群" },
  ],
  edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
};

describe("移動與大小", () => {
  it("位移選取的節點,其餘不動,且原物件不被改動", () => {
    const next = moveNodes(canvas, new Set(["a"]), 55, -23);
    expect(next.nodes[0]).toMatchObject({ x: 60, y: -20 }); // 對齊格線
    expect(next.nodes[1]).toBe(canvas.nodes[1]);
    expect(canvas.nodes[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("沒有位移就回原物件(不製造一次無意義的存檔與同步)", () => {
    expect(moveNodes(canvas, new Set(["a"]), 0, 0)).toBe(canvas);
    expect(moveNodes(canvas, new Set(), 10, 10)).toBe(canvas);
  });

  it("調整大小寫回四個欄位", () => {
    const next = resizeNode(canvas, "a", { x: 10, y: 20, width: 200, height: 300 });
    expect(next.nodes[0]).toMatchObject({ x: 10, y: 20, width: 200, height: 300 });
  });

  it("改到不存在的 id 回原物件", () => {
    expect(updateNode(canvas, "沒有這個", { x: 1 })).toBe(canvas);
  });
});

describe("刪除", () => {
  it("刪節點連同接在上面的邊(留著就是懸空邊,下次開檔會被默默丟掉)", () => {
    const next = removeNodes(canvas, new Set(["a"]));
    expect(next.nodes.map((n) => n.id)).toEqual(["b", "g"]);
    expect(next.edges).toEqual([]);
  });

  it("單獨刪邊不動節點", () => {
    const next = removeEdges(canvas, new Set(["e1"]));
    expect(next.edges).toEqual([]);
    expect(next.nodes).toBe(canvas.nodes);
  });
});

describe("新增與連線", () => {
  it("新節點以指定點為中心,並疊在最上層", () => {
    const next = addNode(canvas, nodeAt("text", { x: 500, y: 500 }, { text: "新" }));
    const created = next.nodes.at(-1)!;
    expect(created.x + created.width / 2).toBe(500);
    expect(created.y + created.height / 2).toBe(500);
    expect(created).toMatchObject({ type: "text", text: "新" });
  });

  it("四種節點都建得出來,且有預設尺寸", () => {
    for (const kind of ["text", "file", "link", "group"] as const) {
      const node = nodeAt(kind, { x: 0, y: 0 }, { file: "a.md", url: "https://x.dev", label: "群" });
      expect(node.type).toBe(kind);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
  });

  it("連線記下兩端與側邊", () => {
    const next = connect({ ...canvas, edges: [] }, { node: "a", side: "right" }, { node: "b", side: "left" });
    expect(next.edges[0]).toMatchObject({ fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" });
  });

  it("同方向重複連線忽略(手滑拖兩次不該產生兩條疊在一起的線)", () => {
    expect(connect(canvas, { node: "a", side: "top" }, { node: "b", side: "bottom" })).toBe(canvas);
  });
});

describe("顏色與標籤", () => {
  it("上色只動選取的項目", () => {
    const next = colorize(canvas, new Set(["a"]), new Set(["e1"]), "4");
    expect(next.nodes[0]).toMatchObject({ color: "4" });
    expect(next.nodes[1]).not.toHaveProperty("color");
    expect(next.edges[0]).toMatchObject({ color: "4" });
  });

  it("清除顏色是把欄位拿掉,而不是寫一個空字串進檔案", () => {
    const painted = colorize(canvas, new Set(["a"]), new Set(), "4");
    const cleared = colorize(painted, new Set(["a"]), new Set(), undefined);
    expect(cleared.nodes[0]).not.toHaveProperty("color");
    expect(serializeCanvas(cleared)).not.toContain("color");
  });

  it("邊標籤設空字串等於移除欄位", () => {
    const labelled = setEdgeLabel(canvas, "e1", "支撐");
    expect(labelled.edges[0]).toMatchObject({ label: "支撐" });
    expect(setEdgeLabel(labelled, "e1", "  ").edges[0]).not.toHaveProperty("label");
  });
});

describe("群組", () => {
  it("完全落在群組內的節點才算成員", () => {
    expect(groupMembers(canvas, "g")).toEqual(["a"]); // b 在群組外
  });

  it("拖群組時帶著成員一起走", () => {
    const ids = dragSet(canvas, new Set(["g"]));
    expect([...ids].sort()).toEqual(["a", "g"]);
    const moved = moveNodes(canvas, ids, 100, 0);
    expect(moved.nodes[0]).toMatchObject({ x: 100 }); // 成員跟著
    expect(moved.nodes[1]).toMatchObject({ x: 300 }); // 群組外的沒動
  });

  it("非群組節點沒有成員", () => {
    expect(groupMembers(canvas, "a")).toEqual([]);
  });
});

describe("選取與層次", () => {
  it("框選同時選到節點,以及兩端都在框內的邊", () => {
    const all = selectionInRect(canvas, { x: -100, y: -100, width: 600, height: 400 });
    expect([...all.nodes].sort()).toEqual(["a", "b", "g"]);
    expect([...all.edges]).toEqual(["e1"]);
  });

  it("只框到一端時不選那條邊(免得「刪除選取」順手刪掉半條關係)", () => {
    const partial = selectionInRect(canvas, { x: -10, y: -10, width: 120, height: 120 });
    expect([...partial.edges]).toEqual([]);
  });

  it("提到最上層只改順序,不改內容", () => {
    const next = bringToFront(canvas, new Set(["a"]));
    expect(next.nodes.map((n) => n.id)).toEqual(["b", "g", "a"]);
    expect(next.nodes.at(-1)).toBe(canvas.nodes[0]);
  });
});

describe("與檔案格式的往返", () => {
  it("編輯後序列化再讀回來,結果一致(操作不會產生解析層會丟掉的東西)", () => {
    const edited = colorize(
      connect(addNode(canvas, nodeAt("link", { x: 800, y: 0 }, { url: "https://jsoncanvas.org" })), { node: "b", side: "right" }, { node: "a", side: "left" }),
      new Set(["b"]),
      new Set(),
      "#FF8800",
    );
    const reparsed = parseCanvas(serializeCanvas(edited));
    expect("error" in reparsed).toBe(false);
    if ("error" in reparsed) return;
    expect(reparsed.nodes).toEqual(edited.nodes);
    expect(reparsed.edges).toEqual(edited.edges);
  });
});
