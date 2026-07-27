import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  signOrgMemberCert,
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  OrgAdminSession,
  signOrgAdminCert,
  signOrgTeamCert,
  encodeClientMessage,
  decodeServerMessage,
  orgChallengeBytes,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

/**
 * 組織委任鏈端到端(3a):團隊綁組織後,信任錨上提到 org root——組織可在**舊 owner 完全不配合**下
 * 指派新 owner,而成員端仍是密碼學可驗。同時鎖死治理/金鑰兩平面的分界:org 連線碰不到任何內容。
 */

const TOKEN = "org-binding-測試-token-1234567890";

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

describe("組織綁定與跨團隊撤換 owner(3a)", () => {
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

  /** 建團隊 + 收一位已核准的 editor 成員;回傳雙方身分與 root */
  async function setupTeam(vaultId: string) {
    const owner = await deriveIdentity(generateSeed());
    const member = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
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

  const bootstrap = (vaultId: string, identity: SyncIdentity, ownerPubSign: Uint8Array, org?: { root: Uint8Array; pinned?: number }) =>
    bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId,
      identity,
      ownerPubSign,
      orgRootPubSign: org?.root,
      pinnedOrgSerial: org?.pinned,
      createSocket: wsSocket,
    });

  it("owner 綁定組織後,成員以 org root 為錨 bootstrap:憑證認定的 owner 即當代 owner", async () => {
    const vaultId = "org-bind-basic";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setupTeam(vaultId);

    const cert = signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined);
    await admin.bindOrg(orgRoot.pubSign, cert);
    admin.close();

    const res = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(res.status).toBe("ready");
    expect(res.status === "ready" && res.orgOwner?.ownerMemberId).toBe(owner.memberId);
    expect(res.status === "ready" && res.orgOwner?.serial).toBe(1);
    expect(res.status === "ready" && res.role).toBe("editor");
  });

  it("組織撤換 owner:舊 owner 完全不參與,新 owner 生效且成員驗得過", async () => {
    const vaultId = "org-transfer";
    const orgRoot = await deriveIdentity(generateSeed());
    const orgAdmin = await deriveIdentity(generateSeed());
    const { owner, member, root, admin } = await setupTeam(vaultId);

    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close(); // 舊 owner 從此離場(離職)

    // 組織以委任的 admin 連線,把 owner 指派給留任成員
    const adminCert = signOrgAdminCert(orgRoot.sign, { adminPubSign: orgAdmin.pubSign, notAfter: 0 });
    const org = await OrgAdminSession.open({
      url: url(),
      token: TOKEN,
      orgRootPubSign: orgRoot.pubSign,
      identity: orgAdmin,
      adminCert,
      createSocket: wsSocket,
    });
    await org.assignOwner(vaultId, member.pubSign, 2, owner.pubSign); // 背書前任信封,免交接窗口鎖死
    org.close();

    expect(store.ownerOf(vaultId)).toBe(member.memberId);
    expect(store.getMember(vaultId, member.memberId)?.role).toBe("owner");
    expect(store.getMember(vaultId, owner.memberId)?.role).toBe("editor"); // 舊 owner 留在團隊,只是不再管理

    // 交接窗口:信封仍是前任簽的,但組織已背書 → 新 owner 解得開 root(否則無從接管),
    // 且旗標誠實回報「待接管」;角色憑證是前任簽的 → 視同未簽發而非採信前任的說法
    const mid = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(mid.status === "ready" && mid.orgOwner?.envelopeFromPrevOwner).toBe(true);
    expect(mid.status === "ready" && mid.role).toBeUndefined();

    // 新 owner 接管:以自己的簽章重發全員信封與憑證(伺服器授權已跟上,他現在真的是 owner)
    const newAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: member, createSocket: wsSocket });
    await newAdmin.reissueAll(root, 0);
    await expect(newAdmin.inviteToken(3600, "viewer")).resolves.toBeTypeOf("string");
    newAdmin.close();

    // 接管後:錨仍是 org root,憑證與信封都指向新 owner → 驗得過且角色為 owner
    const res = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(res.status === "ready" && res.orgOwner?.ownerMemberId).toBe(member.memberId);
    expect(res.status === "ready" && res.orgOwner?.envelopeFromPrevOwner).toBe(false); // 接管完成
    expect(res.status === "ready" && res.role).toBe("owner");
  });

  it("撤換 owner:全體成員連線都被踢,不留任何人抱著舊錨繼續跑", async () => {
    const vaultId = "org-kick-all";
    const orgRoot = await deriveIdentity(generateSeed());
    const owner = await deriveIdentity(generateSeed());
    const successor = await deriveIdentity(generateSeed());
    const bystander = await deriveIdentity(generateSeed()); // 全程沒參與管理的一般成員
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    for (const who of [successor, bystander]) {
      const tok = await admin.inviteToken(3600, "editor");
      await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: who, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
      await admin.approve((await admin.members()).find((m) => m.memberId === who.memberId)!, root, 0);
    }
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close();

    // 旁觀者維持一條活躍連線(此刻用的是舊錨)
    const live = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: bystander, createSocket: wsSocket });
    await expect(live.memberDirectory(owner.pubSign)).resolves.toBeInstanceOf(Array);

    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await org.assignOwner(vaultId, successor.pubSign, 2, owner.pubSign);
    org.close();

    // 撤換後這條連線必須斷:否則他會抱著舊錨繼續跑,重連時才以舊錨拉到新 owner 簽的目錄而整份驗不過
    await expect(live.memberDirectory(owner.pubSign)).rejects.toThrow(/中斷|已關閉|role-changed/);
    live.close();
  });

  it("已綁組織卻收不到團隊憑證:fail-closed 拋錯,不降級回舊信任錨", async () => {
    const vaultId = "org-suppressed";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close();

    // 模擬惡意伺服器抑制憑證(直接清掉 DB 的綁定)
    store.close = store.close.bind(store);
    (store as unknown as { db: { prepare: (s: string) => { run: (v: string) => void } } }).db
      .prepare("DELETE FROM org_bindings WHERE vault_id = ?")
      .run(vaultId);

    await expect(bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign })).rejects.toThrow(/未提供團隊憑證/);
  });

  it("重放較舊的團隊憑證:成員端 pin 拒收(反回滾)", async () => {
    const vaultId = "org-rollback";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close();

    // 成員已見過 serial 3(組織換發過);伺服器卻回放 serial 1 的舊憑證
    await expect(bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign, pinned: 3 })).rejects.toThrow(/序號回退/);
  });

  it("他組織的 root 簽的憑證推不進來;非 owner 也不得綁定", async () => {
    const vaultId = "org-authz";
    const orgRoot = await deriveIdentity(generateSeed());
    const evilRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));

    // 已綁 A 組織,B 組織想接管:伺服器拒(換組織需先解綁)
    const evilCert = signOrgTeamCert(evilRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 9 }, undefined);
    await expect(admin.bindOrg(evilRoot.pubSign, evilCert)).rejects.toThrow(/forbidden|已綁定其他組織/);
    admin.close();

    // 一般成員想自行綁組織:伺服器拒(僅 owner)
    const vault2 = "org-authz-2";
    const t2 = await setupTeam(vault2);
    const memberSession = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId: vault2, identity: t2.member, createSocket: wsSocket });
    const cert2 = signOrgTeamCert(orgRoot.sign, { vaultId: vault2, ownerPubSign: t2.member.pubSign, serial: 1 }, undefined);
    await expect(memberSession.bindOrg(orgRoot.pubSign, cert2)).rejects.toThrow(/forbidden|僅團隊擁有者/);
    expect(store.orgBinding(vault2)).toBeUndefined();
    expect(member).toBeDefined();
  });

  it("憑證指向非成員:伺服器拒(不製造沒人簽得動信封的幽靈 owner)", async () => {
    const vaultId = "org-ghost";
    const orgRoot = await deriveIdentity(generateSeed());
    const outsider = await deriveIdentity(generateSeed());
    const { owner, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close();

    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await expect(org.assignOwner(vaultId, outsider.pubSign, 2)).rejects.toThrow(/no-member|不是此團隊成員/);
    expect(store.ownerOf(vaultId)).toBe(owner.memberId);
  });

  it("組織管理連線碰不到任何 doc 內容(治理平面 ≠ 金鑰平面)", async () => {
    const vaultId = "org-no-content";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close();
    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    const orgId = org.orgId;
    org.close();

    // 走完 org 認證後直接要 doc 內容:必須被拒(組織連線只准換發團隊憑證)
    const denied = await new Promise<string>((resolve, reject) => {
      const probe = wsSocket(url());
      probe.onopen = () =>
        probe.send(encodeClientMessage({ type: "authOrg", token: TOKEN, orgId, adminPubSign: orgRoot.pubSign, adminCert: new Uint8Array() }));
      probe.onmessage = (ev) => {
        const msg = decodeServerMessage(ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data));
        if (msg.type === "authChallenge") {
          probe.send(encodeClientMessage({ type: "authProof", signature: orgRoot.sign(orgChallengeBytes(msg.nonce, orgId, orgRoot.memberId)) }));
        } else if (msg.type === "orgAuthOk") {
          probe.send(encodeClientMessage({ type: "pull", docId: "any-doc", fromSeq: 0 }));
        } else if (msg.type === "error") resolve(msg.code);
      };
      probe.onerror = reject;
    });
    expect(denied).toBe("forbidden");
  });

  it("誤操作的訊息要能自救,且踩過之後救得回來", async () => {
    const vaultId = "org-misstep";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, root, admin } = await setupTeam(vaultId);

    // 貼到簽給別的團隊的綁定碼:訊息要指出最可能的成因,而非只說「簽章驗證失敗」
    const wrongVault = signOrgTeamCert(orgRoot.sign, { vaultId: "另一個團隊", ownerPubSign: owner.pubSign, serial: 1 }, undefined);
    await expect(admin.bindOrg(orgRoot.pubSign, wrongVault)).rejects.toThrow(/簽給其他團隊或其他組織/);
    admin.close(); // 伺服器拒絕時會關線;桌面每次操作開新連線,故重來即可

    // 救回:貼正確的碼就綁定成功(踩過不會卡死)
    const retry = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    await retry.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    retry.close();

    // 撤換時忘了背書前任:連新 owner 自己都解不開金鑰——訊息必須直接說出補救動作
    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await org.assignOwner(vaultId, member.pubSign, 2);
    await expect(bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign })).rejects.toThrow(/組織未在團隊憑證中背書前任/);

    // 序號沒遞增:訊息帶出伺服器目前的序號,管理員不必猜下一張要用多少
    await expect(org.assignOwner(vaultId, member.pubSign, 2, owner.pubSign)).rejects.toThrow(/序號須遞增\(伺服器目前為 2\)/);
    org.close();

    // 救回:以更大的序號重新簽發並帶上前任 → 新 owner 解得開,接管後全隊恢復
    const org2 = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await org2.assignOwner(vaultId, member.pubSign, 3, owner.pubSign);
    org2.close();
    const fixed = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(fixed.status === "ready" && fixed.orgOwner?.envelopeFromPrevOwner).toBe(true);
    const newAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: member, createSocket: wsSocket });
    await newAdmin.reissueAll(root, 0);
    newAdmin.close();
    const done = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(done.status === "ready" && done.orgOwner?.envelopeFromPrevOwner).toBe(false);
  });

  it("組織名冊:成員拉得到可信顯示名,偽造條目被濾,序號不得回退", async () => {
    const vaultId = "org-directory";
    const orgRoot = await deriveIdentity(generateSeed());
    const mallory = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));

    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await org.setMemberName(member.memberId, "王小明", 1, "工程部");

    // 成員(非 owner)也拉得到:名字是公開資訊,可信度來自組織簽章而非連線權限
    const memberSession = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: member, createSocket: wsSocket });
    const dir = await memberSession.orgDirectory(orgRoot.pubSign);
    expect(dir.find((d) => d.memberId === member.memberId)?.displayName).toBe("王小明");
    expect(dir.find((d) => d.memberId === member.memberId)?.department).toBe("工程部");

    // 惡意伺服器摻入非組織簽的條目:成員端濾掉,寧可沒有名字也不顯示偽造的
    store.putOrgMemberCert(
      dir.length > 0 ? store.orgBinding(vaultId)!.orgId : "",
      owner.memberId,
      signOrgMemberCert(mallory.sign, { memberId: owner.memberId, displayName: "假冒的老闆", serial: 9 }, undefined),
      9,
    );
    const filtered = await memberSession.orgDirectory(orgRoot.pubSign);
    expect(filtered.some((d) => d.displayName === "假冒的老闆")).toBe(false);

    // 序號不得回退(改名的用意常是蓋掉舊身分,回放舊名等於復原它)
    await expect(org.setMemberName(member.memberId, "舊名字", 1)).rejects.toThrow(/stale-cert|序號須遞增/);

    // 成員連線不得推名冊或看跨團隊總覽
    await expect(memberSession.orgDirectory(orgRoot.pubSign)).resolves.toBeInstanceOf(Array);
    memberSession.close();
    admin.close();
    org.close();
  });

  it("跨團隊總覽:組織列得到自己的團隊與成員,列不到他組織", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const otherRoot = await deriveIdentity(generateSeed());
    const t1 = await setupTeam("org-overview-1");
    const t2 = await setupTeam("org-overview-2");
    const outsider = await setupTeam("org-overview-out");
    for (const [t, id] of [
      [t1, "org-overview-1"],
      [t2, "org-overview-2"],
    ] as const) {
      await t.admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId: id, ownerPubSign: t.owner.pubSign, serial: 1 }, undefined));
      t.admin.close();
    }
    // 他組織的團隊
    await outsider.admin.bindOrg(
      otherRoot.pubSign,
      signOrgTeamCert(otherRoot.sign, { vaultId: "org-overview-out", ownerPubSign: outsider.owner.pubSign, serial: 1 }, undefined),
    );
    outsider.admin.close();

    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    const vaults = await org.vaults();
    expect(vaults.map((v) => v.vaultId).sort()).toEqual(["org-overview-1", "org-overview-2"]);
    expect(vaults.find((v) => v.vaultId === "org-overview-1")?.ownerMemberId).toBe(t1.owner.memberId);
    expect(vaults.find((v) => v.vaultId === "org-overview-1")?.memberCount).toBe(2);

    const members = await org.members("org-overview-1");
    expect(members.map((m) => m.memberId).sort()).toEqual([t1.member.memberId, t1.owner.memberId].sort());

    // 他組織的 vault:列不到(即使知道 vaultId)
    await expect(org.members("org-overview-out")).rejects.toThrow(/forbidden|不屬於本組織/);
  });

  it("一次全撤:跨團隊即時移除並踢線,擁有者的團隊被略過並回報,各團隊標記待輪換", async () => {
    const orgRoot = await deriveIdentity(generateSeed());
    const t1 = await setupTeam("revoke-1");
    const t2 = await setupTeam("revoke-2");
    // 讓 t1 的成員也加入 t2,模擬「同一個人在多團隊」(身分本來就跨 vault 全域)
    const tok = await t2.admin.inviteToken(3600, "editor");
    await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId: "revoke-2",
      identity: t1.member,
      ownerPubSign: t2.owner.pubSign,
      enrollmentToken: tok,
      createSocket: wsSocket,
    });
    await t2.admin.approve((await t2.admin.members()).find((m) => m.memberId === t1.member.memberId)!, t2.root, 0);
    for (const [t, id] of [
      [t1, "revoke-1"],
      [t2, "revoke-2"],
    ] as const) {
      await t.admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId: id, ownerPubSign: t.owner.pubSign, serial: 1 }, undefined));
      t.admin.close();
    }
    // 第三個團隊:此人正是擁有者,全撤應略過它並回報
    const t3 = await setupTeam("revoke-3");
    await t3.admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId: "revoke-3", ownerPubSign: t3.owner.pubSign, serial: 1 }, undefined));
    t3.admin.close();

    // 離職者維持一條活躍連線,全撤應當場斷掉
    const live = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId: "revoke-1", identity: t1.member, createSocket: wsSocket });
    await expect(live.memberDirectory(t1.owner.pubSign)).resolves.toBeInstanceOf(Array);

    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    const res = await org.revokeEverywhere(t1.member.memberId);
    expect(res.removed.sort()).toEqual(["revoke-1", "revoke-2"]);
    expect(res.skippedOwner).toEqual([]); // 此人不是任何團隊的擁有者

    // 兩個團隊都已移除、都標記待輪換(舊 root 要輪換才作廢,而輪換只有擁有者做得到)
    for (const v of ["revoke-1", "revoke-2"]) {
      expect(store.getMember(v, t1.member.memberId)).toBeUndefined();
      expect(store.pendingRotation(v)).toBe(true);
    }
    // 活躍連線當場被踢
    await expect(live.memberDirectory(t1.owner.pubSign)).rejects.toThrow(/中斷|已關閉|removed/);

    // 被撤者重連即被拒(邀請碼已消耗,重新加入需新碼)
    await expect(
      bootstrapTeamKey({ url: url(), token: TOKEN, vaultId: "revoke-1", identity: t1.member, ownerPubSign: t1.owner.pubSign, createSocket: wsSocket }),
    ).rejects.toThrow(/enroll-required|邀請碼/);

    // 擁有者輪換後旗標自動清除
    const ownerAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId: "revoke-1", identity: t1.owner, createSocket: wsSocket });
    await ownerAdmin.approve((await ownerAdmin.members()).find((m) => m.memberId === t1.owner.memberId)!, new Uint8Array(32).fill(7), 1);
    await ownerAdmin.rotateKey(1);
    ownerAdmin.close();
    expect(store.pendingRotation("revoke-1")).toBe(false);

    // 撤到擁有者身上:略過並回報,團隊不會被斬首
    const res2 = await org.revokeEverywhere(t3.owner.memberId);
    expect(res2.skippedOwner).toEqual(["revoke-3"]);
    expect(store.ownerOf("revoke-3")).toBe(t3.owner.memberId);
    org.close();
  });

  it("組織政策與團隊政策取較嚴者:組織開啟即全組織生效,且不能放寬團隊已開的", async () => {
    const vaultId = "org-policy";
    const orgRoot = await deriveIdentity(generateSeed());
    const { owner, member, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));

    // 團隊自己沒開,組織開 → 成員端生效
    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await org.setRequireSignedWrites(true, 1);
    const res = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(res.status === "ready" && res.requireSignedWrites).toBe(true);
    expect(store.requiresSignedWritesEffective(vaultId)).toBe(true);

    // 團隊自己開、組織關 → 仍是開(組織只能加嚴,不能放寬團隊的決定)
    await admin.setRequireSignedWrites(true, 0);
    await org.setRequireSignedWrites(false, 2);
    const res2 = await bootstrap(vaultId, member, owner.pubSign, { root: orgRoot.pubSign });
    expect(res2.status === "ready" && res2.requireSignedWrites).toBe(true);

    // 政策序號不得回退
    await expect(org.setRequireSignedWrites(true, 2)).rejects.toThrow(/stale-cert|序號須遞增/);
    org.close();
    admin.close();
  });

  it("未知組織不得認證(不讓人憑空宣稱組織身分)", async () => {
    const strangerRoot = await deriveIdentity(generateSeed());
    await expect(
      OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: strangerRoot.pubSign, identity: strangerRoot, createSocket: wsSocket }),
    ).rejects.toThrow(/no-org|查無此組織/);
  });

  it("無委任的外人冒充 admin 連線:伺服器拒", async () => {
    const vaultId = "org-fake-admin";
    const orgRoot = await deriveIdentity(generateSeed());
    const mallory = await deriveIdentity(generateSeed());
    const { owner, admin } = await setupTeam(vaultId);
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: owner.pubSign, serial: 1 }, undefined));
    admin.close();

    await expect(
      OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: mallory, createSocket: wsSocket }),
    ).rejects.toThrow(/forbidden|需管理員委任/);

    // 自簽委任(非 org root 簽)同樣不成立
    const selfCert = signOrgAdminCert(mallory.sign, { adminPubSign: mallory.pubSign, notAfter: 0 });
    await expect(
      OrgAdminSession.open({
        url: url(),
        token: TOKEN,
        orgRootPubSign: orgRoot.pubSign,
        identity: mallory,
        adminCert: selfCert,
        createSocket: wsSocket,
      }),
    ).rejects.toThrow(/forbidden|委任無效/);
  });
});
