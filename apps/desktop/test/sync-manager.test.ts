import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import { deriveVaultKey, VaultCipher } from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";

const TOKEN = "桌面整合-token-1234567890";

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

interface Device {
  dir: string;
  session: VaultSession;
  manager: SyncManager;
}

describe("SyncManager 桌面端對端", () => {
  let server: RunningServer;
  let store: SyncStore;
  const devices: Device[] = [];

  function makeDevice(
    vaultId: string,
    deviceId: string,
    seedFiles: Record<string, string> = {},
    cipher?: VaultCipher,
  ): Device {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-sync-"));
    for (const [rel, content] of Object.entries(seedFiles)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: `ws://127.0.0.1:${server.port}`, token: TOKEN, vaultId, deviceId };
    const manager = new SyncManager(session, settings, undefined, { pushDebounceMs: 20, cipher });
    manager.start();
    const device = { dir, session, manager };
    devices.push(device);
    return device;
  }

  const read = (d: Device, rel: string) => readFileSync(path.join(d.dir, rel), "utf8");
  /** 檔案不存在或內容還在路上都回 undefined,收斂判準一律用內容 */
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

  it("裝置甲的既有筆記物化到裝置乙,編輯即時鏡像到乙的磁碟", async () => {
    const a = makeDevice("v-桌面", "devA", { "筆記.md": "# 筆記\n" });
    const b = makeDevice("v-桌面", "devB");

    await until(() => content(b, "筆記.md") === "# 筆記\n", "乙物化檔案與內容");

    // 甲經 renderer 路徑編輯
    const replica = new Y.Doc();
    Y.applyUpdate(replica, a.session.openDoc("筆記.md"));
    const text = replica.getText("md");
    text.insert(text.length, "甲補一行\n");
    a.session.pushUpdate("筆記.md", Y.encodeStateAsUpdate(replica));

    await until(() => content(b, "筆記.md") === "# 筆記\n甲補一行\n", "乙收到編輯");
  });

  it("甲改名,乙跟著改、doc id 不變、內容保留", async () => {
    const a = makeDevice("v-改名", "devA", { "舊名.md": "# 舊名\n" });
    const b = makeDevice("v-改名", "devB");
    await until(() => content(b, "舊名.md") === "# 舊名\n", "乙物化");

    const idBefore = b.session.peekDocId("舊名.md");
    await a.session.rename("舊名.md", "資料夾/新名");
    await until(() => content(b, "資料夾/新名.md") === "# 舊名\n", "乙套用改名");
    await until(() => !existsSync(path.join(b.dir, "舊名.md")), "乙的舊檔消失");
    expect(b.session.peekDocId("資料夾/新名.md")).toBe(idBefore);
  });

  it("甲刪除,乙的檔案進回收桶", async () => {
    const a = makeDevice("v-刪除", "devA", { "要刪.md": "刪我\n" });
    const b = makeDevice("v-刪除", "devB");
    await until(() => content(b, "要刪.md") === "刪我\n", "乙物化");

    await a.session.delete("要刪.md");
    await until(() => !existsSync(path.join(b.dir, "要刪.md")), "乙套用刪除");
  });

  it("乙離線期間甲的編輯,乙重連後補齊", async () => {
    const a = makeDevice("v-離線桌面", "devA", { "共筆.md": "起頭\n" });
    const b = makeDevice("v-離線桌面", "devB");
    await until(() => content(b, "共筆.md") === "起頭\n", "乙物化");

    await b.manager.stop(); // 乙離線
    const replica = new Y.Doc();
    Y.applyUpdate(replica, a.session.openDoc("共筆.md"));
    replica.getText("md").insert(replica.getText("md").length, "乙不在時寫的\n");
    a.session.pushUpdate("共筆.md", Y.encodeStateAsUpdate(replica));
    await sleep(150);

    // 乙重連(同一顆 session/狀態)
    const settings: SyncSettings = {
      url: `ws://127.0.0.1:${server.port}`,
      token: TOKEN,
      vaultId: "v-離線桌面",
      deviceId: "devB",
    };
    const manager2 = new SyncManager(b.session, settings, undefined, { pushDebounceMs: 20 });
    manager2.start();
    devices.push({ dir: b.dir, session: b.session, manager: manager2 });

    await until(() => read(b, "共筆.md").includes("乙不在時寫的"), "乙補齊離線編輯");
  });

  it("兩台同路徑各自建了不同筆記:衝突退讓,兩份都保留", async () => {
    const a = makeDevice("v-衝突", "devA", { "撞名.md": "甲的內容\n" });
    // 乙在連線前就有自己的同名檔
    const b = makeDevice("v-衝突", "devB", { "撞名.md": "乙的內容\n" });

    const wanted = ["乙的內容\n", "甲的內容\n"];
    const contents = (d: Device) =>
      d.session
        .list()
        .files.map((f) => content(d, f))
        .sort();
    await until(
      () => JSON.stringify(contents(a)) === JSON.stringify(wanted) && JSON.stringify(contents(b)) === JSON.stringify(wanted),
      "兩邊各保留兩份內容",
      10000, // 衝突退讓由哪端執行取決於時序,慢路徑需要多輪 meta 往返
    );
  });

  it("E2EE:兩台密語相同可收斂,伺服器只見密文", async () => {
    const vaultId = "v-加密";
    const cipherA = new VaultCipher(await deriveVaultKey("共同密語 正確馬", vaultId, 12));
    const cipherB = new VaultCipher(await deriveVaultKey("共同密語 正確馬", vaultId, 12));
    const a = makeDevice(vaultId, "devA", { "祕密.md": "極機密內容\n" }, cipherA);
    const b = makeDevice(vaultId, "devB", {}, cipherB);

    await until(() => content(b, "祕密.md") === "極機密內容\n", "乙用同密語解出內容");

    // 伺服器存的每一則 payload 都不含明文
    for (const docId of a.session.allDocIds()) {
      for (const u of store.updatesSince(vaultId, docId, 0)) {
        expect(Buffer.from(u.payload).includes(Buffer.from("極機密內容"))).toBe(false);
      }
    }
  });

  it("E2EE:密語不同解不開,內容不落地", async () => {
    const vaultId = "v-錯密語";
    const cipherA = new VaultCipher(await deriveVaultKey("甲的密語", vaultId, 12));
    const cipherB = new VaultCipher(await deriveVaultKey("乙的不同密語", vaultId, 12));
    const a = makeDevice(vaultId, "devA", { "檔.md": "只有甲讀得到\n" }, cipherA);
    const b = makeDevice(vaultId, "devB", {}, cipherB);

    // 給足時間讓同步嘗試;乙解不開,不該落地任何內容
    await until(() => store.updatesSince(vaultId, a.session.allDocIds()[0]!, 0).length > 0, "甲已上傳");
    await sleep(300);
    expect(b.session.list().files).toHaveLength(0);
  });
});
