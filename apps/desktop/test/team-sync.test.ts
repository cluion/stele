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
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";

/**
 * 金牌(F):團隊 vault 的完整鏈路,兩個**不同身分**的成員經真伺服器收斂。
 * 補上 packages/sync e2e 未覆蓋的缺口——成員↔成員的 doc relay + 以團隊 root 加解密互通,
 * 且 team vault 強制 authId(兩成員皆帶身分連線)。
 */

const TOKEN = "金牌-team-sync-token-1234567890";
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

async function until(cond: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`逾時等待:${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("團隊 vault 金牌:兩成員經真伺服器收斂", () => {
  let server: RunningServer;
  let store: SyncStore;
  const managers: SyncManager[] = [];
  const sessions: VaultSession[] = [];

  const url = (): string => `ws://127.0.0.1:${server.port}`;

  function makeMember(vaultId: string, deviceId: string, root: Uint8Array, identity: SyncIdentity, seed: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-team-"));
    for (const [rel, content] of Object.entries(seed)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: url(), token: TOKEN, vaultId, deviceId };
    const manager = new SyncManager(session, settings, new VaultMeta(dir), undefined, {
      spaces: new MasterKeySpaces(root),
      identity,
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

  it("owner 建 vault → 邀請並核准 bob → 兩成員(不同身分)以團隊 root 收斂筆記", async () => {
    const vaultId = "gold-team";
    const owner = await deriveIdentity(generateSeed());
    const bob = await deriveIdentity(generateSeed());

    // owner 建團隊 vault(生 root、self-wrap、claimOwner)
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });

    // owner 產邀請碼 → bob 憑碼 enroll(pending)→ owner 核准 → bob bootstrap 得同一 root
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const inviteToken = await admin.inviteToken(3600);
    const pending = await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, enrollmentToken: inviteToken, createSocket: wsSocket });
    expect(pending.status).toBe("pending");
    const bobRec = (await admin.members()).find((m) => m.memberId === bob.memberId)!;
    await admin.approve(bobRec, root);
    const ready = await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: bob, ownerPubSign: owner.pubSign, createSocket: wsSocket });
    admin.close();
    expect(ready.status).toBe("ready");
    expect(ready.status === "ready" && Buffer.from(ready.root).equals(Buffer.from(root))).toBe(true);
    const bobRoot = ready.status === "ready" ? ready.root : root;

    // 兩成員(不同身分)各起 SyncManager,同一 team vault、同一 root
    const a = makeMember(vaultId, "owner-dev", root, owner, { "團隊筆記.md": "# 團隊筆記\n" });
    const b = makeMember(vaultId, "bob-dev", bobRoot, bob);

    // owner 的既有筆記物化到 bob(vault-meta 與內容都以 team root 加解密,伺服器全盲)
    await until(() => content(b.dir, "團隊筆記.md") === "# 團隊筆記\n", "bob 物化 owner 的筆記");

    // bob 編輯 → owner 收到(成員↔成員 relay,雙向)
    const replica = new Y.Doc();
    Y.applyUpdate(replica, b.session.openDoc("團隊筆記.md"));
    const text = replica.getText("md");
    text.insert(text.length, "bob 補一行\n");
    b.session.pushUpdate("團隊筆記.md", Y.encodeStateAsUpdate(replica));

    await until(() => content(a.dir, "團隊筆記.md") === "# 團隊筆記\nbob 補一行\n", "owner 收到 bob 的編輯");
  });
});
