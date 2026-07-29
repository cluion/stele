import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/app.ts"],
  outfile: "dist/app.js",
  bundle: true,
  sourcemap: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  logLevel: "warning",
  loader: { ".css": "css" },
});

await build({
  entryPoints: ["src/app.css"],
  outfile: "dist/app.css",
  bundle: true,
  logLevel: "warning",
});

copyFileSync("index.html", "dist/index.html");
