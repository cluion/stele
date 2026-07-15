/**
 * 回歸測試:空段落與 blocks 映射的 1:1 不變量
 * 段尾 Enter 產生的空段落序列化為空字串,從文字重解析會漏掉它;
 * writeBack 必須就地維護映射,否則之後每次寫回都寫錯範圍(吃字、複製區塊)
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { TextSelection, type Transaction } from "prosemirror-state";
import { SteleBinding } from "../src/index.ts";

function setup(source: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, source);
  const binding = new SteleBinding(ytext);
  return { doc, ytext, binding };
}

function pressEnter(binding: SteleBinding): boolean {
  const fakeEvent = {
    key: "Enter",
    keyCode: 13,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  } as KeyboardEvent;
  const fakeView = {
    state: binding.state,
    dispatch: (tr: Transaction) => binding.dispatch(tr),
    endOfTextblock: () => false,
    composing: false,
  };
  return binding.state.plugins.some((p) =>
    (p.props.handleKeyDown as ((view: unknown, e: KeyboardEvent) => boolean) | undefined)?.(fakeView, fakeEvent),
  );
}

/** 第 index 個頂層子節點內 offset 處的 PM 位置 */
function posInChild(binding: SteleBinding, index: number, offset: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += binding.state.doc.child(i).nodeSize;
  return pos + 1 + offset;
}

function typeText(binding: SteleBinding, text: string): void {
  binding.dispatch(binding.state.tr.insertText(text, binding.state.selection.from));
}

describe("空段落後續編輯的收斂", () => {
  it("段尾 Enter → 空段落打字,字不消失", () => {
    const { ytext, binding } = setup("段落。\n");
    binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, 1 + 3)));
    pressEnter(binding);
    typeText(binding, "新");
    expect(ytext.toString()).toContain("段落。");
    expect(ytext.toString()).toContain("新");
    expect(binding.state.doc.textContent).toContain("新");
  });

  it("標題尾 Enter → 連打兩字,既有段落不被吃", () => {
    const { ytext, binding } = setup("# 標題\n\n內文。\n");
    binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, 1 + 2)));
    pressEnter(binding);
    typeText(binding, "甲");
    typeText(binding, "乙");
    expect(ytext.toString()).toContain("甲乙");
    expect(ytext.toString()).toContain("內文。");
    expect(ytext.toString()).toContain("# 標題");
  });

  it("連按兩次 Enter(兩個空段落)再打字,收斂一致", () => {
    const { ytext, binding } = setup("段落。\n");
    binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, 1 + 3)));
    pressEnter(binding);
    pressEnter(binding);
    typeText(binding, "尾");
    expect(ytext.toString()).toContain("段落。");
    expect(ytext.toString()).toContain("尾");
    expect(binding.state.doc.textContent).toBe("段落。尾");
  });

  it("code block 內 Enter 是換行,不分裂區塊", () => {
    const { ytext, binding } = setup("```\nabc\n```\n");
    expect(binding.state.doc.child(0).type.name).toBe("code_block");
    binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, posInChild(binding, 0, 3))));
    pressEnter(binding);
    pressEnter(binding);
    typeText(binding, "x");
    expect(binding.state.doc.childCount).toBe(1);
    expect((ytext.toString().match(/```/g) ?? []).length).toBe(2); // 仍只有一組 fence
    expect(ytext.toString()).toContain("x");
  });

  it("空段落存在時,遠端變更不炸且收斂", () => {
    const { ytext, binding } = setup("甲。\n\n乙。\n");
    binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, 1 + 2)));
    pressEnter(binding); // 甲。後插空段落
    ytext.insert(ytext.toString().indexOf("乙。"), "遠"); // 遠端修改
    expect(binding.state.doc.textContent).toContain("遠乙。");
    typeText(binding, "後");
    expect(ytext.toString()).toContain("遠乙。");
    expect(ytext.toString()).toContain("後");
  });
});
