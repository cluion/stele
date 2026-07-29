import * as Y from "yjs";
import {
  SyncClient,
  deriveVaultKey,
  MasterKeySpaces,
  spaceOf,
  type Cipher,
  type SocketLike,
  type SyncDocState,
  type SyncStatus,
} from "@stele/sync";
import { searchNotes, resolveNote, backlinksOf, type Hit, type Note } from "./notes.ts";
import type { VaultStorage } from "./storage.ts";

/**
 * 行動端的 vault:連上既有的加密 vault,把內容解密後**以明文 `.md` 落到裝置上**。
 *
 * 與桌面最根本的差異是入口——桌面是「選一個資料夾,那就是 vault」,行動端是
 * 「連上一個既有 vault」。iOS 沒有選工作資料夾的心智模型,而手機上開一個空 vault
 * 也沒有意義:手機是既有知識庫的第二個端點,不是它的起點。
 *
 * 同步層(`packages/sync`)整包重用,不分叉:金鑰衍生、協定、簽驗全部是同一份實作,
 * 桌面驗過的東西不會在這裡以另一種方式再錯一次。
 */

/** 與桌面 SyncManager 同一個常數:vault 的路徑對照 doc */
const META_DOC_ID = "vault-meta";
const STATE_SETTING = "sync-states";

export interface VaultSettings {
  url: string;
  token: string;
  vaultId: string;
  passphrase: string;
}

export interface VaultEvents {
  onStatus(status: SyncStatus): void;
  /** 筆記清單或內容有變(遠端同步下來、或本地寫入落地) */
  onChanged(): void;
}

