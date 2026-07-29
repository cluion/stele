import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import { MobileVault } from "../src/vault.ts";
import type { VaultStorage } from "../src/storage.ts";

/**
 * 行動端寫入的整合測試:**起真伺服器**、`MobileVault` 接上、`create` 與 `write`
 * 在另一台裝置上驗證收得到。
 *
 * 為什麼非要這一條:新建與寫入原本只有型別與 lint 過,從沒跑過一次真的往返
 * ——UI 走 `window.prompt`,模擬器上無法程式化觸發,截圖驗不到。而這條路徑串起
 * docId 生成、meta 的 LWW map、`track`、加解密與物化,任一環錯了畫面都只是
 * 「還沒同步到」的樣子,是最難用眼睛查的那種錯。
 *
 * 儲存層換成記憶體實作:這裡要驗的是 `MobileVault` 的行為,不是 Capacitor 的
 * 檔案系統(那已在模擬器上驗過,見 plan/p4-4-mobile.md)。介面就是為此存在的。
 */

const TOKEN = "行動端整合-token-1234567890";
const VAULT_ID = "mobile-write";
const PASSPHRASE = "手機上記一筆的通關密語";

/** VaultStorage 的記憶體實作;`notes` 對外可讀,用來驗明文確實落地 */
class MemoryStorage implements VaultStorage {
  readonly notes = new Map<string, string>();
  private readonly states = new Map<string, Uint8Array>();
  private readonly settings = new Map<string, string>();

  listNotes(): Promise<string[]> {
    return Promise.resolve([...this.notes.keys()].sort());
  }
  readNote(rel: string): Promise<string | null> {
    return Promise.resolve(this.notes.get(rel) ?? null);
  }
  writeNote(rel: string, text: string): Promise<void> {
    this.notes.set(rel, text);
    return Promise.resolve();
  }
  deleteNote(rel: string): Promise<void> {
    this.notes.delete(rel);
    return Promise.resolve();
  }
  readState(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.states.get(key) ?? null);
  }
  writeState(key: string, bytes: Uint8Array): Promise<void> {
    this.states.set(key, bytes);
    return Promise.resolve();
  }
  readSetting(key: string): Promise<string | null> {
    return Promise.resolve(this.settings.get(key) ?? null);
  }
  writeSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
    return Promise.resolve();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待逾時:${what}`);
    await sleep(30);
  }
}

interface Device {
  vault: MobileVault;
  storage: MemoryStorage;
  online: () => boolean;
}

describe("行動端寫入:經真伺服器往返", () => {
  let server: RunningServer;
  let store: SyncStore;
  const devices: Device[] = [];
  /** 手機上新建的那一篇;第二個 it 沿用它驗回程 */
  let created: { docId: string; rel: string };

  const body = (extra = ""): string => `# 靈感箱\n\n在手機上記一筆\n${extra}`;

  async function connect(deviceId: string): Promise<Device> {
    const storage = new MemoryStorage();
    let status = "connecting";
    const vault = new MobileVault(storage, { onStatus: (s) => (status = s), onChanged: () => {} }, deviceId);
    // 全域 WebSocket 直接可用(Node 24),與 WebView 走的是同一個介面,不必 polyfill
    await vault.start({ url: `ws://127.0.0.1:${server.port}`, token: TOKEN, vaultId: VAULT_ID, passphrase: PASSPHRASE });
    const device: Device = { vault, storage, online: () => status === "online" };
    devices.push(device);
    return device;
  }

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  }, 20_000);

  afterAll(async () => {
    for (const d of devices) await d.vault.stop();
    await server.close();
    store.close();
  });

  it("手機新建 + 編輯 → 另一台裝置收得到,並以明文落地", async () => {
    // scrypt 2^18 與桌面同一個工作因子,兩台各衍生一次,起手就是一秒級的成本
    const phone = await connect("phone-a");
    const desk = await connect("desk-b");
    await until(() => phone.online() && desk.online(), "兩台裝置上線");

    created = phone.vault.create("靈感箱");
    expect(created.rel).toBe("靈感箱.md"); // 副檔名補齊
    phone.vault.write(created.docId, body());

    await until(() => desk.vault.list().some((i) => i.rel === "靈感箱.md"), "另一台收到路徑對照");
    await until(() => desk.vault.read(created.docId) === body(), "另一台收到內容");
    // 明文 `.md` 落地才算數:那是使用者能從 Files app 拿走的東西
    expect(desk.storage.notes.get("靈感箱.md")).toBe(body());
    expect(phone.storage.notes.get("靈感箱.md")).toBe(body());
  }, 30_000);

  it("另一台裝置的編輯回到手機", async () => {
    const [phone, desk] = devices;
    const next = body("桌面補一行\n");
    desk!.vault.write(created.docId, next);

    await until(() => phone!.storage.notes.get("靈感箱.md") === next, "手機收到桌面的編輯");
    expect(phone!.vault.read(created.docId)).toBe(next);
  }, 15_000);

  it("撞名時開既有那篇,不覆蓋別人的內容", () => {
    const [phone] = devices;
    const before = phone!.vault.read(created.docId);
    const again = phone!.vault.create("靈感箱.md");
    expect(again.docId).toBe(created.docId);
    expect(phone!.vault.read(created.docId)).toBe(before);
  });
});
