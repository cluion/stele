import { app, BrowserWindow, ipcMain } from "electron";
import * as Y from "yjs";
import diff from "fast-diff";
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";

const VAULT = process.env["STELE_VAULT"]
  ? path.resolve(process.env["STELE_VAULT"])
  : path.resolve(__dirname, "..", "..", "..", "prototypes", "mirror", "fixtures", "vault");

const MIRROR_DEBOUNCE_MS = 120;

/** 單一筆記的主端文件:唯一寫入者,負責鏡像寫回與外部修改吸收 */
class DocHost {
  readonly ydoc = new Y.Doc();
  private readonly ytext = this.ydoc.getText("md");
  private readonly file: string;
  private lastMirrored: string;
  private mirrorTimer: NodeJS.Timeout | undefined;
  private readonly watcher: FSWatcher;

  constructor(readonly rel: string, broadcast: (rel: string, update: Uint8Array) => void) {
    this.file = path.join(VAULT, rel);
    const initial = readFileSync(this.file, "utf8");
    this.ytext.insert(0, initial);
    this.lastMirrored = initial;

    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      broadcast(rel, update);
      if (origin !== "external-file") this.scheduleMirror();
    });

    this.watcher = chokidar.watch(this.file, { ignoreInitial: true });
    this.watcher.on("change", () => this.absorb());
  }

  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  applyFromRenderer(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, "renderer");
  }

  private scheduleMirror(): void {
    clearTimeout(this.mirrorTimer);
    this.mirrorTimer = setTimeout(() => {
      const content = this.ytext.toString();
      this.lastMirrored = content;
      const tmp = this.file + ".tmp";
      void writeFile(tmp, content)
        .then(() => rename(tmp, this.file))
        .catch((err: unknown) => console.error(`鏡像寫回失敗 ${this.rel}:`, err));
    }, MIRROR_DEBOUNCE_MS);
  }

  private absorb(): void {
    let onDisk: string;
    try {
      onDisk = readFileSync(this.file, "utf8");
    } catch (err) {
      console.error(`讀取外部修改失敗 ${this.rel}:`, err);
      return;
    }
    if (onDisk === this.lastMirrored) return;
    this.ydoc.transact(() => {
      let pos = 0;
      for (const [kind, text] of diff(this.ytext.toString(), onDisk)) {
        if (kind === diff.EQUAL) pos += text.length;
        else if (kind === diff.DELETE) this.ytext.delete(pos, text.length);
        else {
          this.ytext.insert(pos, text);
          pos += text.length;
        }
      }
    }, "external-file");
    this.lastMirrored = onDisk;
  }

  async destroy(): Promise<void> {
    clearTimeout(this.mirrorTimer);
    await this.watcher.close();
    this.ydoc.destroy();
  }
}

const hosts = new Map<string, DocHost>();
const windows = new Set<BrowserWindow>();

function broadcast(rel: string, update: Uint8Array): void {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send("doc:update", rel, update);
  }
}

function listMarkdown(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listMarkdown(full, prefix + name + "/"));
    else if (name.endsWith(".md")) out.push(prefix + name);
  }
  return out;
}

ipcMain.handle("vault:list", () => ({ vault: path.basename(VAULT), files: listMarkdown(VAULT) }));

ipcMain.handle("doc:open", (_e, rel: string) => {
  if (rel.includes("..")) throw new Error(`非法路徑:${rel}`);
  let host = hosts.get(rel);
  if (!host) {
    host = new DocHost(rel, broadcast);
    hosts.set(rel, host);
  }
  return host.snapshot();
});

ipcMain.on("doc:push", (_e, rel: string, update: Uint8Array) => {
  hosts.get(rel)?.applyFromRenderer(update);
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Stele",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));

  if (process.argv.includes("--smoke")) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await sleep(1800);
    const mounted = await win.webContents.executeJavaScript(
      `!!document.querySelector("#editor .ProseMirror") && document.querySelector("#editor .ProseMirror").textContent.length > 0`,
    );

    // 模擬真實鍵盤輸入 → 驗證鏡像寫回磁碟,結束後還原 fixture
    const firstFile = path.join(VAULT, listMarkdown(VAULT)[0]!);
    const originalBytes = readFileSync(firstFile, "utf8");
    await win.webContents.executeJavaScript(`document.querySelector("#editor .ProseMirror").focus()`);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ω" });
    await sleep(900);
    const mirrored = readFileSync(firstFile, "utf8").includes("Ω");
    await writeFile(firstFile, originalBytes);
    await sleep(300);

    console.log(mounted ? "SMOKE ✅ 編輯器掛載且有內容" : "SMOKE ❌ 編輯器未就緒");
    console.log(mirrored ? "SMOKE ✅ 鍵盤輸入已鏡像到磁碟" : "SMOKE ❌ 輸入未寫回磁碟");
    app.exit(mounted && mirrored ? 0 : 1);
  }
});

app.on("window-all-closed", () => app.quit());
