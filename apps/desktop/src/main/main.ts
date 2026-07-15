import { app, BrowserWindow, ipcMain } from "electron";
import * as Y from "yjs";
import { extractWikilinks, resolveWikilink, type WikilinkRef } from "@stele/editor-core";
import diff from "fast-diff";
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, readdirSync, statSync, realpathSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";

const VAULT = process.env["STELE_VAULT"]
  ? path.resolve(process.env["STELE_VAULT"])
  : path.resolve(__dirname, "..", "..", "..", "prototypes", "mirror", "fixtures", "vault");

const MIRROR_DEBOUNCE_MS = 120;

/** 驗證 renderer 傳來的相對路徑,回傳 vault 內的真實絕對路徑;絕對路徑、遍歷、symlink 逃逸一律拒絕 */
function resolveVaultFile(rel: unknown): string {
  if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel) || !rel.endsWith(".md")) {
    throw new Error(`非法路徑:${String(rel)}`);
  }
  const vaultReal = realpathSync(VAULT);
  let real: string;
  try {
    real = realpathSync(path.resolve(vaultReal, rel));
  } catch {
    throw new Error(`非法路徑:${rel}`);
  }
  if (real !== vaultReal && !real.startsWith(vaultReal + path.sep)) {
    throw new Error(`非法路徑:${rel}`);
  }
  return real;
}

/** 單一筆記的主端文件:唯一寫入者,負責鏡像寫回與外部修改吸收 */
class DocHost {
  readonly ydoc = new Y.Doc();
  private readonly ytext = this.ydoc.getText("md");
  private readonly file: string;
  private lastMirrored: string;
  private mirrorTimer: NodeJS.Timeout | undefined;
  private readonly watcher: FSWatcher;

  constructor(readonly rel: string, file: string, broadcast: (rel: string, update: Uint8Array) => void) {
    this.file = file;
    const initial = readFileSync(this.file, "utf8");
    this.ytext.insert(0, initial);
    this.lastMirrored = initial;

    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      broadcast(rel, update);
      if (origin !== "external-file") this.scheduleMirror();
    });

    // awaitWriteFinish:避免在外部程式 truncate+write 的中途讀到半成品檔案
    this.watcher = chokidar.watch(this.file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });
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

/** vault 級連結索引:反向連結、graph view、快速切換的共同地基 */
class LinkIndex {
  files: string[] = [];
  private outgoing = new Map<string, WikilinkRef[]>();

  rebuild(): void {
    this.files = listMarkdown(VAULT);
    this.outgoing.clear();
    for (const rel of this.files) this.updateFile(rel);
  }

  updateFile(rel: string): void {
    try {
      this.outgoing.set(rel, extractWikilinks(readFileSync(path.join(VAULT, rel), "utf8")));
    } catch {
      this.outgoing.delete(rel);
    }
    if (!this.files.includes(rel)) this.files = [...this.files, rel].sort();
  }

  removeFile(rel: string): void {
    this.outgoing.delete(rel);
    this.files = this.files.filter((f) => f !== rel);
  }

  backlinks(rel: string): Array<{ file: string; line: string }> {
    const result: Array<{ file: string; line: string }> = [];
    for (const [source, refs] of this.outgoing) {
      if (source === rel) continue;
      for (const ref of refs) {
        if (resolveWikilink(this.files, ref.target) === rel) result.push({ file: source, line: ref.line });
      }
    }
    return result;
  }
}

const hosts = new Map<string, DocHost>();
const windows = new Set<BrowserWindow>();
const index = new LinkIndex();

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

ipcMain.handle("vault:backlinks", (_e, rel: unknown) => {
  if (typeof rel !== "string") throw new Error("非法參數");
  return index.backlinks(rel);
});

ipcMain.handle("doc:open", (_e, rel: string) => {
  const file = resolveVaultFile(rel);
  let host = hosts.get(rel);
  if (!host) {
    host = new DocHost(rel, file, broadcast);
    hosts.set(rel, host);
  }
  return host.snapshot();
});

ipcMain.handle("vault:create", (_e, rel: unknown) => {
  if (
    typeof rel !== "string" ||
    rel.length === 0 ||
    path.isAbsolute(rel) ||
    rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new Error(`非法路徑:${String(rel)}`);
  }
  const withExt = rel.endsWith(".md") ? rel : `${rel}.md`;
  const vaultReal = realpathSync(VAULT);
  const abs = path.resolve(vaultReal, withExt);
  if (!abs.startsWith(vaultReal + path.sep)) throw new Error(`非法路徑:${rel}`);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (!existsSync(abs)) writeFileSync(abs, `# ${path.basename(withExt, ".md")}\n`);
  return withExt;
});

