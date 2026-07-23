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
  MasterKeySpaces,
  VaultCipher,
  signWrite,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";

/**
 * 金牌(P4 第二階段):逐 update 作者驗證的端到端。
 * (a) 啟用簽驗下,合法成員的編輯照樣經真伺服器收斂——簽驗不破壞正常協作;
 * (b) 惡意注入(偽造作者、非成員簽的 update,即使以團隊金鑰加密解得開)被收件端拒絕、不套用。
 */

const TOKEN = "寫入真實性-write-auth-token-1234567890";
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

async function until(cond: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`逾時等待:${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("金牌:逐 update 作者驗證(P4)", () => {
  let server: RunningServer;
  let store: SyncStore;
  const managers: SyncManager[] = [];
  const sessions: VaultSession[] = [];
  const url = (): string => `ws://127.0.0.1:${server.port}`;

  function makeMember(vaultId: string, deviceId: string, root: Uint8Array, identity: SyncIdentity, ownerPubSign: Uint8Array, seed: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-wa-"));
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

  const content = (dir: string, rel: string): string | undefined => {
    try {
      return readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    for (const m of managers) await m.stop();
    for (const s of sessions) await s.destroy();
    await server.close();
    store.close();
  });

  it("合法成員簽的編輯收斂;偽造作者的注入(即使解得開)被拒不套用", async () => {
    const vaultId = "write-auth-gold";
    const owner = await deriveIdentity(generateSeed());
    const bob = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const tok = await admin.inviteToken(3600, "editor");
    await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
    const bobRec = (await admin.members()).find((m) => m.memberId === bob.memberId)!;
    await admin.approve(bobRec, root, 0);
    admin.close();

    // (a) 合法協作:owner 的既有筆記在簽驗啟用下照樣收斂到 bob
    const a = makeMember(vaultId, "own-dev", root, owner, owner.pubSign, { "團隊筆記.md": "# 團隊筆記\n合法內容\n" });
    const b = makeMember(vaultId, "bob-dev", root, bob, owner.pubSign);
    await until(() => content(b.dir, "團隊筆記.md") === "# 團隊筆記\n合法內容\n", "bob 收斂合法內容");

    const noteDocId = a.session.docId("團隊筆記.md");

    // (b) 惡意注入:mallory(非此 vault 成員)以團隊 root 加密一筆「污染」內容,偽造 authorMemberId 塞進 server。
    //     即使 bob 有 root 解得開,作者不在目錄 → 驗證失敗 → 不套用。模擬被攻陷伺服器/被移除者的注入。
    const mallory = await deriveIdentity(generateSeed());
    const poison = new Y.Doc();
    poison.getText("md").insert(0, "!!!被注入的污染內容!!!");
    const poisonPlain = Y.encodeStateAsUpdate(poison);
    const poisonPayload = await new VaultCipher(root).encrypt(noteDocId, poisonPlain);
    const badSig = signWrite(mallory.sign, { kind: "update", docId: noteDocId, epoch: 0, payload: poisonPayload });
    // 直接塞進 store(繞過 push;模擬惡意伺服器持有密文並注入),作者宣稱為 mallory(不在成員目錄)
    store.appendUpdate(vaultId, noteDocId, "mal-dev", 1, poisonPayload, mallory.memberId, badSig);

    // owner 再寫一筆合法內容,製造 seq 跳號 → bob gap-fill 拉到注入那筆 + 這筆
    const replica = new Y.Doc();
    Y.applyUpdate(replica, a.session.openDoc("團隊筆記.md"));
    replica.getText("md").insert(replica.getText("md").length, "後續合法\n");
    a.session.pushUpdate("團隊筆記.md", Y.encodeStateAsUpdate(replica));

    // bob 收斂到「合法 + 後續合法」;注入內容被作者驗證擋下,始終不出現
    await until(() => content(b.dir, "團隊筆記.md")?.includes("後續合法") === true, "bob 收到 owner 的後續合法編輯");
    expect(content(b.dir, "團隊筆記.md")).not.toContain("被注入的污染內容");

    // 再等一小段,確認注入始終沒被套用(非時序僥倖)
    await new Promise((r) => setTimeout(r, 300));
    expect(content(b.dir, "團隊筆記.md")).not.toContain("被注入的污染內容");
    expect(content(b.dir, "團隊筆記.md")).toContain("合法內容");
  }, 20_000);
});
