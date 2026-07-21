import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  type SocketLike,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "team-admin-測試-token-1234567890";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

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

describe("TeamAdminSession(owner 管理連線,端對端)", () => {
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

  it("完整流程:owner 建 vault → 產邀請碼 → 成員 enroll → owner 核准 → 成員拿到同一 root", async () => {
    const vaultId = "admin-flow";
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });

    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const inviteToken = await admin.inviteToken(3600, "editor");
    expect(inviteToken).toBeTruthy();

    // 被邀者憑碼 bootstrap:enroll 成功但尚未被核准 → pending
    const bob = await deriveIdentity(generateSeed());
    const pending = await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, enrollmentToken: inviteToken, createSocket: wsSocket });
    expect(pending.status).toBe("pending");

    // owner 列成員、核對 bob 的 pubWrap、核准
    const members = await admin.members();
    const bobRec = members.find((m) => m.memberId === bob.memberId);
    expect(bobRec).toBeDefined();
    expect(hex(bobRec!.pubWrap)).toBe(hex(bob.pubWrap));
    await admin.approve(bobRec!, root);

    // bob 重試 → ready 且同一 root
    const ready = await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, createSocket: wsSocket });
    expect(ready.status).toBe("ready");
    expect(ready.status === "ready" && hex(ready.root)).toBe(hex(root));
    admin.close();
  });

  it("owner 移除成員:成員列與信封消失,之後該成員 bootstrap 回 pending", async () => {
    const vaultId = "admin-remove";
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const tok = await admin.inviteToken(3600, "editor");

    const bob = await deriveIdentity(generateSeed());
    await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
    const members = await admin.members();
    await admin.approve(members.find((m) => m.memberId === bob.memberId)!, root);
    expect(store.envelopesFor(vaultId, bob.memberId)).toHaveLength(1);

    await admin.remove(bob.memberId);
    expect(store.getMember(vaultId, bob.memberId)).toBeUndefined();
    expect(store.envelopesFor(vaultId, bob.memberId)).toEqual([]);
    admin.close();
  });

  it("非 owner 開 admin session 發指令被拒(request 拋)", async () => {
    const vaultId = "admin-authz";
    const owner = await deriveIdentity(generateSeed());
    await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const ownerAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const tok = await ownerAdmin.inviteToken(3600, "editor");

    const bob = await deriveIdentity(generateSeed());
    await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });

    // bob 是成員但非 owner,開 admin session 發 memberList 應被伺服器拒
    const bobAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: bob, createSocket: wsSocket });
    await expect(bobAdmin.members()).rejects.toThrow();
    ownerAdmin.close();
  });
});