ipcMain.on("doc:push", (_e, rel: string, update: Uint8Array) => {
  hosts.get(rel)?.applyFromRenderer(update);
});

function watchVaultForIndex(): void {
  index.rebuild();
  const watcher = chokidar.watch(VAULT, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  watcher.on("all", (event, file) => {
    if (!file.endsWith(".md")) return;
    const rel = path.relative(VAULT, file);
    if (event === "unlink") index.removeFile(rel);
    else if (event === "add" || event === "change") index.updateFile(rel);
    else return;
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send("index:updated");
    }
  });
}

app.whenReady().then(async () => {
  watchVaultForIndex();
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
    let mirrored = false;
    for (let waited = 0; waited < 5000 && !mirrored; waited += 200) {
      await sleep(200);
      mirrored = readFileSync(firstFile, "utf8").includes("Ω");
    }
    await writeFile(firstFile, originalBytes);
    await sleep(300);

    // 反向連結面板:立項.md 被日記 2026-07-15 連到
    let backlinked = false;
    for (let waited = 0; waited < 5000 && !backlinked; waited += 200) {
      await sleep(200);
      backlinked = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".backlinks .file")].some((el) => el.textContent.includes("2026-07-15"))`,
      );
    }

    // 點擊 wikilink → 建立不存在的筆記並跳轉,驗證後清理
    const clickInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(".wikilink");
        if (!el) return { ok: false, editor: document.querySelector("#editor")?.innerHTML?.slice(0, 400) ?? "no-editor" };
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, opts));
        return { ok: true };
      })()`,
    )) as { ok: boolean; editor?: string };
    if (!clickInfo.ok) console.log("SMOKE DEBUG 找不到 .wikilink:", clickInfo.editor);
    let navigated = false;
    for (let waited = 0; waited < 5000 && !navigated; waited += 200) {
      await sleep(200);
      navigated = await win.webContents.executeJavaScript(
        `document.querySelector("#editor .ProseMirror h1")?.textContent === "Obsidian"`,
      );
    }
    const created = path.join(VAULT, "Obsidian.md");
    const createdOk = existsSync(created);
    if (createdOk) rmSync(created);

    // 快速切換器:Cmd+P → 打「靈感」→ Enter,應切換到 靈感箱.md
    const typeInSwitcher = (text: string) => `(() => {
      const input = document.querySelector(".switcher input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`;
    const pressInSwitcher = (key: string) => `(() => {
      const input = document.querySelector(".switcher input");
      if (!input) return false;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;
    })()`;
    const openSwitcher = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, cancelable: true }))`;
    const activeSidebarText = `document.querySelector(".sidebar button.active")?.textContent ?? ""`;

    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    const switcherTyped = (await win.webContents.executeJavaScript(typeInSwitcher("靈感"))) as boolean;
    await sleep(200);
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    let switched = false;
    for (let waited = 0; waited < 5000 && !switched; waited += 200) {
      await sleep(200);
      switched = ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "靈感箱";
    }

    // 快速切換器建檔:查詢無符合 → 末項「建立筆記」→ Enter 建檔並開啟
    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("煙霧測試新檔"));
    await sleep(200);
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    const smokeNote = path.join(VAULT, "煙霧測試新檔.md");
    let switcherCreated = false;
    for (let waited = 0; waited < 5000 && !switcherCreated; waited += 200) {
      await sleep(200);
      switcherCreated =
        existsSync(smokeNote) &&
        ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "煙霧測試新檔";
    }
    if (existsSync(smokeNote)) rmSync(smokeNote);

    console.log(mounted ? "SMOKE ✅ 編輯器掛載且有內容" : "SMOKE ❌ 編輯器未就緒");
    console.log(mirrored ? "SMOKE ✅ 鍵盤輸入已鏡像到磁碟" : "SMOKE ❌ 輸入未寫回磁碟");
    console.log(navigated && createdOk ? "SMOKE ✅ 點擊 wikilink 建檔並跳轉" : "SMOKE ❌ wikilink 導航失敗");
    console.log(backlinked ? "SMOKE ✅ 反向連結面板顯示來源" : "SMOKE ❌ 反向連結未顯示");
    console.log(switcherTyped && switched ? "SMOKE ✅ Cmd+P 模糊搜尋切換筆記" : "SMOKE ❌ 快速切換器切換失敗");
    console.log(switcherCreated ? "SMOKE ✅ 快速切換器建檔並開啟" : "SMOKE ❌ 快速切換器建檔失敗");
    app.exit(mounted && mirrored && navigated && createdOk && backlinked && switcherTyped && switched && switcherCreated ? 0 : 1);
  }
});

app.on("window-all-closed", () => app.quit());
