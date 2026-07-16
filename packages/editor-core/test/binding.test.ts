import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { TextSelection, type Transaction } from "prosemirror-state";
import { SteleBinding, splitBlocks } from "../src/index.ts";

const fixturesDir = fileURLToPath(new URL("../../../prototypes/mirror/fixtures/", import.meta.url));
const obsidianMd = readFileSync(fixturesDir + "obsidian.md", "utf8");

function setup(source: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, source);
  const binding = new SteleBinding(ytext);
  return { doc, ytext, binding };
}

describe("SteleBinding:本地編輯寫回", () => {
  it("段落內打字 → Y.Text 更新,其他區塊位元組不動", () => {
    const source = "# 標題\n\n第一段。\n\n第二段。\n";
    const { ytext, binding } = setup(source);
    const tr = binding.state.tr.insertText("插入", 1 + "# 標題".length + 2 + 2); // 第一段「第一」之後
    binding.dispatch(tr);
    const after = ytext.toString();
    expect(after).toContain("插入");
    expect(after).toContain("# 標題\n\n");
    expect(after).toContain("第二段。\n");
    expect(binding.state.doc.textContent).toContain("插入");
  });

  it("Enter 切段:區塊數改變也正確重寫該範圍", () => {
    const source = "一二三四。\n\n下一段。\n";
    const { ytext, binding } = setup(source);
    binding.dispatch(binding.state.tr.split(1 + 2)); // 在「一二」後切段
    expect(ytext.toString()).toBe("一二\n\n三四。\n\n下一段。\n");
    expect(binding.state.doc.childCount).toBe(3);
  });

  it("編輯支援區塊時,鄰近的 opaque 區塊位元組不動", () => {
    const { ytext, binding } = setup(obsidianMd);
    const blocksBefore = splitBlocks(obsidianMd);
    const fmText = obsidianMd.slice(blocksBefore[0]!.from, blocksBefore[0]!.to);
    // 找標題節點的位置:第一個非 opaque 子節點
    let pos = 0;
    let heading = -1;
    for (let i = 0; i < binding.state.doc.childCount; i++) {
      if (binding.state.doc.child(i).type.name === "heading") { heading = i; break; }
      pos += binding.state.doc.child(i).nodeSize;
    }
    expect(heading).toBeGreaterThan(-1);
    binding.dispatch(binding.state.tr.insertText("改", pos + 1));
    const after = ytext.toString();
    expect(after).toContain("改");
    expect(after.startsWith(fmText)).toBe(true); // frontmatter 一字未動
    expect(after).toContain("> [!note] 這是 callout");
  });

  it("純選取變更不寫回", () => {
    const source = "段落。\n";
    const { ytext, binding } = setup(source);
    let updated = 0;
    ytext.doc!.on("update", () => { updated++; });
    binding.dispatch(binding.state.tr.setMeta("ui", true));
    expect(updated).toBe(0);
    expect(ytext.toString()).toBe(source);
  });
});

/** 與 prosemirror-keymap 相同的平台偵測:Mod 在 mac 是 Meta,其他是 Ctrl */
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");
const MOD: Partial<KeyboardEvent> = IS_MAC ? { metaKey: true } : { ctrlKey: true };

/** 模擬 EditorView 的 keydown:走 state 上 keymap plugin 的 handleKeyDown,與真實視圖同一路徑 */
function pressKey(binding: SteleBinding, event: Partial<KeyboardEvent> & { key: string }): boolean {
  const fakeEvent = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...event,
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

describe("SteleBinding:鍵盤指令經 keymap plugin", () => {
  it("Enter 鍵切段並寫回 Y.Text", () => {
    const source = "一二三四。\n";
    const { ytext, binding } = setup(source);
    binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, 3))); // 游標在「一二」後
    const handled = pressKey(binding, { key: "Enter", keyCode: 13 });
    expect(handled).toBe(true);
    expect(ytext.toString()).toBe("一二\n\n三四。\n");
  });

  it("Mod-z 復原本地編輯", () => {
    const { ytext, binding } = setup("段落。\n");
    binding.dispatch(binding.state.tr.insertText("X", 1));
    expect(ytext.toString()).toBe("X段落。\n");
    const handled = pressKey(binding, { key: "z", keyCode: 90, ...MOD });
    expect(handled).toBe(true);
    expect(ytext.toString()).toBe("段落。\n");
  });

  it("遠端變更不進 undo 歷史", () => {
    const source = "甲。\n\n乙。\n";
    const { ytext, binding } = setup(source);
    ytext.insert(ytext.toString().indexOf("乙。"), "遠"); // origin 非 binding → 遠端
    expect(binding.state.doc.textContent).toContain("遠乙。");
    const handled = pressKey(binding, { key: "z", keyCode: 90, ...MOD });
    // 沒有本地編輯可復原:遠端變更標記 addToHistory=false,undo 不得吃掉它
    expect(handled).toBe(false);
    expect(ytext.toString()).toContain("遠乙。");
  });
});

describe("SteleBinding:遠端變更更新 PM", () => {
  it("遠端在中段插入 → PM 反映,未變區塊的節點保持同一參考", () => {
    const source = "甲段。\n\n乙段。\n\n丙段。\n";
    const { ytext, binding } = setup(source);
    const child0 = binding.state.doc.child(0);
    const child2 = binding.state.doc.child(2);
    ytext.insert(source.indexOf("乙段。") + "乙段".length, "被遠端改"); // origin 非 binding → 視為遠端
    expect(binding.state.doc.textContent).toContain("乙段被遠端改");
    expect(binding.state.doc.child(0)).toBe(child0);
    expect(binding.state.doc.child(2)).toBe(child2);
  });

  it("本地寫回不回音:不會再觸發一次 PM 更新", () => {
    const source = "段落。\n";
    const { binding } = setup(source);
    let stateChanges = 0;
    binding.onStateChange = () => { stateChanges++; };
    binding.dispatch(binding.state.tr.insertText("X", 1));
    expect(stateChanges).toBe(1); // 只有 dispatch 本身,沒有 observe 回音
    expect(binding.state.doc.textContent).toBe("X段落。");
  });

  it("本地與遠端交錯後,PM 與 Y.Text 收斂一致", () => {
    const source = "甲。\n\n乙。\n";
    const { ytext, binding } = setup(source);
    binding.dispatch(binding.state.tr.insertText("1", 1));
    ytext.insert(ytext.toString().indexOf("乙。"), "遠");
    binding.dispatch(binding.state.tr.insertText("2", 2));
    const final = ytext.toString();
    expect(final).toContain("12甲。");
    expect(final).toContain("遠乙。");
  });
});
