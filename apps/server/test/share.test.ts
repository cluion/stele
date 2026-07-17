import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { encodeClientMessage, decodeServerMessage, type ClientMessage, type ServerMessage } from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "測試用-token-1234567890";

/** 最小 promise 化 client,足夠驗分享流程 */
class Client {
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
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(encodeClientMessage(msg));
  }

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

  async auth(vaultId: string): Promise<void> {
    await this.open();
    this.send({ type: "auth", token: TOKEN, vaultId });
    await this.next("authOk");
  }

  async shareAuth(shareId: string): Promise<ServerMessage & { type: "shareAuthOk" }> {
    await this.open();
    this.send({ type: "shareAuth", shareId });
    return this.next("shareAuthOk");
  }

  close(): void {
    this.ws.close();
  }
}

describe("分享連結", () => {
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

  /** owner 認證後建立分享,回傳 shareId */
  async function makeShare(vaultId: string, docId: string, permission: "read" | "write"): Promise<{ owner: Client; shareId: string }> {
    const owner = new Client(server.port);
    await owner.auth(vaultId);
    // 先塞一筆內容讓 doc 存在
    owner.send({ type: "push", docId, deviceId: "owner", counter: 1, payload: new Uint8Array([1, 2, 3]) });
    await owner.next("ack");
    owner.send({ type: "shareCreate", reqId: 7, docId, permission });
    const created = await owner.next("shareCreated");
    expect(created.reqId).toBe(7);
    expect(created.shareId).toMatch(/^[A-Za-z0-9_-]+$/);
    return { owner, shareId: created.shareId };
  }

  it("唯讀分享:收件人可拉既有內容,推送被拒", async () => {
    const { owner, shareId } = await makeShare("vault-唯讀", "doc-唯讀", "read");
    const guest = new Client(server.port);
    const ok = await guest.shareAuth(shareId);
    expect(ok).toMatchObject({ docId: "doc-唯讀", permission: "read", headSeq: 1 });

    guest.send({ type: "pull", docId: "doc-唯讀", fromSeq: 0 });
    const update = await guest.next("update");
    expect(Array.from(update.payload)).toEqual([1, 2, 3]);

    guest.send({ type: "push", docId: "doc-唯讀", deviceId: "guest", counter: 1, payload: new Uint8Array([9]) });
    const err = await guest.next("error");
    expect(err.code).toBe("forbidden");
    await guest.closed;
    owner.close();
  });

  it("唯讀分享:snapshotPush 也被拒,不得覆寫快照或截斷增量", async () => {
    const { owner, shareId } = await makeShare("vault-唯讀快照", "doc-唯讀快照", "read");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);
    // snapshotPush 會呼叫 saveSnapshot 覆寫並截斷,是寫入操作,唯讀連線必須擋
    guest.send({ type: "snapshotPush", docId: "doc-唯讀快照", uptoSeq: 1, payload: new Uint8Array([0, 0]) });
    expect((await guest.next("error")).code).toBe("forbidden");
    await guest.closed;
    owner.close();
  });

  it("可編輯分享:收件人推送被接受,owner 收到廣播", async () => {
    const { owner, shareId } = await makeShare("vault-可編輯", "doc-可編輯", "write");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);

    guest.send({ type: "push", docId: "doc-可編輯", deviceId: "guest", counter: 1, payload: new Uint8Array([42]) });
    expect((await guest.next("ack")).seq).toBe(2);
    const update = await owner.next("update");
    expect(Array.from(update.payload)).toEqual([42]);
    guest.close();
    owner.close();
  });

  it("分享連線鎖定單一 doc:碰別的 doc 被拒", async () => {
    const { owner, shareId } = await makeShare("vault-鎖定", "doc-鎖定", "write");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);
    guest.send({ type: "pull", docId: "另一篇", fromSeq: 0 });
    expect((await guest.next("error")).code).toBe("forbidden");
    await guest.closed;
    owner.close();
  });

  it("廣播按作用域過濾:分享連線只收得到自己那篇", async () => {
    const owner = new Client(server.port);
    await owner.auth("vault-過濾");
    owner.send({ type: "push", docId: "分享篇", deviceId: "owner", counter: 1, payload: new Uint8Array([1]) });
    await owner.next("ack");
    owner.send({ type: "shareCreate", reqId: 1, docId: "分享篇", permission: "read" });
    const shareId = (await owner.next("shareCreated")).shareId;

    const guest = new Client(server.port);
    await guest.shareAuth(shareId);

    // owner 改動「別篇」——同 vault 但不在分享範圍,guest 不該收到
    owner.send({ type: "push", docId: "別篇", deviceId: "owner", counter: 1, payload: new Uint8Array([2]) });
    await owner.next("ack");
    // owner 改動「分享篇」——guest 應收到
    owner.send({ type: "push", docId: "分享篇", deviceId: "owner", counter: 2, payload: new Uint8Array([3]) });
    await owner.next("ack");

    const update = await guest.next("update");
    expect(Array.from(update.payload)).toEqual([3]);
    expect(guest.peekInbox().filter((m) => m.type === "update")).toEqual([]); // 沒有別篇的
    guest.close();
    owner.close();
  });

  it("awareness 只轉發給同一篇的分享連線", async () => {
    const { owner, shareId } = await makeShare("vault-aware", "doc-aware", "write");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);
    owner.send({ type: "awareness", docId: "doc-aware", payload: new Uint8Array([5, 5]) });
    const aw = await guest.next("awareness");
    expect(Array.from(aw.payload)).toEqual([5, 5]);
    guest.close();
    owner.close();
  });

  it("撤銷後分享失效,收件人認證被拒", async () => {
    const owner = new Client(server.port);
    await owner.auth("vault-撤銷");
    owner.send({ type: "push", docId: "doc-撤銷", deviceId: "owner", counter: 1, payload: new Uint8Array([1]) });
    await owner.next("ack");
    owner.send({ type: "shareCreate", reqId: 1, docId: "doc-撤銷", permission: "read" });
    const shareId = (await owner.next("shareCreated")).shareId;

    owner.send({ type: "shareRevoke", reqId: 2, shareId });
    const catalog = await owner.next("shareCatalog");
    expect(catalog.shares).toEqual([{ shareId, docId: "doc-撤銷", permission: "read", revoked: true }]);

    const guest = new Client(server.port);
    await guest.open();
    guest.send({ type: "shareAuth", shareId });
    expect((await guest.next("error")).code).toBe("no-share");
    await guest.closed;
    owner.close();
  });

  it("撤銷立即踢掉既有連線,撤銷後的內容一個字都拿不到", async () => {
    const { owner, shareId } = await makeShare("vault-撤銷即時", "doc-撤銷即時", "read");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);

    owner.send({ type: "shareRevoke", reqId: 2, shareId });
    await owner.next("shareCatalog");

    // 收件人應收到與「分享不存在」相同的錯誤,ShareClient 據此停止且不重連
    expect((await guest.next("error")).code).toBe("no-share");
    await guest.closed;

    // 撤銷後 owner 續寫:已被踢的連線不可能再收到任何更新
    owner.send({ type: "push", docId: "doc-撤銷即時", deviceId: "owner", counter: 2, payload: new Uint8Array([7]) });
    await owner.next("ack");
    expect(guest.peekInbox().some((m) => m.type === "update")).toBe(false);
    owner.close();
  });

  it("撤銷只踢該分享的連線,同 vault 的其他連線不受影響", async () => {
    const { owner, shareId } = await makeShare("vault-撤銷隔離", "doc-撤銷隔離", "read");
    owner.send({ type: "shareCreate", reqId: 8, docId: "doc-撤銷隔離", permission: "read" });
    const other = (await owner.next("shareCreated")).shareId;

    const victim = new Client(server.port);
    await victim.shareAuth(shareId);
    const bystander = new Client(server.port);
    await bystander.shareAuth(other);

    owner.send({ type: "shareRevoke", reqId: 9, shareId });
    await owner.next("shareCatalog");
    await victim.closed;

    // 另一則分享仍活著:續寫仍收得到
    owner.send({ type: "push", docId: "doc-撤銷隔離", deviceId: "owner", counter: 2, payload: new Uint8Array([5]) });
    await owner.next("ack");
    const update = await bystander.next("update");
    expect(Array.from(update.payload)).toEqual([5]);
    bystander.close();
    owner.close();
  });

  it("撤銷不跨 vault:猜中他人 shareId 也踢不掉對方的連線", async () => {
    const { owner: victimOwner, shareId } = await makeShare("vault-受害", "doc-受害", "read");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);

    // 別的 vault 的 owner 拿著猜到的 shareId 撤銷:DB 因 vault 不符不會動,連線也不該被踢
    const attacker = new Client(server.port);
    await attacker.auth("vault-攻擊者");
    attacker.send({ type: "shareRevoke", reqId: 3, shareId });
    await attacker.next("shareCatalog");
    await new Promise((r) => setTimeout(r, 150));

    victimOwner.send({ type: "push", docId: "doc-受害", deviceId: "owner", counter: 2, payload: new Uint8Array([6]) });
    await victimOwner.next("ack");
    const update = await guest.next("update");
    expect(Array.from(update.payload)).toEqual([6]);
    guest.close();
    attacker.close();
    victimOwner.close();
  });

  it("查無此分享:亂猜 shareId 認證被拒", async () => {
    const guest = new Client(server.port);
    await guest.open();
    guest.send({ type: "shareAuth", shareId: "完全不存在的分享" });
    expect((await guest.next("error")).code).toBe("no-share");
    await guest.closed;
  });

  it("分享連線不得管理分享", async () => {
    const { owner, shareId } = await makeShare("vault-越權", "doc-越權", "write");
    const guest = new Client(server.port);
    await guest.shareAuth(shareId);
    guest.send({ type: "shareCreate", reqId: 1, docId: "doc-越權", permission: "read" });
    expect((await guest.next("error")).code).toBe("forbidden");
    await guest.closed;
    owner.close();
  });

  it("shareList 列出本 vault 全部分享,異 vault 看不到", async () => {
    const owner = new Client(server.port);
    await owner.auth("vault-清單");
    owner.send({ type: "push", docId: "d1", deviceId: "o", counter: 1, payload: new Uint8Array([1]) });
    await owner.next("ack");
    owner.send({ type: "shareCreate", reqId: 1, docId: "d1", permission: "read" });
    await owner.next("shareCreated");
    owner.send({ type: "shareList", reqId: 2 });
    const catalog = await owner.next("shareCatalog");
    expect(catalog.shares.length).toBe(1);
    expect(catalog.shares[0]).toMatchObject({ docId: "d1", permission: "read", revoked: false });

    const other = new Client(server.port);
    await other.auth("vault-清單別人");
    other.send({ type: "shareList", reqId: 1 });
    expect((await other.next("shareCatalog")).shares).toEqual([]);
    owner.close();
    other.close();
  });
});
