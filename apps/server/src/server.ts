import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeClientMessage, encodeServerMessage, type ClientMessage, type ServerMessage } from "@stele/sync";
import { SyncStore, VaultMismatchError } from "./store.ts";

/**
 * blind relay:認證、存加密 blob、配序號、廣播;完全不解讀 payload
 * 每條連線隸屬一個 vault,push 會廣播給同 vault 的其他連線
 */

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_ID_LENGTH = 128;

const validId = (id: string): boolean => id.length > 0 && id.length <= MAX_ID_LENGTH;

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(opts: { port: number; token: string; store: SyncStore }): Promise<RunningServer> {
  const wss = new WebSocketServer({ port: opts.port, maxPayload: MAX_PAYLOAD_BYTES });
  const vaults = new Map<string, Set<WebSocket>>();
  const alive = new WeakSet<WebSocket>();

  // 死連線偵測:兩輪沒回 pong 就終止,避免 vaults 累積殭屍連線
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("connection", (ws) => {
    let vaultId: string | undefined;
    const authTimer = setTimeout(() => ws.close(4401, "未認證"), AUTH_TIMEOUT_MS);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    // 沒有 error listener 時,單一 client 的 socket 異常會以 uncaught exception 炸掉整個行程
    ws.on("error", (err) => {
      console.error("連線錯誤:", err);
    });

    const send = (msg: ServerMessage): void => {
      ws.send(encodeServerMessage(msg));
    };
    const refuse = (code: string, message: string): void => {
      send({ type: "error", code, message });
      ws.close();
    };

    const handleAuth = (msg: ClientMessage & { type: "auth" }): void => {
      if (vaultId !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      if (!tokenMatches(msg.token, opts.token)) {
        refuse("bad-token", "token 錯誤");
        return;
      }
      if (!validId(msg.vaultId)) {
        refuse("bad-vault", "非法 vault id");
        return;
      }
      vaultId = msg.vaultId;
      clearTimeout(authTimer);
      const peers = vaults.get(vaultId) ?? new Set<WebSocket>();
      peers.add(ws);
      vaults.set(vaultId, peers);
      send({ type: "authOk", docs: opts.store.headSeqs(vaultId) });
    };

    const handle = (vault: string, msg: Exclude<ClientMessage, { type: "auth" }>): void => {
      if (!validId(msg.docId) || (msg.type === "push" && !validId(msg.deviceId))) {
        refuse("bad-message", "非法 id");
        return;
      }
      switch (msg.type) {
        case "push": {
          const seq = opts.store.appendUpdate(vault, msg.docId, msg.deviceId, msg.counter, msg.payload);
          send({ type: "ack", docId: msg.docId, counter: msg.counter, seq });
          const broadcast = encodeServerMessage({ type: "update", docId: msg.docId, seq, payload: msg.payload });
          for (const peer of vaults.get(vault) ?? []) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(broadcast);
          }
          break;
        }
        case "pull": {
          for (const u of opts.store.updatesSince(vault, msg.docId, msg.fromSeq)) {
            send({ type: "update", docId: msg.docId, seq: u.seq, payload: u.payload });
          }
          break;
        }
        case "snapshotPush": {
          opts.store.saveSnapshot(vault, msg.docId, msg.uptoSeq, msg.payload);
          send({ type: "snapshotAck", docId: msg.docId, uptoSeq: msg.uptoSeq });
          break;
        }
        case "snapshotPull": {
          const snap = opts.store.snapshot(vault, msg.docId);
          send({ type: "snapshot", docId: msg.docId, uptoSeq: snap?.uptoSeq ?? 0, payload: snap?.payload ?? new Uint8Array() });
          break;
        }
      }
    };

    ws.on("message", (data: RawData) => {
      let msg: ClientMessage;
      try {
        msg = decodeClientMessage(toBytes(data));
      } catch {
        refuse("bad-message", "訊息解析失敗");
        return;
      }
      try {
        if (msg.type === "auth") handleAuth(msg);
        else if (vaultId === undefined) refuse("unauthorized", "尚未認證");
        else handle(vaultId, msg);
      } catch (err) {
        if (err instanceof VaultMismatchError) {
          refuse("forbidden", "doc 隸屬其他 vault");
        } else {
          console.error("處理訊息失敗:", err);
          refuse("internal", "伺服器錯誤");
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (vaultId === undefined) return;
      const peers = vaults.get(vaultId);
      peers?.delete(ws);
      if (peers && peers.size === 0) vaults.delete(vaultId);
    });
  });

  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      // 啟動後的 reject 已無作用,換成會留下紀錄的 handler,不靜默吞錯
      wss.on("error", (err) => {
        console.error("WebSocketServer 錯誤:", err);
      });
      const address = wss.address();
      const port = typeof address === "object" && address !== null ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

/** 長度不同 timingSafeEqual 會拋錯,比較雜湊消除長度側信道 */
function tokenMatches(given: string, expected: string): boolean {
  const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
