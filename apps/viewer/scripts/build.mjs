import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/viewer.ts"],
  outfile: "dist/viewer.js",
  bundle: true,
  sourcemap: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  logLevel: "warning",
});

copyFileSync("index.html", "dist/index.html");
