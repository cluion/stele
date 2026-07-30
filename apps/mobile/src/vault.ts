import * as Y from "yjs";
import {
  SyncClient,
  deriveVaultKey,
  MasterKeySpaces,
  WrappedKeySpaces,
  spaceOf,
  spaceMembersOf,
  type Cipher,
  type SocketLike,
  type SpaceKeySource,
  type SyncDocState,
  type SyncIdentity,
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

interface BaseSettings {
  url: string;
  token: string;
  vaultId: string;
}

/** 個人 vault:主金鑰由密語衍生,沒有其他成員,不簽也不驗 */
export interface PersonalVaultSettings extends BaseSettings {
  passphrase: string;
}

/**
 * 團隊 vault:主金鑰(root)是 `bootstrapTeamKey` 從自己的信封解出來的,不是密語衍生的。
 * 連線一律帶身分——團隊 vault 的每一筆寫入都要簽,收到的每一筆都要查成員目錄驗作者。
 */
export interface TeamVaultSettings extends BaseSettings {
  identity: SyncIdentity;
  /** 信任錨:驗信封、成員目錄與政策的 owner 公鑰(綁組織時是委任鏈認定的當代 owner) */
  ownerPubSign: Uint8Array;
  root: Uint8Array;
  epoch: number;
  /** 受限空間的獨立金鑰;沒有份的空間就是不在這個 map 裡 */
  spaceKeys?: ReadonlyMap<string, Uint8Array>;
  restrictedSpaceIds?: readonly string[];
  requireSignedWrites?: boolean;
}

export type VaultSettings = PersonalVaultSettings | TeamVaultSettings;

export const isTeamSettings = (s: VaultSettings): s is TeamVaultSettings => "root" in s;

export interface VaultEvents {
  onStatus(status: SyncStatus): void;
  /** 筆記清單或內容有變(遠端同步下來、或本地寫入落地) */
  onChanged(): void;
  /**
   * 金鑰已輪換(團隊 vault):推送已自動暫停。上層應重跑 bootstrap 取新 root,
   * 再呼叫 `applyRotation` 恢復收斂——不接這個事件,手機會安靜地停在舊紀元。
   */
  onKeyRotated?(epoch: number): void;
  /** 被移出團隊:已停止重連,上層據此告訴使用者發生了什麼 */
  onRevoked?(code: string): void;
}

export class MobileVault {
  private client: SyncClient | undefined;
  private readonly meta = new Y.Doc();
  private readonly docs = new Map<string, Y.Doc>();
  private readonly states = new Map<string, SyncDocState>();
  private readonly deviceId: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 空間金鑰來源;輪換時原地換 root,不重建 client */
  private keys: SpaceKeySource | undefined;
  /** 團隊 vault 才有:判斷自己是否在某受限空間的名單裡 */
  private memberId: string | undefined;

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
    /**
     * 金鑰來源。個人 vault 是密語 → scrypt 2^18 衍生主金鑰,與桌面同一條路徑、同一個工作因子
     * ——行動端若另訂較低的工作因子,同一句 passphrase 在兩邊會衍生出不同金鑰,那是一輩子
     * 拔不掉的相容包袱。團隊 vault 的 root 則是加入流程從自己的信封解出來的,不經密語。
     */
    const team = isTeamSettings(settings);
    this.memberId = team ? settings.identity.memberId : undefined;
    this.keys = team
      ? new WrappedKeySpaces(settings.root, settings.spaceKeys, settings.restrictedSpaceIds)
      : new MasterKeySpaces(await deriveVaultKey(settings.passphrase, settings.vaultId));
    /**
     * 走**空間路由**而非單一 cipher:每篇筆記以其所屬空間的金鑰加解密,與桌面同一條路徑。
     * 少了這一層,放在非預設空間的筆記在手機上會靜默解不開——而「解不開」與「還沒同步到」
     * 在畫面上長得一模一樣,是最難查的那種錯。
     *
     * encrypt 端是硬性防線:受限空間而我沒有它的金鑰就拒絕加密,寧可寫入失敗。放行的話,
     * 這篇會以 root 衍生的金鑰重新加密推上共享日誌——等於把只給部分人的內容攤給整個 vault 看。
     */
    const keys = this.keys;
    const cipher: Cipher = {
      encrypt: (docId, plain) => {
        if (!this.canDecrypt(docId)) return Promise.reject(new Error(`無此空間的金鑰,拒絕加密:${docId}`));
        return keys.cipher(spaceOf(this.meta, docId)).then((c) => c.encrypt(docId, plain));
      },
      decrypt: (docId, data) => keys.cipher(spaceOf(this.meta, docId)).then((c) => c.decrypt(docId, data)),
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
      // 以下四項只有團隊 vault 有:帶身分認證、逐寫入簽驗、金鑰紀元與輪換/撤銷通知
      ...(team
        ? {
            identity: settings.identity,
            ownerPubSign: settings.ownerPubSign,
            epoch: settings.epoch,
            requireSignedWrites: settings.requireSignedWrites,
            onKeyRotated: (epoch: number) => this.events.onKeyRotated?.(epoch),
            onRevoked: (code: string) => this.events.onRevoked?.(code),
          }
        : {}),
    });
    this.client.start();
  }

  /**
   * 這篇筆記所屬的空間,我有沒有金鑰。個人 vault 恆為 true(所有空間都由主金鑰衍生)。
   *
   * 判準與桌面 `canDecrypt` 相同:有獨立金鑰 → 有;信封層說受限而我沒金鑰 → 沒有;
   * 兩者皆非則看 meta 的名單有沒有把這個空間圈起來。信封層優先於 meta,因為 meta 是
   * 同步下來的、可能還沒到齊,而信封是我這一紀元實際拿到的東西。
   */
  private canDecrypt(docId: string): boolean {
    if (!this.keys?.hasSpaceKey) return true;
    const spaceId = spaceOf(this.meta, docId);
    if (this.keys.hasSpaceKey(spaceId)) return true;
    if (this.keys.isRestricted?.(spaceId)) return false;
    return spaceMembersOf(this.meta, spaceId) === undefined;
  }

  /**
   * 輪換後把新金鑰接上(團隊 vault):上層收到 `onKeyRotated` → 重跑 bootstrap → 呼叫這裡。
   * 先卸掉這一紀元解不開的 doc 再恢復推送——留著的話,client 恢復後會拿新金鑰把它整份重推,
   * 而那正是「我已經沒權限的內容被我重新加密外洩」的路徑。
   */
  async applyRotation(root: Uint8Array, epoch: number, spaceKeys?: ReadonlyMap<string, Uint8Array>, restrictedSpaceIds?: readonly string[]): Promise<void> {
    if (!this.keys?.rotate || !this.client) throw new Error("此 vault 的金鑰來源不支援輪換");
    this.keys.rotate(root, spaceKeys, restrictedSpaceIds);
    for (const docId of this.paths().keys()) {
      if (this.canDecrypt(docId)) continue;
      this.client.forget(docId);
      // 確定無權(信封說受限、我沒金鑰、名單也明確排除我)才刪本地明文;
      // 不確定就留著——授權競態下的暫態誤刪是拿不回來的
      if (this.definitelyInaccessible(docId)) void this.purgeLocal(docId);
    }
    await this.client.applyRotation(epoch);
  }

  /** 三重確認的「確定無權」;任何一項不成立都當作不確定,不動使用者的檔案 */
  private definitelyInaccessible(docId: string): boolean {
    if (!this.keys?.isRestricted || this.memberId === undefined) return false;
    const spaceId = spaceOf(this.meta, docId);
    if (!this.keys.isRestricted(spaceId) || (this.keys.hasSpaceKey?.(spaceId) ?? false)) return false;
    const members = spaceMembersOf(this.meta, spaceId);
    return members !== undefined && !members.includes(this.memberId);
  }

  private async purgeLocal(docId: string): Promise<void> {
    const rel = this.paths().get(docId);
    this.docs.get(docId)?.destroy();
    this.docs.delete(docId);
    if (rel) await this.storage.deleteNote(rel).catch(() => undefined);
    this.events.onChanged();
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
   * 新建一篇筆記。docId 由本端產生(與桌面同樣是 UUID),路徑寫進 meta 的 LWW map,
   * 然後 `track` 讓同步層當場開始推——不 track 的話,這篇要等下一次重連的對帳才上得去,
   * 而「在手機上記一筆」的價值就在於它馬上會出現在桌面。
   *
   * 離線時 track 是 no-op(client 會在重連的 reconcile 依 listDocIds 補上),
   * 筆記仍已寫進本地檔案與 meta,不會遺失。
   */
  create(relRaw: string): { docId: string; rel: string } {
    const rel = relRaw.endsWith(".md") || relRaw.endsWith(".canvas") ? relRaw : `${relRaw}.md`;
    const existing = this.list().find((i) => i.rel === rel);
    if (existing) return existing; // 撞名就開既有那篇,不覆蓋別人的內容
    const docId = crypto.randomUUID();
    const doc = this.openDoc(docId);
    const title = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.(md|canvas)$/, "");
    doc.transact(() => doc.getText("md").insert(0, `# ${title}\n\n`), "local");
    this.meta.transact(() => this.paths().set(docId, rel), "local");
    this.client?.track(docId);
    return { docId, rel };
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
