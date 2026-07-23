import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  encodeClientMessage,
  decodeServerMessage,
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  createTeamVault,
  TeamAdminSession,
  type SocketLike,
  type ClientMessage,
  type ServerMessage,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "team-roles-測試-token-1234567890";

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

/** 低階 client:握手(帶邀請碼 enroll)+ 送 doc 訊息、讀回應與關閉碼 */
class RoleClient {
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
  /** 帶身分握手(可帶邀請碼);回 authOk */
  async auth(id: SyncIdentity, vaultId: string, enrollmentToken = ""): Promise<void> {
    await new Promise<void>((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.send({ type: "authId", token: TOKEN, vaultId, memberId: id.memberId, pubSign: id.pubSign, pubWrap: id.pubWrap, enrollmentToken });
    const ch = await this.next("authChallenge");
    this.send({ type: "authProof", signature: id.sign(identityChallengeBytes(ch.nonce, vaultId, id.memberId)) });
    await this.next("authOk");
  }
  pushDoc(docId: string, dev: string): void {
    this.send({ type: "push", docId, deviceId: dev, counter: 1, epoch: 0, payload: new Uint8Array([1, 2, 3]) });
  }
  close(): void {
    this.ws.close();
  }
}

describe("團隊角色與授權強制(2c)", () => {
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

  /** owner 建 vault + admin 連線;回 owner 身分、root、admin session */
  async function setup(vaultId: string) {
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    return { owner, root, admin };
  }
  /** 以某角色 enroll 一個新成員(憑邀請碼),回其身分 */
  async function joinAs(vaultId: string, admin: TeamAdminSession, role: "editor" | "viewer"): Promise<SyncIdentity> {
    const id = await deriveIdentity(generateSeed());
    const tok = await admin.inviteToken(3600, role);
    const c = new RoleClient(server.port);
    await c.auth(id, vaultId, tok); // enroll
    c.close();
    return id;
  }

  it("editor 可寫、viewer 寫入(含 vault-meta)被拒;pull 兩者皆放行", async () => {
    const vaultId = "role-write";
    const { admin } = await setup(vaultId);
    const editor = await joinAs(vaultId, admin, "editor");
    const viewer = await joinAs(vaultId, admin, "viewer");

    const ec = new RoleClient(server.port);
    await ec.auth(editor, vaultId);
    ec.pushDoc("doc-1", "ed-dev");
    expect((await ec.next("ack")).docId).toBe("doc-1"); // editor 寫入被接受

    // viewer 仍可 pull(讀):先在乾淨連線上驗讀,再驗寫入被拒(refuse 會關線)
    const vread = new RoleClient(server.port);
    await vread.auth(viewer, vaultId);
    vread.send({ type: "pull", docId: "doc-1", fromSeq: 0 });
    expect((await vread.next("update")).docId).toBe("doc-1");
    vread.close();

    const vc = new RoleClient(server.port);
    await vc.auth(viewer, vaultId);
    vc.pushDoc("doc-2", "vw-dev");
    expect((await vc.next("error")).code).toBe("forbidden"); // viewer 寫 doc 被拒(連線隨即關)

    // viewer 連 vault-meta 也不得寫(不能改共享結構)
    const vc2 = new RoleClient(server.port);
    await vc2.auth(viewer, vaultId);
    vc2.pushDoc("vault-meta", "vw-dev2");
    expect((await vc2.next("error")).code).toBe("forbidden");

    admin.close();
    ec.close();
    vc.close();
    vc2.close();
  });

  it("owner 移除成員:活躍連線被踢(code removed),重連被拒(enroll-required)", async () => {
    const vaultId = "role-remove";
    const { admin } = await setup(vaultId);
    const editor = await joinAs(vaultId, admin, "editor");
    const live = new RoleClient(server.port);
    await live.auth(editor, vaultId);

    await admin.remove(editor.memberId);
    const err = await live.next("error");
    expect(err.code).toBe("removed");
    expect(await live.closed).toBeGreaterThanOrEqual(1000); // 連線被關

    // 重連:已非成員 + 舊碼已用 → enroll-required
    const again = new RoleClient(server.port);
    await new Promise<void>((res, rej) => {
      again["ws"].once("open", () => res());
      again["ws"].once("error", rej);
    });
    again.send({ type: "authId", token: TOKEN, vaultId, memberId: editor.memberId, pubSign: editor.pubSign, pubWrap: editor.pubWrap, enrollmentToken: "" });
    const ch = await again.next("authChallenge");
    again.send({ type: "authProof", signature: editor.sign(identityChallengeBytes(ch.nonce, vaultId, editor.memberId)) });
    expect((await again.next("error")).code).toBe("enroll-required");
    admin.close();
  });

  it("owner 降級 editor→viewer:活躍連線被踢,重連後寫入被拒", async () => {
    const vaultId = "role-downgrade";
    const { admin } = await setup(vaultId);
    const ed = await joinAs(vaultId, admin, "editor");
    const live = new RoleClient(server.port);
    await live.auth(ed, vaultId);
    live.pushDoc("doc-1", "d1");
    await live.next("ack"); // 降級前是 editor,可寫

    await admin.setRole(ed.memberId, ed.pubSign, "viewer", 0);
    expect((await live.next("error")).code).toBe("role-changed");
    await live.closed;

    // 重連後角色為 viewer,寫入被拒
    const back = new RoleClient(server.port);
    await back.auth(ed, vaultId);
    back.pushDoc("doc-2", "d2");
    expect((await back.next("error")).code).toBe("forbidden");
    admin.close();
    back.close();
  });

  it("非 owner 成員發 setRole / remove 被拒(forbidden)", async () => {
    const vaultId = "role-authz";
    const { admin } = await setup(vaultId);
    const ed = await joinAs(vaultId, admin, "editor");
    const other = await joinAs(vaultId, admin, "viewer");
    const edAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: ed, createSocket: wsSocket });
    await expect(edAdmin.setRole(other.memberId, other.pubSign, "editor", 0)).rejects.toThrow();
    await expect(edAdmin.remove(other.memberId)).rejects.toThrow();
    admin.close();
  });

  it("升級自癒:owner 的 members.role 被遷移成 viewer 時,重連仍能寫入且角色回填 owner", async () => {
    const vaultId = "role-migrated-owner";
    const { owner } = await setup(vaultId);
    // 模擬 0.9.0→2c 遷移:owner 的 members.role 被預設成 viewer(claimOwner 只在建立時跑一次)
    store.setRole(vaultId, owner.memberId, "viewer");
    expect(store.roleOf(vaultId, owner.memberId)).toBe("viewer");

    // owner 重連:server 認出他是 vault owner → 角色回 owner,寫入放行
    const c = new RoleClient(server.port);
    await c.auth(owner, vaultId);
    c.pushDoc("doc-1", "owner-dev");
    expect((await c.next("ack")).docId).toBe("doc-1");
    expect(store.roleOf(vaultId, owner.memberId)).toBe("owner"); // 已自癒回填
    c.close();
  });

  it("memberCatalog 帶角色;owner 為 owner、被邀者為其邀請碼角色", async () => {
    const vaultId = "role-catalog";
    const { owner, admin } = await setup(vaultId);
    const ed = await joinAs(vaultId, admin, "editor");
    const members = await admin.members();
    expect(members.find((m) => m.memberId === owner.memberId)!.role).toBe("owner");
    expect(members.find((m) => m.memberId === ed.memberId)!.role).toBe("editor");
    admin.close();
  });
});
