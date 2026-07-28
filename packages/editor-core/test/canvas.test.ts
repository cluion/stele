import { describe, it, expect } from "vitest";
import { parseCanvas, serializeCanvas, emptyCanvas, canvasFileLinks, rewriteCanvasFiles, canvasText } from "../src/index.ts";

/**
 * JSON Canvas 1.0(jsoncanvas.org)的讀寫層。
 *
 * 兩個非談判點:
 * 1. **未知欄位一字不漏地帶回去**。.canvas 是開放格式,同一個檔案可能被 Obsidian 或別的工具寫過;
 *    我們看不懂的欄位若在存檔時被抹掉,使用者會在別的 app 裡發現資料無聲消失。
 * 2. **壞資料丟節點而非丟整份**。單一節點缺座標不該讓整張白板打不開。
 */

const sample = {
  nodes: [
    { id: "a1", type: "text", x: 0, y: 0, width: 260, height: 120, text: "# 想法\n\n第一條" },
    { id: "a2", type: "file", x: 400, y: 0, width: 300, height: 200, file: "專案/立項.md", subpath: "#背景" },
    { id: "a3", type: "link", x: 0, y: 300, width: 300, height: 160, url: "https://jsoncanvas.org" },
    { id: "a4", type: "group", x: -40, y: -40, width: 800, height: 400, label: "研究", color: "4" },
  ],
  edges: [{ id: "e1", fromNode: "a1", fromSide: "right", toNode: "a2", toSide: "left", label: "支撐", color: "2" }],
};

describe("parseCanvas", () => {
  it("解析四種節點與邊,欄位完整保留", () => {
    const canvas = parseCanvas(JSON.stringify(sample));
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.nodes).toHaveLength(4);
    expect(canvas.nodes[0]).toMatchObject({ id: "a1", type: "text", text: "# 想法\n\n第一條" });
    expect(canvas.nodes[1]).toMatchObject({ type: "file", file: "專案/立項.md", subpath: "#背景" });
    expect(canvas.nodes[2]).toMatchObject({ type: "link", url: "https://jsoncanvas.org" });
    expect(canvas.nodes[3]).toMatchObject({ type: "group", label: "研究", color: "4" });
    expect(canvas.edges[0]).toMatchObject({ id: "e1", fromNode: "a1", fromSide: "right", toNode: "a2", label: "支撐" });
  });

  it("空字串與空物件都是空白板(新建的檔案就是這樣)", () => {
    for (const source of ["", "  \n", "{}", '{"nodes":[],"edges":[]}']) {
      const canvas = parseCanvas(source);
      expect("error" in canvas).toBe(false);
      if ("error" in canvas) return;
      expect(canvas.nodes).toEqual([]);
      expect(canvas.edges).toEqual([]);
    }
  });

  it("JSON 壞掉回 error 而非拋(協作合併中途可能讀到半成品)", () => {
    const outcome = parseCanvas('{"nodes": [oops');
    expect("error" in outcome && outcome.error.length > 0).toBe(true);
  });

  it("頂層是陣列或純量一律 error(那不是白板)", () => {
    expect("error" in parseCanvas("[]")).toBe(true);
    expect("error" in parseCanvas('"字串"')).toBe(true);
    expect("error" in parseCanvas("null")).toBe(true);
  });

  it("nodes/edges 不是陣列時當作沒有,不是整份壞掉", () => {
    const canvas = parseCanvas('{"nodes": "壞", "edges": 3}');
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.nodes).toEqual([]);
    expect(canvas.edges).toEqual([]);
  });

  it("缺必要欄位、座標非有限數、未知 type 的節點逐一丟棄,其餘照常", () => {
    const canvas = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "好", type: "text", x: 1, y: 2, width: 3, height: 4, text: "留" },
          { type: "text", x: 0, y: 0, width: 1, height: 1, text: "缺 id" },
          { id: "無座標", type: "text", y: 0, width: 1, height: 1, text: "x 不見了" },
          { id: "非數", type: "text", x: "0", y: 0, width: 1, height: 1, text: "x 是字串" },
          { id: "無限", type: "text", x: Infinity, y: 0, width: 1, height: 1, text: "炸掉渲染" },
          { id: "怪型", type: "hologram", x: 0, y: 0, width: 1, height: 1 },
          { id: "缺內容", type: "file", x: 0, y: 0, width: 1, height: 1 },
        ],
      }),
    );
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.nodes.map((n) => n.id)).toEqual(["好"]);
  });

  it("Infinity 序列化成 null 的往返也擋得住", () => {
    const canvas = parseCanvas('{"nodes":[{"id":"n","type":"text","x":null,"y":0,"width":1,"height":1,"text":"x"}]}');
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.nodes).toEqual([]);
  });

  it("id 重複時只留第一個(重複 id 會讓邊指向不確定的節點)", () => {
    const canvas = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "x", type: "text", x: 0, y: 0, width: 1, height: 1, text: "先" },
          { id: "x", type: "text", x: 9, y: 9, width: 1, height: 1, text: "後" },
        ],
      }),
    );
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0]).toMatchObject({ text: "先" });
  });

  it("兩端接不到節點的懸空邊丟棄", () => {
    const canvas = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" }],
        edges: [
          { id: "e1", fromNode: "a", toNode: "不存在" },
          { id: "e2", fromNode: "幽靈", toNode: "a" },
          { id: "e3", fromNode: "a", toNode: "a" },
        ],
      }),
    );
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.edges.map((e) => e.id)).toEqual(["e3"]); // 自環是合法的(節點指向自己)
  });

  it("side/end/backgroundStyle 的非法值當作沒填,不讓整筆消失", () => {
    const canvas = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
          { id: "b", type: "group", x: 0, y: 0, width: 1, height: 1, backgroundStyle: "斜的" },
        ],
        edges: [{ id: "e", fromNode: "a", toNode: "b", fromSide: "上面", toEnd: "火箭" }],
      }),
    );
    expect("error" in canvas).toBe(false);
    if ("error" in canvas) return;
    expect(canvas.nodes[1]).not.toHaveProperty("backgroundStyle");
    expect(canvas.edges[0]).not.toHaveProperty("fromSide");
    expect(canvas.edges[0]).not.toHaveProperty("toEnd");
  });
});

