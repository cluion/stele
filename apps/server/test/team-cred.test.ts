import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  signRoleCredential,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

/**
 * 角色憑證(§9.5)端到端:owner 簽 {vaultId,memberId,role,epoch} 經盲中繼分發,
 * 成員 bootstrap 對信任錨驗證——伺服器無法捏造角色、舊紀元憑證重放無效、改角色即重簽。
 */

const TOKEN = "role-cred-測試-token-1234567890";

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

describe("角色憑證(§9.5):簽發、驗證、重放防護", () => {
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

  async function setupWithMember(vaultId: string, role: "editor" | "viewer") {
    const owner = await deriveIdentity(generateSeed());
    const member = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const tok = await admin.inviteToken(3600, role);
    await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: member, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
    const rec = (await admin.members()).find((m) => m.memberId === member.memberId)!;
    await admin.approve(rec, root, 0);
    return { owner, member, root, admin };
  }

  const memberBootstrap = (vaultId: string, member: SyncIdentity, ownerPubSign: Uint8Array) =>
    bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: member, ownerPubSign, createSocket: wsSocket });

  it("approve 簽發憑證:成員 bootstrap 得驗證過的角色;setRole 重簽即更新", async () => {
    const vaultId = "cred-basic";
    const { owner, member, admin } = await setupWithMember(vaultId, "editor");

    const res = await memberBootstrap(vaultId, member, owner.pubSign);
    expect(res.status === "ready" && res.role).toBe("editor");

    await admin.setRole(member.memberId, "viewer", 0);
    const after = await memberBootstrap(vaultId, member, owner.pubSign);
    expect(after.status === "ready" && after.role).toBe("viewer");
    admin.close();
  });

  it("伺服器捏造/偽簽的憑證:bootstrap 直接拋錯,不會拿到假角色", async () => {
    const vaultId = "cred-forged";
    const { owner, member, admin } = await setupWithMember(vaultId, "viewer");
    admin.close();

    // 模擬惡意伺服器:直接把 DB 裡的憑證換成 mallory 簽的「editor」
    const mallory = await deriveIdentity(generateSeed());
    const forged = signRoleCredential(mallory.sign, { vaultId, memberId: member.memberId, role: "editor", epoch: 0 });
    store.putRoleCredential(vaultId, member.memberId, forged);

    await expect(memberBootstrap(vaultId, member, owner.pubSign)).rejects.toThrow(/驗證失敗/);
  });

  it("輪換後憑證重簽新紀元;舊紀元憑證重放視同未簽發(fallback,不拋)", async () => {
    const vaultId = "cred-epoch";
    const { owner, member, admin } = await setupWithMember(vaultId, "editor");
    const oldCred = store.roleCredentialFor(vaultId, member.memberId)!;

    // 輪換:重包 + 重簽 epoch 1(模擬 rotateTeamRoot 的 owner 迴圈)
    const newRoot = new Uint8Array(32).fill(9);
    for (const m of (await admin.members()).filter((m) => m.approved)) await admin.approve(m, newRoot, 1);
    await admin.rotateKey(1);
    admin.close();

    const res = await memberBootstrap(vaultId, member, owner.pubSign);
    expect(res.status === "ready" && res.epoch === 1 && res.role === "editor").toBe(true);
    expect(res.status === "ready" && Buffer.from(res.root).equals(Buffer.from(newRoot))).toBe(true);

    // 惡意伺服器重放舊紀元(epoch 0)的真簽憑證:與信封紀元不符 → 不採信,role 缺席而非錯值
    store.putRoleCredential(vaultId, member.memberId, oldCred);
    const replayed = await memberBootstrap(vaultId, member, owner.pubSign);
    expect(replayed.status === "ready" && replayed.role).toBeUndefined();
  });

  it("credPush 僅限 owner;removeMember 一併刪憑證", async () => {
    const vaultId = "cred-authz";
    const { member, admin } = await setupWithMember(vaultId, "editor");

    // 非 owner 想給自己簽 owner 憑證:伺服器拒(縱使放行,驗簽也擋——此處驗伺服器的濫用防線)
    const memberAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: member, createSocket: wsSocket });
    await expect(memberAdmin.setRole(member.memberId, "editor", 0)).rejects.toThrow(/forbidden/);
    expect(store.roleCredentialFor(vaultId, member.memberId)).toBeDefined();

    await admin.remove(member.memberId);
    expect(store.roleCredentialFor(vaultId, member.memberId)).toBeUndefined();
    admin.close();
  });
});
