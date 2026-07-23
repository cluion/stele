import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  encodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "測試用-token-1234567890";

/** promise 化的測試 client:送訊息、依序取回應、可等特定類型 */
class TestClient {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<{ code: number }>;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (data) => {
      this.inbox.push(decodeServerMessage(new Uint8Array(data as Buffer)));
      for (const w of this.waiters) w();
      this.waiters = [];
    });
    this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve({ code })));
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return; // 事件可能已在 await 其他 client 期間錯過
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(encodeClientMessage(msg));
  }

  sendRaw(data: Uint8Array): void {
    this.ws.send(data);
  }

  /** 取回下一則符合類型的訊息;不符合的按序保留給後續斷言 */
  async next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<ServerMessage & { type: T }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.inbox.findIndex((m) => m.type === type);
      if (idx >= 0) return this.inbox.splice(idx, 1)[0] as ServerMessage & { type: T };
      if (Date.now() > deadline) throw new Error(`等不到 ${type},收件匣:${JSON.stringify(this.inbox)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  peekInbox(): ServerMessage[] {
    return [...this.inbox];
  }

  async auth(vaultId: string, token = TOKEN): Promise<ServerMessage & { type: "authOk" }> {
    await this.open();
    this.send({ type: "auth", token, vaultId });
    return this.next("authOk");
  }

  close(): void {
    this.ws.close();
  }

  /** 不握手直接斷線,模擬網路異常 */
  terminate(): void {
    this.ws.terminate();
  }
}

describe("同步伺服器", () => {
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

  it("錯誤 token 收到 error 且連線被關閉", async () => {
    const client = new TestClient(server.port);
    await client.open();
    client.send({ type: "auth", token: "錯的", vaultId: "v1" });
    const err = await client.next("error");
    expect(err.code).toBe("bad-token");
    await client.closed;
  });

  it("未認證就推送:拒絕並關閉", async () => {
    const client = new TestClient(server.port);
    await client.open();
    client.send({ type: "push", docId: "d1", deviceId: "dev", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) });
    const err = await client.next("error");
    expect(err.code).toBe("unauthorized");
    await client.closed;
  });

  it("解析不了的訊息:拒絕並關閉", async () => {
    const client = new TestClient(server.port);
    await client.open();
    client.sendRaw(new Uint8Array([250, 250, 250]));
    const err = await client.next("error");
    expect(err.code).toBe("bad-message");
    await client.closed;
  });

  it("push 拿到 ack,同 vault 其他連線收到廣播,異 vault 收不到", async () => {
    const a = new TestClient(server.port);
    const b = new TestClient(server.port);
    const other = new TestClient(server.port);
    await a.auth("vault-廣播");
    await b.auth("vault-廣播");
    await other.auth("vault-別人");

    a.send({ type: "push", docId: "廣播-d1", deviceId: "devA", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([42]) });
    const ack = await a.next("ack");
    expect(ack).toMatchObject({ docId: "廣播-d1", counter: 1, seq: 1 });

    const update = await b.next("update");
    expect(update.seq).toBe(1);
    expect(Array.from(update.payload)).toEqual([42]);

    await new Promise((r) => setTimeout(r, 100));
    expect(other.peekInbox()).toEqual([]);
    expect(a.peekInbox()).toEqual([]); // 自己不收自己的回音
    a.close();
    b.close();
    other.close();
  });

  it("重連後 authOk 帶 doc 清單,pull 補齊離線期間的增量", async () => {
    const a = new TestClient(server.port);
    await a.auth("vault-補齊");
    for (let i = 1; i <= 3; i++) {
      a.send({ type: "push", docId: "補-d1", deviceId: "devA", counter: i, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([i]) });
      await a.next("ack");
    }
    a.close();

    const b = new TestClient(server.port);
    const hello = await b.auth("vault-補齊");
    expect(hello.docs).toEqual([{ docId: "補-d1", headSeq: 3, snapshotSeq: 0 }]);
    b.send({ type: "pull", docId: "補-d1", fromSeq: 1 });
    expect((await b.next("update")).seq).toBe(2);
    expect((await b.next("update")).seq).toBe(3);
    b.close();
  });

  it("快照上傳截斷增量,新裝置從快照+殘餘增量重建", async () => {
    const a = new TestClient(server.port);
    await a.auth("vault-快照");
    for (let i = 1; i <= 4; i++) {
      a.send({ type: "push", docId: "快-d1", deviceId: "devA", counter: i, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([i]) });
      await a.next("ack");
    }
    a.send({ type: "snapshotPush", docId: "快-d1", uptoSeq: 3, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([9, 9]) });
    const snapAck = await a.next("snapshotAck");
    expect(snapAck.uptoSeq).toBe(3);
    a.close();

    const fresh = new TestClient(server.port);
    const hello = await fresh.auth("vault-快照");
    expect(hello.docs).toEqual([{ docId: "快-d1", headSeq: 4, snapshotSeq: 3 }]);
    fresh.send({ type: "snapshotPull", docId: "快-d1" });
    const snap = await fresh.next("snapshot");
    expect(snap.uptoSeq).toBe(3);
    expect(Array.from(snap.payload)).toEqual([9, 9]);
    fresh.send({ type: "pull", docId: "快-d1", fromSeq: snap.uptoSeq });
    expect((await fresh.next("update")).seq).toBe(4);
    fresh.close();
  });

  it("client 突然斷線不影響伺服器與其他連線", async () => {
    const a = new TestClient(server.port);
    const b = new TestClient(server.port);
    await a.auth("vault-斷線");
    await b.auth("vault-斷線");
    a.terminate();
    await new Promise((r) => setTimeout(r, 100));
    b.send({ type: "push", docId: "斷-d1", deviceId: "devB", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) });
    expect((await b.next("ack")).seq).toBe(1);
    b.close();
  });

  it("超長與含穿越素材的 docId 被拒", async () => {
    const c = new TestClient(server.port);
    await c.auth("vault-長id");
    c.send({ type: "push", docId: "x".repeat(129), deviceId: "dev", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) });
    const err = await c.next("error");
    expect(err.code).toBe("bad-message");
    await c.closed;

    const c2 = new TestClient(server.port);
    await c2.auth("vault-長id");
    c2.send({ type: "push", docId: "a/../b", deviceId: "dev", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) });
    expect((await c2.next("error")).code).toBe("bad-message");
    await c2.closed;
  });

  it("vault 命名空間隔離:同名 doc 讀不到他人資料也互不干擾", async () => {
    const a = new TestClient(server.port);
    await a.auth("vault-甲");
    a.send({ type: "push", docId: "共用名-d1", deviceId: "devA", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1]) });
    await a.next("ack");
    a.close();

    const other = new TestClient(server.port);
    const hello = await other.auth("vault-乙");
    expect(hello.docs).toEqual([]); // 看不到 vault-甲 的 doc
    other.send({ type: "pull", docId: "共用名-d1", fromSeq: 0 });
    other.send({ type: "snapshotPull", docId: "共用名-d1" });
    const snap = await other.next("snapshot");
    expect(snap.payload.length).toBe(0); // 空快照,如同不存在
    expect(other.peekInbox().filter((m) => m.type === "update")).toEqual([]);
    other.send({ type: "push", docId: "共用名-d1", deviceId: "devO", counter: 1, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([7]) });
    expect((await other.next("ack")).seq).toBe(1); // 自己命名空間的新 doc,從 1 起算
    other.close();
  });
});
