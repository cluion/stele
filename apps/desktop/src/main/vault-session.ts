import * as Y from "yjs";
import diff from "fast-diff";
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, readdirSync, statSync, realpathSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { extractWikilinks, resolveWikilink, type WikilinkRef } from "@stele/editor-core";

const MIRROR_DEBOUNCE_MS = 120;
/** awaitWriteFinish:避免在外部程式 truncate+write 的中途讀到半成品檔案 */
const WATCH_STABILITY = { stabilityThreshold: 80, pollInterval: 20 };

export interface SessionCallbacks {
  broadcastDoc(rel: string, update: Uint8Array): void;
  notifyIndexUpdated(): void;
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

    this.watcher = chokidar.watch(this.file, {
      ignoreInitial: true,
      awaitWriteFinish: WATCH_STABILITY,
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

  constructor(private readonly root: string) {}

  rebuild(): void {
    this.files = listMarkdown(this.root);
    this.outgoing.clear();
    for (const rel of this.files) this.updateFile(rel);
  }

  updateFile(rel: string): void {
    try {
      this.outgoing.set(rel, extractWikilinks(readFileSync(path.join(this.root, rel), "utf8")));
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

function listMarkdown(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listMarkdown(full, prefix + name + "/"));
    else if (name.endsWith(".md")) out.push(prefix + name);
  }
  return out;
}

/**
 * 一個開啟中 vault 的全部狀態:文件 hosts、連結索引、目錄 watcher
 * 換 vault = destroy 舊 session、建新 session;生命週期綁在一起,不會漏清
 */
export class VaultSession {
  readonly root: string;
  private readonly hosts = new Map<string, DocHost>();
  private readonly index: LinkIndex;
  private readonly watcher: FSWatcher;

  /** dir 不存在或不是資料夾時建構即拋錯,呼叫端保留原 session */
  constructor(dir: string, private readonly callbacks: SessionCallbacks) {
    this.root = realpathSync(dir);
    if (!statSync(this.root).isDirectory()) throw new Error(`不是資料夾:${dir}`);

    this.index = new LinkIndex(this.root);
    this.index.rebuild();

    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      awaitWriteFinish: WATCH_STABILITY,
    });
    this.watcher.on("all", (event, file) => {
      if (!file.endsWith(".md")) return;
      const rel = path.relative(this.root, file);
      if (event === "unlink") this.index.removeFile(rel);
      else if (event === "add" || event === "change") this.index.updateFile(rel);
      else return;
      callbacks.notifyIndexUpdated();
    });
  }

  list(): { vault: string; root: string; files: string[] } {
    return { vault: path.basename(this.root), root: this.root, files: listMarkdown(this.root) };
  }

  backlinks(rel: string): Array<{ file: string; line: string }> {
    return this.index.backlinks(rel);
  }

  openDoc(rel: unknown): Uint8Array {
    if (typeof rel !== "string") throw new Error(`非法路徑:${String(rel)}`);
    const file = this.resolveFile(rel);
    let host = this.hosts.get(rel);
    if (!host) {
      host = new DocHost(rel, file, this.callbacks.broadcastDoc);
      this.hosts.set(rel, host);
    }
    return host.snapshot();
  }

  pushUpdate(rel: string, update: Uint8Array): void {
    this.hosts.get(rel)?.applyFromRenderer(update);
  }

  create(rel: unknown): string {
    if (
      typeof rel !== "string" ||
      rel.length === 0 ||
      path.isAbsolute(rel) ||
      rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      throw new Error(`非法路徑:${String(rel)}`);
    }
    const withExt = rel.endsWith(".md") ? rel : `${rel}.md`;
    const abs = path.resolve(this.root, withExt);
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`非法路徑:${rel}`);
    mkdirSync(path.dirname(abs), { recursive: true });
    if (!existsSync(abs)) writeFileSync(abs, `# ${path.basename(withExt, ".md")}\n`);
    return withExt;
  }

  async destroy(): Promise<void> {
    await this.watcher.close();
    await Promise.all([...this.hosts.values()].map((h) => h.destroy()));
    this.hosts.clear();
  }

  /** 驗證 renderer 傳來的相對路徑,回傳 vault 內的真實絕對路徑;絕對路徑、遍歷、symlink 逃逸一律拒絕 */
  private resolveFile(rel: string): string {
    if (rel.length === 0 || path.isAbsolute(rel) || !rel.endsWith(".md")) {
      throw new Error(`非法路徑:${rel}`);
    }
    let real: string;
    try {
      real = realpathSync(path.resolve(this.root, rel));
    } catch {
      throw new Error(`非法路徑:${rel}`);
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      throw new Error(`非法路徑:${rel}`);
    }
    return real;
  }
}
