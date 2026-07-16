import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { SyncClient, type SocketLike, type SyncDocState, type SyncHost } from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "整合測試-token-1234567890";

const createSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待逾時:${what}`);
    await sleep(25);
  }
}

/** 模擬一台裝置:doc 集合 + 同步狀態,兩者跨重啟保留 */
function makeDevice(port: number, vaultId: string, deviceId: string, snapshotThreshold = 100) {
  const docs = new Map<string, Y.Doc>();
  const states = new Map<string, SyncDocState>();
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
    loadState: (docId) => states.get(docId),
    saveState: (docId, state) => states.set(docId, state),
  };
  const start = () => {
    const client = new SyncClient({
      url: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      vaultId,
      deviceId,
      host,
      createSocket,
      pushDebounceMs: 20,
      snapshotThreshold,
    });
    client.start();
    return client;
  };
  const text = (docId: string) => docs.get(docId)?.getText("md").toString() ?? "";
  const type = (docId: string, content: string) => {
    const t = docs.get(docId)!.getText("md");
    t.insert(t.length, content);
  };
  return { docs, states, host, start, text, type };
}

describe("SyncClient 端對端", () => {
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

  it("兩台裝置即時雙向收斂", async () => {
    const a = makeDevice(server.port, "v-即時", "devA");
    const b = makeDevice(server.port, "v-即時", "devB");
    const ca = a.start();
    const cb = b.start();

    await a.host.openDoc("d1");
    a.type("d1", "甲先寫\n");
    await until(() => b.text("d1") === "甲先寫\n", "乙收到甲的編輯");

    b.type("d1", "乙接著寫\n");
    await until(() => a.text("d1") === "甲先寫\n乙接著寫\n", "甲收到乙的編輯");
    expect(b.text("d1")).toBe(a.text("d1"));

    await ca.stop();
    await cb.stop();
  });

  it("新裝置全量補齊既有內容", async () => {
    const a = makeDevice(server.port, "v-補齊", "devA");
    const ca = a.start();
    await a.host.openDoc("d1");
    a.type("d1", "既有內容\n");
    await until(() => a.states.get("d1")?.lastSeq === 1, "甲的推送被確認");
    await ca.stop();

    const fresh = makeDevice(server.port, "v-補齊", "devC");
    const cf = fresh.start();
    await until(() => fresh.text("d1") === "既有內容\n", "新裝置補齊");
    await cf.stop();
  });

  it("離線編輯在重連後以差分補上,雙方收斂", async () => {
    const a = makeDevice(server.port, "v-離線", "devA");
    const b = makeDevice(server.port, "v-離線", "devB");
    let ca = a.start();
    const cb = b.start();
    await a.host.openDoc("d1");
    a.type("d1", "上線寫的\n");
    await until(() => b.text("d1") === "上線寫的\n", "乙同步基準");

    await ca.stop(); // 甲離線
    a.type("d1", "離線寫的\n");
    b.type("d1", "乙趁機寫的\n"); // 乙持續在線
    await sleep(100);

    ca = a.start(); // 甲重連,離線差分一次補上
    await until(
      () => a.text("d1").includes("離線寫的") && a.text("d1").includes("乙趁機寫的"),
      "甲拿到雙方全部編輯",
    );
    await until(() => b.text("d1") === a.text("d1"), "乙收斂到相同內容");

    await ca.stop();
    await cb.stop();
  });

  it("重連時沒有變更就不推,伺服器日誌不長胖", async () => {
    const a = makeDevice(server.port, "v-冪等", "devA");
    let ca = a.start();
    await a.host.openDoc("d1");
    a.type("d1", "只有這筆\n");
    await until(() => a.states.get("d1")?.lastSeq === 1, "推送確認");
    await ca.stop();

    for (let i = 0; i < 3; i++) {
      ca = a.start();
      await until(() => a.states.get("d1") !== undefined, "重連完成");
      await sleep(150);
      await ca.stop();
    }
    expect(store.updatesSince("v-冪等", "d1", 0)).toHaveLength(1);
  });

  it("超過門檻自動上傳快照,伺服器截斷舊增量,新裝置走快照 bootstrap", async () => {
    const a = makeDevice(server.port, "v-壓縮", "devA", 3);
    const ca = a.start();
    await a.host.openDoc("d1");
    for (let i = 1; i <= 4; i++) {
      a.type("d1", `第${i}筆\n`);
      await until(() => a.states.get("d1")?.lastSeq === i, `第 ${i} 筆確認`);
    }
    await until(() => (store.snapshot("v-壓縮", "d1")?.uptoSeq ?? 0) >= 3, "快照落地");
    expect(store.updatesSince("v-壓縮", "d1", 0).length).toBeLessThan(4);
    await ca.stop();

    const fresh = makeDevice(server.port, "v-壓縮", "devC");
    const cf = fresh.start();
    await until(() => fresh.text("d1") === "第1筆\n第2筆\n第3筆\n第4筆\n", "快照 bootstrap 完整");
    await cf.stop();
  });

  it("同時編輯同一 doc:兩邊都不掉字", async () => {
    const a = makeDevice(server.port, "v-並發", "devA");
    const b = makeDevice(server.port, "v-並發", "devB");
    const ca = a.start();
    const cb = b.start();
    await a.host.openDoc("d1");
    await b.host.openDoc("d1");
    for (let i = 1; i <= 5; i++) {
      a.type("d1", `甲${i} `);
      b.type("d1", `乙${i} `);
      await sleep(10);
    }
    await until(() => a.text("d1") === b.text("d1") && a.text("d1").length > 0, "雙方收斂");
    for (let i = 1; i <= 5; i++) {
      expect(a.text("d1")).toContain(`甲${i}`);
      expect(a.text("d1")).toContain(`乙${i}`);
    }
    await ca.stop();
    await cb.stop();
  });
});
