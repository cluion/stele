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
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

/**
 * 管理事件彙整(3b-3)端到端。
 * 這是**伺服器自己的紀錄**,不是密碼學證據——測的是歸屬、範圍與隔離:
 * 誰拉得到、拉得到誰的、以及**拉不到什麼**(內容操作永遠不在其中)。
 */

const TOKEN = "org-events-token-1234567890";

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

describe("管理事件彙整(3b-3)", () => {
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

  /** 建團隊、綁組織、收一位已核准的 editor */
  async function setup(vaultId: string, orgRoot: SyncIdentity) {
    const owner = await deriveIdentity(generateSeed());
    const member = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    const tok = await admin.inviteToken(3600, "editor");
    await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId,
      identity: member,
      ownerPubSign: owner.pubSign,
      enrollmentToken: tok,
      createSocket: wsSocket,
    });
    const rec = (await admin.members()).find((m) => m.memberId === member.memberId)!;
    await admin.approve(rec, root, 0);
    return { owner, member, root, admin };
  }

  const orgSession = (orgRoot: SyncIdentity) =>
    OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });

  it("組織拉得到旗下團隊的管理事件:綁定、加入、核准都在,新到舊", async () => {
    const vaultId = "ev-basic";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setup(vaultId, orgRoot);
    admin.close();

    const org = await orgSession(orgRoot);
    const events = await org.events();
    org.close();

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("org-bound");
    expect(kinds).toContain("member-enrolled");
    expect(kinds).toContain("member-approved");
    // 新到舊:核准必定晚於綁定
    expect(kinds.indexOf("member-approved")).toBeLessThan(kinds.indexOf("org-bound"));

    const approved = events.find((e) => e.kind === "member-approved")!;
    expect(approved).toMatchObject({ vaultId, actor: owner.memberId, target: member.memberId });
    const enrolled = events.find((e) => e.kind === "member-enrolled")!;
    expect(enrolled).toMatchObject({ target: "", actor: member.memberId, detail: "editor" });
  }, 20000);

  it("改角色、輪換、一次全撤都留下事件", async () => {
    const vaultId = "ev-actions";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setup(vaultId, orgRoot);
    await admin.setRole(member.memberId, member.pubSign, "viewer", 0);
    await admin.rotateKey(1); // 只驗事件落點,不需真的重包信封
    admin.close();

    const org = await orgSession(orgRoot);
    await org.revokeEverywhere(member.memberId);
    const events = await org.events(vaultId);
    org.close();

    const byKind = new Map(events.map((e) => [e.kind, e]));
    expect(byKind.get("role-changed")).toMatchObject({ actor: owner.memberId, target: member.memberId, detail: "viewer" });
    expect(byKind.get("key-rotated")).toMatchObject({ actor: owner.memberId, detail: "1" });
    // 組織發起的動作:actor 是 orgId 而非某個成員
    expect(byKind.get("org-revoked")).toMatchObject({ actor: org.orgId, target: member.memberId });
  }, 25000);

  it("核准只記首次:輪換的重包憑證不再各記一筆(走查發現的雜訊)", async () => {
    const vaultId = "ev-approve-once";
    const orgRoot = await deriveIdentity(generateSeed());
    const { member, root, admin } = await setup(vaultId, orgRoot);

    const org = await orgSession(orgRoot);
    const afterApprove = (await org.events(vaultId)).filter((e) => e.kind === "member-approved");
    expect(afterApprove).toHaveLength(1); // 只有 B 那一筆;owner 給自己的 self-envelope 不算核准

    // 輪換 = 替全員重包信封 + 重簽憑證;這些都不是新的核准,不該再記
    const rec = (await admin.members()).find((m) => m.memberId === member.memberId)!;
    await admin.approve(rec, root, 1);
    await admin.rotateKey(1);
    admin.close();

    const afterRotate = (await org.events(vaultId)).filter((e) => e.kind === "member-approved");
    org.close();
    expect(afterRotate).toHaveLength(1);
  }, 25000);

  it("跨組織隔離:A 組織拉不到 B 組織團隊的事件,連指名 vault 也不行", async () => {
    const orgA = await deriveIdentity(generateSeed());
    const orgB = await deriveIdentity(generateSeed());
    const a = await setup("ev-org-a", orgA);
    const b = await setup("ev-org-b", orgB);
    a.admin.close();
    b.admin.close();

    const sessionA = await orgSession(orgA);
    const all = await sessionA.events();
    expect(all.every((e) => e.vaultId === "ev-org-a")).toBe(true);
    // 指名他組織的 vault:撈不到東西(不是報錯洩漏存在性,就是空)
    expect(await sessionA.events("ev-org-b")).toHaveLength(0);
    sessionA.close();
  }, 25000);

  it("一般團隊成員的連線拉不到管理事件(範圍橫跨全組織,非單一團隊成員該見)", async () => {
    const vaultId = "ev-member-denied";
    const orgRoot = await deriveIdentity(generateSeed());
    const { member, admin } = await setup(vaultId, orgRoot);
    admin.close();

    // 借 TeamAdminSession 的成員連線送出 orgEventPull:伺服器應以 forbidden 回絕
    const memberSession = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: member, createSocket: wsSocket });
    const raw = memberSession as unknown as { request: (build: (id: number) => unknown, expect: string) => Promise<unknown> };
    await expect(raw.request((reqId: number) => ({ type: "orgEventPull", reqId, vaultId: "", limit: 10 }), "orgEventList")).rejects.toThrow(
      /forbidden|僅限組織管理連線/,
    );
    memberSession.close();
  }, 20000);

  it("內容操作不在事件裡:寫入筆記不產生任何管理事件", async () => {
    const vaultId = "ev-no-content";
    const orgRoot = await deriveIdentity(generateSeed());
    const { admin } = await setup(vaultId, orgRoot);
    admin.close();

    const org = await orgSession(orgRoot);
    const before = await org.events(vaultId);
    // 直接對 store 寫一筆 doc 增量(等同成員推內容);管理日誌不該因此增加
    store.appendUpdate(vaultId, "doc-1", "dev-1", 1, new Uint8Array([1, 2, 3]));
    const after = await org.events(vaultId);
    org.close();

    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
  }, 20000);
});
