import * as Y from "yjs";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

/**
 * vault 的中繼資料 doc:路徑 LWW(docId → 相對路徑)、留言登記、空間登記與筆記歸屬、稽核紀錄。
 *
 * 落盤於 .stele/meta.ybin,由 **vault 生命週期**擁有——同步層只是「有啟用時額外把它推上去」
 * 的訂閱者,而非它的持有者。這條所有權界線讓空間與留言在未啟用同步的 vault 也完整可用。
 */

const SAVE_DEBOUNCE_MS = 200;

/** 本地變更的 transaction origin;遠端變更走 "sync",載入走 "load",觀察者據此決定要不要落地成檔案操作 */
export const LOCAL_ORIGIN = "local-meta";

/** 路徑 LWW 的守門寫入:比對後才寫,app 內操作、watcher 回音與遠端落地的回音都在這裡歸零 */
export function setPath(meta: VaultMeta, docId: string, rel: string): void {
  const paths = meta.doc.getMap<string>("paths");
  if (paths.get(docId) === rel) return;
  meta.transact(() => paths.set(docId, rel));
}

export class VaultMeta {
  readonly doc = new Y.Doc();
  private readonly file: string;
  private timer: NodeJS.Timeout | undefined;

  constructor(root: string) {
    this.file = path.join(root, ".stele", "meta.ybin");
    this.load();
    this.doc.on("update", () => this.scheduleSave());
  }

  /** 本地變更統一走這裡,確保帶上 LOCAL_ORIGIN 而不被誤認成遠端變更 */
  transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  /** 收工:停 debounce、最後一次落盤、銷毀 doc */
  stop(): void {
    clearTimeout(this.timer);
    this.saveNow();
    this.doc.destroy();
  }

  saveNow(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file + ".tmp", Y.encodeStateAsUpdate(this.doc));
      renameSync(this.file + ".tmp", this.file);
    } catch (err) {
      console.error("meta 狀態落盤失敗:", err);
    }
  }

  private load(): void {
    try {
      Y.applyUpdate(this.doc, readFileSync(this.file), "load");
    } catch {
      // 首次啟用或狀態不在:空 doc,由開機對帳從 manifest 重建
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }
}
