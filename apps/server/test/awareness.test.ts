import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  SyncClient,
  VaultCipher,
  deriveVaultKey,
  type SocketLike,
  type SyncDocState,
  type SyncHost,
  type AwarenessState,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "awareness-token-1234567890";
const DOC = "5f8e0000-0000-4000-8000-000000000abc";
const createSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待逾時:${what}`);
    await sleep(25);
  }
}

/** 一台裝置:每個 docId 一個共享 Y.Doc,awareness 遠端狀態記在 seen */
function makeDevice(port: number, deviceId: string, cipher?: VaultCipher) {
  const docs = new Map<string, Y.Doc>();
  const seen = new Map<string, Map<number, AwarenessState>>();
  const host: SyncHost = {
    openDoc: (docId) => {
      let doc = docs.get(docId);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(docId, doc);
      }
      return Promise.resolve(doc);
    },
    listDocIds: () => Promise.resolve([...docs.keys()]),
    loadState: (): SyncDocState | undefined => undefined,
    saveState: () => undefined,
  };
  const client = new SyncClient({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    vaultId: "v-aware",
    deviceId,
    host,
    createSocket,
    cipher,
    pushDebounceMs: 15,
    onAwareness: (docId, states) => seen.set(docId, states),
  });
  return { client, seen, docs };
}

describe("awareness 加密即時協作", () => {
  let server: RunningServer;
  let store: SyncStore;

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  it("甲設 awareness,乙收到解密後的狀態;伺服器不落盤", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("同密語", "v-aware", 12));
    const a = makeDevice(server.port, "devA", cipher);
    const b = makeDevice(server.port, "devB", new VaultCipher(await deriveVaultKey("同密語", "v-aware", 12)));
    a.client.start();
    b.client.start();
    await sleep(200);

    a.client.setLocalAwareness(DOC, { name: "甲", color: "#0e7b93", cursor: 7 });

    await until(() => (b.seen.get(DOC)?.size ?? 0) >= 1, "乙收到甲的 awareness");
    const states = [...b.seen.get(DOC)!.values()];
    expect(states.some((s) => s.name === "甲" && s.cursor === 7)).toBe(true);

    // awareness 是 ephemeral:不產生任何 doc 增量
    expect(store.headSeqs("v-aware")).toEqual([]);

    await a.client.stop();
    await b.client.stop();
  });

  it("密語不同解不開,收不到對方 awareness", async () => {
    const a = makeDevice(server.port, "devA", new VaultCipher(await deriveVaultKey("甲密語", "v-aware", 12)));
    const b = makeDevice(server.port, "devB", new VaultCipher(await deriveVaultKey("乙密語", "v-aware", 12)));
    a.client.start();
    b.client.start();
    await sleep(200);

    a.client.setLocalAwareness(DOC, { name: "甲", cursor: 1 });
    await sleep(400);
    expect(b.seen.get(DOC)?.size ?? 0).toBe(0);

    await a.client.stop();
    await b.client.stop();
  });

  it("甲離線後,乙的 awareness 清掉甲", async () => {
    const cipher1 = new VaultCipher(await deriveVaultKey("同密語", "v-aware", 12));
    const cipher2 = new VaultCipher(await deriveVaultKey("同密語", "v-aware", 12));
    const a = makeDevice(server.port, "devA", cipher1);
    const b = makeDevice(server.port, "devB", cipher2);
    a.client.start();
    b.client.start();
    await sleep(200);
    a.client.setLocalAwareness(DOC, { name: "甲", cursor: 3 });
    await until(() => (b.seen.get(DOC)?.size ?? 0) >= 1, "乙先看到甲");

    await a.client.stop(); // 正常離線:應主動送移除
    await until(() => (b.seen.get(DOC)?.size ?? 0) === 0, "乙清掉離線的甲");

    await b.client.stop();
  });
});
