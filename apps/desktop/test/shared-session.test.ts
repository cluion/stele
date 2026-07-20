import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import { deriveVaultKey, VaultCipher, type SyncStatus, type SharePermission } from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";
import { parseConsumeLink } from "../src/main/share-link.ts";
import { SharedSession } from "../src/main/shared-session.ts";

const TOKEN = "分享消費-token-1234567890";

const noop = {
  broadcastDoc() {},
  notifyIndexUpdated() {},
  trash(absPath: string) {
    rmSync(absPath, { force: true });
    return Promise.resolve();
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待逾時:${what}`);
    await sleep(30);
  }
}

/** 從 SharedSession 目前狀態取出 md 文字 */
function textOf(s: SharedSession): string {
  const rep = new Y.Doc();
  Y.applyUpdate(rep, s.snapshot());
  return rep.getText("md").toString();
}

/** 對 SharedSession 目前狀態做一次本地編輯(模擬 renderer 送 shared:push) */
function editShared(s: SharedSession, mutate: (t: Y.Text) => void): void {
  const rep = new Y.Doc();
  Y.applyUpdate(rep, s.snapshot());
  const sv = Y.encodeStateVector(rep);
  mutate(rep.getText("md"));
  s.applyFromRenderer(Y.encodeStateAsUpdate(rep, sv));
}

describe("SharedSession 消費分享連結", () => {
  let server: RunningServer;
  let store: SyncStore;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function makeOrigin(vaultId: string, seed: Record<string, string>) {
    const cipher = new VaultCipher(await deriveVaultKey("分享密語", vaultId, 12));
    const dir = mkdtempSync(path.join(tmpdir(), "stele-shared-"));
    for (const [rel, content] of Object.entries(seed)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: `ws://127.0.0.1:${server.port}`, token: TOKEN, vaultId, deviceId: "origin" };
    const manager = new SyncManager(session, settings, new VaultMeta(dir), undefined, {
      pushDebounceMs: 20,
      cipher,
      exportDocKey: (docId: string) => cipher.exportDocKey(docId),
    });
    manager.start();
    cleanups.push(async () => {
      await manager.stop();
      await session.destroy();
    });
    const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
    return { session, manager, read };
  }

  function consume(url: string) {
    const link = parseConsumeLink(url);
    if (!link) throw new Error("連結解析失敗");
    const events: { status: SyncStatus[]; permission?: SharePermission; synced: boolean; closed?: string } = {
      status: [],
      synced: false,
    };
    const shared = new SharedSession(link, {
      onStatus: (s) => events.status.push(s),
      onPermission: (p) => (events.permission = p),
      onSynced: () => (events.synced = true),
      onClosed: (c) => (events.closed = c),
      broadcast: () => {},
    });
    shared.start();
    cleanups.push(() => shared.close());
    return { shared, events };
  }

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });

  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
    await server.close();
    store.close();
  });

  it("消費 write 分享:bootstrap 內容、回報可寫、本地編輯即時推回來源方磁碟", async () => {
    const origin = await makeOrigin("v-w", { "協作.md": "# 協作\n第一行\n" });
    await sleep(150);
    const link = await origin.manager.createShareLink("協作.md", "write");

    const { shared, events } = consume(link.url);
    await until(() => events.synced, "消費端 bootstrap 完成");
    expect(textOf(shared)).toBe("# 協作\n第一行\n");
    expect(events.permission).toBe("write");

    // 消費者編輯 → 應即時鏡像回來源方 vault 的 .md
    editShared(shared, (t) => t.insert(t.length, "消費者補一行\n"));
    await until(() => origin.read("協作.md") === "# 協作\n第一行\n消費者補一行\n", "來源方收到消費者編輯");
  });

  it("消費 read 分享:回報唯讀,本地編輯不推回來源方", async () => {
    const origin = await makeOrigin("v-r", { "唯讀.md": "# 唯讀\n原文\n" });
    await sleep(150);
    const link = await origin.manager.createShareLink("唯讀.md", "read");

    const { shared, events } = consume(link.url);
    await until(() => events.synced, "唯讀消費端 bootstrap");
    expect(events.permission).toBe("read");

    editShared(shared, (t) => t.insert(t.length, "偷改\n"));
    await sleep(400); // 給足推送 debounce 的時間,確認唯讀不外洩
    expect(origin.read("唯讀.md")).toBe("# 唯讀\n原文\n");
  });

  it("撤銷後消費端收到 closed,連結失效", async () => {
    const origin = await makeOrigin("v-x", { "撤.md": "內容\n" });
    await sleep(150);
    const link = await origin.manager.createShareLink("撤.md", "write");
    const { shared, events } = consume(link.url);
    await until(() => events.synced, "bootstrap");

    await origin.manager.revokeShare(link.shareId);
    await until(() => events.closed !== undefined, "消費端收到失效");
    expect(events.closed).toBe("no-share");
    void shared;
  });
});
