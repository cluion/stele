import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  sourcemap: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // native module 不能進 bundle,執行環境需自帶
  external: ["better-sqlite3"],
  logLevel: "warning",
});

// 組織管理 CLI(3a):與伺服器同 repo 但**在管理者本機執行**,組織根金鑰不進伺服器環境
await build({
  entryPoints: ["src/org-tool.ts"],
  outfile: "dist/org-tool.cjs",
  bundle: true,
  sourcemap: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["better-sqlite3"],
  logLevel: "warning",
});
