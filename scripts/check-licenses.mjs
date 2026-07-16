// 依賴授權檢查:政策=MIT 或 dual 含 MIT;其餘須列入例外清單並附理由
// 只檢查 production 依賴;devDependencies 不隨產品散布,不在此限
import { execFileSync } from "node:child_process";

/** 個案核可的非 MIT 授權,格式:套件名 → 理由 */
const EXCEPTIONS = new Map([
  ["fast-diff", "Apache-2.0,OSI 寬鬆授權與 MIT 相容;鏡像引擎最小 diff 核心,Quill 團隊維護"],
  ["argparse", "Python-2.0,OSI 寬鬆授權;markdown-it 傳遞依賴,無法單獨替換"],
  ["entities", "BSD-2-Clause,OSI 寬鬆授權;markdown-it 傳遞依賴,無法單獨替換"],
  ["typescript", "Apache-2.0,僅 devDependencies;pnpm licenses --prod 誤列,不隨產品散布"],
]);

const passes = (license) => license.split(/\s+OR\s+|[()]/i).some((part) => part.trim().startsWith("MIT"));

const raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
  encoding: "utf8",
  cwd: new URL("..", import.meta.url).pathname,
});
const byLicense = JSON.parse(raw);

const violations = [];
for (const [license, packages] of Object.entries(byLicense)) {
  if (passes(license)) continue;
  for (const pkg of packages) {
    if (EXCEPTIONS.has(pkg.name)) continue;
    violations.push(`${pkg.name}@${pkg.versions.join(",")} — ${license}`);
  }
}

if (violations.length > 0) {
  console.error("❌ 非 MIT 授權且不在例外清單的依賴:");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("✅ 所有 production 依賴符合 MIT 授權政策");
