/**
 * WYSIWYG 的 markdown 快捷輸入與跳出 code block
 * 走 plugin 的 handleTextInput / handleKeyDown,與真實視圖同一路徑
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

function fakeView(binding: SteleBinding) {
  return {
    get state() {
      return binding.state;
    },
    dispatch: (tr: Transaction) => binding.dispatch(tr),
    endOfTextblock: () => false,
    composing: false,
  };
}

/** 模擬逐字打字:先問 handleTextInput(input rules),沒人接手才普通插入 */
function typeText(binding: SteleBinding, text: string): void {
  for (const ch of text) {
    const { from, to } = binding.state.selection;
    const handled = binding.state.plugins.some((p) =>
      (p.props.handleTextInput as ((view: unknown, from: number, to: number, text: string) => boolean) | undefined)?.(
        fakeView(binding),
        from,
        to,
        ch,
      ),
    );
    if (!handled) binding.dispatch(binding.state.tr.insertText(ch, from, to));
  }
}

function pressKey(binding: SteleBinding, event: Partial<KeyboardEvent> & { key: string }): boolean {
  const fakeEvent = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...event } as KeyboardEvent;
  return binding.state.plugins.some((p) =>
    (p.props.handleKeyDown as ((view: unknown, e: KeyboardEvent) => boolean) | undefined)?.(fakeView(binding), fakeEvent),
  );
}

/** 游標移到第 index 個頂層子節點內 offset 處 */
function placeCursor(binding: SteleBinding, index: number, offset: number): void {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += binding.state.doc.child(i).nodeSize;
  binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, pos + 1 + offset)));
}

describe("markdown 快捷輸入", () => {
  it("``` 變 code block,並寫回 fence", () => {
    const { ytext, binding } = setup("先佔位\n");
    placeCursor(binding, 0, 0);
    binding.dispatch(binding.state.tr.insertText("", 1, 1 + 3)); // 清空段落
    typeText(binding, "```");
    expect(binding.state.doc.child(0).type.name).toBe("code_block");
    typeText(binding, "code");
    expect(ytext.toString()).toContain("```\ncode");
  });

  it("# + 空格變標題", () => {
    const { ytext, binding } = setup("字\n");
    placeCursor(binding, 0, 0);
    typeText(binding, "# ");
    expect(binding.state.doc.child(0).type.name).toBe("heading");
    expect(binding.state.doc.child(0).attrs["level"]).toBe(1);
    expect(ytext.toString()).toBe("# 字\n");
  });

  it("## + 空格變二級標題", () => {
    const { binding } = setup("字\n");
    placeCursor(binding, 0, 0);
    typeText(binding, "## ");
    expect(binding.state.doc.child(0).attrs["level"]).toBe(2);
  });

  it("- + 空格變無序清單", () => {
    const { ytext, binding } = setup("項目\n");
    placeCursor(binding, 0, 0);
    typeText(binding, "- ");
    expect(binding.state.doc.child(0).type.name).toBe("bullet_list");
    expect(ytext.toString()).toContain("- 項目");
  });

  it("1. + 空格變有序清單", () => {
    const { binding } = setup("項目\n");
    placeCursor(binding, 0, 0);
    typeText(binding, "1. ");
    expect(binding.state.doc.child(0).type.name).toBe("ordered_list");
  });

  it("> + 空格變引用", () => {
    const { binding } = setup("引言\n");
    placeCursor(binding, 0, 0);
    typeText(binding, "> ");
    expect(binding.state.doc.child(0).type.name).toBe("blockquote");
  });

  it("code block 內打 # 不觸發規則", () => {
    const { binding } = setup("```\nx\n```\n");
    placeCursor(binding, 0, 0);
    typeText(binding, "# ");
    expect(binding.state.doc.child(0).type.name).toBe("code_block");
    expect(binding.state.doc.childCount).toBe(1);
  });
});

