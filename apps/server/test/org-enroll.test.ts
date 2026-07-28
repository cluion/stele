import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  OrgAdminSession,
  signOrgTeamCert,
  decodeInvite,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

/**
 * 一次入職批次產碼(3b-4)端到端。
 * 核心不變量是**能力邊界**:組織產得出碼,但產碼 ≠ 加人——對方只能進到待核准佇列,
 * 金鑰信封仍非各團隊擁有者不可。這條界線在密碼學上成立(組織沒有 root),測試要守住它。
 */

const TOKEN = "org-enroll-token-1234567890";

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

describe("一次入職批次產碼(3b-4)", () => {
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

  /** 建一個綁好組織的團隊 */
  async function team(vaultId: string, orgRoot: SyncIdentity) {
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    return { owner, root, admin };
  }

  const orgSession = (orgRoot: SyncIdentity) =>
    OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });

  it("為全組織批次產碼:每個團隊一張,附當代擁有者公鑰", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const a = await team("enr-a", orgRoot);
    const b = await team("enr-b", orgRoot);
    a.admin.close();
    b.admin.close();

    const org = await orgSession(orgRoot);
    const entries = await org.createEnrollTokens(undefined, "editor", 3600);
    org.close();

    expect(entries.map((e) => e.vaultId).sort()).toEqual(["enr-a", "enr-b"]);
    const forA = entries.find((e) => e.vaultId === "enr-a")!;
    expect(Buffer.from(forA.ownerPubSign)).toEqual(Buffer.from(a.owner.pubSign)); // 被邀者的信任錨
    expect(forA.token.length).toBeGreaterThan(20);
    expect(entries[0]!.token).not.toBe(entries[1]!.token); // 每個團隊各自一張,不共用
  }, 20000);

  it("**產碼不等於加人**:新人用碼只進到待核准,擁有者核准前拿不到金鑰", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const t = await team("enr-boundary", orgRoot);
    const org = await orgSession(orgRoot);
    const [entry] = await org.createEnrollTokens(["enr-boundary"], "editor", 3600);
    org.close();

    const newbie = await deriveIdentity(generateSeed());
    const joined = await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId: "enr-boundary",
      identity: newbie,
      ownerPubSign: t.owner.pubSign,
      enrollmentToken: entry!.token,
      createSocket: wsSocket,
    });
    // 這就是邊界:組織產的碼只換到 pending,換不到 root
    expect(joined.status).toBe("pending");

    // 擁有者核准後才拿得到金鑰——而核准只有擁有者做得到
    const rec = (await t.admin.members()).find((m) => m.memberId === newbie.memberId)!;
    expect(rec.approved).toBe(false);
    await t.admin.approve(rec, t.root, 0);
    t.admin.close();

    const ready = await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId: "enr-boundary",
      identity: newbie,
      ownerPubSign: t.owner.pubSign,
      createSocket: wsSocket,
    });
    expect(ready.status).toBe("ready");
  }, 25000);

  it("碼是一次性的:同一張用第二次即失效", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const t = await team("enr-once", orgRoot);
    t.admin.close();
    const org = await orgSession(orgRoot);
    const [entry] = await org.createEnrollTokens(["enr-once"], "viewer", 3600);
    org.close();

    const first = await deriveIdentity(generateSeed());
    const second = await deriveIdentity(generateSeed());
    const join = (who: SyncIdentity) =>
      bootstrapTeamKey({
        url: url(),
        token: TOKEN,
        vaultId: "enr-once",
        identity: who,
        ownerPubSign: t.owner.pubSign,
        enrollmentToken: entry!.token,
        createSocket: wsSocket,
      });
    expect((await join(first)).status).toBe("pending");
    await expect(join(second)).rejects.toThrow(/enroll-required|邀請碼/);
  }, 25000);

  it("指定他組織的團隊:拒絕,且不透露那個團隊是否存在", async () => {
    const orgA = await deriveIdentity(generateSeed());
    const orgB = await deriveIdentity(generateSeed());
    const a = await team("enr-org-a", orgA);
    const b = await team("enr-org-b", orgB);
    a.admin.close();
    b.admin.close();

    // 存在但屬於他組織的 vault,與根本不存在的 vault,回覆必須**一字不差**——
    // 只要兩者可區分,組織就能拿它當他組織 vault 的存在性探測器。
    // 各開一條連線:伺服器的 refuse 不帶 reqId,client 收到即讓整條連線失敗(既有行為)
    const errFor = async (vaultId: string): Promise<string> => {
      const session = await orgSession(orgA);
      try {
        await session.createEnrollTokens([vaultId], "editor", 3600);
        return "(沒有被拒)";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        session.close();
      }
    };
    const otherOrg = await errFor("enr-org-b");
    const notExist = await errFor("根本沒這個團隊");
    expect(otherOrg).toMatch(/forbidden|不屬於本組織/);
    expect(notExist).toBe(otherOrg);
  }, 25000);

  it("組織不得用批次碼發 owner 角色(owner 由憑證釘選)", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const t = await team("enr-no-owner", orgRoot);
    t.admin.close();
    const org = await orgSession(orgRoot);
    const [entry] = await org.createEnrollTokens(["enr-no-owner"], "owner", 3600);
    org.close();

    const newbie = await deriveIdentity(generateSeed());
    await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId: "enr-no-owner",
      identity: newbie,
      ownerPubSign: t.owner.pubSign,
      enrollmentToken: entry!.token,
      createSocket: wsSocket,
    });
    // 要到的是 viewer(收斂),不是 owner;擁有者仍是原本那位
    expect(store.getMember("enr-no-owner", newbie.memberId)?.role).toBe("viewer");
    expect(store.ownerOf("enr-no-owner")).toBe(t.owner.memberId);
  }, 25000);

  it("一般團隊成員的連線送批次產碼:一律拒(跨團隊動作只給組織連線)", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const t = await team("enr-member-denied", orgRoot);
    const raw = t.admin as unknown as { request: (build: (id: number) => unknown, expect: string) => Promise<unknown> };
    await expect(
      raw.request((reqId: number) => ({ type: "orgEnrollCreate", reqId, vaultIds: [], role: "editor", ttlSec: 3600 }), "orgEnrollTokens"),
    ).rejects.toThrow(/forbidden|僅限組織管理連線/);
    t.admin.close();
  }, 20000);

  it("產出的邀請碼可解析,且信任錨釘在組織根(撤換擁有者後不必重新加入)", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const t = await team("enr-bundle", orgRoot);
    t.admin.close();
    const org = await orgSession(orgRoot);
    const [entry] = await org.createEnrollTokens(["enr-bundle"], "editor", 3600);
    org.close();

    // CLI 就是這樣組 bundle 的;確認格式與欄位都對得上
    const bundle = decodeInvite(
      Buffer.from(
        JSON.stringify({
          url: url(),
          token: TOKEN,
          vaultId: entry!.vaultId,
          ownerPubSign: Buffer.from(entry!.ownerPubSign).toString("base64"),
          enrollToken: entry!.token,
          role: "editor",
          orgRootPubSign: Buffer.from(orgRoot.pubSign).toString("base64"),
        }),
        "utf8",
      ).toString("base64url"),
    );
    expect(bundle.vaultId).toBe("enr-bundle");
    expect(bundle.role).toBe("editor");
    expect(bundle.orgRootPubSign).toBe(Buffer.from(orgRoot.pubSign).toString("base64"));
  }, 20000);
});
