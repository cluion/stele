import * as Y from "yjs";
import diff from "fast-diff";
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, readdirSync, statSync, realpathSync, mkdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { extractWikilinks, resolveWikilink, rewriteWikilinks, type WikilinkRef } from "@stele/editor-core";
import { SearchIndex } from "./search-index.ts";
import { DocStore, type DocPersistence } from "./doc-store.ts";

const FLUSH_DEBOUNCE_MS = 120;

/** 先在探針文件上試套,避免損毀的狀態半套進正式文件 */
function isValidUpdate(state: Uint8Array): boolean {
  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, state);
    return true;
  } catch {
    return false;
  } finally {
    probe.destroy();
  }
}
/** awaitWriteFinish:避免在外部程式 truncate+write 的中途讀到半成品檔案 */
const WATCH_STABILITY = { stabilityThreshold: 80, pollInterval: 20 };

export interface SessionCallbacks {
  broadcastDoc(rel: string, update: Uint8Array): void;
  notifyIndexUpdated(): void;
  /** 移到系統回收桶;由外層注入,讓本模組不依賴 electron */
  trash(absPath: string): Promise<void>;
}

/** 檔案生滅事件:app 內操作與外部修改都走這裡,同步層據此維護路徑 meta */
export type VaultFileEvent =
  | { kind: "add"; rel: string }
  | { kind: "remove"; rel: string }
  | { kind: "rename"; from: string; to: string };

/** 單一筆記的主端文件:唯一寫入者,負責鏡像寫回、外部修改吸收與 CRDT 狀態持久化 */
class DocHost {
  readonly ydoc: Y.Doc;
  private readonly ytext: Y.Text;
  private readonly file: string;
  private readonly persistence: DocPersistence;
  private lastMirrored: string;
  private dirtyMirror = false;
  private dirtyState = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushInFlight: Promise<void> = Promise.resolve();
  private readonly watcher: FSWatcher;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(
    readonly rel: string,
    file: string,
    broadcast: (rel: string, update: Uint8Array) => void,
    persistence: DocPersistence,
    existing?: Y.Doc,
  ) {
    this.file = file;
    this.persistence = persistence;
    this.ydoc = existing ?? new Y.Doc();
    this.ytext = this.ydoc.getText("md");
    const onDisk = readFileSync(this.file, "utf8");
    if (existing) {
      // 領養同步來的 doc:內容已在,狀態排程落盤
      this.dirtyState = true;
    } else {
      let persisted = persistence.load();
      if (persisted && !isValidUpdate(persisted)) {
        console.error(`CRDT 狀態損毀,改由磁碟內容重播種 ${rel}`);
        persisted = undefined;
      }
      if (persisted) {
        // 歷史延續:載入舊狀態,關檔期間的外部修改再以 diff 吸收
        Y.applyUpdate(this.ydoc, persisted, "load");
      } else {
        this.ytext.insert(0, onDisk);
        this.dirtyState = true;
      }
    }
    this.lastMirrored = this.ytext.toString();

    this.onDocUpdate = (update: Uint8Array, origin: unknown) => {
      broadcast(rel, update);
      this.dirtyState = true;
      if (origin !== "external-file") this.dirtyMirror = true;
      this.scheduleFlush();
    };
    this.ydoc.on("update", this.onDocUpdate);

    if (this.lastMirrored !== onDisk) this.absorbContent(onDisk);
    if (this.dirtyState) this.scheduleFlush();

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

  private scheduleFlush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      // 串在前一次之後:flush 不並行,destroy 也才有單一 promise 可等
      this.flushInFlight = this.flushInFlight.then(() => this.flush());
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const wantMirror = this.dirtyMirror;
    const wantState = this.dirtyState;
    this.dirtyMirror = false;
    this.dirtyState = false;
    if (wantMirror) {
      const content = this.ytext.toString();
      this.lastMirrored = content;
      const tmp = this.file + ".tmp";
      try {
        await writeFile(tmp, content);
        await rename(tmp, this.file);
      } catch (err) {
        console.error(`鏡像寫回失敗 ${this.rel}:`, err);
      }
    }
    if (wantState) {
      try {
        await this.persistence.save(Y.encodeStateAsUpdate(this.ydoc));
      } catch (err) {
        console.error(`CRDT 狀態落盤失敗 ${this.rel}:`, err);
      }
    }
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
    this.absorbContent(onDisk);
  }

