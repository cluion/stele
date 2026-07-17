import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import { encodeCursor, decodeCursor, participantCursor, throttle } from "../src/renderer/remote-cursors.ts";

function docWith(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, text);
  return { doc, ytext };
}

describe("遠端游標編解碼", () => {
  it("往返還原相同 offset", () => {
    const { doc, ytext } = docWith("hello world");
    const payload = encodeCursor(ytext, 2, 7);
    expect(decodeCursor(doc, ytext, payload)).toEqual({ anchor: 2, head: 7 });
  });

  it("relative position 抗漂移:前方插字後 offset 自動位移", () => {
    const { doc, ytext } = docWith("hello world");
    const payload = encodeCursor(ytext, 6, 11); // 指向 "world"
    ytext.insert(0, ">> "); // 前面插 3 字
    expect(decodeCursor(doc, ytext, payload)).toEqual({ anchor: 9, head: 14 });
  });

  it("participantCursor 從 state.cur 抽出可渲染游標", () => {
    const { doc, ytext } = docWith("abcdef");
    const cur = encodeCursor(ytext, 1, 4);
    const p = { clientId: 42, name: "甲", color: "#0e7b93", state: { name: "甲", cur } };
    expect(participantCursor(doc, ytext, p)).toEqual({ clientId: 42, name: "甲", color: "#0e7b93", anchor: 1, head: 4 });
  });

  it("沒有 cur 欄位回 null", () => {
    const { doc, ytext } = docWith("abc");
    const p = { clientId: 1, name: "乙", color: "#000", state: { name: "乙" } };
    expect(participantCursor(doc, ytext, p)).toBeNull();
  });

  it("壞掉的 payload 不拋錯,回 null", () => {
    const { doc, ytext } = docWith("abc");
    expect(decodeCursor(doc, ytext, { a: "!!!壞", h: "###" })).toBeNull();
  });
});

describe("throttle", () => {
  afterEach(() => vi.useRealTimers());

  it("立刻送第一次,期間合併,最後一次保證送出", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const t = throttle((n: number) => seen.push(n), 90);
    t.call(1); // leading:立刻
    t.call(2);
    t.call(3); // 期間合併
    expect(seen).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1, 3]); // trailing 送最後一次
  });

  it("cancel 後不再送 trailing", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const t = throttle((n: number) => seen.push(n), 90);
    t.call(1);
    t.call(2);
    t.cancel();
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([1]);
  });
});
