import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import WebSocket from "ws";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import {
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  OrgAdminSession,
  signOrgTeamCert,
  MasterKeySpaces,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";

/**
 * 金牌(3a 組織撤換 owner):owner 離職、完全不參與的情況下,組織指派留任成員為新 owner。
 * 驗三件事:
 * (a) 撤換 + 接管重簽後,成員仍能雙向協作(信任錨熱換到位,新 owner 重簽的目錄不被判為偽造);
 * (b) 接管完成後,前任 owner 的簽章即刻失效——他重簽的成員憑證不再被採信;
 * (c) 惡意伺服器重放舊團隊憑證(把 owner 指回離職者)被成員端序號 pin 擋下。
 */

const TOKEN = "組織撤換-org-transfer-token-1234567890";
const noop = { broadcastDoc() {}, notifyIndexUpdated() {}, async trash() {} };

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

async function until(cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`逾時等待:${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("金牌:組織撤換團隊擁有者(3a)", () => {
  let server: RunningServer;
  let store: SyncStore;
  const managers: SyncManager[] = [];
  const sessions: VaultSession[] = [];
  const url = (): string => `ws://127.0.0.1:${server.port}`;

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    for (const m of managers) await m.stop().catch(() => {});
    for (const s of sessions) await s.destroy().catch(() => {});
    await server.close();
    store.close();
  });

  function makeMember(vaultId: string, deviceId: string, root: Uint8Array, identity: SyncIdentity, ownerPubSign: Uint8Array, seed: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-org-"));
    for (const [rel, content] of Object.entries(seed)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: url(), token: TOKEN, vaultId, deviceId };
    const manager = new SyncManager(session, settings, new VaultMeta(dir), undefined, {
      spaces: new MasterKeySpaces(root),
      identity,
      ownerPubSign,
      pushDebounceMs: 20,
    });
    manager.start();
    managers.push(manager);
    sessions.push(session);
    return { dir, session, manager };
  }

  /** 以 Yjs replica 追寫一行再推回:與其他桌面測試同一套編輯路徑 */
  const appendLine = (session: VaultSession, rel: string, text: string): void => {
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc(rel)); // openDoc 回的是 state update,不是 Doc
    const md = replica.getText("md");
    md.insert(md.length, text);
    session.pushUpdate(rel, Y.encodeStateAsUpdate(replica));
  };

  const content = (dir: string, rel: string): string | undefined => {
    try {
      return readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };

  it("owner 離職:組織指派留任成員,接管重簽後協作照常、前任簽章失效", async () => {
    const vaultId = "org-gold";
    const orgRoot = await deriveIdentity(generateSeed());
    const leaving = await deriveIdentity(generateSeed()); // 即將離職的 owner
    const successor = await deriveIdentity(generateSeed()); // 接任者
    const worker = await deriveIdentity(generateSeed()); // 一般成員(全程不參與管理)

    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: leaving, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: leaving, createSocket: wsSocket });
    for (const who of [successor, worker]) {
      const tok = await admin.inviteToken(3600, "editor");
      await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: who, ownerPubSign: leaving.pubSign, enrollmentToken: tok, createSocket: wsSocket });
      const rec = (await admin.members()).find((m) => m.memberId === who.memberId)!;
      await admin.approve(rec, root, 0);
    }
    // 綁組織後,信任錨即上提;隨後 owner 徹底離場
    await admin.bindOrg(orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: leaving.pubSign, serial: 1 }, undefined));
    admin.close();

    // 兩位成員在線協作(此刻錨仍是離職者)
    const a = makeMember(vaultId, "dev-successor", root, successor, leaving.pubSign, { "note.md": "接班前\n" });
    const b = makeMember(vaultId, "dev-worker", root, worker, leaving.pubSign);
    await until(() => content(b.dir, "note.md") === "接班前\n", "撤換前的初始同步");

    // 組織直接指派新 owner(舊 owner 不在場);背書前任信封以免交接窗口鎖死
    const org = await OrgAdminSession.open({ url: url(), token: TOKEN, orgRootPubSign: orgRoot.pubSign, identity: orgRoot, createSocket: wsSocket });
    await org.assignOwner(vaultId, successor.pubSign, 2, leaving.pubSign);
    org.close();

    // 成員重跑 bootstrap:憑證認定的 owner 已是接任者,信封仍前任簽(待接管)
    const mid = await bootstrapTeamKey({
      url: url(),
      token: TOKEN,
      vaultId,
      identity: worker,
      ownerPubSign: leaving.pubSign,
      orgRootPubSign: orgRoot.pubSign,
      createSocket: wsSocket,
    });
    expect(mid.status === "ready" && mid.orgOwner?.ownerMemberId).toBe(successor.memberId);
    expect(mid.status === "ready" && mid.orgOwner?.envelopeFromPrevOwner).toBe(true);

    // 接任者接管重簽,並把執行中的連線熱換到新錨(桌面 main.ts 的 refreshTeamRole 做同一件事)
    const newAdmin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: successor, createSocket: wsSocket });
    await newAdmin.reissueAll(root, 0);
    newAdmin.close();
    a.manager.setOwnerPubSign(successor.pubSign);
    b.manager.setOwnerPubSign(successor.pubSign);

    // (a) 協作照常:雙向都通(目錄已重拉,新 owner 背書的成員互認)
    appendLine(a.session, "note.md", "接班後\n");
    await until(() => content(b.dir, "note.md")?.includes("接班後") === true, "接管後 successor→worker");
    appendLine(b.session, "note.md", "同事也寫\n");
    await until(() => content(a.dir, "note.md")?.includes("同事也寫") === true, "接管後 worker→successor");

    // (b) 前任簽章失效:離職者重簽的成員憑證在新錨下不被採信(伺服器層也已不認他是 owner)
    const exOwner = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: leaving, createSocket: wsSocket });
    await expect(exOwner.setRole(worker.memberId, worker.pubSign, "viewer", 0)).rejects.toThrow(/forbidden/);
    exOwner.close();

    // (c) 惡意伺服器重放舊憑證(serial 1,把 owner 指回離職者):成員端 pin 擋下
    store.putOrgBinding(vaultId, "any", orgRoot.pubSign, signOrgTeamCert(orgRoot.sign, { vaultId, ownerPubSign: leaving.pubSign, serial: 1 }, undefined), 1, leaving.memberId);
    await expect(
      bootstrapTeamKey({
        url: url(),
        token: TOKEN,
        vaultId,
        identity: worker,
        ownerPubSign: successor.pubSign,
        orgRootPubSign: orgRoot.pubSign,
        pinnedOrgSerial: 2,
        createSocket: wsSocket,
      }),
    ).rejects.toThrow(/序號回退/);
  }, 60_000);
});
