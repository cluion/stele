// 網頁端 bundle 體積實測:esbuild 打包 + gzip
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const kb = (n) => Math.round((n / 1024) * 10) / 10;
const require = createRequire(import.meta.url);

async function bundleJs(name, code) {
  const r = await build({
    stdin: { contents: code, resolveDir: process.cwd() },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["*.wasm"],
    logLevel: "silent",
  });
  const out = r.outputFiles[0].contents;
  return { name, raw: kb(out.length), gzip: kb(gzipSync(out).length) };
}

const yjs = await bundleJs("yjs (純 JS)", `import * as Y from "yjs"; const d=new Y.Doc(); d.getText("t").insert(0,"x"); console.log(Y.encodeStateAsUpdate(d).length);`);
const loroJs = await bundleJs("loro-crdt JS 膠水層", `import { LoroDoc } from "loro-crdt"; const d=new LoroDoc(); d.getText("t").insert(0,"x"); console.log(d.export({mode:"snapshot"}).length);`);

// Loro 的 WASM 主體(瀏覽器要另外載這個檔)
const loroDir = require.resolve("loro-crdt/package.json").replace(/package\.json$/, "");
let wasm = null;
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = dir + "/" + f;
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".wasm")) {
      const buf = readFileSync(p);
      if (!wasm || buf.length > wasm.rawBytes) wasm = { file: p.replace(loroDir, ""), rawBytes: buf.length, raw: kb(buf.length), gzip: kb(gzipSync(buf).length) };
    }
  }
};
walk(loroDir);

console.log(JSON.stringify({
  yjs,
  loro: { js: loroJs, wasm, "合計gzip(KB)": Math.round((loroJs.gzip + (wasm?.gzip ?? 0)) * 10) / 10 },
}, null, 2));
