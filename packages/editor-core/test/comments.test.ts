import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  encodeAnchor,
  decodeAnchor,
  addThread,
  addReply,
  setResolved,
  deleteThread,
  readThreads,
} from "../src/index.ts";

function noteWith(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, text);
  return { doc, ytext };
}

describe("留言資料模型", () => {
  it("addThread/readThreads 往返;含根留言欄位", () => {
    const doc = new Y.Doc();
    addThread(doc, { id: "t1", anchor: { a: "AA", h: "BB" }, author: "d1", name: "甲", body: "這段怪怪的", createdAt: 100 });
    const threads = readThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "t1", author: "d1", name: "甲", body: "這段怪怪的", resolved: false, replies: [] });
    expect(threads[0]!.anchor).toEqual({ a: "AA", h: "BB" });
  });

  it("addReply 依序附加;resolve/delete 生效", () => {
    const doc = new Y.Doc();
    addThread(doc, { id: "t1", anchor: { a: "AA", h: "BB" }, author: "d1", name: "甲", body: "根", createdAt: 100 });
    addReply(doc, "t1", { id: "r1", author: "d2", name: "乙", body: "同意", createdAt: 200 });
    addReply(doc, "t1", { id: "r2", author: "d1", name: "甲", body: "改好了", createdAt: 300 });
    expect(readThreads(doc)[0]!.replies.map((r) => r.body)).toEqual(["同意", "改好了"]);

    setResolved(doc, "t1", true);
    expect(readThreads(doc)[0]!.resolved).toBe(true);

    deleteThread(doc, "t1");
    expect(readThreads(doc)).toHaveLength(0);
  });

  it("兩裝置各自加討論串/回覆,merge 後都在(CRDT)", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addThread(a, { id: "t1", anchor: { a: "AA", h: "BB" }, author: "d1", name: "甲", body: "甲的串", createdAt: 100 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); // b 先同步到 a
    addReply(b, "t1", { id: "r1", author: "d2", name: "乙", body: "乙的回覆", createdAt: 200 });
    addThread(a, { id: "t2", anchor: { a: "CC", h: "DD" }, author: "d1", name: "甲", body: "甲的第二串", createdAt: 300 });
    // 雙向 merge
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ta = readThreads(a);
    const tb = readThreads(b);
    expect(ta.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(tb.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(ta.find((t) => t.id === "t1")!.replies.map((r) => r.body)).toEqual(["乙的回覆"]);
  });
});

describe("留言範圍錨定", () => {
  it("encodeAnchor/decodeAnchor 往返到原範圍", () => {
    const { doc, ytext } = noteWith("零一二三四五六七八九");
    const anchor = encodeAnchor(ytext, 2, 5);
    expect(decodeAnchor(doc, ytext, anchor)).toEqual({ from: 2, to: 5 });
  });

  it("在錨前插字,範圍自動位移", () => {
    const { doc, ytext } = noteWith("零一二三四五六七八九");
    const anchor = encodeAnchor(ytext, 4, 6); // 「四五」
    ytext.insert(0, "★★★"); // 前面插 3 字
    expect(decodeAnchor(doc, ytext, anchor)).toEqual({ from: 7, to: 9 });
  });

  it("錨定區間被刪,decode 塌縮成零長度(from===to,視為原文已刪)", () => {
    const { doc, ytext } = noteWith("零一二三四五六七八九");
    const anchor = encodeAnchor(ytext, 3, 7);
    ytext.delete(3, 4); // 刪掉錨定區間「三四五六」
    const range = decodeAnchor(doc, ytext, anchor);
    expect(range).not.toBeNull();
    expect(range!.from).toBe(range!.to); // 塌縮=孤兒
  });
});
