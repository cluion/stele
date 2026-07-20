import * as Y from "yjs";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { VaultSession } from "./vault-session.ts";
import type { VaultMeta } from "./vault-meta.ts";

/**
 * 留言伴生 doc 的生命週期:每篇筆記的留言存在與筆記本體不同的 CRDT doc,
 * 不進 .md 鏡像、不污染筆記歷史,落盤於 .stele/comments/<id>.ybin。
 *
 * 與空間同理,**不需要同步**——純本地 vault 一樣能留言;
 * 同步啟用時由 SyncManager 掛上 CommentSyncHooks,伴生 doc 才跟著上傳與跨裝置傳播。
 */

const SAVE_DEBOUNCE_MS = 200;

/** 留言 doc id 必須是 UUID 形狀:登記表的值來自遠端,寬鬆放行就是路徑穿越面 */
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 同步啟用時才有的副作用 */
export interface CommentSyncHooks {
  /** 伴生 doc 納入同步 */
  trackNewDoc(docId: string): void;
  /** 同步層 loose 池若已有這顆 doc 就交出同一個物件(client runtime 可能已指向它) */
  adoptLoose(docId: string): Y.Doc | undefined;
}

/** 供同步層的 host 服務伴生 doc */
export interface CommentDocSource {
  get(docId: string): Y.Doc | undefined;
  ids(): string[];
}

/** 由筆記 docId 決定性衍生留言伴生 docId(UUID 形狀);兩裝置各自算出同一個,免對照即可避免分裂 */
export function commentDocIdFor(noteDocId: string): string {
  const h = createHash("sha256").update(`stele-comments:${noteDocId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class CommentStore implements CommentDocSource {
  /** 留言登記表:筆記 docId → 伴生留言 docId,隨 meta 傳播,讓留言 doc 的存在跨裝置可見 */
  private readonly registry: Y.Map<string>;
  private readonly docs = new Map<string, Y.Doc>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly dir: string;
  private sync: CommentSyncHooks | undefined;

  constructor(
    private readonly meta: VaultMeta,
    private readonly session: VaultSession,
    /** 伴生 doc 有非本地更新時通知(noteDocId + Y update),供 main 廣播給 renderer */
    private readonly onUpdate?: (noteDocId: string, update: Uint8Array) => void,
  ) {
    this.dir = path.join(session.root, ".stele", "comments");
    this.registry = meta.doc.getMap("comments");
    // 遠端 meta 帶來新的留言登記 → materialize 伴生 doc
    this.registry.observe((event, tx) => {
      if (tx.origin !== "sync") return;
      for (const noteDocId of event.keysChanged as Set<string>) this.materialize(noteDocId);
    });
  }

  /** 同步就緒後掛上:既有伴生 doc 一併讀進記憶體,才會進 listDocIds、連線後同步 */
  setSyncHooks(hooks: CommentSyncHooks): void {
    this.sync = hooks;
    for (const [noteDocId, commentDocId] of this.registry.entries()) {
      if (DOC_ID.test(commentDocId)) this.docFor(commentDocId, noteDocId);
    }
  }

  /** 開啟某筆記的留言 doc(必要時建立),回傳目前狀態快照供 renderer 投影 */
  open(noteRel: string): Uint8Array {
    return Y.encodeStateAsUpdate(this.ensure(this.docIdFor(noteRel)));
  }

  /** renderer 對留言 doc 的本地變更:origin "renderer" 讓 client 推同步、不回音給自己 */
  push(noteRel: string, update: Uint8Array): void {
    Y.applyUpdate(this.ensure(this.docIdFor(noteRel)), update, "renderer");
  }

  get(docId: string): Y.Doc | undefined {
    return this.docs.get(docId);
  }

  ids(): string[] {
    return [...this.docs.keys()];
  }

  /** 收工:停 debounce、全部落盤、銷毀 */
  stop(): void {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    for (const docId of this.docs.keys()) this.saveNow(docId);
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
  }

  private ensure(noteDocId: string): Y.Doc {
    // 決定性 id:兩裝置由同一 noteDocId 各自算出同一個 commentDocId,避免併發開啟時分裂
    const commentDocId = commentDocIdFor(noteDocId);
    if (this.registry.get(noteDocId) !== commentDocId) {
      this.meta.transact(() => this.registry.set(noteDocId, commentDocId));
    }
    return this.docFor(commentDocId, noteDocId);
  }

  /** 遠端登記到達:materialize 伴生 doc,並把既有留言送給已開著該筆記的 renderer */
  private materialize(noteDocId: string): void {
    const commentDocId = this.registry.get(noteDocId);
    if (!commentDocId || !DOC_ID.test(commentDocId) || this.docs.has(commentDocId)) return;
    this.onUpdate?.(noteDocId, Y.encodeStateAsUpdate(this.docFor(commentDocId, noteDocId)));
  }

  private docFor(commentDocId: string, noteDocId: string): Y.Doc {
    const cached = this.docs.get(commentDocId);
    if (cached) return cached;
    // 沿用同步層 loose 池的同一物件,否則從 .ybin 載入
    const doc = this.sync?.adoptLoose(commentDocId) ?? this.load(commentDocId);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.scheduleSave(commentDocId);
      if (origin !== "renderer") this.onUpdate?.(noteDocId, update);
    });
    this.docs.set(commentDocId, doc);
    this.sync?.trackNewDoc(commentDocId);
    return doc;
  }

  private docIdFor(noteRel: string): string {
    return this.session.peekDocId(noteRel) ?? this.session.docId(noteRel);
  }

  private load(commentDocId: string): Y.Doc {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, readFileSync(path.join(this.dir, `${commentDocId}.ybin`)), "load");
    } catch {
      // 首次:空 doc
    }
    return doc;
  }

  private scheduleSave(commentDocId: string): void {
    clearTimeout(this.saveTimers.get(commentDocId));
    this.saveTimers.set(
      commentDocId,
      setTimeout(() => this.saveNow(commentDocId), SAVE_DEBOUNCE_MS),
    );
  }

  private saveNow(commentDocId: string): void {
    const doc = this.docs.get(commentDocId);
    if (!doc) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${commentDocId}.ybin`);
      writeFileSync(file + ".tmp", Y.encodeStateAsUpdate(doc));
      renameSync(file + ".tmp", file);
    } catch (err) {
      console.error(`留言狀態落盤失敗 ${commentDocId}:`, err);
    }
  }
}
