import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { encodeClientMessage, decodeServerMessage, type ClientMessage, type ServerMessage, type SharePermission } from "./protocol.ts";
import type { Cipher } from "./cipher.ts";
import type { SocketLike, SyncStatus, AwarenessState } from "./client.ts";

/**
 * 分享收件端:以 shareId 認證的單 doc 同步器
 * 瀏覽器檢視器(唯讀)與 Stele 桌面(可編輯)共用;伺服器只憑 shareId 供密文,金鑰在收件端
 * 唯讀時只 bootstrap + 套用即時更新;可編輯時觀察本地變更並推回,權限以伺服器回報的為準
 */

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PUSH_DEBOUNCE_MS = 300;
const AWARENESS_REFRESH_MS = 10_000;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ShareClientOptions {
  url: string;
  shareId: string;
  doc: Y.Doc;
  cipher: Cipher;
  deviceId: string;
  createSocket(url: string): SocketLike;
  onStatus?(status: SyncStatus): void;
  /** 伺服器回報的權限;收件端據此決定 UI 是否唯讀 */
  onPermission?(permission: SharePermission): void;
  /** 首次追平伺服器進度(bootstrap 完成),UI 可解除載入態 */
  onSynced?(): void;
  /** 分享失效(撤銷/過期/不存在):code 為伺服器錯誤碼 */
  onClosed?(code: string): void;
  /** 傳入才啟用 awareness(游標/在場);唯讀檢視器通常不傳 */
  awareness?: awarenessProtocol.Awareness;
  onAwareness?(states: Map<number, AwarenessState>): void;
  pushDebounceMs?: number;
}

export class ShareClient {
  private socket: SocketLike | undefined;
  private online = false;
  private stopped = true;
  private status: SyncStatus = "offline";
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private awarenessTimer: ReturnType<typeof setInterval> | undefined;
  private docId: string | undefined;
  private permission: SharePermission = "read";
  private expectedHead = 0;
  private synced = false;
  private lastSeq = 0;
  private counter = 0;
  private syncedSv: Uint8Array | undefined;
  private pushedSv: Uint8Array | undefined;
  private pushing = false;
  private dirty = false;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private rx: Promise<void> = Promise.resolve();
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;

