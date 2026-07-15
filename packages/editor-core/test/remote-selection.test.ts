/**
 * selection mapping 純函式:PM 位置 ↔ 純文字偏移 ↔ fast-diff 映射
 */
import { describe, it, expect } from "vitest";
import { textOffsetAt, posAtTextOffset, mapTextOffset } from "../src/remote-selection.ts";
import { parseDoc } from "../src/index.ts";

describe("mapTextOffset", () => {
  it("游標前插入 → 右移", () => {
    expect(mapTextOffset("甲乙丙", "遠甲乙丙", 2)).toBe(3);
  });

  it("游標後插入 → 不動", () => {
    expect(mapTextOffset("甲乙丙", "甲乙丙遠", 2)).toBe(2);
  });

  it("游標前刪除 → 左移", () => {
    expect(mapTextOffset("甲乙丙丁", "丙丁", 3)).toBe(1);
  });

  it("刪除跨過游標 → 夾到刪除點", () => {
    expect(mapTextOffset("甲乙丙丁", "甲丁", 2)).toBe(1);
  });

  it("整段替換 → 夾住不越界", () => {
    const mapped = mapTextOffset("原文", "完全不同的新文", 1);
    expect(mapped).toBeGreaterThanOrEqual(0);
    expect(mapped).toBeLessThanOrEqual("完全不同的新文".length);
  });

  it("offset 0 恆為插入後前緣", () => {
    expect(mapTextOffset("乙", "甲乙", 0)).toBeLessThanOrEqual(1);
  });
});

describe("textOffsetAt / posAtTextOffset 往返", () => {
  const { doc } = parseDoc("# 標題\n\n甲乙[[目標|別名]]丙。\n");

  it("PM 位置 → 偏移 → PM 位置往返一致(含 wikilink atom)", () => {
    const span = { from: 0, to: doc.content.size };
    for (let pos = 1; pos < doc.content.size - 1; pos++) {
      const offset = textOffsetAt(doc, span.from, pos);
      const back = posAtTextOffset(doc, span.from, span.to, offset);
      // 往返後偏移必須相同(位置可落在等價的區塊邊界)
      expect(textOffsetAt(doc, span.from, back)).toBe(offset);
    }
  });

  it("偏移隨位置單調不減", () => {
    let prev = -1;
    for (let pos = 0; pos <= doc.content.size; pos++) {
      const offset = textOffsetAt(doc, 0, pos);
      expect(offset).toBeGreaterThanOrEqual(prev);
      prev = offset;
    }
  });
});
