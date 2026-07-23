import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import {
  encodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type DocHead,
  type ShareInfo,
  type SharePermission,
} from "./protocol.ts";
import { identityCipher, type Cipher } from "./cipher.ts";
import { identityChallengeBytes, type SyncIdentity } from "./identity.ts";

/** awareness 狀態:游標/選取/使用者資訊等,JSON 可序列化 */
export type AwarenessState = Record<string, unknown>;

/** 週期重播本地 awareness:讓新加入者看得到,並刷新對端的過期計時 */
const AWARENESS_REFRESH_MS = 10_000;

/**
 * 空 Yjs update 的位元組:沒有任何 struct 也沒有任何刪除
 * 用來判斷 diff 是否真的沒東西可推;不能用 state vector 比對,因為 SV 不記錄刪除
 */
const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * client 同步引擎:每 doc 一個狀態機
 * syncedSv = 伺服器已確認持有的本端 state vector;推送一律是對它的差分,
 * 離線編輯不用逐筆佇列,重連一則差分補齊;重送冪等(Yjs 重複 op 無害 + 伺服器 device/counter 去重)
 */

export interface SyncDocState {
  lastSeq: number;
  counter: number;
  syncedSv?: Uint8Array;
}

export interface SyncHost {
  /** 取得(必要時建立)docId 對應的 Y.Doc;undefined = 拒絕這個 doc */
  openDoc(docId: string): Promise<Y.Doc | undefined>;
  listDocIds(): Promise<string[]>;
  loadState(docId: string): SyncDocState | undefined;
  saveState(docId: string, state: SyncDocState): void;
}

/** 與瀏覽器 WebSocket 同形的最小介面,Electron main 以 ws 適配 */
export interface SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer | Uint8Array }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export type SyncStatus = "connecting" | "online" | "offline";

export interface SyncClientOptions {
  url: string;
  token: string;
  vaultId: string;
  deviceId: string;
  host: SyncHost;
  createSocket(url: string): SocketLike;
  cipher?: Cipher;
  /** 提供時走帶身分認證(challenge-response);未提供則走 legacy token-only auth */
  identity?: SyncIdentity;
  /** vault 當前金鑰紀元(2c-2;team vault 由 bootstrap 的信封取得,個人 vault 省略 = 0);doc 寫入都帶它 */
  epoch?: number;
  /**
   * 金鑰已輪換(keyRotated 廣播,或重連 authOk 發現 epoch 落後):推送已自動暫停,
   * 呼叫端應重跑 bootstrap 取新 root、rotate 金鑰來源後呼叫 applyRotation 恢復收斂
   */
  onKeyRotated?(epoch: number): void;
  /** 被移出團隊(伺服器 error code removed/enroll-required):已停止重連,上層據此通知使用者 */
  onRevoked?(code: string): void;
  onStatus?(status: SyncStatus): void;
  /** 某 doc 的 awareness 狀態集變化(含遠端加入/離開);states 的 key 是 Yjs clientID */
  onAwareness?(docId: string, states: Map<number, AwarenessState>): void;
  pushDebounceMs?: number;
  /** 增量日誌超過快照點多少筆就上傳新快照 */
  snapshotThreshold?: number;
  /** 輪換 repull 撞到尚未重加密的舊快照時,隔多久重拉一次 */
  repullRetryMs?: number;
}

interface AwarenessEntry {
  aw: awarenessProtocol.Awareness;
  onUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;
}