describe("serializeCanvas", () => {
  it("原封不動地往返:欄位不增不減", () => {
    const canvas = parseCanvas(JSON.stringify(sample));
    if ("error" in canvas) throw new Error(canvas.error);
    expect(JSON.parse(serializeCanvas(canvas))).toEqual(sample);
  });

  it("看不懂的欄位照樣帶回去(別的工具寫的資料不能被我們抹掉)", () => {
    const source = JSON.stringify({
      nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "嗨", styleAttributes: { shape: "pill" } }],
      edges: [{ id: "e", fromNode: "a", toNode: "a", futureField: 7 }],
      metadata: { frontmatter: { tags: ["白板"] } },
    });
    const canvas = parseCanvas(source);
    if ("error" in canvas) throw new Error(canvas.error);
    expect(JSON.parse(serializeCanvas(canvas))).toEqual(JSON.parse(source));
  });

  it("已知欄位在未知欄位之前,且不讓未知欄位蓋掉已知欄位", () => {
    const canvas = parseCanvas('{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1,"text":"對","z":1}]}');
    if ("error" in canvas) throw new Error(canvas.error);
    const moved = { ...canvas, nodes: [{ ...canvas.nodes[0]!, x: 42 }] };
    const out = JSON.parse(serializeCanvas(moved)) as { nodes: Array<Record<string, unknown>> };
    expect(out.nodes[0]).toMatchObject({ x: 42, z: 1 });
    expect(Object.keys(out.nodes[0]!).slice(0, 2)).toEqual(["id", "type"]);
  });

  it("未填的選用欄位不寫出來(不製造 color: undefined 這種噪音)", () => {
    const out = serializeCanvas({
      nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" }],
      edges: [{ id: "e", fromNode: "a", toNode: "a" }],
    });
    expect(out).not.toContain("color");
    expect(out).not.toContain("fromSide");
  });

  it("縮排兩格、結尾換行:白板檔在 git diff 裡要讀得懂", () => {
    const out = serializeCanvas(emptyCanvas());
    expect(out.endsWith("\n")).toBe(true);
    expect(serializeCanvas(parseCanvas(JSON.stringify(sample)) as never)).toContain('\n    {\n      "id": "a1"');
  });

  it("空白板也寫出 nodes 與 edges 兩個空陣列(下次讀回來仍是白板)", () => {
    expect(JSON.parse(serializeCanvas(emptyCanvas()))).toEqual({ nodes: [], edges: [] });
  });
});

describe("canvasFileLinks", () => {
  it("列出 file 節點指向的筆記,去重且忽略其他型別", () => {
    expect(canvasFileLinks(JSON.stringify(sample))).toEqual(["專案/立項.md"]);
  });

  it("同一份筆記被放兩次只算一條", () => {
    const source = JSON.stringify({
      nodes: [
        { id: "a", type: "file", x: 0, y: 0, width: 1, height: 1, file: "A.md" },
        { id: "b", type: "file", x: 0, y: 0, width: 1, height: 1, file: "A.md", subpath: "#二" },
        { id: "c", type: "file", x: 0, y: 0, width: 1, height: 1, file: "圖/封面.png" },
      ],
    });
    expect(canvasFileLinks(source)).toEqual(["A.md", "圖/封面.png"]);
  });

  it("壞掉的白板回空陣列,不讓索引重建炸掉", () => {
    expect(canvasFileLinks("{壞")).toEqual([]);
  });
});

describe("rewriteCanvasFiles", () => {
  it("改名筆記時跟著改 file 欄位,其餘一字不動", () => {
    const out = rewriteCanvasFiles(JSON.stringify(sample), (file) => (file === "專案/立項.md" ? "專案/Stele 立項.md" : null));
    const canvas = parseCanvas(out);
    if ("error" in canvas) throw new Error(canvas.error);
    expect(canvas.nodes[1]).toMatchObject({ file: "專案/Stele 立項.md", subpath: "#背景" });
    expect(canvas.nodes[0]).toMatchObject({ text: "# 想法\n\n第一條" });
  });

  it("沒有命中就回傳原字串本身(不重寫檔案、不製造無謂的同步流量)", () => {
    const source = JSON.stringify(sample);
    expect(rewriteCanvasFiles(source, () => null)).toBe(source);
  });

  it("白板壞掉時原樣返回:改名不是修檔的時機,寧可不動", () => {
    expect(rewriteCanvasFiles("{壞", () => "新.md")).toBe("{壞");
  });
});

describe("canvasText", () => {
  it("串出可被全文搜尋的內容:節點文字、群組標籤、邊標籤、連結與檔名", () => {
    const text = canvasText(JSON.stringify(sample));
    for (const piece of ["第一條", "研究", "支撐", "jsoncanvas.org", "專案/立項.md"]) {
      expect(text).toContain(piece);
    }
  });

  it("壞掉的白板回空字串", () => {
    expect(canvasText("{壞")).toBe("");
  });
});
