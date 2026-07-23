import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  encodeClientMessage,
  decodeServerMessage,
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  type SocketLike,
  type ClientMessage,
  type ServerMessage,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "team-rotation-測試-token-1234567890";

function wsSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock: SocketLike = {
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (d) => ws.send(d),
    close: () => ws.close(),
  };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data) => sock.onmessage?.({ data: new Uint8Array(data as Buffer) }));
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (e) => sock.onerror?.(e));
  return sock;
}

/** 低階 client:身分握手 + 帶 epoch 的 doc 寫入、讀回應與關閉碼 */
class EpochClient {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<number>;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (data) => {
      this.inbox.push(decodeServerMessage(new Uint8Array(data as Buffer)));
      for (const w of this.waiters) w();
      this.waiters = [];
    });
    this.ws.on("error", () => {});
    this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve(code)));
  }
  send(msg: ClientMessage): void {
    this.ws.send(encodeClientMessage(msg));
  }
  async next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<ServerMessage & { type: T }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.inbox.findIndex((m) => m.type === type);
      if (idx >= 0) return this.inbox.splice(idx, 1)[0] as ServerMessage & { type: T };
      if (Date.now() > deadline) throw new Error(`等不到 ${type},收件匣:${JSON.stringify(this.inbox.map((m) => m.type))}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 25);
      });
    }
  }
  async auth(id: SyncIdentity, vaultId: string, enrollmentToken = ""): Promise<ServerMessage & { type: "authOk" }> {
    await new Promise<void>((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.send({ type: "authId", token: TOKEN, vaultId, memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap, enrollmentToken });
    const ch = await this.next("authChallenge");
    this.send({ type: "authProof", signature: id.sign(identityChallengeBytes(ch.nonce, vaultId, id.memberId)) });
    return this.next("authOk");
  }
  pushDoc(docId: string, dev: string, epoch: number, counter = 1): void {
    this.send({ type: "push", docId, deviceId: dev, counter, epoch, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([1, 2, 3]) });
  }
  close(): void {
    this.ws.close();
  }
}

describe("金鑰輪換(2c-2):epoch 柵欄與 rotateKey", () => {
  let server: RunningServer;
  let store: SyncStore;
  const url = (): string => `ws://127.0.0.1:${server.port}`;

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    await server.close();
    store.close();
  });

  // 每個 vault 的 owner 身分記錄於此:refuse 會關 admin 連線,重試需以同一 owner 重開 session
  const owners = new Map<string, SyncIdentity>();
  async function setup(vaultId: string) {
    const owner = await deriveIdentity(generateSeed());
    owners.set(vaultId, owner);
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    return { owner, root, admin };
  }
  async function reopenAdmin(vaultId: string): Promise<TeamAdminSession> {
    return TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owners.get(vaultId)!, createSocket: wsSocket });
  }
  async function joinAs(vaultId: string, admin: TeamAdminSession, role: "editor" | "viewer"): Promise<SyncIdentity> {
    const id = await deriveIdentity(generateSeed());
    const tok = await admin.inviteToken(3600, role);
    const c = new EpochClient(server.port);
    await c.auth(id, vaultId, tok);
    c.close();
    return id;
  }

  it("rotateKey:owner CAS bump;跳號/重放被拒(bad-epoch)、非 owner 被拒(forbidden)", async () => {
    const vaultId = "rot-cas";
    const { admin } = await setup(vaultId);
    const ed = await joinAs(vaultId, admin, "editor");

    await admin.rotateKey(1);
    expect(store.epochOf(vaultId)).toBe(1);
    // 重放同號 / 跳號:CAS 拒絕且 epoch 不動(refuse 會關 admin 連線,各開新 session)
    const adminRetry = await reopenAdmin(vaultId);
    await expect(adminRetry.rotateKey(1)).rejects.toThrow(/bad-epoch/);
    expect(store.epochOf(vaultId)).toBe(1);
    const adminSkip = await reopenAdmin(vaultId);
    await expect(adminSkip.rotateKey(3)).rejects.toThrow(/bad-epoch/);
    expect(store.epochOf(vaultId)).toBe(1);

    // 非 owner:forbidden
    const edAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: ed, createSocket: wsSocket });
    await expect(edAdmin.rotateKey(2)).rejects.toThrow(/forbidden/);
    expect(store.epochOf(vaultId)).toBe(1);
    admin.close();
  });

  it("epoch 寫入柵欄:bump 後舊 epoch 寫入被拒(stale-epoch)、新 epoch 放行;個人 vault 不受影響", async () => {
    const vaultId = "rot-fence";
    const { owner, admin } = await setup(vaultId);

    const c = new EpochClient(server.port);
    await c.auth(owner, vaultId);
    c.pushDoc("doc-1", "d1", 0);
    await c.next("ack"); // epoch 0 時寫入放行

    await admin.rotateKey(1);
    await c.next("keyRotated"); // 廣播已到,此後同連線舊 epoch 寫入被柵欄拒
    c.pushDoc("doc-1", "d1", 0, 2);
    expect((await c.next("error")).code).toBe("stale-epoch");
    await c.closed;

    // 新 epoch 寫入放行(重連)
    const c2 = new EpochClient(server.port);
    const ok = await c2.auth(owner, vaultId);
    expect(ok.epoch).toBe(1); // authOk 告知當前 epoch
    c2.pushDoc("doc-1", "d1b", 1);
    await c2.next("ack");
    // snapshotPush 同受柵欄管
    c2.send({ type: "snapshotPush", docId: "doc-1", uptoSeq: 5, epoch: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array([9]) });
    expect((await c2.next("error")).code).toBe("stale-epoch");
    admin.close();

    // 個人 vault(無 owner):epoch 0 恆放行
    const personal = await deriveIdentity(generateSeed());
    const pc = new EpochClient(server.port);
    const pok = await pc.auth(personal, "rot-personal");
    expect(pok.epoch).toBe(0);
    pc.pushDoc("doc-p", "pd", 0);
    await pc.next("ack");
    pc.close();
  });

  it("keyRotated 廣播給同 vault 其他成員連線;成員以新 epoch 信封 bootstrap 得 newRoot", async () => {
    const vaultId = "rot-broadcast";
    const { owner, root, admin } = await setup(vaultId);
    const bob = await joinAs(vaultId, admin, "editor");
    const bobRec = (await admin.members()).find((m) => m.memberId === bob.memberId)!;
    await admin.approve(bobRec, root, 0);

    const live = new EpochClient(server.port);
    await live.auth(bob, vaultId);

    // owner 輪換:先推 bob 的新 epoch 信封,再 commit
    const newRoot = new Uint8Array(32).fill(7);
    await admin.approve(bobRec, newRoot, 1);
    const ownerRec = (await admin.members()).find((m) => m.memberId === owner.memberId)!;
    await admin.approve(ownerRec, newRoot, 1);
    await admin.rotateKey(1);

    expect((await live.next("keyRotated")).epoch).toBe(1);
    live.close();

    // bob 重跑 bootstrap:拿到 epoch 1 的 newRoot(envelopesFor 回每 keyId 最新 epoch)
    const res = await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, createSocket: wsSocket });
    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.epoch).toBe(1);
      expect(Buffer.from(res.root).equals(Buffer.from(newRoot))).toBe(true);
    }
    // owner 自己的 self-envelope 也在新 epoch(崩潰復原路徑)
    const own = await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: owner, ownerPubSign: owner.pubSign, createSocket: wsSocket });
    expect(own.status === "ready" && own.epoch === 1 && Buffer.from(own.root).equals(Buffer.from(newRoot))).toBe(true);
    admin.close();
  });

  it("輪換踢分享連線且舊分享連結永久失效;輪換後新建分享有效", async () => {
    const vaultId = "rot-share";
    const { owner, admin } = await setup(vaultId);

    // owner 連線建立分享
    const oc = new EpochClient(server.port);
    await oc.auth(owner, vaultId);
    oc.pushDoc("doc-1", "od", 0);
    await oc.next("ack");
    oc.send({ type: "shareCreate", reqId: 1, docId: "doc-1", permission: "read" });
    const created = await oc.next("shareCreated");

    // 收件人以 shareId 連上
    const sc = new EpochClient(server.port);
    await new Promise<void>((res) => sc["ws"].once("open", () => res()));
    sc.send({ type: "shareAuth", shareId: created.shareId });
    await sc.next("shareAuthOk");

    await admin.rotateKey(1);
    expect((await sc.next("error")).code).toBe("no-share"); // 分享連線被踢
    await sc.closed;

    // 重連:resolveShare 綁 epoch → 查無此分享
    const sc2 = new EpochClient(server.port);
    await new Promise<void>((res) => sc2["ws"].once("open", () => res()));
    sc2.send({ type: "shareAuth", shareId: created.shareId });
    expect((await sc2.next("error")).code).toBe("no-share");

    // 輪換後新建的分享可用(owner 舊連線未寫入不會被關,但分享要綁新 epoch,開新連線建)
    oc.close();
    const oc2 = new EpochClient(server.port);
    await oc2.auth(owner, vaultId);
    oc2.send({ type: "shareCreate", reqId: 1, docId: "doc-1", permission: "read" });
    const created2 = await oc2.next("shareCreated");
    const sc3 = new EpochClient(server.port);
    await new Promise<void>((res) => sc3["ws"].once("open", () => res()));
    sc3.send({ type: "shareAuth", shareId: created2.shareId });
    await sc3.next("shareAuthOk");
    oc2.close();
    sc3.close();
  });
});