interface DocRuntime {
  docId: string;
  doc: Y.Doc;
  state: SyncDocState;
  pushing: boolean;
  dirty: boolean;
  pushTimer: ReturnType<typeof setTimeout> | undefined;
  pushedSv: Uint8Array | undefined;
  /** 上次收到跳號 update 時已發過增量 pull:再跳號表示增量已被快照截斷(如輪換 rekey),改拉快照 */
  gapPulled: boolean;
  /** 上次補洞請求的時刻:pull 回覆本身可能又是跳號 update(1:1 再生),節流免得變緊迴圈 */
  gapSince: number | undefined;
  /** 排程中的補洞請求:節流窗內的跳號不丟需求,窗後補發一次 */
  gapTimer: ReturnType<typeof setTimeout> | undefined;
  onUpdate: (update: Uint8Array, origin: unknown) => void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_PUSH_DEBOUNCE_MS = 300;
const DEFAULT_SNAPSHOT_THRESHOLD = 200;
const DEFAULT_REPULL_RETRY_MS = 3000;
/** 跳號補洞請求的節流窗:pull 的回覆若仍跳號會再觸發補洞,無節流會變成每秒數千次的自我再生迴圈 */
const GAP_RETRY_MS = 1000;

export class SyncClient {
  private readonly cipher: Cipher;
  private socket: SocketLike | undefined;
  private online = false;
  private stopped = true;
  private status: SyncStatus = "offline";
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runtimes = new Map<string, DocRuntime>();
  private readonly awareness = new Map<string, AwarenessEntry>();
  private awarenessTimer: ReturnType<typeof setInterval> | undefined;
  private serverHeads = new Map<string, DocHead>();
  /** 分享管理請求以 reqId 對應回覆 */
  private readonly pendingShare = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private shareReqId = 0;
  /** 訊息依到達順序處理,避免非同步解密造成亂序套用 */
  private rx: Promise<void> = Promise.resolve();
  /** vault 金鑰紀元(2c-2):doc 寫入都帶它,伺服器以柵欄拒不符者 */
  private epoch: number;
  /** 輪換窗口:收到 keyRotated(或 authOk 發現落後)後暫停一切寫入,等 applyRotation 才恢復 */
  private rotationPending = false;
  /** 輪換後待以新金鑰重拉的 doc;撞到尚未重加密的舊快照就排程重試,直到收斂 */
  private readonly pendingRepull = new Set<string>();
  private repullTimer: ReturnType<typeof setTimeout> | undefined;
  /** rekey 等待伺服器 snapshotAck 的回呼(docId → waiters):ack 才算完成,斷線一律以 false 收尾 */
  private readonly snapshotAckWaiters = new Map<string, Array<(ok: boolean) => void>>();

  constructor(private readonly opts: SyncClientOptions) {
    this.cipher = opts.cipher ?? identityCipher;
    this.epoch = opts.epoch ?? 0;
  }

  start(): void {
    this.stopped = false;
    this.awarenessTimer = setInterval(() => this.refreshAwareness(), AWARENESS_REFRESH_MS);
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.repullTimer);
    if (this.awarenessTimer !== undefined) clearInterval(this.awarenessTimer);
    // 趁連線還在,主動告知對端本地離場,對端據此即時清掉游標(否則要等逾時)
    await this.announceLeave();
    for (const rt of this.runtimes.values()) {
      clearTimeout(rt.pushTimer);
      clearTimeout(rt.gapTimer);
      rt.doc.off("update", rt.onUpdate);
    }
    this.runtimes.clear();
    for (const { aw, onUpdate } of this.awareness.values()) {
      aw.off("update", onUpdate);
      aw.destroy();
    }
    this.awareness.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.online = false;
    this.setStatus("offline");
    this.rejectPendingShares();
    this.flushSnapshotAcks(false);
    await this.rx;
  }

  private rejectPendingShares(): void {
    for (const { reject } of this.pendingShare.values()) reject(new Error("連線已關閉"));
    this.pendingShare.clear();
  }

  /** 為某 doc 建立分享,回傳伺服器產生的 shareId(URL 與金鑰由呼叫端組) */
  createShare(docId: string, permission: SharePermission): Promise<string> {
    return this.shareRequest((reqId) => ({ type: "shareCreate", reqId, docId, permission }));
  }

  /** 列出本 vault 全部分享(含已撤銷) */
  listShares(): Promise<ShareInfo[]> {
    return this.shareRequest((reqId) => ({ type: "shareList", reqId }));
  }

  /** 撤銷分享,回傳撤銷後的分享清單 */
  revokeShare(shareId: string): Promise<ShareInfo[]> {
    return this.shareRequest((reqId) => ({ type: "shareRevoke", reqId, shareId }));
  }

  private shareRequest<T>(build: (reqId: number) => ClientMessage): Promise<T> {
    if (!this.online) return Promise.reject(new Error("離線,無法管理分享"));
    const reqId = ++this.shareReqId;
    return new Promise<T>((resolve, reject) => {
      this.pendingShare.set(reqId, { resolve: resolve as (value: unknown) => void, reject });
      this.send(build(reqId));
    });
  }

