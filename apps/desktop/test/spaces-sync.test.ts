import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import { deriveVaultKey, MasterKeySpaces, DEFAULT_SPACE_ID } from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";

const TOKEN = "空間同步-token-1234567890";
const noop = {
  broadcastDoc() {},
  notifyIndexUpdated() {},
  trash(absPath: string) {
    rmSync(absPath, { force: true });
    return Promise.resolve();
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`逾時:${what}`);
    await sleep(30);
  }
}

interface Device {
  dir: string;
  session: VaultSession;
  manager: SyncManager;
}

describe("空間端對端同步", () => {
  let server: RunningServer;
  let store: SyncStore;
  const devices: Device[] = [];

  async function makeDevice(vaultId: string, deviceId: string, seed: Record<string, string> = {}): Promise<Device> {
    const spaces = new MasterKeySpaces(await deriveVaultKey("空間密語", vaultId, 12));
    const dir = mkdtempSync(path.join(tmpdir(), "stele-space-"));
    for (const [rel, c] of Object.entries(seed)) writeFileSync(path.join(dir, rel), c);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: `ws://127.0.0.1:${server.port}`, token: TOKEN, vaultId, deviceId };
    const manager = new SyncManager(session, settings, undefined, { pushDebounceMs: 20, spaces });
    manager.start();
    const device = { dir, session, manager };
    devices.push(device);
    return device;
  }
  const content = (d: Device, rel: string): string | undefined => {
    try {
      return readFileSync(path.join(d.dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    for (const d of devices) {
      await d.manager.stop();
      await d.session.destroy();
    }
    await server.close();
    store.close();
  });

  it("零遷移:預設空間的筆記照常端對端同步", async () => {
    const a = await makeDevice("v-sp1", "devA", { "祕密.md": "預設空間內容\n" });
    void a;
    const b = await makeDevice("v-sp1", "devB");
    await until(() => content(b, "祕密.md") === "預設空間內容\n", "B 物化預設空間筆記");
    expect(b.manager.spaceOfNote("祕密.md")).toBe(DEFAULT_SPACE_ID);
  });

  it("已連線的 B:A 把筆記移到新空間後,B 收斂到該空間且仍解得出內容", async () => {
    const a = await makeDevice("v-sp2", "devA", { "工作筆記.md": "工作內容\n" });
    const b = await makeDevice("v-sp2", "devB");
    await until(() => content(b, "工作筆記.md") === "工作內容\n", "B 先拿到預設空間內容");

    const spaceId = a.manager.createSpace("工作");
    await a.manager.moveNoteToSpace("工作筆記.md", spaceId);

    await until(() => b.manager.spaceOfNote("工作筆記.md") === spaceId, "B 收斂到新空間歸屬");
    expect(content(b, "工作筆記.md")).toBe("工作內容\n"); // 用新空間金鑰仍解得出
    expect(b.manager.listSpaces().some((s) => s.id === spaceId && s.name === "工作")).toBe(true);
    // A 端內容不變,歸屬為新空間
    expect(a.manager.spaceOfNote("工作筆記.md")).toBe(spaceId);
    expect(content(a, "工作筆記.md")).toBe("工作內容\n");
  });

  it("後加入的裝置:移動之後才連線,仍 bootstrap 出該空間的筆記", async () => {
    const a = await makeDevice("v-sp3", "devA", { "機密.md": "機密內容\n" });
    const b = await makeDevice("v-sp3", "devB");
    await until(() => content(b, "機密.md") === "機密內容\n", "B 先確保 A 已上線並推送");

    const spaceId = a.manager.createSpace("機要");
    await a.manager.moveNoteToSpace("機密.md", spaceId);
    await until(() => b.manager.spaceOfNote("機密.md") === spaceId, "B 收斂新空間");

    // C 在移動之後才加入
    const c = await makeDevice("v-sp3", "devC");
    await until(
      () => content(c, "機密.md") === "機密內容\n" && c.manager.spaceOfNote("機密.md") === spaceId,
      "C bootstrap 出空間筆記內容與歸屬",
    );
  });
});
