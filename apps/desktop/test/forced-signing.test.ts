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
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";

/**
 * 金牌(P4 §7.3 強制簽章):
 * (a) owner 開啟政策後,新 bootstrap 回報 requireSignedWrites、伺服器對 unsigned 寫入軟拒;
 * (b) 強制模式的成員拒收 unsigned 注入(authorMemberId 空,即使以團隊金鑰加密解得開)——
 *     關閉過渡容忍窗口(否則惡意中繼把注入寫入的作者欄清空即可繞過驗證)。
 */

const TOKEN = "強制簽章-forced-signing-token-1234567890";
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

describe("金牌:強制簽章模式(P4 §7.3)", () => {
  let server: RunningServer;
  let store: SyncStore;
  const managers: SyncManager[] = [];
  const sessions: VaultSession[] = [];
  const url = (): string => `ws://127.0.0.1:${server.port}`;

  function makeMember(
    vaultId: string,
    deviceId: string,
    root: Uint8Array,
    identity: SyncIdentity,
    ownerPubSign: Uint8Array,
    requireSignedWrites: boolean,
    seed: Record<string, string> = {},
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-fs-"));
    for (const [rel, content] of Object.entries(seed)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: url(), token: TOKEN, vaultId, deviceId };
    const manager = new SyncManager(session, settings, new VaultMeta(dir), undefined, {
      spaces: new MasterKeySpaces(root),
      identity,
      ownerPubSign,
      requireSignedWrites,
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

  it("政策 tri-state:缺席/抑制→undefined(保留 pin)、開啟→true、關閉→false", async () => {
    const vaultId = "forced-wiring";
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const boot = () => bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: owner, ownerPubSign: owner.pubSign, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });

    // 政策未設:bootstrap 回 undefined(非 false)——呼叫端據此保留既有 pin,不誤把「缺席」當關閉
    const before = await boot();
    if (before.status === "ready") expect(before.requireSignedWrites).toBeUndefined();
    expect(store.requiresSignedWrites(vaultId)).toBe(false);

    // 開啟:當代政策明確 true,伺服器記錄要求簽章
    await admin.setRequireSignedWrites(true, 0);
    const on = await boot();
    if (on.status === "ready") expect(on.requireSignedWrites).toBe(true);
    expect(store.requiresSignedWrites(vaultId)).toBe(true);

    // 惡意伺服器抑制政策(直接刪掉存放的 blob):bootstrap 回 undefined 而非 false,
    // 呼叫端「?? 既有值」保留 pin true——這是反回滾的關鍵訊號,不讓抑制偷降級
    const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare("DELETE FROM vault_policy WHERE vault_id = ?").run(vaultId);
    const suppressed = await boot();
    if (suppressed.status === "ready") expect(suppressed.requireSignedWrites).toBeUndefined();

    // 明確關閉:owner 簽發當代 off 政策 → bootstrap 回 false(明確關閉,才允許降級)
    await admin.setRequireSignedWrites(false, 0);
    const off = await boot();
    if (off.status === "ready") expect(off.requireSignedWrites).toBe(false);
    expect(store.requiresSignedWrites(vaultId)).toBe(false);

    admin.close();
    expect(root.length).toBe(32);
  });

  it("強制模式成員:拒收 unsigned 注入(即使解得開),只收斂合法簽章內容", async () => {
    const vaultId = "forced-gold";
    const owner = await deriveIdentity(generateSeed());
    const bob = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const tok = await admin.inviteToken(3600, "editor");
    await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
    const bobRec = (await admin.members()).find((m) => m.memberId === bob.memberId)!;
    await admin.approve(bobRec, root, 0);
    await admin.setRequireSignedWrites(true, 0); // 全員(此測試中 owner+bob)已升級,開啟強制
    admin.close();

    // 合法協作:owner 的既有筆記在強制模式下照樣簽章收斂到 bob
    const a = makeMember(vaultId, "own-dev", root, owner, owner.pubSign, true, { "團隊筆記.md": "# 團隊筆記\n合法內容\n" });
    const b = makeMember(vaultId, "bob-dev", root, bob, owner.pubSign, true);
    await until(() => content(b.dir, "團隊筆記.md") === "# 團隊筆記\n合法內容\n", "bob 收斂合法內容");

    const noteDocId = a.session.docId("團隊筆記.md");

    // 惡意注入:以團隊 root 加密污染內容,作者欄清空冒充「未簽章舊 client」。
    // 過渡模式會容忍套用;強制模式下 verifyAuthor 對 unsigned 回 false → poison-skip 丟棄。
    const poison = new Y.Doc();
    poison.getText("md").insert(0, "!!!未簽章注入的污染!!!");
    const poisonPayload = await new VaultCipher(root).encrypt(noteDocId, Y.encodeStateAsUpdate(poison));
    store.appendUpdate(vaultId, noteDocId, "mal-dev", 1, poisonPayload, "", new Uint8Array()); // authorMemberId 空 = unsigned

    // owner 再寫一筆合法內容,製造 seq 跳號 → bob gap-fill 拉到注入那筆 + 這筆
    const replica = new Y.Doc();
    Y.applyUpdate(replica, a.session.openDoc("團隊筆記.md"));
    replica.getText("md").insert(replica.getText("md").length, "後續合法\n");
    a.session.pushUpdate("團隊筆記.md", Y.encodeStateAsUpdate(replica));

    await until(() => content(b.dir, "團隊筆記.md")?.includes("後續合法") === true, "bob 收到 owner 的後續合法編輯");
    expect(content(b.dir, "團隊筆記.md")).not.toContain("未簽章注入的污染");

    // 再等一小段確認注入始終沒被套用(非時序僥倖)
    await new Promise((r) => setTimeout(r, 300));
    expect(content(b.dir, "團隊筆記.md")).not.toContain("未簽章注入的污染");
    expect(content(b.dir, "團隊筆記.md")).toContain("合法內容");
  }, 20_000);
});
