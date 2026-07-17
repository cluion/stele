import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { decodeClientMessage, encodeServerMessage, type ClientMessage, type ServerMessage } from "@stele/sync";
import { SyncStore, type ShareScope } from "./store.ts";

/**
 * blind relay:認證、存加密 blob、配序號、廣播;完全不解讀 payload
 * 每條連線隸屬一個 vault,push 會廣播給同 vault 的其他連線
 * 同一 http 埠也提供唯讀分享檢視器的靜態頁(viewerDir 有設才提供);shareId 由前端解析,伺服器全盲
 */

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_ID_LENGTH = 128;

const CONTENT_TYPE: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "viewer.js": "text/javascript; charset=utf-8",
  "viewer.js.map": "application/json; charset=utf-8",
};

/** 靜態檔案只認允許清單,不吃使用者路徑,天然免於路徑穿越 */
function makeRequestHandler(viewerDir: string | undefined) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // 分享頁一律回同一份 shell,shareId 只在前端解析
    const file =
      url === "/viewer.js" || url === "/viewer.js.map"
        ? url.slice(1)
        : url === "/" || url.startsWith("/s/")
          ? "index.html"
          : undefined;
    if (!viewerDir || !file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(join(viewerDir, file));
      res.writeHead(200, {
        "content-type": CONTENT_TYPE[file] ?? "application/octet-stream",
        "cache-control": file === "index.html" ? "no-cache" : "public, max-age=3600",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  };
}

/** 收斂字元集:id 不進伺服器路徑,但協議層就該擋掉 / 與 .. 這類穿越素材 */
const validId = (id: string): boolean => id.length <= MAX_ID_LENGTH && /^[\p{L}\p{N}._-]+$/u.test(id) && !id.includes("..");

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(opts: { port: number; token: string; store: SyncStore; viewerDir?: string }): Promise<RunningServer> {
  const httpServer = createServer(makeRequestHandler(opts.viewerDir));
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  const vaults = new Map<string, Set<WebSocket>>();
  const alive = new WeakSet<WebSocket>();
  // 分享連線的 doc 作用域:值為受限 docId 時,只收得到該 doc 的廣播;owner 連線不入此表(全收)
  const restrictedDoc = new WeakMap<WebSocket, string>();
  const genShareId = (): string => randomBytes(16).toString("base64url");

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
    // vaultId 是連線所屬 vault;share 連線 scope 非 undefined,被鎖在單一 doc 與權限
    let vaultId: string | undefined;
    let scope: ShareScope | undefined;
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

    const joinVault = (vault: string): void => {
      const peers = vaults.get(vault) ?? new Set<WebSocket>();
      peers.add(ws);
      vaults.set(vault, peers);
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
      joinVault(vaultId);
      send({ type: "authOk", docs: opts.store.headSeqs(vaultId) });
    };

    // 收件人以 shareId 認證:解析出作用域後併入該 doc 所屬 vault 的 peer 集,只是廣播被 restrictedDoc 過濾
    const handleShareAuth = (msg: ClientMessage & { type: "shareAuth" }): void => {
      if (vaultId !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      if (!validId(msg.shareId)) {
        refuse("bad-share", "非法 share id");
        return;
      }
      const resolved = opts.store.resolveShare(msg.shareId);
      if (!resolved) {
        refuse("no-share", "分享不存在或已失效");
        return;
      }
      scope = resolved;
      vaultId = resolved.vaultId;
      restrictedDoc.set(ws, resolved.docId);
      clearTimeout(authTimer);
      joinVault(vaultId);
      const head = opts.store.headSeqs(vaultId).find((d) => d.docId === resolved.docId);
      send({
        type: "shareAuthOk",
        docId: resolved.docId,
        permission: resolved.permission,
        headSeq: head?.headSeq ?? 0,
        snapshotSeq: head?.snapshotSeq ?? 0,
      });
    };

    const relayToPeers = (vault: string, docId: string, msg: ServerMessage): void => {
      const frame = encodeServerMessage(msg);
      for (const peer of vaults.get(vault) ?? []) {
        if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
        const limit = restrictedDoc.get(peer);
        if (limit !== undefined && limit !== docId) continue; // share 連線只收自己那篇
        peer.send(frame);
      }
    };

    // 分享管理僅限 owner 連線;share 連線不得觸碰
    const handleShareAdmin = (vault: string, msg: ClientMessage): void => {
      switch (msg.type) {
        case "shareCreate": {
          if (!validId(msg.docId)) {
            refuse("bad-message", "非法 id");
            return;
          }
          const shareId = genShareId();
          opts.store.createShare(shareId, vault, msg.docId, msg.permission);
          send({ type: "shareCreated", reqId: msg.reqId, shareId });
          break;
        }
        case "shareList":
          send({ type: "shareCatalog", reqId: msg.reqId, shares: opts.store.listShares(vault) });
          break;
        case "shareRevoke":
          opts.store.revokeShare(vault, msg.shareId);
          send({ type: "shareCatalog", reqId: msg.reqId, shares: opts.store.listShares(vault) });
          break;
      }
    };

    const handle = (vault: string, msg: Exclude<ClientMessage, { type: "auth" | "shareAuth" }>): void => {
      if (msg.type === "shareCreate" || msg.type === "shareList" || msg.type === "shareRevoke") {
        if (scope !== undefined) {
          refuse("forbidden", "分享連線不得管理分享");
          return;
        }
        handleShareAdmin(vault, msg);
        return;
      }
      if (!validId(msg.docId) || (msg.type === "push" && !validId(msg.deviceId))) {
        refuse("bad-message", "非法 id");
        return;
      }
      // share 連線鎖定單一 doc:別的 doc 一律拒;唯讀分享不得寫入
      if (scope !== undefined) {
        if (msg.docId !== scope.docId) {
          refuse("forbidden", "超出分享範圍");
          return;
        }
        if (msg.type === "push" && scope.permission !== "write") {
          refuse("forbidden", "唯讀分享不得寫入");
          return;
        }
      }
      switch (msg.type) {
        case "push": {
          const seq = opts.store.appendUpdate(vault, msg.docId, msg.deviceId, msg.counter, msg.payload);
          send({ type: "ack", docId: msg.docId, counter: msg.counter, seq });
          relayToPeers(vault, msg.docId, { type: "update", docId: msg.docId, seq, payload: msg.payload });
          break;
        }
        case "awareness": {
          // ephemeral:只轉發給同 vault 其他連線,不落盤、不配 seq
          relayToPeers(vault, msg.docId, { type: "awareness", docId: msg.docId, payload: msg.payload });
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
        else if (msg.type === "shareAuth") handleShareAuth(msg);
        else if (vaultId === undefined) refuse("unauthorized", "尚未認證");
        else handle(vaultId, msg);
      } catch (err) {
        console.error("處理訊息失敗:", err);
        refuse("internal", "伺服器錯誤");
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      restrictedDoc.delete(ws);
      if (vaultId === undefined) return;
      const peers = vaults.get(vaultId);
      peers?.delete(ws);
      if (peers && peers.size === 0) vaults.delete(vaultId);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, () => {
      httpServer.off("error", reject);
      // 啟動後的 reject 已無作用,換成會留下紀錄的 handler,不靜默吞錯
      httpServer.on("error", (err) => console.error("HTTP 伺服器錯誤:", err));
      wss.on("error", (err) => console.error("WebSocketServer 錯誤:", err));
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of wss.clients) client.terminate();
            wss.close(() => httpServer.close(() => done()));
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
