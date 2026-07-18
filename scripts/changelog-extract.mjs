// 從 CHANGELOG.md 抽出指定版本那一節,供發版 workflow 當 release notes
// 用法:node scripts/changelog-extract.mjs 0.4.0(或帶 v 前綴 v0.4.0)
// 找不到該版本即以非零碼結束,讓 CI 大聲失敗而非發出空 notes
import { readFileSync } from "node:fs";

const raw = process.argv[2];
if (!raw) {
  console.error("用法:node scripts/changelog-extract.mjs <version>");
  process.exit(2);
}
const version = raw.replace(/^v/, "");

const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
const headingIdx = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (headingIdx === -1) {
  console.error(`CHANGELOG.md 找不到版本 [${version}] 的章節`);
  process.exit(1);
}

// 從標題下一行起,取到下一個 "## [" 章節或底部連結參照 "[x.y.z]:" 為止
const body = [];
for (let i = headingIdx + 1; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith("## [")) break;
  if (/^\[\d/.test(line)) break; // 底部版本比較連結區
  body.push(line);
}

const notes = body.join("\n").trim();
if (!notes) {
  console.error(`版本 [${version}] 章節內容為空`);
  process.exit(1);
}
process.stdout.write(notes + "\n");