describe("清單接續", () => {
  it("有序清單項尾 Enter → 接續為第 2 項", () => {
    const { ytext, binding } = setup("1. 123\n");
    binding.dispatch(
      binding.state.tr.setSelection(TextSelection.near(binding.state.doc.resolve(binding.state.doc.content.size), -1)),
    );
    const handled = pressKey(binding, { key: "Enter", keyCode: 13 });
    expect(handled).toBe(true);
    typeText(binding, "456");
    expect(ytext.toString()).toContain("1. 123");
    expect(ytext.toString()).toContain("2. 456");
  });

  it("無序清單項尾 Enter → 新項目沿用原符號", () => {
    const { ytext, binding } = setup("- 甲\n");
    binding.dispatch(
      binding.state.tr.setSelection(TextSelection.near(binding.state.doc.resolve(binding.state.doc.content.size), -1)),
    );
    pressKey(binding, { key: "Enter", keyCode: 13 });
    typeText(binding, "乙");
    expect(ytext.toString()).toContain("- 甲");
    expect(ytext.toString()).toContain("- 乙");
  });

  it("空清單項按 Enter → 跳出清單", () => {
    const { binding } = setup("- 甲\n");
    binding.dispatch(
      binding.state.tr.setSelection(TextSelection.near(binding.state.doc.resolve(binding.state.doc.content.size), -1)),
    );
    pressKey(binding, { key: "Enter", keyCode: 13 }); // 產生空項
    pressKey(binding, { key: "Enter", keyCode: 13 }); // 空項再 Enter → 離開清單
    expect(binding.state.doc.childCount).toBe(2);
    expect(binding.state.doc.child(1).type.name).toBe("paragraph");
  });
});

describe("跳出 code block", () => {
  it("文末 code block 最後一行按 ↓ → 建段落跳出", () => {
    const { ytext, binding } = setup("```\nabc\n```\n");
    placeCursor(binding, 0, 3);
    // fakeView 的 endOfTextblock 回 true,模擬游標已在區塊底部
    const fakeEvent = { key: "ArrowDown", keyCode: 40, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as KeyboardEvent;
    const view = { ...fakeView(binding), endOfTextblock: () => true };
    const handled = binding.state.plugins.some((p) =>
      (p.props.handleKeyDown as ((view: unknown, e: KeyboardEvent) => boolean) | undefined)?.(view, fakeEvent),
    );
    expect(handled).toBe(true);
    typeText(binding, "下面");
    expect(binding.state.doc.child(1).type.name).toBe("paragraph");
    expect(ytext.toString()).toContain("```\nabc\n```");
    expect(ytext.toString()).toContain("下面");
  });

  it("code block 不在文末時,↓ 不攔截(交給預設行為)", () => {
    const { binding } = setup("```\nabc\n```\n\n後段。\n");
    placeCursor(binding, 0, 3);
    const fakeEvent = { key: "ArrowDown", keyCode: 40, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as KeyboardEvent;
    const view = { ...fakeView(binding), endOfTextblock: () => true };
    const handled = binding.state.plugins.some((p) =>
      (p.props.handleKeyDown as ((view: unknown, e: KeyboardEvent) => boolean) | undefined)?.(view, fakeEvent),
    );
    expect(handled).toBe(false); // PM 預設會把游標移進後段
    expect(binding.state.doc.childCount).toBe(2);
  });

  it("Shift-Enter 在 code block 尾跳出到新段落", () => {
    const { ytext, binding } = setup("```\nabc\n```\n");
    placeCursor(binding, 0, 3);
    const handled = pressKey(binding, { key: "Enter", keyCode: 13, shiftKey: true });
    expect(handled).toBe(true);
    typeText(binding, "出來了");
    expect(binding.state.doc.childCount).toBe(2);
    expect(binding.state.doc.child(1).type.name).toBe("paragraph");
    expect(ytext.toString()).toContain("```\nabc\n```");
    expect(ytext.toString()).toContain("出來了");
  });
});
