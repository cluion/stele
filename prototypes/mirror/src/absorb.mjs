// 策略 A 驗證:CRDT 存原始 Markdown 文字 + 外部修改吸收 + 併發合併
import * as Y from "yjs";
import diff from "fast-diff";
import { readFileSync } from "node:fs";

// 外部修改 → 最小 diff → CRDT 操作(這就是鏡像引擎「吸收」的核心)
function absorbExternalEdit(ytext, newContent) {
  const ops = diff(ytext.toString(), newContent);
  let pos = 0;
  ytext.doc.transact(() => {
    for (const [kind, text] of ops) {
      if (kind === 0) pos += text.length;          // 未變
      else if (kind === -1) ytext.delete(pos, text.length); // 刪除
      else { ytext.insert(pos, text); pos += text.length; } // 插入
    }
  }, "external-file"); // origin 標記:fsWatch 迴圈防護就靠這個
}

const original = readFileSync(new URL("../fixtures/obsidian.md", import.meta.url), "utf8");

// 裝置 A 持有文件
const docA = new Y.Doc();
const textA = docA.getText("md");
textA.insert(0, original);

// 裝置 B(協作者)拿到同一份
const docB = new Y.Doc();
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
const textB = docB.getText("md");

// 同時發生:
// 1. 使用者在裝置 A 之外用別的編輯器改了檔案(改 frontmatter + 改一行 + 加一段)
const externalEdit = original
  .replace("title: Obsidian 語法測試", "title: 標題被外部編輯器改掉")
  .replace("==螢光標記==", "==被改過的螢光標記==")
  + "\n外部工具在檔尾加的一行。\n";
// 2. 協作者在裝置 B 的 callout 裡打字
const calloutPos = textB.toString().indexOf("內容第二行");
textB.insert(calloutPos + "內容第二行".length, "(B 在協作中補充)");

// 裝置 A 吸收外部修改
absorbExternalEdit(textA, externalEdit);

// 雙向同步
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

const finalA = textA.toString();
const finalB = textB.toString();
const checks = {
  兩端收斂一致: finalA === finalB,
  外部改的標題保留: finalA.includes("標題被外部編輯器改掉"),
  外部改的螢光標記保留: finalA.includes("==被改過的螢光標記=="),
  外部加的檔尾行保留: finalA.includes("外部工具在檔尾加的一行"),
  協作者的併發輸入保留: finalA.includes("(B 在協作中補充)"),
  未被動到的部分零損傷: finalA.includes("> [!note] 這是 callout") && finalA.includes("^block-id-123"),
};
console.log(JSON.stringify(checks, null, 2));
console.log(Object.values(checks).every(Boolean) ? "\n✅ 策略 A:吸收 + 併發合併全數通過" : "\n❌ 有項目失敗");
