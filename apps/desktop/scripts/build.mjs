import { build } from "esbuild";

const shared = { bundle: true, sourcemap: true, logLevel: "warning" };

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
