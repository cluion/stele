import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  encodeClientMessage,
  decodeServerMessage,
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  type ClientMessage,
  type ServerMessage,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "身分測試-token-1234567890";

/** 低階測試 client:直接收送協議訊息,精確驗握手各分支 */
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
        setTimeout(resolve, 50);
      });
    }
  }

  /** 完整帶身分握手:authId → 收 challenge → 簽章 authProof → 回傳 authOk */
  async authWith(id: SyncIdentity, vaultId: string, token = TOKEN): Promise<ServerMessage & { type: "authOk" }> {
    await this.open();
    this.send({ type: "authId", token, vaultId, memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap });
    const challenge = await this.next("authChallenge");
    const proof = id.sign(identityChallengeBytes(challenge.nonce, vaultId, id.memberId));
    this.send({ type: "authProof", signature: proof });
    return this.next("authOk");
  }

  close(): void {
    this.ws.close();
  }
}

describe("帶身分認證(challenge-response)", () => {
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

  it("完整握手成功,成員以 TOFU 入表且公鑰正確", async () => {
    const id = await deriveIdentity(generateSeed());
    const c = new TestClient(server.port);
    await c.authWith(id, "v-ok");

    const rec = store.getMember("v-ok", id.memberId);
    expect(rec).toBeDefined();
    expect([...rec!.pubSign]).toEqual([...id.pubSign]);
    expect([...rec!.pubWrap]).toEqual([...id.pubWrap]);
    c.close();
  });

  it("壞簽章被拒(連線關閉、不入表)", async () => {
    const id = await deriveIdentity(generateSeed());
    const c = new TestClient(server.port);
    await c.open();
    c.send({ type: "authId", token: TOKEN, vaultId: "v-bad", memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap });
    await c.next("authChallenge");
    c.send({ type: "authProof", signature: new Uint8Array(64).fill(0) }); // 亂簽

    const err = await c.next("error");
    expect(err.code).toBe("bad-proof");
    expect(store.getMember("v-bad", id.memberId)).toBeUndefined();
  });

  it("重放:別的連線的 nonce+簽章換到新連線無效(每連線新 nonce)", async () => {
    const id = await deriveIdentity(generateSeed());
    // 連線 1 拿到 challenge 並簽好,但不送
    const c1 = new TestClient(server.port);
    await c1.open();
    c1.send({ type: "authId", token: TOKEN, vaultId: "v-replay", memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap });
    const ch1 = await c1.next("authChallenge");
    const proof1 = id.sign(identityChallengeBytes(ch1.nonce, "v-replay", id.memberId));

    // 連線 2 發起自己的握手,拿到不同 nonce,卻重放連線 1 的簽章
    const c2 = new TestClient(server.port);
    await c2.open();
    c2.send({ type: "authId", token: TOKEN, vaultId: "v-replay", memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap });
    await c2.next("authChallenge");
    c2.send({ type: "authProof", signature: proof1 });

    const err = await c2.next("error");
    expect(err.code).toBe("bad-proof");
    c1.close();
  });

  it("同一成員(同種子)多裝置:各自握手皆入同一 members 列", async () => {
    const seed = generateSeed();
    const idA = await deriveIdentity(seed);
    const idB = await deriveIdentity(seed.slice()); // 匯入同種子的「另一台裝置」
    expect(idB.memberId).toBe(idA.memberId);

    const a = new TestClient(server.port);
    await a.authWith(idA, "v-multi");
    const b = new TestClient(server.port);
    await b.authWith(idB, "v-multi");

    expect(store.listMembers("v-multi").filter((m) => m.memberId === idA.memberId)).toHaveLength(1);
    a.close();
    b.close();
  });

  it("搶註:memberId 與 pubSign 不符即拒(擋自選 memberId 配自己金鑰霸佔他人身分)", async () => {
    // 攻擊者用自己的合法 keypair,但宣稱一個任意的、非其公鑰衍生的 memberId
    const attacker = await deriveIdentity(generateSeed());
    const fakeMemberId = "b".repeat(64);
    expect(fakeMemberId).not.toBe(attacker.memberId);

    // memberId↔pubSign 綁定在第一階段就查,連 challenge 都拿不到,攻擊者沒有簽章的機會
    const c = new TestClient(server.port);
    await c.open();
    c.send({ type: "authId", token: TOKEN, vaultId: "v-squat", memberId: fakeMemberId, pubSign: attacker.pubSign, pubWrap: attacker.pubWrap });

    const err = await c.next("error");
    expect(err.code).toBe("bad-member");
    expect(store.getMember("v-squat", fakeMemberId)).toBeUndefined();
  });

  it("token 錯誤在身分握手第一階段就被拒", async () => {
    const id = await deriveIdentity(generateSeed());
    const c = new TestClient(server.port);
    await c.open();
    c.send({ type: "authId", token: "錯的-token", vaultId: "v-badtoken", memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap });
    const err = await c.next("error");
    expect(err.code).toBe("bad-token");
  });
});
