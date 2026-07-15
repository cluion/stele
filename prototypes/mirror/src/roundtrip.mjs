// 策略 B 驗證:md → AST(富結構)→ md 的往返損耗量測
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { readFileSync, readdirSync } from "node:fs";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkStringify); // 預設設定,先量測「不調校」的損耗基準

const dir = new URL("../fixtures/", import.meta.url);
for (const file of readdirSync(dir).sort()) {
  const original = readFileSync(new URL(file, dir), "utf8");
  const output = String(processor.processSync(original));

  if (output === original) {
    console.log(`✅ ${file}:位元組級一致`);
    continue;
  }
  const a = original.split("\n");
  const b = output.split("\n");
  let changed = 0;
  const samples = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      changed++;
      if (samples.length < 8) samples.push(`  原:${JSON.stringify(a[i] ?? "<無>")}\n  出:${JSON.stringify(b[i] ?? "<無>")}`);
    }
  }
  console.log(`❌ ${file}:${changed}/${a.length} 行被改寫。樣本:`);
  console.log(samples.join("\n  ──\n"));
  console.log("");
}