  constructor(private readonly opts: ShareClientOptions) {
    this.onDocUpdate = (_update, origin) => {
      if (origin === "share" || this.permission !== "write") return;
      this.dirty = true;
      this.schedulePush();
    };
    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      this.opts.onAwareness?.(new Map(this.opts.awareness!.getStates() as Map<number, AwarenessState>));
      if (origin === "remote") return;
      this.sendAwareness([...added, ...updated, ...removed]);
    };
  }

  start(): void {
    this.stopped = false;
    this.opts.doc.on("update", this.onDocUpdate);
    if (this.opts.awareness) {
      this.opts.awareness.on("update", this.onAwarenessUpdate);
      this.awarenessTimer = setInterval(() => this.refreshAwareness(), AWARENESS_REFRESH_MS);
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pushTimer);
    if (this.awarenessTimer !== undefined) clearInterval(this.awarenessTimer);
    await this.announceLeave();
    this.opts.doc.off("update", this.onDocUpdate);
    this.opts.awareness?.off("update", this.onAwarenessUpdate);
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
    socket.onopen = () => this.send({ type: "shareAuth", shareId: this.opts.shareId });
    socket.onmessage = (event) => {
      this.rx = this.rx
        .then(() => {
          const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
          return this.handleMessage(decodeServerMessage(bytes));
        })
        .catch((err: unknown) => console.error("分享訊息處理失敗:", err));
    };
    socket.onerror = () => {
      // onclose 會接手重連
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.online = false;
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }

  private async handleMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "shareAuthOk": {
        this.online = true;
        this.backoff = RECONNECT_MIN_MS;
        this.setStatus("online");
        this.docId = msg.docId;
        this.permission = msg.permission;
        this.expectedHead = msg.headSeq;
        this.pushing = false;
        this.opts.onPermission?.(msg.permission);
        // bootstrap:落後快照點走快照,否則增量補齊
        if (this.lastSeq < msg.snapshotSeq) this.send({ type: "snapshotPull", docId: msg.docId });
        else if (this.lastSeq < msg.headSeq) this.send({ type: "pull", docId: msg.docId, fromSeq: this.lastSeq });
        this.maybeSynced();
        if (this.permission === "write" && !bytesEqual(Y.encodeStateAsUpdate(this.opts.doc, this.syncedSv), EMPTY_UPDATE)) {
          this.schedulePush(); // 重連後把離線期間的本地編輯補推
        }
        this.refreshAwareness();
        break;
      }
      case "snapshot": {
        if (!this.docId || msg.payload.length === 0) return;
        if (msg.uptoSeq > this.lastSeq) {
          Y.applyUpdate(this.opts.doc, await this.opts.cipher.decrypt(this.docId, msg.payload), "share");
          this.lastSeq = msg.uptoSeq;
        }
        if (this.expectedHead > this.lastSeq) this.send({ type: "pull", docId: this.docId, fromSeq: this.lastSeq });
        this.maybeSynced();
        break;
      }
      case "update": {
        if (!this.docId || msg.seq <= this.lastSeq) return;
        if (msg.seq > this.lastSeq + 1) {
          this.send({ type: "pull", docId: this.docId, fromSeq: this.lastSeq });
          return;
        }
        Y.applyUpdate(this.opts.doc, await this.opts.cipher.decrypt(this.docId, msg.payload), "share");
        this.lastSeq = msg.seq;
        this.maybeSynced();
        break;
      }
      case "ack": {
        this.pushing = false;
        this.syncedSv = this.pushedSv;
        if (msg.seq === this.lastSeq + 1) this.lastSeq = msg.seq;
        if (this.dirty) this.schedulePush();
        break;
      }
      case "awareness": {
        if (!this.docId || !this.opts.awareness) return;
        const update = await this.opts.cipher.decrypt(this.docId, msg.payload);
        awarenessProtocol.applyAwarenessUpdate(this.opts.awareness, update, "remote");
        break;
      }
      case "error":
        console.error(`分享伺服器回報錯誤:${msg.code} ${msg.message}`);
        // 分享失效類錯誤不重連,交由 UI 呈現
        if (msg.code === "no-share" || msg.code === "forbidden" || msg.code === "bad-share") {
          this.stopped = true;
          clearTimeout(this.reconnectTimer);
          this.opts.onClosed?.(msg.code);
        }
        break;
    }
  }

  private maybeSynced(): void {
    if (this.synced || this.lastSeq < this.expectedHead) return;
    this.synced = true;
    this.opts.onSynced?.();
  }

  private schedulePush(): void {
    if (this.pushTimer !== undefined || this.permission !== "write") return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.push().catch((err: unknown) => console.error("分享推送失敗:", err));
    }, this.opts.pushDebounceMs ?? PUSH_DEBOUNCE_MS);
  }

  private async push(): Promise<void> {
    if (!this.online || this.pushing || !this.docId) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const diff = Y.encodeStateAsUpdate(this.opts.doc, this.syncedSv);
    if (bytesEqual(diff, EMPTY_UPDATE)) return;
    this.pushedSv = Y.encodeStateVector(this.opts.doc);
    this.pushing = true;
    this.counter += 1;
    this.send({
      type: "push",
      docId: this.docId,
      deviceId: this.opts.deviceId,
      counter: this.counter,
      // share 連線不套 epoch 柵欄(輪換時伺服器直接踢分享連線並作廢連結),恆送 0
      epoch: 0,
      payload: await this.opts.cipher.encrypt(this.docId, diff),
    });
  }

  /** UI 設定本地 awareness(游標/在場) */
  setLocalAwareness(state: AwarenessState | null): void {
    this.opts.awareness?.setLocalState(state);
  }

  private sendAwareness(clients: number[]): void {
    const aw = this.opts.awareness;
    if (!aw || !this.online || !this.docId || clients.length === 0) return;
    const docId = this.docId;
    void this.opts.cipher
      .encrypt(docId, awarenessProtocol.encodeAwarenessUpdate(aw, clients))
      .then((payload) => this.send({ type: "awareness", docId, payload }))
      .catch((err: unknown) => console.error("分享 awareness 廣播失敗:", err));
  }

  private refreshAwareness(): void {
    const aw = this.opts.awareness;
    if (!aw || !this.online) return;
    if (aw.getLocalState() !== null) this.sendAwareness([aw.clientID]);
  }

  private async announceLeave(): Promise<void> {
    const aw = this.opts.awareness;
    if (!aw || !this.online || !this.docId || aw.getLocalState() === null) return;
    const clients = [aw.clientID];
    awarenessProtocol.removeAwarenessStates(aw, clients, "local");
    try {
      const payload = await this.opts.cipher.encrypt(this.docId, awarenessProtocol.encodeAwarenessUpdate(aw, clients));
      this.socket?.send(encodeClientMessage({ type: "awareness", docId: this.docId, payload }));
    } catch (err) {
      console.error("分享 awareness 離場廣播失敗:", err);
    }
  }

  private send(msg: ClientMessage): void {
    try {
      this.socket?.send(encodeClientMessage(msg));
    } catch (err) {
      console.error("分享訊息送出失敗:", err);
    }
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
