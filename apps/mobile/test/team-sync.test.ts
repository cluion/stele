import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import {
  generateSeed,
  deriveIdentity,
  createTeamVault,
  encodeInvite,
  bytesToBase64,
  TeamAdminSession,
  type SyncIdentity,
} from "@stele/sync";
import { MobileVault, type TeamVaultSettings } from "../src/vault.ts";
import { recordFromInvite, openTeamVault, webSocketFactory } from "../src/join.ts";
import { loadOrCreateIdentity } from "../src/identity.ts";
import type { SecretStore } from "../src/secrets.ts";
import type { VaultStorage } from "../src/storage.ts";

/**
 * 團隊 vault 在手機上的完整鏈路,經**真伺服器**:
 * owner 建 vault → 產邀請碼 → 手機憑碼加入(pending)→ owner 核准 → 手機拿到 root →
 * 在手機上新建筆記並編輯 → owner 端收得到。
 *
 * 這條路徑是整個 Keychain 工作的目的。它要證明的不只是「同步得動」,而是三件更具體的事:
 * 手機的身分來自保管層(不是每次連線臨時生一個)、`pending` 是流程的一站而非錯誤、
 * 以及手機的寫入**帶得出可驗的作者簽章**——驗不過的寫入會被對端 poison-skip 丟掉,
 * 所以 owner 端讀得到內容本身就是簽驗通過的證明。
 */

const TOKEN = "行動端團隊-token-1234567890";
const VAULT_ID = "mobile-team";

class MemorySecrets implements SecretStore {
  private readonly items = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.items.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.items.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.items.delete(key);
    return Promise.resolve();
  }
}

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

describe("行動端團隊 vault:加入、核准、寫入", () => {
  let server: RunningServer;
  let store: SyncStore;
  const vaults: MobileVault[] = [];

  const url = (): string => `ws://127.0.0.1:${server.port}`;

  /** 起一台裝置:身分來自保管層,storage 是記憶體 */
  function device(settings: TeamVaultSettings, deviceId: string): { vault: MobileVault; storage: MemoryStorage; online: () => boolean } {
    const storage = new MemoryStorage();
    let status = "connecting";
    const vault = new MobileVault(storage, { onStatus: (s) => (status = s), onChanged: () => {} }, deviceId);
    vaults.push(vault);
    return { vault, storage, online: () => status === "online" };
  }

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  }, 20_000);

  afterAll(async () => {
    for (const v of vaults) await v.stop();
    await server.close();
    store.close();
  });

  it("憑邀請碼加入 → 等核准 → 拿到 root → 手機寫入,owner 收得到", async () => {
    // ── owner 端(桌面):建團隊 vault,產一張 editor 邀請碼 ──
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId: VAULT_ID, identity: owner, createSocket: webSocketFactory });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId: VAULT_ID, identity: owner, createSocket: webSocketFactory });
    const inviteText = encodeInvite({
      url: url(),
      token: TOKEN,
      vaultId: VAULT_ID,
      ownerPubSign: bytesToBase64(owner.pubSign),
      enrollToken: await admin.inviteToken(3600, "editor"),
      role: "editor",
    });

    // ── 手機端:身分從保管層來(這台裝置的長期金鑰,不是每次連線臨時生的) ──
    const secrets = new MemorySecrets();
    const phoneIdentity: SyncIdentity = await loadOrCreateIdentity(secrets);
    const { record, invite } = recordFromInvite(inviteText);
    expect(record.vaultId).toBe(VAULT_ID);
    expect(record).not.toHaveProperty("enrollToken"); // 一次性碼不落盤

    // 首次憑碼加入:owner 還沒核准 → pending。這是流程的一站,不是錯誤
    const pending = await openTeamVault(record, phoneIdentity, { enrollToken: invite.enrollToken });
    expect(pending.status).toBe("pending");

    // ── owner 核准 ──
    const member = (await admin.members()).find((m) => m.memberId === phoneIdentity.memberId);
    expect(member, "owner 的成員清單裡看得到這台手機").toBeDefined();
    await admin.approve(member!, root);

    // ── 手機重試(這次不帶邀請碼,身分本身就是憑據)→ 拿到 root ──
    const ready = await openTeamVault(record, phoneIdentity);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    expect(ready.role).toBe("editor");
    expect(bytesToBase64(ready.settings.root)).toBe(bytesToBase64(root)); // 與 owner 同一把 root

    // ── 手機連上並記一筆 ──
    const phone = device(ready.settings, "phone-team");
    await phone.vault.start(ready.settings);
    const ownerSettings: TeamVaultSettings = {
      url: url(),
      token: TOKEN,
      vaultId: VAULT_ID,
      identity: owner,
      ownerPubSign: owner.pubSign,
      root,
      epoch: 0,
    };
    const desk = device(ownerSettings, "owner-desk");
    await desk.vault.start(ownerSettings);
    await until(() => phone.online() && desk.online(), "手機與 owner 端上線");

    const t0 = Date.now();
    const created = phone.vault.create("會議記錄");
    const body = "# 會議記錄\n\n在手機上記的\n";
    phone.vault.write(created.docId, body);

    // owner 端讀得到 = 作者簽章驗過了(驗不過的寫入會被丟掉,內容根本不會出現)
    await until(() => desk.storage.notes.get("會議記錄.md") === body, "owner 收到手機寫的筆記");
    expect(desk.vault.read(created.docId)).toBe(body);

    /**
     * 迴歸柵欄:這一段原本要 **5.3 秒**才收斂,原因是 `SyncClient` 的 authOk 處理
     * `await` 成員目錄的回覆,而收訊佇列是嚴格序列的——那則回覆排在自己後面,只能等 5 秒逾時。
     * 團隊 vault 每次連線後的第一筆寫入都慢 5 秒,而且完全靜默。修在 packages/sync 的收訊路徑
     * (目錄回覆插隊),這裡守著它不要再長回來。
     */
    expect(Date.now() - t0).toBeLessThan(3000);

    admin.close();
  }, 30_000);

  it("同一台裝置重開後是同一個成員,不必重新被核准", async () => {
    const secrets = new MemorySecrets();
    const first = await loadOrCreateIdentity(secrets);
    const again = await loadOrCreateIdentity(secrets); // 模擬重開 app:秘密還在保管層裡
    expect(again.memberId).toBe(first.memberId);
  });
});