  private absorbContent(onDisk: string): void {
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

  /** keepDoc:改名換宿主時保留 Y.Doc 實例,同步層的引用不失效 */
  async destroy(keepDoc = false): Promise<void> {
    // debounce 中的鏡像與狀態必須先落盤,否則最後 120ms 的編輯會無聲消失
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    // 已觸發但 I/O 未完成的 flush 也要等完,否則 rename/delete 後舊路徑會被復活
    await this.flushInFlight;
    if (this.dirtyMirror || this.dirtyState) await this.flush();
    await this.watcher.close();
    this.ydoc.off("update", this.onDocUpdate);
    if (!keepDoc) this.ydoc.destroy();
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

  updateFile(rel: string, content?: string): void {
    try {
      const source = content ?? readFileSync(path.join(this.root, rel), "utf8");
      this.outgoing.set(rel, extractWikilinks(source));
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

  /** 全 vault 關聯圖:節點=筆記,邊=解析成功的 wikilink(去重、去自環) */
  graph(): { nodes: string[]; edges: Array<[number, number]> } {
    const nodes = [...this.files];
    const indexOf = new Map(nodes.map((f, i) => [f, i]));
    const edges: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (const [source, refs] of this.outgoing) {
      const si = indexOf.get(source);
      if (si === undefined) continue;
      for (const ref of refs) {
        const target = resolveWikilink(nodes, ref.target);
        if (!target) continue;
        const ti = indexOf.get(target);
        if (ti === undefined || ti === si) continue;
        const key = `${si}→${ti}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([si, ti]);
        }
      }
    }
    return { nodes, edges };
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
  private readonly searchIndex = new SearchIndex();
  private readonly docStore: DocStore;
  private readonly watcher: FSWatcher;
  private readonly fileListeners = new Set<(event: VaultFileEvent) => void>();

  /** dir 不存在或不是資料夾時建構即拋錯,呼叫端保留原 session */
  constructor(dir: string, private readonly callbacks: SessionCallbacks) {
    this.root = realpathSync(dir);
    if (!statSync(this.root).isDirectory()) throw new Error(`不是資料夾:${dir}`);

    this.docStore = new DocStore(this.root);
    this.index = new LinkIndex(this.root);
    for (const rel of listMarkdown(this.root)) this.refreshFile(rel);

    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      awaitWriteFinish: WATCH_STABILITY,
    });
    this.watcher.on("all", (event, file) => {
      if (!file.endsWith(".md")) return;
      const rel = path.relative(this.root, file);
      if (event === "unlink") {
        // 外部刪除不清 CRDT 狀態:git 切分支會暫時 unlink,檔案回來時歷史才接得上
        this.index.removeFile(rel);
        this.searchIndex.remove(rel);
        this.emitFile({ kind: "remove", rel });
      } else if (event === "add" || event === "change") {
        this.refreshFile(rel);
        if (event === "add") this.emitFile({ kind: "add", rel });
      } else return;
      callbacks.notifyIndexUpdated();
    });
  }

  /** 訂閱檔案生滅事件,回傳退訂函式 */
  onFileEvent(listener: (event: VaultFileEvent) => void): () => void {
    this.fileListeners.add(listener);
    return () => this.fileListeners.delete(listener);
  }

  private emitFile(event: VaultFileEvent): void {
    for (const listener of this.fileListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("檔案事件處理失敗:", err);
      }
    }
  }

  list(): { vault: string; root: string; files: string[] } {
    return { vault: path.basename(this.root), root: this.root, files: listMarkdown(this.root) };
  }

  backlinks(rel: string): Array<{ file: string; line: string }> {
    return this.index.backlinks(rel);
  }

  graph(): { nodes: string[]; edges: Array<[number, number]> } {
    return this.index.graph();
  }

  /** 全文搜尋:回傳命中檔案與包含查詢字串的第一行作為上下文 */
  search(query: unknown): Array<{ file: string; line: string }> {
    if (typeof query !== "string") throw new Error("非法參數");
    const needle = query.trim().toLowerCase();
    return this.searchIndex.search(query).map(({ file }) => {
      let line = "";
      try {
        const lines = readFileSync(path.join(this.root, file), "utf8").split("\n");
        line =
          lines.find((l) => l.toLowerCase().includes(needle)) ??
          lines.find((l) => l.trim() !== "" && !l.startsWith("---")) ??
          "";
      } catch {
        // 檔案剛被刪:仍回傳檔名,無上下文
      }
      return { file, line: line.trim() };
    });
  }

  /** 內容只讀一次,同時餵連結索引與搜尋索引 */
  private refreshFile(rel: string): void {
    let content: string | undefined;
    try {
      content = readFileSync(path.join(this.root, rel), "utf8");
    } catch {
      content = undefined;
    }
    if (content === undefined) {
      this.index.removeFile(rel);
      this.searchIndex.remove(rel);
      return;
    }
    this.index.updateFile(rel, content);
    this.searchIndex.update(rel, content);
  }

  openDoc(rel: unknown): Uint8Array {
    if (typeof rel !== "string") throw new Error(`非法路徑:${String(rel)}`);
    return this.ensureHost(rel).snapshot();
  }

  /** 同步層取得(必要時建立)筆記的主端 Y.Doc */
  docFor(rel: string): Y.Doc {
    return this.ensureHost(rel).ydoc;
  }

  private ensureHost(rel: string, existing?: Y.Doc): DocHost {
    const file = this.resolveFile(rel);
    let host = this.hosts.get(rel);
    if (!host) {
      host = new DocHost(rel, file, (r, u) => this.callbacks.broadcastDoc(r, u), this.persistenceFor(rel), existing);
      this.hosts.set(rel, host);
    }
    return host;
  }

  private persistenceFor(rel: string): DocPersistence {
    return {
      load: () => this.docStore.load(rel),
      save: (state) => this.docStore.save(rel, state),
    };
  }

  /** 同步用 doc id 介面:id 穩定跟著筆記走 */
  docId(rel: string): string {
    return this.docStore.idFor(rel);
  }

  peekDocId(rel: string): string | undefined {
    return this.docStore.peekId(rel);
  }

  relForDocId(id: string): string | undefined {
    return this.docStore.relFor(id);
  }

  /** 全 vault 檔案的 doc id,沒有的當場配發;同步啟動時的全量對帳用 */
  allDocIds(): string[] {
    return listMarkdown(this.root).map((rel) => this.docStore.idFor(rel));
  }

  /** 物化遠端新筆記:以同步來的 id 與 Y.Doc 建檔並開 host;回傳實際落地路徑 */
  adoptRemoteDoc(relRaw: string, docId: string, ydoc: Y.Doc): string {
    const rel = this.freeVariant(relRaw);
    const abs = this.resolveNewFile(rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, ydoc.getText("md").toString());
    this.docStore.adopt(rel, docId);
    this.ensureHost(rel, ydoc);
    this.refreshFile(rel);
    this.callbacks.notifyIndexUpdated();
    return rel;
  }

  /** 純搬移:改名落地但不改寫連結,遠端改名套用時用(連結改寫已在來源端發生並隨內容同步) */
  async renamePlumbing(oldRel: string, newRelRaw: string): Promise<string> {
    const oldFile = this.resolveFile(oldRel);
    const newRel = this.freeVariant(newRelRaw);
    const newAbs = this.resolveNewFile(newRel);
    const host = this.hosts.get(oldRel);
    let kept: Y.Doc | undefined;
    if (host) {
      this.hosts.delete(oldRel);
      kept = host.ydoc;
      await host.destroy(true);
    }
    mkdirSync(path.dirname(newAbs), { recursive: true });
    renameSync(oldFile, newAbs);
    this.docStore.rename(oldRel, newRel);
    if (kept) this.ensureHost(newRel, kept);
    this.index.removeFile(oldRel);
    this.searchIndex.remove(oldRel);
    this.refreshFile(newRel);
    this.callbacks.notifyIndexUpdated();
    return newRel;
  }

  /** 路徑被別的檔案占用時退讓:「a.md」→「a (衝突).md」 */
  private freeVariant(rel: string): string {
    if (!existsSync(path.resolve(this.root, rel))) return rel;
    const base = rel.replace(/\.md$/, "");
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? `${base} (衝突).md` : `${base} (衝突 ${i}).md`;
      if (!existsSync(path.resolve(this.root, candidate))) return candidate;
    }
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
    const abs = this.resolveNewFile(withExt);
    mkdirSync(path.dirname(abs), { recursive: true });
    if (!existsSync(abs)) {
      writeFileSync(abs, `# ${path.basename(withExt, ".md")}\n`);
      this.emitFile({ kind: "add", rel: withExt });
    }
    return withExt;
  }

  /** 改名(可跨資料夾)並改寫全 vault 指向它的 wikilink;開啟中的文件先 flush 再搬 */
  async rename(oldRelRaw: unknown, nextRaw: unknown): Promise<string> {
    if (typeof oldRelRaw !== "string" || typeof nextRaw !== "string") throw new Error("非法參數");
    const oldFile = this.resolveFile(oldRelRaw);
    const next = nextRaw.trim();
    if (
      next.length === 0 ||
      path.isAbsolute(next) ||
      next.split("/").some((seg) => seg.trim() === "" || seg === "." || seg === "..")
    ) {
      throw new Error(`非法路徑:${next}`);
    }
    const newRel = next.endsWith(".md") ? next : `${next}.md`;
    if (newRel === oldRelRaw) return newRel;
    const newAbs = this.resolveNewFile(newRel);
    if (existsSync(newAbs)) throw new Error(`已存在同名筆記:${newRel}`);

    const oldFiles = [...this.index.files];
    const host = this.hosts.get(oldRelRaw);
    let kept: Y.Doc | undefined;
    if (host) {
      this.hosts.delete(oldRelRaw);
      kept = host.ydoc;
      await host.destroy(true); // flush 未落盤的編輯,並停掉鏡像避免復活舊路徑
    }
    mkdirSync(path.dirname(newAbs), { recursive: true });
    renameSync(oldFile, newAbs);
    this.docStore.rename(oldRelRaw, newRel);
    if (kept) this.ensureHost(newRel, kept); // 同一 Y.Doc 續掛新路徑,同步引用不失效

    const newBase = newRel.replace(/\.md$/, "");
    const shouldRename = (target: string): string | null => {
      const [base, ...anchor] = target.split("#");
      if (resolveWikilink(oldFiles, base!.trim()) !== oldRelRaw) return null;
      return [newBase, ...anchor].join("#");
    };
    for (const rel of oldFiles) {
      if (rel === oldRelRaw) continue;
      try {
        const source = readFileSync(path.join(this.root, rel), "utf8");
        const rewritten = rewriteWikilinks(source, shouldRename);
        if (rewritten !== source) writeFileSync(path.join(this.root, rel), rewritten);
        // 開啟中的文件會經 fsWatch 吸收這次改寫,不需特別處理
      } catch (err) {
        console.error(`改寫連結失敗 ${rel}:`, err);
      }
    }

    this.index.removeFile(oldRelRaw);
    this.searchIndex.remove(oldRelRaw);
    this.refreshFile(newRel);
    this.callbacks.notifyIndexUpdated();
    this.emitFile({ kind: "rename", from: oldRelRaw, to: newRel });
    return newRel;
  }

  /** 刪除筆記:flush 開啟中的文件、停掉鏡像,再移入回收桶 */
  async delete(relRaw: unknown): Promise<void> {
    if (typeof relRaw !== "string") throw new Error("非法參數");
    const file = this.resolveFile(relRaw);
    const host = this.hosts.get(relRaw);
    if (host) {
      this.hosts.delete(relRaw);
      await host.destroy();
    }
    await this.callbacks.trash(file);
    this.emitFile({ kind: "remove", rel: relRaw }); // 在對照移除前發出,同步層還查得到 doc id
    this.docStore.remove(relRaw);
    this.index.removeFile(relRaw);
    this.searchIndex.remove(relRaw);
    this.callbacks.notifyIndexUpdated();
  }

  /** 開啟(必要時建立)date 當天的每日筆記;模板存在時套用並替換 {{date}} */
  daily(date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法日期:${date}`);
    const cfg = this.config();
    const rel = `${cfg.dailyFolder}/${date}.md`;
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`非法路徑:${rel}`);
    if (!existsSync(abs)) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, this.dailyContent(cfg, date));
    }
    return rel;
  }

  private config(): { dailyFolder: string; dailyTemplate: string } {
    const defaults = { dailyFolder: "日記", dailyTemplate: "模板/每日.md" };
    try {
      const raw = JSON.parse(readFileSync(path.join(this.root, ".stele", "config.json"), "utf8")) as Record<string, unknown>;
      return {
        dailyFolder: typeof raw["dailyFolder"] === "string" ? raw["dailyFolder"] : defaults.dailyFolder,
        dailyTemplate: typeof raw["dailyTemplate"] === "string" ? raw["dailyTemplate"] : defaults.dailyTemplate,
      };
    } catch {
      return defaults;
    }
  }

  private dailyContent(cfg: { dailyTemplate: string }, date: string): string {
    const tpl = path.resolve(this.root, cfg.dailyTemplate);
    if (!tpl.startsWith(this.root + path.sep)) return `# ${date}\n`;
    try {
      return readFileSync(tpl, "utf8").replaceAll("{{date}}", date);
    } catch {
      return `# ${date}\n`;
    }
  }

  async destroy(): Promise<void> {
    await this.watcher.close();
    await Promise.all([...this.hosts.values()].map((h) => h.destroy()));
    this.hosts.clear();
  }

  /**
   * 驗證「將要建立」的檔案路徑:分段/副檔名詞法檢查,再對最近的既存祖先做 realpath,
   * 擋 symlink 逃逸;路徑可能來自遠端 meta,不受信
   */
  private resolveNewFile(rel: string): string {
    if (
      rel.length === 0 ||
      path.isAbsolute(rel) ||
      !rel.endsWith(".md") ||
      rel.split("/").some((seg) => seg.trim() === "" || seg === "." || seg === "..")
    ) {
      throw new Error(`非法路徑:${rel}`);
    }
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`非法路徑:${rel}`);
    let ancestor = path.dirname(abs);
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = realpathSync(ancestor);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new Error(`非法路徑:${rel}`);
    return abs;
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