  /** UI 設定本地 awareness(游標/選取/在線);null = 清除本地狀態 */
  setLocalAwareness(docId: string, state: AwarenessState | null): void {
    void this.ensureAwareness(docId)
      .then((entry) => entry?.aw.setLocalState(state))
      .catch((err: unknown) => console.error(`設定 awareness 失敗 ${docId}:`, err));
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      const id = this.opts.identity;
      if (id) {
        // 帶身分:送宣稱身分與公鑰,等伺服器回 challenge nonce 再簽章(見 handleMessage authChallenge)
        // enrollmentToken 留空:SyncClient 只跑「已 enroll 成員」的重連;新成員帶邀請碼的首次 enroll 走獨立 bootstrap
        this.send({
          type: "authId",
          token: this.opts.token,
          vaultId: this.opts.vaultId,
          memberId: id.memberId,
          pubSign: id.pubSign,
          pubWrap: id.pubWrap,
          enrollmentToken: "",
        });
      } else {
        this.send({ type: "auth", token: this.opts.token, vaultId: this.opts.vaultId });
      }
    };
    socket.onmessage = (event) => {
      this.rx = this.rx
        .then(() => {
          const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
          return this.handleMessage(decodeServerMessage(bytes));
        })
        .catch((err: unknown) => {
          console.error("同步訊息處理失敗:", err);
        });
    };
    socket.onerror = () => {
      // onclose 會跟著觸發,重連交給它
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.online = false;
      this.setStatus("offline");
      this.rejectPendingShares(); // 未回覆的分享請求不留懸空 promise
      this.flushSnapshotAcks(false); // 等 ack 的 rekey 以失敗收尾,呼叫端重試
      this.scheduleReconnect();
    };
  }

  /** doc 已刪除:卸下狀態機與 awareness,之後同名 docId 的訊息會重新建立 */
  /** 開始同步某 doc(mid-session 新建的本地 doc,如新筆記或留言 doc):建狀態機並補推/補拉 */
  track(docId: string): void {
    if (!this.online) return; // 離線時 reconnect 的 reconcile 會依 listDocIds 補上
    void this.reconcile(docId).catch((err: unknown) => console.error(`追蹤 doc 失敗 ${docId}:`, err));
  }

  /**
   * 以目前 cipher 重推一份全量快照,伺服器截斷該點之前的舊增量。
   * 用於「筆記換空間」重新加密:讓該 docId 的伺服器 blob 全部改用新空間金鑰。
   * uptoSeq 取 head+1 以越過現有快照點(同 seq 會被伺服器 saveSnapshot 忽略);需已與伺服器拉齊,
   * 否則不覆蓋(不能用不完整的本地內容蓋掉伺服器)。回傳是否真的推了快照。
   */
  async rekey(docId: string): Promise<boolean> {
    const rt = await this.ensure(docId);
    if (!rt || !this.online || this.rotationPending) return false;
    const knownHead = this.serverHeads.get(docId)?.headSeq ?? rt.state.lastSeq;
    if (rt.state.lastSeq < knownHead) return false; // 未拉齊
    const uptoSeq = knownHead + 1;
    const payload = await this.cipher.encrypt(docId, Y.encodeStateAsUpdate(rt.doc));
    this.send({ type: "snapshotPush", docId, uptoSeq, epoch: this.epoch, payload });
    // 等伺服器 snapshotAck 才算數:輪換的 rekey「完成」意味著快照確實落盤,
    // 否則 owner 在飛行窗口崩潰會清掉續跑標記、留下一篇舊金鑰 doc 讓成員永遠解不開
    if (!(await this.waitSnapshotAck(docId))) return false;
    rt.state = { ...rt.state, lastSeq: uptoSeq };
    this.opts.host.saveState(docId, rt.state);
    this.serverHeads.set(docId, { docId, headSeq: uptoSeq, snapshotSeq: uptoSeq });
    return true;
  }

  private waitSnapshotAck(docId: string, timeoutMs = 10_000): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const list = this.snapshotAckWaiters.get(docId) ?? [];
      list.push(done);
      this.snapshotAckWaiters.set(docId, list);
    });
  }

  /** ack 到(ok)或連線斷(!ok):喚醒該 doc(或全部)等待中的 rekey */
  private flushSnapshotAcks(ok: boolean, docId?: string): void {
    const entries = docId === undefined ? [...this.snapshotAckWaiters.keys()] : [docId];
    for (const id of entries) {
      const list = this.snapshotAckWaiters.get(id);
      if (!list) continue;
      this.snapshotAckWaiters.delete(id);
      for (const w of list) w(ok);
    }
  }

  /**
   * 金鑰輪換後的全量重加密(2c-2,owner 在柵欄下執行):對每個 doc 以新金鑰重推快照。
   * 全冪等——owner 崩潰重啟後整套重跑一遍即補完。回傳是否每個 doc 都完成(false = 有 doc 未拉齊或離線)。
   */
  async rekeyAll(): Promise<boolean> {
    const ids = new Set([...(await this.opts.host.listDocIds()), ...this.serverHeads.keys()]);
    let all = true;
    for (const docId of ids) {
      if (!(await this.rekey(docId))) all = false;
    }
    return all;
  }

  /** 是否已拉齊伺服器上所有 doc(輪換前置檢查:未拉齊就 rekey 會蓋掉別人的內容,必須中止) */
  allCaughtUp(): boolean {
    if (!this.online) return false;
    for (const [docId, head] of this.serverHeads) {
      const rt = this.runtimes.get(docId);
      if (!rt || rt.state.lastSeq < head.headSeq) return false;
    }
    return true;
  }

  /**
   * 輪換收斂(2c-2):上層拿到新 root 並 rotate 金鑰來源後呼叫。前移 epoch、恢復推送;
   * repull 時把所有 doc 以新金鑰重拉快照(對齊 rekey 後的新序列),owner 端(自己重加密)傳 false 跳過。
   */
  async applyRotation(epoch: number, repull = true): Promise<void> {
    if (epoch < this.epoch) return;
    this.epoch = epoch;
    this.rotationPending = false;
    if (!this.online) return; // 離線:重連 authOk 的 epoch 已相符,走正常 reconcile
    const local = await this.opts.host.listDocIds();
    for (const docId of new Set([...local, ...this.serverHeads.keys()])) {
      const rt = await this.ensure(docId);
      if (!rt) continue;
      if (repull && this.serverHeads.has(docId)) {
        // 全量重拉而非增量 pull:輪換重加密會截斷舊增量並使 seq 出現空洞,只有快照能對齊新序列
        this.pendingRepull.add(docId);
        this.send({ type: "snapshotPull", docId });
      }
      this.schedulePush(rt);
    }
  }

  /**
   * 跳號補洞(節流,不丟需求):先增量 pull;上一輪已 pull 過仍跳號 = 增量被快照截斷
   * (輪換 rekey 或壓縮),改拉快照對齊。pull 的回覆可能正是同一則跳號 update(1:1 再生),
   * 無節流會滾成每秒數千次的緊迴圈把 event loop 吃滿;每 doc 同時間至多一個排程中的補洞。
   */
  private scheduleGapFill(rt: DocRuntime): void {
    if (rt.gapTimer !== undefined) return;
    const elapsed = rt.gapSince === undefined ? GAP_RETRY_MS : Date.now() - rt.gapSince;
    rt.gapTimer = setTimeout(
      () => {
        rt.gapTimer = undefined;
        if (!this.online || this.stopped) return;
        rt.gapSince = Date.now();
        if (rt.gapPulled) {
          rt.gapPulled = false;
          this.send({ type: "snapshotPull", docId: rt.docId });
        } else {
          rt.gapPulled = true;
          this.send({ type: "pull", docId: rt.docId, fromSeq: rt.state.lastSeq });
        }
      },
      Math.max(0, GAP_RETRY_MS - elapsed),
    );
  }

  /** 序列已對齊:清跳號補洞狀態 */
  private clearGap(rt: DocRuntime): void {
    rt.gapPulled = false;
    rt.gapSince = undefined;
    clearTimeout(rt.gapTimer);
    rt.gapTimer = undefined;
  }

  /**
   * 跨越解不開的 update:以本地內容重推快照,uptoSeq 蓋到毒 update 為止,伺服器隨即截斷它。
   * 本地內容含毒之前已收斂的一切;毒對本紀元金鑰持有者是永遠的死資料,截斷即正確。
   * 與補洞共用 gapTimer 槽位(同一 doc 同時間只跑一種恢復),節流同 GAP_RETRY_MS。
   */
  private schedulePoisonSkip(rt: DocRuntime, poisonSeq: number): void {
    if (rt.gapTimer !== undefined) return;
    rt.gapTimer = setTimeout(() => {
      rt.gapTimer = undefined;
      if (!this.online || this.rotationPending || this.stopped) return;
      void (async () => {
        const payload = await this.cipher.encrypt(rt.docId, Y.encodeStateAsUpdate(rt.doc));
        this.send({ type: "snapshotPush", docId: rt.docId, uptoSeq: poisonSeq, epoch: this.epoch, payload });
        if (!(await this.waitSnapshotAck(rt.docId))) return; // 被拒(唯讀成員)或斷線:等可寫成員收尾
        rt.state = { ...rt.state, lastSeq: Math.max(rt.state.lastSeq, poisonSeq) };
        this.opts.host.saveState(rt.docId, rt.state);
        // serverHeads 一併前移:之後的 rekey/compact 以此算 uptoSeq,停在舊值會把重加密推到已存在的快照點之下
        const head = this.serverHeads.get(rt.docId);
        this.serverHeads.set(rt.docId, {
          docId: rt.docId,
          headSeq: Math.max(head?.headSeq ?? 0, poisonSeq),
          snapshotSeq: Math.max(head?.snapshotSeq ?? 0, poisonSeq),
        });
        this.send({ type: "pull", docId: rt.docId, fromSeq: rt.state.lastSeq });
      })().catch((err: unknown) => console.error(`跨越解不開的 update 失敗 ${rt.docId}:`, err));
    }, GAP_RETRY_MS);
  }

  /** 撞到尚未重加密的舊快照:隔一陣子把 pendingRepull 名單重拉一輪,直到 owner 補完 */
  private scheduleRepullRetry(): void {
    if (this.repullTimer !== undefined || this.stopped) return;
    this.repullTimer = setTimeout(() => {
      this.repullTimer = undefined;
      if (!this.online) return; // 重連後 applyRotation/reconcile 會接手
      for (const docId of this.pendingRepull) this.send({ type: "snapshotPull", docId });
    }, this.opts.repullRetryMs ?? DEFAULT_REPULL_RETRY_MS);
  }

  /**
   * 強制重新抓取某 doc 的最新快照(以目前 cipher 解密)。
   * 用於另一裝置得知某筆記換了空間(金鑰改變)後,重新以新空間金鑰解出——
   * 不倚賴可能過期的 serverHeads,直接請伺服器回快照。
   */
  repull(docId: string): void {
    if (!this.online) return;
    void this.ensure(docId).then((rt) => {
      if (rt) this.send({ type: "snapshotPull", docId });
    });
  }

  forget(docId: string): void {
    const entry = this.awareness.get(docId);
    if (entry) {
      entry.aw.off("update", entry.onUpdate);
      entry.aw.destroy();
      this.awareness.delete(docId);
    }
    const rt = this.runtimes.get(docId);
    if (!rt) return;
    clearTimeout(rt.pushTimer);
    clearTimeout(rt.gapTimer);
    rt.doc.off("update", rt.onUpdate);
    this.runtimes.delete(docId);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }

  private async handleMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "authChallenge": {
        // 伺服器給的 nonce:以身分私鑰簽 challenge 回證,兩端用同一 helper 組待簽位元組
        const id = this.opts.identity;
        if (!id) return; // 沒送 authId 卻收到 challenge:忽略
        const proof = id.sign(identityChallengeBytes(msg.nonce, this.opts.vaultId, id.memberId));
        this.send({ type: "authProof", signature: proof });
        break;
      }
      case "authOk": {
        this.online = true;
        this.backoff = RECONNECT_MIN_MS;
        this.setStatus("online");
        this.serverHeads = new Map(msg.docs.map((d) => [d.docId, d]));
        // 斷線期間卡住的 in-flight 推送作廢,重連後重推
        for (const rt of this.runtimes.values()) rt.pushing = false;
        // 離線期間錯過金鑰輪換:本地 root 已解不開伺服器內容,暫停一切寫入並通知上層
        // 重跑 bootstrap 取新 root;收斂(repull + 恢復推送)交給 applyRotation
        if (msg.epoch > this.epoch) {
          this.rotationPending = true;
          this.opts.onKeyRotated?.(msg.epoch);
          break;
        }
        const local = await this.opts.host.listDocIds();
        for (const docId of new Set([...local, ...this.serverHeads.keys()])) {
          await this.reconcile(docId);
        }
        this.refreshAwareness(); // 重連後立刻重播本地 awareness,讓在場者重新看到我
        break;
      }
      case "update": {
        const rt = await this.ensure(msg.docId);
        if (!rt || msg.seq <= rt.state.lastSeq) return;
        if (msg.seq > rt.state.lastSeq + 1) {
          // 跳號:交給節流的補洞排程(先增量 pull、仍跳號改快照),丟棄這則亂序 update 本身
          this.scheduleGapFill(rt);
          return;
        }
        let plain: Uint8Array;
        try {
          plain = await this.cipher.decrypt(msg.docId, msg.payload);
        } catch (err) {
          // 解不開的連續 update(對方以不同金鑰視圖寫入,如空間受限的同步窗口):它會永遠
          // 擋在序列上,任何 pull 都跨不過去。丟棄它、節流後以本地內容重推快照把它蓋掉——
          // 對「解不開的一方」它本就是死資料;唯讀成員的快照會被伺服器軟拒,由可寫成員收尾
          console.error(`update 解密失敗 ${msg.docId} seq=${msg.seq},排程以快照跨越:`, err);
          this.schedulePoisonSkip(rt, msg.seq);
          return;
        }
        Y.applyUpdate(rt.doc, plain, "sync");
        rt.state = { ...rt.state, lastSeq: msg.seq };
        this.clearGap(rt);
        this.opts.host.saveState(msg.docId, rt.state);
        await this.maybeCompact(rt);
        break;
      }
      case "snapshot": {
        const rt = await this.ensure(msg.docId);
        if (!rt) return;
        if (msg.payload.length > 0 && msg.uptoSeq > rt.state.lastSeq) {
          let update: Uint8Array;
          try {
            update = await this.cipher.decrypt(msg.docId, msg.payload);
          } catch (err) {
            // 輪換窗口:owner 尚未以新 root 重加密此 doc,快照仍是舊金鑰密文 → 稍後重拉,絕不套用壞資料
            if (this.pendingRepull.has(msg.docId)) {
              this.scheduleRepullRetry();
              return;
            }
            console.error(`snapshot 解密失敗 ${msg.docId} uptoSeq=${msg.uptoSeq}(金鑰不符?):`, err);
            return;
          }
          Y.applyUpdate(rt.doc, update, "sync");
          rt.state = { ...rt.state, lastSeq: msg.uptoSeq };
          this.opts.host.saveState(msg.docId, rt.state);
          this.clearGap(rt);
        }
        const head = this.serverHeads.get(msg.docId);
        const caughtUp = !head || rt.state.lastSeq >= head.headSeq;
        if (caughtUp) this.pendingRepull.delete(msg.docId);
        if (this.pendingRepull.has(msg.docId)) {
          // 輪換 repull 還沒等到新快照(空快照或舊快照點):增量已被截斷,只能等重加密後的快照
          this.scheduleRepullRetry();
        } else {
          // 快照後補拉增量:本地 head 資訊可能過期(輪換 rekey 會前移 seq),以現況問一次最保險,沒新增量就是空回覆
          this.send({ type: "pull", docId: msg.docId, fromSeq: rt.state.lastSeq });
        }
        break;
      }
      case "ack": {
        const rt = this.runtimes.get(msg.docId);
        if (!rt) return;
        rt.pushing = false;
        // syncedSv 前移到剛送出那一刻的 state vector:之後只有更新的 op 才會被推
        rt.state = { ...rt.state, syncedSv: rt.pushedSv };
        if (msg.seq === rt.state.lastSeq + 1) rt.state = { ...rt.state, lastSeq: msg.seq };
        else if (msg.seq > rt.state.lastSeq + 1) this.send({ type: "pull", docId: msg.docId, fromSeq: rt.state.lastSeq });
        this.opts.host.saveState(msg.docId, rt.state);
        if (rt.dirty) this.schedulePush(rt);
        else await this.maybeCompact(rt);
        break;
      }
      case "snapshotAck":
        this.flushSnapshotAcks(true, msg.docId);
        break;
      case "awareness": {
        const entry = await this.ensureAwareness(msg.docId);
        if (!entry) return;
        // 解密失敗(密語錯)由 rx 的 catch 吞掉,對端就是看不到,不影響同步
        const update = await this.cipher.decrypt(msg.docId, msg.payload);
        awarenessProtocol.applyAwarenessUpdate(entry.aw, update, "remote");
        break;
      }
      case "shareCreated": {
        this.pendingShare.get(msg.reqId)?.resolve(msg.shareId);
        this.pendingShare.delete(msg.reqId);
        break;
      }
      case "shareCatalog": {
        this.pendingShare.get(msg.reqId)?.resolve(msg.shares);
        this.pendingShare.delete(msg.reqId);
        break;
      }
      case "keyRotated": {
        // 金鑰已輪換:立即暫停一切寫入(柵欄下舊 epoch 會被拒,更重要的是不能拿舊 root 產生新密文)
        // 上層 bootstrap 到新 root 後呼叫 applyRotation 恢復。舊 epoch 的重複廣播忽略
        if (msg.epoch <= this.epoch) break;
        this.rotationPending = true;
        this.opts.onKeyRotated?.(msg.epoch);
        break;
      }
      case "error":
        console.error(`同步伺服器回報錯誤:${msg.code} ${msg.message}`);
        // 被移出團隊 / 重連被拒為非成員:停止重連並通知上層(本地檔案收不回,但 UI 要誠實反映)
        if (msg.code === "removed" || msg.code === "enroll-required") {
          this.stopped = true;
          clearTimeout(this.reconnectTimer);
          this.opts.onRevoked?.(msg.code);
        }
        break;
    }
  }

  private async ensureAwareness(docId: string): Promise<AwarenessEntry | undefined> {
    const existing = this.awareness.get(docId);
    if (existing) return existing;
    const doc = await this.opts.host.openDoc(docId);
    // stop() 可能在 await 期間跑完並清空 map:此時不能再建實例,否則帶計時器的 Awareness 永不回收
    if (!doc || this.stopped) return undefined;
    const raced = this.awareness.get(docId);
    if (raced) return raced;
    const aw = new awarenessProtocol.Awareness(doc);
    aw.setLocalState(null); // 開場不宣告在場,等 UI 設定狀態才廣播
    const onUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      this.opts.onAwareness?.(docId, new Map(aw.getStates() as Map<number, AwarenessState>));
      if (origin === "remote") return; // 遠端來的不回廣播,避免迴圈
      this.sendAwareness(docId, aw, [...added, ...updated, ...removed]);
    };
    aw.on("update", onUpdate);
    const entry: AwarenessEntry = { aw, onUpdate };
    this.awareness.set(docId, entry);
    return entry;
  }

  private sendAwareness(docId: string, aw: awarenessProtocol.Awareness, clients: number[]): void {
    if (!this.online || clients.length === 0) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(aw, clients);
    void this.cipher
      .encrypt(docId, update)
      .then((payload) => this.send({ type: "awareness", docId, payload }))
      .catch((err: unknown) => console.error(`awareness 廣播失敗 ${docId}:`, err));
  }

  /** 週期重播本地非空 awareness:讓新加入者看到、刷新對端過期計時 */
  private refreshAwareness(): void {
    if (!this.online) return;
    for (const [docId, { aw }] of this.awareness) {
      if (aw.getLocalState() !== null) this.sendAwareness(docId, aw, [aw.clientID]);
    }
  }

  private async announceLeave(): Promise<void> {
    if (!this.online) return;
    for (const [docId, { aw }] of this.awareness) {
      if (aw.getLocalState() === null) continue;
      const clients = [aw.clientID];
      awarenessProtocol.removeAwarenessStates(aw, clients, "local"); // clock 前進、state=null
      try {
        const payload = await this.cipher.encrypt(docId, awarenessProtocol.encodeAwarenessUpdate(aw, clients));
        this.socket?.send(encodeClientMessage({ type: "awareness", docId, payload }));
      } catch (err) {
        console.error(`awareness 離場廣播失敗 ${docId}:`, err);
      }
    }
  }

  private async reconcile(docId: string): Promise<void> {
    const rt = await this.ensure(docId);
    if (!rt) return;
    const head = this.serverHeads.get(docId);
    if (head) {
      // 雙路徑:落後快照點就走快照 bootstrap,否則增量補齊
      if (rt.state.lastSeq < head.snapshotSeq) this.send({ type: "snapshotPull", docId });
      else if (rt.state.lastSeq < head.headSeq) this.send({ type: "pull", docId, fromSeq: rt.state.lastSeq });
    }
    this.schedulePush(rt);
    await this.maybeCompact(rt);
  }

  private async ensure(docId: string): Promise<DocRuntime | undefined> {
    const existing = this.runtimes.get(docId);
    if (existing) return existing;
    const doc = await this.opts.host.openDoc(docId);
    // stop() 可能在 await 期間跑完並清空 runtimes:此時不能再掛 update listener
    if (!doc || this.stopped) return undefined;
    const raced = this.runtimes.get(docId);
    if (raced) return raced;
    const rt: DocRuntime = {
      docId,
      doc,
      state: this.opts.host.loadState(docId) ?? { lastSeq: 0, counter: 0 },
      pushing: false,
      dirty: false,
      pushTimer: undefined,
      pushedSv: undefined,
      gapPulled: false,
      gapSince: undefined,
      gapTimer: undefined,
      onUpdate: (_update, origin) => {
        if (origin === "sync") return;
        rt.dirty = true;
        this.schedulePush(rt);
      },
    };
    doc.on("update", rt.onUpdate);
    this.runtimes.set(docId, rt);
    return rt;
  }

  private schedulePush(rt: DocRuntime): void {
    if (rt.pushTimer !== undefined) return;
    rt.pushTimer = setTimeout(() => {
      rt.pushTimer = undefined;
      void this.push(rt).catch((err: unknown) => {
        console.error(`推送失敗 ${rt.docId}:`, err);
      });
    }, this.opts.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS);
  }

  private async push(rt: DocRuntime): Promise<void> {
    if (!this.online || rt.pushing || this.rotationPending) {
      rt.dirty = true;
      return;
    }
    rt.dirty = false;
    // 只有真的有新 op(含刪除)才推:diff 為空 update 就沒東西可送
    // 不用 state vector 比對,因為 SV 不涵蓋刪除,會把刪除當成無變更吞掉
    const diff = Y.encodeStateAsUpdate(rt.doc, rt.state.syncedSv);
    if (bytesEqual(diff, EMPTY_UPDATE)) return;
    rt.pushedSv = Y.encodeStateVector(rt.doc);
    rt.pushing = true;
    // counter 先落盤再送,重啟後不重用號碼,伺服器去重才不會誤傷不同內容
    rt.state = { ...rt.state, counter: rt.state.counter + 1 };
    this.opts.host.saveState(rt.docId, rt.state);
    this.send({
      type: "push",
      docId: rt.docId,
      deviceId: this.opts.deviceId,
      counter: rt.state.counter,
      epoch: this.epoch,
      payload: await this.cipher.encrypt(rt.docId, diff),
    });
  }

  /** 增量日誌拉長且本端已拉齊時,上傳全量快照讓伺服器截斷 */
  private async maybeCompact(rt: DocRuntime): Promise<void> {
    if (this.rotationPending) return;
    const head = this.serverHeads.get(rt.docId);
    const snapshotSeq = head?.snapshotSeq ?? 0;
    const knownHead = head?.headSeq ?? 0;
    const threshold = this.opts.snapshotThreshold ?? DEFAULT_SNAPSHOT_THRESHOLD;
    if (rt.state.lastSeq < knownHead || rt.state.lastSeq - snapshotSeq < threshold) return;
    const payload = await this.cipher.encrypt(rt.docId, Y.encodeStateAsUpdate(rt.doc));
    this.send({ type: "snapshotPush", docId: rt.docId, uptoSeq: rt.state.lastSeq, epoch: this.epoch, payload });
    this.serverHeads.set(rt.docId, {
      docId: rt.docId,
      headSeq: Math.max(knownHead, rt.state.lastSeq),
      snapshotSeq: rt.state.lastSeq,
    });
  }

  private send(msg: ClientMessage): void {
    try {
      this.socket?.send(encodeClientMessage(msg));
    } catch (err) {
      // 連線剛斷的競態:訊息丟了沒關係,重連後 reconcile 會補
      console.error("同步訊息送出失敗:", err);
    }
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
