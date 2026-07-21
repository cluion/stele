import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  encodeClientMessage,
  decodeServerMessage,
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  bootstrapTeamKey,
  createTeamVault,
  rootWrapContext,
  wrapKey,
  type SocketLike,
  type ClientMessage,
  type ServerMessage,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "bootstrap-測試-token-1234567890";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** ws → SocketLike 適配器(與 main.ts 給 SyncClient 的同形),供 bootstrap 對真伺服器握手 */
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

/** 最小 owner 管理 client:握手後可發 enrollCreate / memberList / envelopePush 並讀回應 */
class AdminClient {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(private readonly port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (data) => {
      this.inbox.push(decodeServerMessage(new Uint8Array(data as Buffer)));
      for (const w of this.waiters) w();
      this.waiters = [];
    });
    this.ws.on("error", () => {});
  }
  private send(msg: ClientMessage): void {
    this.ws.send(encodeClientMessage(msg));
  }
  async next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<ServerMessage & { type: T }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.inbox.findIndex((m) => m.type === type);
      if (idx >= 0) return this.inbox.splice(idx, 1)[0] as ServerMessage & { type: T };
      if (Date.now() > deadline) throw new Error(`等不到 ${type}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 30);
      });
    }
  }
  async auth(id: SyncIdentity, vaultId: string, enrollmentToken = ""): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise((res, rej) => {
        this.ws.once("open", res);
        this.ws.once("error", rej);
      });
    }
    this.send({ type: "authId", token: TOKEN, vaultId, memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap, enrollmentToken });
    const ch = await this.next("authChallenge");
    this.send({ type: "authProof", signature: id.sign(identityChallengeBytes(ch.nonce, vaultId, id.memberId)) });
    await this.next("authOk");
  }
  async makeInviteToken(): Promise<string> {
    this.send({ type: "enrollCreate", reqId: 1, ttlSec: 3600, role: "editor" });
    return (await this.next("enrollCreated")).token;
  }
  async pushRootTo(vaultId: string, member: SyncIdentity, owner: SyncIdentity, root: Uint8Array): Promise<void> {
    const env = await wrapKey(root, member.pubWrap, owner.sign, rootWrapContext(vaultId, member.memberId));
    this.send({ type: "envelopePush", reqId: 2, keyId: "root", memberId: member.memberId, epoch: 0, blob: env });
    await this.next("ok");
  }
  close(): void {
    this.ws.close();
  }
}

describe("團隊 vault bootstrap(端對端)", () => {
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

  it("createTeamVault 建立並認領 owner,self-envelope 落庫;owner 再 bootstrap 復原同一 root", async () => {
    const vaultId = "boot-owner";
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    expect(root).toHaveLength(32);
    expect(store.ownerOf(vaultId)).toBe(owner.memberId);
    expect(store.envelopesFor(vaultId, owner.memberId)).toHaveLength(1);

    // 換裝置(同 identity)只靠 self-envelope 復原,不需本機保存 root
    const res = await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId,
      identity: owner,
      ownerPubSign: owner.pubSign,
      createSocket: wsSocket,
    });
    expect(res.status).toBe("ready");
    expect(res.status === "ready" && hex(res.root)).toBe(hex(root));
  });

  it("新成員:owner 尚未包 root 給他 → pending;owner 包了之後 → ready 且 root 相同", async () => {
    const vaultId = "boot-member";
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });

    const admin = new AdminClient(server.port);
    await admin.auth(owner, vaultId);
    const inviteToken = await admin.makeInviteToken();

    const bob = await deriveIdentity(generateSeed());
    // 憑碼 enroll,但 owner 還沒包 root → pending
    const pending = await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId,
      identity: bob,
      ownerPubSign: owner.pubSign,
      enrollmentToken: inviteToken,
      createSocket: wsSocket,
    });
    expect(pending.status).toBe("pending");

    // owner 包 root 給 bob(bob 已 enroll,pubWrap 在 members 表)
    await admin.pushRootTo(vaultId, bob, owner, root);

    // bob 重試 bootstrap(已是成員,不需邀請碼)→ ready 且拿到同一 root
    const ready = await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId,
      identity: bob,
      ownerPubSign: owner.pubSign,
      createSocket: wsSocket,
    });
    expect(ready.status).toBe("ready");
    expect(ready.status === "ready" && hex(ready.root)).toBe(hex(root));
    admin.close();
  });

  it("偽造防線:owner pubSign 對不上(惡意中繼換信封)→ bootstrap 拋,不回假 root", async () => {
    const vaultId = "boot-forge";
    const owner = await deriveIdentity(generateSeed());
    await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const impostor = await deriveIdentity(generateSeed());
    await expect(
      bootstrapTeamKey({
        url: url(),
        token: TOKEN,
        vaultId,
        identity: owner,
        ownerPubSign: impostor.pubSign, // 錯的信任錨
        createSocket: wsSocket,
      }),
    ).rejects.toThrow();
  });
});
