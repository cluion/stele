import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { SyncClient, type SocketLike, type SyncDocState, type SyncHost } from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "混沌測試-token-1234567890";
const createSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 固定 seed 的 PRNG(mulberry32):失敗可重現,不用 Math.random */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 一台裝置:doc 集合、同步狀態、outbox 都跨「重啟」保留(模擬 process 中殺再開)
 * client 可為 undefined(離線);edits 累積每次插入,收斂後驗證一個字都沒丟
 */
class Device {
  readonly docs = new Map<string, Y.Doc>();
  readonly states = new Map<string, SyncDocState>();
  private client: SyncClient | undefined;
  readonly host: SyncHost;

  constructor(
    private readonly port: number,
    private readonly vaultId: string,
    readonly id: string,
  ) {
    this.host = {
      openDoc: (docId) => {
        let doc = this.docs.get(docId);
        if (!doc) {
          doc = new Y.Doc();
          this.docs.set(docId, doc);
        }
        return Promise.resolve(doc);
      },
      listDocIds: () => Promise.resolve([...this.docs.keys()]),
      loadState: (docId) => this.states.get(docId),
      saveState: (docId, state) => this.states.set(docId, state),
    };
  }

  get online(): boolean {
    return this.client !== undefined;
  }

  connect(): void {
    if (this.client) return;
    this.client = new SyncClient({
      url: `ws://127.0.0.1:${this.port}`,
      token: TOKEN,
      vaultId: this.vaultId,
      deviceId: this.id,
      host: this.host,
      createSocket,
      pushDebounceMs: 15,
      snapshotThreshold: 25,
    });
    this.client.start();
  }

  /** 正常斷線:等 in-flight 落定 */
  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.stop();
  }

  /** 硬殺:不等 stop,模擬 process 被 kill;狀態/docs 保留 */
  kill(): void {
    this.client?.stop().catch(() => undefined);
    this.client = undefined;
  }

  edit(docId: string, text: string): void {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(docId, doc);
    }
    const t = doc.getText("md");
    t.insert(t.length, text);
  }

  /** 隨機刪掉一段既有文字:製造 delete-set 變更,驗證刪除也會收斂 */
  deleteRange(docId: string, rand: () => number): void {
    const t = this.docs.get(docId)?.getText("md");
    if (!t || t.length === 0) return;
    const len = Math.min(t.length, 1 + Math.floor(rand() * 5));
    const from = Math.floor(rand() * (t.length - len + 1));
    t.delete(from, len);
  }

  text(docId: string): string {
    return this.docs.get(docId)?.getText("md").toString() ?? "";
  }
}

describe("多裝置混沌測試", () => {
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

  // 每個 seed 一輪獨立混沌;固定 seed 讓任一輪失敗可單獨重現
  for (const seed of [1, 7, 42, 123, 777, 2024, 31337, 90210]) {
    it(`seed ${seed}:隨機編輯/斷線/重連/中殺後全員收斂且零資料遺失`, async () => {
      const rand = rng(seed);
      const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
      const vaultId = `chaos-${seed}`;
      const docIds = ["d1", "d2", "d3"];
      const devices = [0, 1, 2].map((i) => new Device(server.port, vaultId, `dev${i}`));
      for (const d of devices) d.connect();

      // 沒被刪過的 doc 保留「插入的 token 一個都不能少」;被刪過的只驗收斂
      const inserted = new Map<string, string[]>(docIds.map((id) => [id, []]));
      const deletedDocs = new Set<string>();
      let counter = 0;

      for (let step = 0; step < 120; step++) {
        const roll = rand();
        const dev = pick(devices);
        if (roll < 0.5) {
          // 編輯:只有在線時內容才有機會傳出去,但離線編輯也要記帳(重連後須補上)
          const docId = pick(docIds);
          const token = `<${dev.id}-${counter++}>`;
          dev.edit(docId, token);
          inserted.get(docId)!.push(token);
        } else if (roll < 0.6) {
          const docId = pick(docIds);
          dev.deleteRange(docId, rand);
          deletedDocs.add(docId);
        } else if (roll < 0.75) {
          await dev.disconnect();
        } else if (roll < 0.87) {
          dev.kill();
        } else {
          dev.connect();
        }
        await sleep(pick([0, 5, 15, 30]));
      }

      // 收斂階段:全員上線,等到所有裝置的每個 doc 內容與伺服器 head 一致且彼此相同
      for (const d of devices) d.connect();
      await settle(devices, docIds, store, vaultId);

      // 驗證一(零資料遺失鐵律):全員每個 doc 內容位元組完全相同
      for (const docId of docIds) {
        const texts = devices.map((d) => d.text(docId));
        for (const t of texts) expect(t, `${docId} 未收斂`).toBe(texts[0]);
      }
      // 驗證二:沒被刪過的 doc,每個插入的 token 都還在(離線編輯也不能漏)
      for (const docId of docIds) {
        if (deletedDocs.has(docId)) continue;
        const final = devices[0]!.text(docId);
        for (const token of inserted.get(docId)!) {
          expect(final, `${docId} 掉了 ${token}`).toContain(token);
        }
      }

      for (const d of devices) await d.disconnect();
    }, 30000);
  }
});

/** 反覆推進到穩態:全員在線、每個 doc 各裝置內容一致、且與伺服器 head seq 對齊 */
async function settle(
  devices: Device[],
  docIds: string[],
  store: SyncStore,
  vaultId: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(60);
    const converged = docIds.every((docId) => {
      const texts = devices.map((d) => d.text(docId));
      return texts.every((t) => t === texts[0]);
    });
    // head 穩定(沒有還在飛的 push):兩次取樣相同
    if (converged) {
      const h1 = docIds.map((id) => headSeq(store, vaultId, id)).join(",");
      await sleep(120);
      const h2 = docIds.map((id) => headSeq(store, vaultId, id)).join(",");
      const stillConverged = docIds.every((docId) => {
        const texts = devices.map((d) => d.text(docId));
        return texts.every((t) => t === texts[0]);
      });
      if (h1 === h2 && stillConverged) return;
    }
    if (Date.now() > deadline) {
      const lines: string[] = [];
      for (const docId of docIds) {
        const texts = devices.map((d) => d.text(docId));
        const head = store.headSeqs(vaultId).find((h) => h.docId === docId);
        lines.push(
          `${docId}: 長度=${texts.map((t) => t.length).join("/")} head=${head?.headSeq ?? 0} snap=${head?.snapshotSeq ?? 0} lastSeq=${devices.map((d) => d.states.get(docId)?.lastSeq ?? 0).join("/")}`,
        );
      }
      throw new Error("收斂逾時:\n" + lines.join("\n"));
    }
  }
}

function headSeq(store: SyncStore, vaultId: string, docId: string): number {
  const heads = store.headSeqs(vaultId);
  return heads.find((h) => h.docId === docId)?.headSeq ?? 0;
}
