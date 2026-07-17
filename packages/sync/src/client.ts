import * as Y from "yjs";
import {
  encodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type DocHead,
} from "./protocol.ts";
import { identityCipher, type Cipher } from "./cipher.ts";

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
  onStatus?(status: SyncStatus): void;
  pushDebounceMs?: number;
  /** 增量日誌超過快照點多少筆就上傳新快照 */
  snapshotThreshold?: number;
}

interface DocRuntime {
  docId: string;
  doc: Y.Doc;
  state: SyncDocState;
  pushing: boolean;
  dirty: boolean;
  pushTimer: ReturnType<typeof setTimeout> | undefined;
  pushedSv: Uint8Array | undefined;
  onUpdate: (update: Uint8Array, origin: unknown) => void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_PUSH_DEBOUNCE_MS = 300;
const DEFAULT_SNAPSHOT_THRESHOLD = 200;

export class SyncClient {
  private readonly cipher: Cipher;
  private socket: SocketLike | undefined;
  private online = false;
  private stopped = true;
  private status: SyncStatus = "offline";
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runtimes = new Map<string, DocRuntime>();
  private serverHeads = new Map<string, DocHead>();
  /** 訊息依到達順序處理,避免非同步解密造成亂序套用 */
  private rx: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SyncClientOptions) {
    this.cipher = opts.cipher ?? identityCipher;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    for (const rt of this.runtimes.values()) {
      clearTimeout(rt.pushTimer);
      rt.doc.off("update", rt.onUpdate);
    }
    this.runtimes.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.online = false;
    this.setStatus("offline");
    await this.rx;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this.send({ type: "auth", token: this.opts.token, vaultId: this.opts.vaultId });
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
      this.scheduleReconnect();
    };
  }

  /** doc 已刪除:卸下狀態機,之後同名 docId 的訊息會重新建立 */
  forget(docId: string): void {
    const rt = this.runtimes.get(docId);
    if (!rt) return;
    clearTimeout(rt.pushTimer);
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
      case "authOk": {
        this.online = true;
        this.backoff = RECONNECT_MIN_MS;
        this.setStatus("online");
        this.serverHeads = new Map(msg.docs.map((d) => [d.docId, d]));
        // 斷線期間卡住的 in-flight 推送作廢,重連後重推
        for (const rt of this.runtimes.values()) rt.pushing = false;
        const local = await this.opts.host.listDocIds();
        for (const docId of new Set([...local, ...this.serverHeads.keys()])) {
          await this.reconcile(docId);
        }
        break;
      }
      case "update": {
        const rt = await this.ensure(msg.docId);
        if (!rt || msg.seq <= rt.state.lastSeq) return;
        if (msg.seq > rt.state.lastSeq + 1) {
          this.send({ type: "pull", docId: msg.docId, fromSeq: rt.state.lastSeq });
          return;
        }
        Y.applyUpdate(rt.doc, await this.cipher.decrypt(msg.docId, msg.payload), "sync");
        rt.state = { ...rt.state, lastSeq: msg.seq };
        this.opts.host.saveState(msg.docId, rt.state);
        await this.maybeCompact(rt);
        break;
      }
      case "snapshot": {
        const rt = await this.ensure(msg.docId);
        if (!rt || msg.payload.length === 0) return;
        if (msg.uptoSeq > rt.state.lastSeq) {
          Y.applyUpdate(rt.doc, await this.cipher.decrypt(msg.docId, msg.payload), "sync");
          rt.state = { ...rt.state, lastSeq: msg.uptoSeq };
          this.opts.host.saveState(msg.docId, rt.state);
        }
        const head = this.serverHeads.get(msg.docId);
        if (head && head.headSeq > rt.state.lastSeq) {
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
        break;
      case "error":
        console.error(`同步伺服器回報錯誤:${msg.code} ${msg.message}`);
        break;
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
    if (!doc) return undefined;
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
    if (!this.online || rt.pushing) {
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
      payload: await this.cipher.encrypt(rt.docId, diff),
    });
  }

  /** 增量日誌拉長且本端已拉齊時,上傳全量快照讓伺服器截斷 */
  private async maybeCompact(rt: DocRuntime): Promise<void> {
    const head = this.serverHeads.get(rt.docId);
    const snapshotSeq = head?.snapshotSeq ?? 0;
    const knownHead = head?.headSeq ?? 0;
    const threshold = this.opts.snapshotThreshold ?? DEFAULT_SNAPSHOT_THRESHOLD;
    if (rt.state.lastSeq < knownHead || rt.state.lastSeq - snapshotSeq < threshold) return;
    const payload = await this.cipher.encrypt(rt.docId, Y.encodeStateAsUpdate(rt.doc));
    this.send({ type: "snapshotPush", docId: rt.docId, uptoSeq: rt.state.lastSeq, payload });
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
