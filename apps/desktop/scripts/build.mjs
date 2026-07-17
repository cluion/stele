import { build } from "esbuild";
import { writeFileSync } from "node:fs";

const shared = { bundle: true, sourcemap: true, logLevel: "warning" };

// 打包後 asar 內只有 dist/,index.html 與資產同層;dev 也走同一路徑,main.ts loadFile 一致
const INDEX_HTML = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Stele</title>
    <link rel="stylesheet" href="./renderer.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./renderer.js"></script>
  </body>
</html>
`;

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...shared,
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/preload.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...shared,
    entryPoints: ["src/renderer/renderer.tsx"],
    outfile: "dist/renderer.js",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "css" },
  }),
]);

writeFileSync("dist/index.html", INDEX_HTML);