export class MobileVault {
  private client: SyncClient | undefined;
  private readonly meta = new Y.Doc();
  private readonly docs = new Map<string, Y.Doc>();
  private readonly states = new Map<string, SyncDocState>();
  private readonly deviceId: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly storage: VaultStorage,
    private readonly events: VaultEvents,
    deviceId: string,
  ) {
    this.deviceId = deviceId;
  }

  /** docId → vault 相對路徑;來源是同步下來的 meta doc */
  private paths(): Y.Map<string> {
    return this.meta.getMap<string>("paths");
  }

  async start(settings: VaultSettings): Promise<void> {
    await this.restoreStates();
    /**
     * meta doc 自己也要落地。少了這一段,重開 app 會是這樣:同步進度(lastSeq)有存,
     * 於是伺服器認為這台裝置已經拿過 meta 而不重送,但本地的 `paths` 是空的
     * ——畫面上就是「連線正常、一篇筆記都沒有」。真機驗證第一次重連就撞到。
     */
    const metaState = await this.storage.readState(META_DOC_ID);
    if (metaState) Y.applyUpdate(this.meta, metaState, "load");
    /**
     * 沒有本地 meta 卻有同步進度 = 兩者不一致(升級、清快取、或中途失敗留下的)。
     * 進度說「都拿過了」,伺服器因此不重送,而本地連一篇筆記的路徑都沒有——畫面會停在
     * 「已同步、零筆記」,而且自己好不了。這種時候把進度丟掉重新對帳,代價只是多拉一次。
     */
    if (!metaState && this.states.size > 0) this.states.clear();
    this.meta.on("update", () => {
      void this.storage.writeState(META_DOC_ID, Y.encodeStateAsUpdate(this.meta)).catch(() => undefined);
    });
    // 主金鑰與桌面同一條路徑、同一個工作因子(2^18)。行動端若另訂較低的工作因子,
    // 同一句 passphrase 在兩邊會衍生出不同金鑰——那是一輩子拔不掉的相容包袱。
    const key = await deriveVaultKey(settings.passphrase, settings.vaultId);
    /**
     * 走**空間路由**而非單一 cipher:每篇筆記以其所屬空間的金鑰加解密,與桌面同一條路徑。
     * 少了這一層,放在非預設空間的筆記在手機上會靜默解不開——而「解不開」與「還沒同步到」
     * 在畫面上長得一模一樣,是最難查的那種錯。
     */
    const spaces = new MasterKeySpaces(key);
    const cipher: Cipher = {
      encrypt: (docId, plain) => spaces.cipher(spaceOf(this.meta, docId)).then((c) => c.encrypt(docId, plain)),
      decrypt: (docId, data) => spaces.cipher(spaceOf(this.meta, docId)).then((c) => c.decrypt(docId, data)),
    };

    // 路徑對照一變就把該篇物化到磁碟:遠端改名、新增在這裡落地
    this.paths().observe(() => void this.materializeAll());

    this.client = new SyncClient({
      url: settings.url,
      token: settings.token,
      vaultId: settings.vaultId,
      deviceId: this.deviceId,
      cipher,
      host: {
        openDoc: (docId) => Promise.resolve(this.openDoc(docId)),
        listDocIds: () => Promise.resolve([META_DOC_ID, ...this.paths().keys()]),
        loadState: (docId) => this.states.get(docId),
        saveState: (docId, state) => {
          this.states.set(docId, state);
          this.scheduleStateSave();
        },
      },
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onStatus: (status) => this.events.onStatus(status),
    });
    this.client.start();
  }

  private openDoc(docId: string): Y.Doc {
    if (docId === META_DOC_ID) return this.meta;
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(docId, doc);
      void this.storage.readState(docId).then((state) => {
        if (state) Y.applyUpdate(doc!, state, "load");
      });
      // 內容一變就寫回明文檔案;來源是遠端同步或本地編輯,兩者都該落地
      doc.on("update", () => void this.materialize(docId));
    }
    return doc;
  }

  /** 把某個 doc 的目前內容寫成明文 `.md`,並保存 CRDT 狀態 */
  private async materialize(docId: string): Promise<void> {
    const doc = this.docs.get(docId);
    const rel = this.paths().get(docId);
    if (!doc || !rel) return; // 路徑還沒同步到:等 meta 到齊再落地
    try {
      await this.storage.writeNote(rel, doc.getText("md").toString());
      await this.storage.writeState(docId, Y.encodeStateAsUpdate(doc));
      this.events.onChanged();
    } catch (err) {
      console.error(`物化筆記失敗 ${rel}:`, err);
    }
  }

  private async materializeAll(): Promise<void> {
    for (const docId of this.paths().keys()) await this.materialize(docId);
  }

  /** 目前筆記清單(docId → 路徑),依路徑排序 */
  list(): Array<{ docId: string; rel: string }> {
    return [...this.paths().entries()]
      .map(([docId, rel]) => ({ docId, rel }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** 讀一篇筆記的目前內容(CRDT 為準,與桌面一致——磁碟只是鏡像) */
  read(docId: string): string {
    return this.docs.get(docId)?.getText("md").toString() ?? "";
  }

  /** 目前全部筆記(含內容)攤平;查詢層是純函式,只吃這個 */
  private notes(): Note[] {
    return this.list().map(({ docId, rel }) => ({ docId, rel, text: this.read(docId) }));
  }

  /** 全文搜尋(檔名優先於內文);規則與測試在 notes.ts */
  search(query: string): Hit[] {
    return searchNotes(this.notes(), query);
  }

  /** 解析 wikilink 目標;解不到回 undefined——手機上不建檔 */
  resolve(target: string): { docId: string; rel: string } | undefined {
    const note = resolveNote(this.notes(), target);
    return note ? { docId: note.docId, rel: note.rel } : undefined;
  }

  /** 反向連結:哪些筆記連到這一篇 */
  backlinks(rel: string): Hit[] {
    return backlinksOf(this.notes(), rel);
  }

  /**
   * 覆寫一篇筆記的內容。走 CRDT 的最小差異而非整份重寫:協作者收到的是一串小改動,
   * 游標不會全部跳掉——與桌面 `applyTextDiff` 同一個理由。
   */
  write(docId: string, next: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    const ytext = doc.getText("md");
    const current = ytext.toString();
    if (current === next) return;
    // 手機上的編輯量體小,取共同前後綴即可,不必為此帶進一個 diff 套件
    let head = 0;
    while (head < current.length && head < next.length && current[head] === next[head]) head++;
    let tail = 0;
    while (
      tail < current.length - head &&
      tail < next.length - head &&
      current[current.length - 1 - tail] === next[next.length - 1 - tail]
    ) {
      tail++;
    }
    doc.transact(() => {
      const removed = current.length - head - tail;
      if (removed > 0) ytext.delete(head, removed);
      const inserted = next.slice(head, next.length - tail);
      if (inserted.length > 0) ytext.insert(head, inserted);
    }, "local");
  }

  async stop(): Promise<void> {
    clearTimeout(this.saveTimer);
    await this.persistStates();
    // SyncClient.stop 是非同步的:等它收完再拆 doc,否則收尾中的推送會踩到已銷毀的 Y.Doc
    await this.client?.stop();
    this.client = undefined;
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
  }

  private scheduleStateSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persistStates(), 500);
  }

  /** 同步進度以設定形式保存;syncedSv 是二進位,存 base64 陣列 */
  private async persistStates(): Promise<void> {
    const plain: Record<string, { lastSeq: number; counter: number; syncedSv?: number[] }> = {};
    for (const [docId, s] of this.states) {
      plain[docId] = { lastSeq: s.lastSeq, counter: s.counter, ...(s.syncedSv ? { syncedSv: [...s.syncedSv] } : {}) };
    }
    await this.storage.writeSetting(STATE_SETTING, JSON.stringify(plain)).catch(() => undefined);
  }

  private async restoreStates(): Promise<void> {
    try {
      const raw = await this.storage.readSetting(STATE_SETTING);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { lastSeq: number; counter: number; syncedSv?: number[] }>;
      for (const [docId, s] of Object.entries(parsed)) {
        this.states.set(docId, {
          lastSeq: s.lastSeq,
          counter: s.counter,
          ...(s.syncedSv ? { syncedSv: new Uint8Array(s.syncedSv) } : {}),
        });
      }
    } catch {
      // 進度壞掉不是災難:當成沒同步過,重新對帳一次
    }
  }
}
