import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  encodeClientMessage,
  decodeServerMessage,
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  wrapKey,
  type ClientMessage,
  type ServerMessage,
  type SyncIdentity,
  type WrapContext,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "團隊金鑰測試-token-1234567890";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const randomRoot = () => crypto.getRandomValues(new Uint8Array(32));
const rootCtx = (vaultId: string, recipientMemberId: string): WrapContext => ({ vaultId, keyId: "root", epoch: 0, recipientMemberId });

/** 低階測試 client:握手 + 團隊 reqId 請求回應 */
class TeamClient {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (data) => {
      this.inbox.push(decodeServerMessage(new Uint8Array(data as Buffer)));
      for (const w of this.waiters) w();
      this.waiters = [];
    });
    this.ws.on("error", () => {});
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
      if (Date.now() > deadline) throw new Error(`等不到 ${type},收件匣:${JSON.stringify(this.inbox.map((m) => m.type))}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 30);
      });
    }
  }

  /** 完整帶身分握手(可帶邀請碼);回 authOk */
  async authWith(id: SyncIdentity, vaultId: string, enrollmentToken = "", token = TOKEN): Promise<void> {
    await this.open();
    this.send({ type: "authId", token, vaultId, memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap, enrollmentToken });
    const challenge = await this.next("authChallenge");
    this.send({ type: "authProof", signature: id.sign(identityChallengeBytes(challenge.nonce, vaultId, id.memberId)) });
    await this.next("authOk");
  }

  close(): void {
    this.ws.close();
  }
}

describe("團隊金鑰盲中繼分發(2b)", () => {
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

  /** owner 建 team vault:認證 → claimOwner → self-wrap root 並 push */
  async function makeOwner(vaultId: string): Promise<{ id: SyncIdentity; root: Uint8Array; client: TeamClient }> {
    const id = await deriveIdentity(generateSeed());
    const client = new TeamClient(server.port);
    await client.authWith(id, vaultId);
    client.send({ type: "claimOwner", reqId: 1 });
    await client.next("ok");
    const root = randomRoot();
    const selfEnv = await wrapKey(root, id.pubWrap, id.sign, rootCtx(vaultId, id.memberId));
    client.send({ type: "envelopePush", reqId: 2, keyId: "root", memberId: id.memberId, epoch: 0, blob: selfEnv });
    await client.next("ok");
    return { id, root, client };
  }

  it("owner 建 team vault + self-envelope:自己 pull 回自己的信封並 unwrap 得 root", async () => {
    const { id, root, client } = await makeOwner("team-self");
    client.send({ type: "envelopePull", reqId: 3 });
    const list = await client.next("envelopeList");
    expect(list.envelopes).toHaveLength(1);
    const back = await id.unwrap(list.envelopes[0]!.blob, id.pubSign, rootCtx("team-self", id.memberId));
    expect(hex(back)).toBe(hex(root));
    client.close();
  });

  it("完整邀請:owner 產邀請碼 → 新成員憑碼加入 → owner 包 root 給他 → 他 pull+unwrap 得同一 root", async () => {
    const vaultId = "team-invite";
    const owner = await makeOwner(vaultId);
    // owner 產生一次性邀請碼
    owner.client.send({ type: "enrollCreate", reqId: 10, ttlSec: 3600, role: "editor" });
    const created = await owner.client.next("enrollCreated");
    expect(created.token).toBeTruthy();

    // 被邀者憑碼加入
    const bob = await deriveIdentity(generateSeed());
    const bobClient = new TeamClient(server.port);
    await bobClient.authWith(bob, vaultId, created.token);

    // owner 查成員拿 bob 的 pubWrap,包 root 給他
    owner.client.send({ type: "memberList", reqId: 11 });
    const catalog = await owner.client.next("memberCatalog");
    const bobRec = catalog.members.find((m) => m.memberId === bob.memberId);
    expect(bobRec).toBeDefined();
    expect(hex(bobRec!.pubWrap)).toBe(hex(bob.pubWrap));
    const bobEnv = await wrapKey(owner.root, bobRec!.pubWrap, owner.id.sign, rootCtx(vaultId, bob.memberId));
    owner.client.send({ type: "envelopePush", reqId: 12, keyId: "root", memberId: bob.memberId, epoch: 0, blob: bobEnv });
    await owner.client.next("ok");

    // bob pull 出信封,以 owner pubSign 驗簽 unwrap → 同一 root(協作前提)
    bobClient.send({ type: "envelopePull", reqId: 13 });
    const list = await bobClient.next("envelopeList");
    expect(list.envelopes).toHaveLength(1);
    const bobRoot = await bob.unwrap(list.envelopes[0]!.blob, owner.id.pubSign, rootCtx(vaultId, bob.memberId));
    expect(hex(bobRoot)).toBe(hex(owner.root));

    owner.client.close();
    bobClient.close();
  });

  it("新成員無邀請碼加入 team vault 被拒(enroll-required)", async () => {
    const vaultId = "team-noinvite";
    const owner = await makeOwner(vaultId);
    const intruder = await deriveIdentity(generateSeed());
    const c = new TeamClient(server.port);
    await c.open();
    c.send({ type: "authId", token: TOKEN, vaultId, memberId: intruder.memberId, pubSign: intruder.pubSign, pubWrap: intruder.pubWrap, enrollmentToken: "" });
    const challenge = await c.next("authChallenge");
    c.send({ type: "authProof", signature: intruder.sign(identityChallengeBytes(challenge.nonce, vaultId, intruder.memberId)) });
    const err = await c.next("error");
    expect(err.code).toBe("enroll-required");
    expect(store.getMember(vaultId, intruder.memberId)).toBeUndefined();
    owner.client.close();
    c.close();
  });

  it("team vault 拒 legacy token-only 連線(堵 snapshotPush 截斷 DoS)", async () => {
    const vaultId = "team-legacy";
    const owner = await makeOwner(vaultId);
    const c = new TeamClient(server.port);
    await c.open();
    c.send({ type: "auth", token: TOKEN, vaultId });
    const err = await c.next("error");
    expect(err.code).toBe("team-vault");
    owner.client.close();
    c.close();
  });

  it("envelopePull 只回自己:成員拉不到別人的信封", async () => {
    const vaultId = "team-isolation";
    const owner = await makeOwner(vaultId);
    owner.client.send({ type: "enrollCreate", reqId: 20, ttlSec: 3600, role: "editor" });
    const tok = (await owner.client.next("enrollCreated")).token;
    const bob = await deriveIdentity(generateSeed());
    const bobClient = new TeamClient(server.port);
    await bobClient.authWith(bob, vaultId, tok);

    // owner 只包給自己(makeOwner 已做),沒包給 bob → bob pull 得空
    bobClient.send({ type: "envelopePull", reqId: 21 });
    const list = await bobClient.next("envelopeList");
    expect(list.envelopes).toEqual([]);
    owner.client.close();
    bobClient.close();
  });

  it("owner-only:非 owner 成員的 envelopePush / memberList / memberRemove / enrollCreate 一律 forbidden", async () => {
    const vaultId = "team-authz";
    const owner = await makeOwner(vaultId);
    owner.client.send({ type: "enrollCreate", reqId: 30, ttlSec: 3600, role: "editor" });
    const tok = (await owner.client.next("enrollCreated")).token;
    const bob = await deriveIdentity(generateSeed());
    // bob 先憑碼加入成為成員(之後重連不需碼)
    const enrol = new TeamClient(server.port);
    await enrol.authWith(bob, vaultId, tok);
    enrol.close();

    const attempts: ClientMessage[] = [
      { type: "envelopePush", reqId: 31, keyId: "root", memberId: bob.memberId, epoch: 0, blob: new Uint8Array([1]) },
      { type: "memberList", reqId: 32 },
      { type: "memberRemove", reqId: 33, memberId: owner.id.memberId },
      { type: "enrollCreate", reqId: 34, ttlSec: 60, role: "viewer" },
    ];
    for (const msg of attempts) {
      // forbidden 會關連線,每項用全新連線重試
      const c = new TeamClient(server.port);
      await c.authWith(bob, vaultId);
      c.send(msg);
      const err = await c.next("error");
      expect(err.code, `type ${msg.type}`).toBe("forbidden");
      c.close();
    }
    owner.client.close();
  });

  it("owner 移除成員:member 列與其信封皆消失", async () => {
    const vaultId = "team-remove";
    const owner = await makeOwner(vaultId);
    owner.client.send({ type: "enrollCreate", reqId: 40, ttlSec: 3600, role: "editor" });
    const tok = (await owner.client.next("enrollCreated")).token;
    const bob = await deriveIdentity(generateSeed());
    const bobClient = new TeamClient(server.port);
    await bobClient.authWith(bob, vaultId, tok);
    const env = await wrapKey(owner.root, bob.pubWrap, owner.id.sign, rootCtx(vaultId, bob.memberId));
    owner.client.send({ type: "envelopePush", reqId: 41, keyId: "root", memberId: bob.memberId, epoch: 0, blob: env });
    await owner.client.next("ok");
    expect(store.getMember(vaultId, bob.memberId)).toBeDefined();
    expect(store.envelopesFor(vaultId, bob.memberId)).toHaveLength(1);

    owner.client.send({ type: "memberRemove", reqId: 42, memberId: bob.memberId });
    await owner.client.next("ok");
    expect(store.getMember(vaultId, bob.memberId)).toBeUndefined();
    expect(store.envelopesFor(vaultId, bob.memberId)).toEqual([]);
    owner.client.close();
    bobClient.close();
  });
});
