import * as Y from "yjs";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { ShareClient, ShareCipher, type SocketLike, type SyncStatus, type SharePermission } from "@stele/sync";
import type { ConsumeLink } from "./share-link.ts";

/**
 * 分享消費端的臨時協作 session:一個不屬於任何 vault 的 Y.Doc,由 ShareClient 驅動即時同步
 * 金鑰留在 main(不進 renderer 主世界),與 SyncManager 同一安全姿態;本地不落 .md,關閉即消失
 * renderer 透過 shared:* IPC 投影這個 doc,可寫與否以伺服器回報的權限為準
 */

export interface SharedSessionCallbacks {
  onStatus(status: SyncStatus): void;
  onPermission(permission: SharePermission): void;
  onSynced(): void;
  onClosed(code: string): void;
  /** 把遠端更新推給 renderer 投影;renderer 自己送來的編輯不回音 */
  broadcast(update: Uint8Array): void;
}

export class SharedSession {
  private readonly doc = new Y.Doc();
  private readonly client: ShareClient;
  permission: SharePermission = "read";

  constructor(link: ConsumeLink, cb: SharedSessionCallbacks) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "renderer") return; // renderer 已有自己的編輯,不回音
      cb.broadcast(update);
    });
    this.client = new ShareClient({
      url: link.wsUrl,
      shareId: link.shareId,
      doc: this.doc,
      cipher: new ShareCipher(link.key),
      deviceId: randomUUID(), // 消費者是獨立參與者,每次配發新 id
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onStatus: (s) => cb.onStatus(s),
      onPermission: (p) => {
        this.permission = p;
        cb.onPermission(p);
      },
      onSynced: () => cb.onSynced(),
      onClosed: (code) => cb.onClosed(code),
    });
  }

  start(): void {
    this.client.start();
  }

  /** 供 renderer 進入共享模式時取目前狀態 */
  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** renderer 的本地編輯:origin="renderer" 讓 ShareClient 推回、doc.on 不回音 */
  applyFromRenderer(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, "renderer");
  }

  async close(): Promise<void> {
    await this.client.stop();
    this.doc.destroy();
  }
}
