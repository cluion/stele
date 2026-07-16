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
