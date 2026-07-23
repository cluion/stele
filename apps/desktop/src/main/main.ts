import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { VaultSession, type SessionCallbacks } from "./vault-session.ts";
import { deriveVaultKey, MasterKeySpaces, WrappedKeySpaces, bootstrapTeamKey, createTeamVault, TeamAdminSession, readSpaces } from "@stele/sync";
import type { SocketLike, MemberRole, SpaceKeySource } from "@stele/sync";
import { SyncManager, type SyncSettings } from "./sync-manager.ts";
import { encodeInvite, decodeInvite } from "./team-invite.ts";
import { rotateTeamRoot, rekeyUntilDone } from "./team-rotate.ts";
import { VaultMeta } from "./vault-meta.ts";
import { SpacesService } from "./spaces-service.ts";
import { CommentStore } from "./comment-store.ts";
import { loadOrCreateIdentity } from "./identity-store.ts";
import type { SyncIdentity } from "@stele/sync";
import { SharedSession } from "./shared-session.ts";
import { parseConsumeLink } from "./share-link.ts";
import { loadSettings, saveSettings, localIdentity } from "./settings.ts";

const SMOKE = process.argv.includes("--smoke");
// smoke 固定 zh-TW locale:CI runner 多為 en,navigator.language 會讓 i18n 走英文,
// 令選單/檔名等中文斷言落空;正式執行不設,仍尊重使用者 OS locale
if (SMOKE) app.commandLine.appendSwitch("lang", "zh-TW");
// 開發用:同機多開時各實例獨立 userData(身分 identity.json 在其中;共用會變成同一位成員)
const USER_DATA_OVERRIDE = process.env["STELE_USER_DATA"];
if (USER_DATA_OVERRIDE) app.setPath("userData", path.resolve(USER_DATA_OVERRIDE));
const FIXTURES_VAULT = path.resolve(__dirname, "..", "..", "..", "prototypes", "mirror", "fixtures", "vault");

let session: VaultSession | undefined;
/** vault 的中繼資料 doc 與空間服務:與同步無關,純本地 vault 一樣有 */
let meta: VaultMeta | undefined;
let spaces: SpacesService | undefined;
let comments: CommentStore | undefined;
let syncManager: SyncManager | undefined;
/** app 級成員身分,跨 vault 共用,首次啟用同步時載入並快取 */
let identity: SyncIdentity | undefined;
async function getIdentity(): Promise<SyncIdentity> {
  if (!identity) identity = await loadOrCreateIdentity();
  return identity;
}
let sharedSession: SharedSession | undefined;
const windows = new Set<BrowserWindow>();

/** 送訊息給所有存活的窗 */
function sendAll(channel: string, ...args: unknown[]): void {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

/**
 * 同步設定:個人 vault 的金鑰來自 passphrase→scrypt(E2EE 硬條件);
 * 團隊 vault(vaultType="team")無 passphrase,root 由 bootstrap 經伺服器信封取得,
 * 信任錨 ownerPubSign 隨 sync.json(join 時由邀請 bundle 帶入)。
 */
type LoadedSync =
  | { kind: "personal"; settings: SyncSettings; passphrase: string }
  | { kind: "team"; settings: SyncSettings; ownerPubSign: Uint8Array; role: MemberRole; requireSigned: boolean; enrollmentToken?: string };

const syncFile = (root: string): string => path.join(root, ".stele", "sync.json");

function loadSyncSettings(root: string): LoadedSync | undefined {
  const file = syncFile(root);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const url = raw["url"];
    const token = raw["token"];
    if (typeof url !== "string" || typeof token !== "string") return undefined;

    if (raw["vaultType"] === "team") {
      const ownerPubSign = raw["ownerPubSign"];
      // team vault 的 vaultId 由建立/加入時指定,不自動配發(它是伺服器上共享金鑰的命名空間)
      if (typeof ownerPubSign !== "string" || typeof raw["vaultId"] !== "string") {
        console.error("team sync.json 缺 ownerPubSign 或 vaultId,同步停用");
        return undefined;
      }
      let changed = false;
      if (typeof raw["deviceId"] !== "string") {
        raw["deviceId"] = randomUUID();
        changed = true;
      }
      if (changed) writeFileSync(file, JSON.stringify(raw, null, 2));
      const settings: SyncSettings = { url, token, vaultId: raw["vaultId"], deviceId: raw["deviceId"] as string };
      if (typeof raw["displayName"] === "string") settings.displayName = raw["displayName"];
      const enrollmentToken = typeof raw["enrollmentToken"] === "string" ? raw["enrollmentToken"] : undefined;
      // 本人角色(供 renderer 收斂 viewer UI);owner 管理面走 memberList 取權威角色。舊檔缺 → viewer
      const role: MemberRole = raw["role"] === "owner" ? "owner" : raw["role"] === "editor" ? "editor" : "viewer";
      // 強制簽章模式(P4 §7.3):持久化上次驗過的政策,重開即先套用(bootstrap 會以當代政策覆蓋);
      // 惡意伺服器抑制政策下發時,成員仍守住上次已知的強制態(縱深)
      const requireSigned = raw["requireSigned"] === true;
      return { kind: "team", settings, ownerPubSign: new Uint8Array(Buffer.from(ownerPubSign, "base64")), role, requireSigned, enrollmentToken };
    }

    const passphrase = raw["passphrase"];
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      console.error("sync.json 缺 passphrase:E2EE 為必要條件,同步停用");
      return undefined;
    }
    let changed = false;
    if (typeof raw["vaultId"] !== "string") {
      raw["vaultId"] = randomUUID();
      changed = true;
    }
    if (typeof raw["deviceId"] !== "string") {
      raw["deviceId"] = randomUUID();
      changed = true;
    }
    if (changed) writeFileSync(file, JSON.stringify(raw, null, 2));
    const settings: SyncSettings = { url, token, vaultId: raw["vaultId"] as string, deviceId: raw["deviceId"] as string };
    if (typeof raw["displayName"] === "string") settings.displayName = raw["displayName"];
    return { kind: "personal", settings, passphrase };
  } catch {
    return undefined;
  }
}

/** 目前 team vault 的執行態(供 owner 管理 IPC 與 pending 重試);切 vault 時重設。epoch = 當前金鑰紀元 */
let teamRuntime:
  | { settings: SyncSettings; ownerPubSign: Uint8Array; role: MemberRole; requireSigned: boolean; root: Uint8Array | undefined; epoch: number }
  | undefined;
/** 成員端收 keyRotated 後重試 bootstrap 的計時器;切 vault 時清除 */
let rotateRetryTimer: NodeJS.Timeout | undefined;

/** 輪換 commit 後、重加密完成前的崩潰復原標記(owner 端;rekey 全冪等,重啟見標記即續跑) */
const rekeyMarkerFile = (vaultRoot: string): string => path.join(vaultRoot, ".stele", "rekey-pending.json");

/** 建 socket:與 SyncManager 給 SyncClient 的同形,供 bootstrap/admin 對伺服器握手 */
const createTeamSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

/** 我是不是此 team vault 的 owner(pubSign == 信任錨);owner 才給管理 IPC */
async function isTeamOwner(): Promise<boolean> {
  if (!teamRuntime) return false;
  const me = await getIdentity();
  return Buffer.from(me.pubSign).equals(Buffer.from(teamRuntime.ownerPubSign));
}

/** 把驗證過的角色(owner 簽章憑證,§9.5)寫回 sync.json,離線重開也顯示對的角色 */
function persistVerifiedRole(root: string, role: MemberRole): void {
  const file = syncFile(root);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (raw["role"] === role) return;
    raw["role"] = role;
    writeFileSync(file, JSON.stringify(raw, null, 2));
  } catch (err) {
    console.error("寫回驗證角色失敗:", err);
  }
}

/** 把驗證過的強制簽章態(owner 簽章政策,§7.3)寫回 sync.json,離線重開先套用 */
function persistRequireSigned(root: string, requireSigned: boolean): void {
  const file = syncFile(root);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (raw["requireSigned"] === requireSigned) return;
    raw["requireSigned"] = requireSigned;
    writeFileSync(file, JSON.stringify(raw, null, 2));
  } catch (err) {
    console.error("寫回強制簽章態失敗:", err);
  }
}

/** 首次 enroll 後把已消耗的一次性邀請碼從 sync.json 移除 */
function clearEnrollmentToken(root: string): void {
  const file = syncFile(root);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (raw["enrollmentToken"] === undefined) return;
    delete raw["enrollmentToken"];
    writeFileSync(file, JSON.stringify(raw, null, 2));
  } catch (err) {
    console.error("清除邀請碼失敗:", err);
  }
}

/** 協作顯示名預設值:OS 使用者名(取不到就留空,fallback 回「訪客-xxxx」) */
function defaultDisplayName(): string | undefined {
  try {
    const name = userInfo().username.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/** 把設定物件寫入某 vault 的 .stele/sync.json(建立/加入 team vault 用) */
function writeSyncConfig(root: string, config: Record<string, unknown>): void {
  const file = syncFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
}

/** 成員 pubWrap 的人類可核對指紋(safety number 式):SHA-256 前 16 hex 分四組 */
function fingerprintOf(pub: Uint8Array): string {
  const h = createHash("sha256").update(pub).digest("hex");
  return (h.slice(0, 16).match(/.{4}/g) ?? []).join(" ");
}

function broadcastSyncStatus(status: string): void {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send("sync:status", status);
  }
}

const callbacks: SessionCallbacks = {
  broadcastDoc(rel, update) {
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send("doc:update", rel, update);
    }
  },
  notifyIndexUpdated() {
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send("index:updated");
    }
  },
  async trash(absPath) {
    try {
      await shell.trashItem(absPath);
    } catch (err) {
      console.warn(`回收桶不可用,改為永久刪除 ${absPath}:`, err);
      rmSync(absPath);
    }
  },
};

function requireSession(): VaultSession {
  if (!session) throw new Error("尚未開啟 vault");
  return session;
}

/** pending 成員的背景輪詢計時器:owner 核准後免重開 app 自動就緒;切 vault 時清除 */
let pendingRetryTimer: NodeJS.Timeout | undefined;

/** bootstrap ready 結果落進 teamRuntime(root/epoch/驗證過的角色) */
function adoptTeamBootstrap(next: VaultSession, res: { root: Uint8Array; epoch: number; role?: MemberRole; requireSignedWrites: boolean }): void {
  if (!teamRuntime) return;
  teamRuntime.root = res.root;
  teamRuntime.epoch = res.epoch;
  // 驗過 owner 簽章的角色憑證(§9.5)蓋過 sync.json 的本地宣稱;舊成員未簽發則沿用既有
  if (res.role) {
    teamRuntime.role = res.role;
    persistVerifiedRole(next.root, res.role);
  }
  // 強制簽章政策(§7.3):驗過的當代政策蓋過本地宣稱並持久化(重開先套、抗惡意伺服器抑制)
  teamRuntime.requireSigned = res.requireSignedWrites;
  persistRequireSigned(next.root, res.requireSignedWrites);
}

/** 金鑰就緒後把 SyncManager 接上目前 vault(personal 與 team 共用);含輪換續跑檢查 */
function attachSyncManager(next: VaultSession, settings: SyncSettings, keySource: SpaceKeySource, memberIdentity: SyncIdentity): void {
  if (!meta || !spaces || !comments) return; // vault 生命週期物件尚未就緒(理論上不會發生)
  const onStatus = (status: string): void => {
    broadcastSyncStatus(status);
    // 重連常肇因於角色變更被踢(memberSetRole 即踢線):上線後背景重驗 owner 簽章的角色憑證,
    // 讓降級/升級即時反映到 UI(viewer 唯讀收斂),不必等重開 vault
    if (status === "online" && teamRuntime) void refreshTeamRole(next, memberIdentity);
  };
  syncManager = new SyncManager(next, settings, meta, onStatus, {
    spaces: keySource,
    identity: memberIdentity,
    ownerPubSign: teamRuntime?.ownerPubSign, // 團隊信任錨:啟用逐寫入作者簽驗(P4);個人 vault 為 undefined
    requireSignedWrites: teamRuntime?.requireSigned, // 強制簽章模式(§7.3):拒 unsigned 寫入
    epoch: teamRuntime?.epoch,
    onKeyRotated: teamRuntime ? (epoch) => void handleKeyRotated(epoch) : undefined,
    onRevoked: teamRuntime ? () => handleRevoked(next) : undefined,
    onPresence: (rel, participants) => {
      for (const w of windows) {
        if (!w.isDestroyed()) w.webContents.send("presence:update", rel, participants);
      }
    },
    comments,
  });
  spaces.setSyncHooks(syncManager);
  comments.setSyncHooks(syncManager);
  syncManager.start();
  // 上次輪換 commit 後重加密沒跑完(崩潰/斷線):owner 重啟續跑,rekey 全冪等
  if (teamRuntime && existsSync(rekeyMarkerFile(next.root)) && Buffer.from(memberIdentity.pubSign).equals(Buffer.from(teamRuntime.ownerPubSign))) {
    const manager = syncManager;
    const markerPath = rekeyMarkerFile(next.root);
    void rekeyUntilDone(manager, 3000, 200)
      .then(() => rmSync(markerPath, { force: true }))
      .catch((err: unknown) => console.error("輪換重加密續跑失敗:", err));
  }
  sendAll("team:changed"); // pending→ready 或初次就緒:renderer 刷新 team 狀態(角色、ready)
}

/**
 * 被移出團隊(伺服器踢線或重連被拒):停止一切重試,狀態切 revoked 讓 UI 誠實提示。
 * 本地既有筆記檔案是解密過的明文,密碼學上收不回——只能告知使用者已失去存取,不再同步新內容。
 */
function handleRevoked(next: VaultSession): void {
  if (session !== next) return;
  clearTimeout(rotateRetryTimer);
  clearTimeout(pendingRetryTimer);
  broadcastSyncStatus("revoked");
  sendAll("team:changed");
}

/** 重連上線後重驗本人角色憑證(同紀元;跨紀元交給 keyRotated 自癒):角色有變即更新並通知 UI */
let roleRefreshInFlight = false;
async function refreshTeamRole(next: VaultSession, memberIdentity: SyncIdentity): Promise<void> {
  const rt = teamRuntime;
  if (!rt || rt.root === undefined || roleRefreshInFlight) return;
  roleRefreshInFlight = true;
  try {
    const res = await bootstrapTeamKey({
      url: rt.settings.url,
      token: rt.settings.token,
      vaultId: rt.settings.vaultId,
      identity: memberIdentity,
      ownerPubSign: rt.ownerPubSign,
      createSocket: createTeamSocket,
    });
    if (session !== next || teamRuntime !== rt) return;
    if (res.status === "ready" && res.epoch === rt.epoch) {
      if (res.role && res.role !== rt.role) {
        rt.role = res.role;
        persistVerifiedRole(next.root, res.role);
        sendAll("team:changed");
      }
      // 強制簽章政策(§7.3)同紀元變更:owner 切換後成員重連即近即時套用(不必等輪換)
      if (res.requireSignedWrites !== rt.requireSigned) {
        rt.requireSigned = res.requireSignedWrites;
        persistRequireSigned(next.root, res.requireSignedWrites);
        syncManager?.setRequireSignedWrites(res.requireSignedWrites);
        sendAll("team:changed");
      }
    }
  } catch (err) {
    console.error("重驗團隊角色失敗:", err);
  } finally {
    roleRefreshInFlight = false;
  }
}

/** pending(已 enroll、等 owner 核准)背景輪詢:每 5 秒重試 bootstrap,核准即自動接上同步 */
function schedulePendingRetry(next: VaultSession, memberIdentity: SyncIdentity): void {
  clearTimeout(pendingRetryTimer);
  pendingRetryTimer = setTimeout(() => void retryPendingBootstrap(next, memberIdentity), 5000);
}

async function retryPendingBootstrap(next: VaultSession, memberIdentity: SyncIdentity): Promise<void> {
  const rt = teamRuntime;
  // 期間切了 vault、或已就緒(其他路徑接上)就收手
  if (session !== next || !rt || rt.root !== undefined || syncManager) return;
  try {
    const res = await bootstrapTeamKey({
      url: rt.settings.url,
      token: rt.settings.token,
      vaultId: rt.settings.vaultId,
      identity: memberIdentity,
      ownerPubSign: rt.ownerPubSign,
      createSocket: createTeamSocket,
    });
    if (session !== next || teamRuntime !== rt || syncManager) return;
    if (res.status === "ready") {
      adoptTeamBootstrap(next, res);
      attachSyncManager(next, rt.settings, new WrappedKeySpaces(res.root, res.spaceKeys, res.restrictedSpaceIds), memberIdentity);
      return;
    }
  } catch (err) {
    console.error("等待核准的重試 bootstrap 失敗:", err);
  }
  schedulePendingRetry(next, memberIdentity);
}

/** 換 vault:先建新 session 再拆舊的,新目錄無效時拋錯、原狀不動 */
async function switchVault(dir: string): Promise<{ vault: string; files: string[] }> {
  const next = new VaultSession(dir, callbacks);
  const prev = session;
  const prevManager = syncManager;
  const prevMeta = meta;
  session = next;
  syncManager = undefined;
  if (prevManager) await prevManager.stop().catch((err: unknown) => console.error("停止同步失敗:", err));
  comments?.stop();
  prevMeta?.stop(); // 同步停妥後才收 meta:順序反了會漏掉最後一批寫入
  if (prev) await prev.destroy();
  // meta、空間與留言先於同步建立:三者在未啟用同步的 vault 也完整可用
  meta = new VaultMeta(next.root);
  spaces = new SpacesService(meta, next, () => sendAll("spaces:changed"));
  comments = new CommentStore(meta, next, (noteDocId, update) => {
    const rel = next.relForDocId(noteDocId);
    if (rel) sendAll("comments:update", rel, update);
  });
  teamRuntime = undefined;
  clearTimeout(rotateRetryTimer);
  clearTimeout(pendingRetryTimer);
  const loaded = SMOKE ? undefined : loadSyncSettings(next.root);
  if (loaded) {
    const memberIdentity = await getIdentity();
    if (loaded.kind === "personal") {
      attachSyncManager(next, loaded.settings, new MasterKeySpaces(await deriveVaultKey(loaded.passphrase, loaded.settings.vaultId)), memberIdentity);
    } else {
      // team:先跑獨立 bootstrap 拿 root(避開 SyncClient authOk 立即解 vault-meta 的死結)
      teamRuntime = { settings: loaded.settings, ownerPubSign: loaded.ownerPubSign, role: loaded.role, requireSigned: loaded.requireSigned, root: undefined, epoch: 0 };
      try {
        const res = await bootstrapTeamKey({
          url: loaded.settings.url,
          token: loaded.settings.token,
          vaultId: loaded.settings.vaultId,
          identity: memberIdentity,
          ownerPubSign: loaded.ownerPubSign,
          enrollmentToken: loaded.enrollmentToken,
          createSocket: createTeamSocket,
        });
        // 首次以邀請碼 enroll 後,碼已被伺服器消耗;清出 sync.json(單次、留著無益)
        if (loaded.enrollmentToken) clearEnrollmentToken(next.root);
        if (res.status === "ready") {
          adoptTeamBootstrap(next, res);
          attachSyncManager(next, loaded.settings, new WrappedKeySpaces(res.root, res.spaceKeys, res.restrictedSpaceIds), memberIdentity);
        } else {
          // pending:owner 尚未包 root 給我。不 start sync、不碰 vault-meta;背景輪詢,核准後免重開自動就緒
          broadcastSyncStatus("pending");
          schedulePendingRetry(next, memberIdentity);
        }
      } catch (err) {
        console.error("團隊金鑰 bootstrap 失敗:", err);
        broadcastSyncStatus("error");
      }
    }
  } else {
    broadcastSyncStatus("off");
  }
  if (!SMOKE) {
    try {
      saveSettings({ lastVault: next.root });
    } catch (err) {
      console.error("設定寫入失敗:", err);
    }
  }
  return next.list();
}

/** 啟動時的 vault 決定順序:smoke 固定 fixtures → STELE_VAULT(開發 override)→ 上次開啟 → 無(歡迎畫面) */
function initialVaultDir(): string | undefined {
  if (SMOKE) return FIXTURES_VAULT;
  const env = process.env["STELE_VAULT"];
  if (env) return path.resolve(env);
  const { lastVault } = loadSettings();
  if (lastVault && existsSync(lastVault) && statSync(lastVault).isDirectory()) return lastVault;
  return undefined;
}

ipcMain.handle("vault:list", () => session?.list() ?? null);

ipcMain.handle("sync:status", () => {
  if (syncManager) return syncManager.status;
  // team vault 已認證但 owner 尚未包 root 給我:pending(初次查詢也要反映,不只靠 switchVault 廣播)
  if (teamRuntime && teamRuntime.root === undefined) return "pending";
  return "off";
});

ipcMain.on("presence:active", (_e, rel: unknown) => {
  syncManager?.setActiveNote(typeof rel === "string" ? rel : undefined);
});

ipcMain.on("presence:cursor", (_e, rel: unknown, cursor: unknown) => {
  if (typeof rel !== "string") return;
  syncManager?.setCursor(rel, cursor && typeof cursor === "object" ? { cur: cursor } : null);
});

ipcMain.handle("share:create", (_e, rel: unknown, permission: unknown) => {
  if (!syncManager) throw new Error("同步未啟用,無法建立分享");
  if (typeof rel !== "string") throw new Error("非法 rel");
  return syncManager.createShareLink(rel, permission === "write" ? "write" : "read");
});

ipcMain.handle("share:list", () => syncManager?.listShares() ?? []);

ipcMain.handle("share:revoke", (_e, shareId: unknown) => {
  if (!syncManager || typeof shareId !== "string") throw new Error("非法請求");
  return syncManager.revokeShare(shareId);
});

async function closeSharedSession(): Promise<void> {
  const s = sharedSession;
  sharedSession = undefined;
  if (s) await s.close().catch((err: unknown) => console.error("關閉共享 session 失敗:", err));
}

// 消費可編輯/唯讀分享連結:貼上完整連結 → 臨時協作 session(金鑰留 main,不進 renderer)
ipcMain.handle("shared:consume", async (_e, url: unknown): Promise<{ ok: boolean; error?: string }> => {
  const link = typeof url === "string" ? parseConsumeLink(url) : undefined;
  if (!link) return { ok: false, error: "bad-link" };
  await closeSharedSession();
  sharedSession = new SharedSession(link, {
    onStatus: (s) => sendAll("shared:status", s),
    onPermission: (p) => sendAll("shared:permission", p),
    onSynced: () => sendAll("shared:synced"),
    onClosed: (code) => sendAll("shared:closed", code),
    broadcast: (update) => sendAll("shared:update", update),
  });
  sharedSession.start();
  return { ok: true };
});

ipcMain.handle("shared:open", () => sharedSession?.snapshot() ?? null);

ipcMain.on("shared:push", (_e, update: unknown) => {
  if (update instanceof Uint8Array) sharedSession?.applyFromRenderer(update);
});

ipcMain.handle("shared:close", () => closeSharedSession());

ipcMain.handle("comments:open", (_e, rel: unknown) => {
  if (!comments || typeof rel !== "string") return null;
  // 有同步時沿用同步身分,與在場指示同一個 deviceId;純本地則用本機身分
  return { snapshot: comments.open(rel), me: syncManager?.identity() ?? localIdentity() };
});

ipcMain.on("comments:push", (_e, rel: unknown, update: unknown) => {
  if (comments && typeof rel === "string" && update instanceof Uint8Array) comments.push(rel, update);
});

ipcMain.handle("spaces:overview", () => {
  const overview = spaces?.overview();
  if (!overview) return null;
  // 名單外成員完全看不到受限空間:雖然空間登記在共享 meta 裡人人可讀,呈現層不揭露無權空間與其筆記
  const hidden = syncManager?.inaccessibleSpaceIds() ?? new Set<string>();
  if (hidden.size === 0) return overview;
  const assignments: Record<string, string> = {};
  for (const [rel, spaceId] of Object.entries(overview.assignments)) {
    if (!hidden.has(spaceId)) assignments[rel] = spaceId;
  }
  return { spaces: overview.spaces.filter((s) => !hidden.has(s.id)), assignments };
});

ipcMain.handle("spaces:create", (_e, name: unknown, color: unknown) => {
  if (!spaces || typeof name !== "string" || name.trim().length === 0) throw new Error("非法請求");
  return spaces.createSpace(name.trim(), typeof color === "string" ? color : undefined);
});

ipcMain.handle("spaces:rename", (_e, spaceId: unknown, name: unknown) => {
  if (!spaces || typeof spaceId !== "string" || typeof name !== "string" || name.trim().length === 0) {
    throw new Error("非法請求");
  }
  spaces.renameSpace(spaceId, name.trim());
});

ipcMain.handle("spaces:move", (_e, rel: unknown, spaceId: unknown) => {
  if (!spaces || typeof rel !== "string" || typeof spaceId !== "string") throw new Error("非法請求");
  return spaces.moveNoteToSpace(rel, spaceId);
});

ipcMain.handle("spaces:copy", (_e, rel: unknown, spaceId: unknown) => {
  if (!spaces || typeof rel !== "string" || typeof spaceId !== "string") throw new Error("非法請求");
  return spaces.copyNoteToSpace(rel, spaceId);
});

ipcMain.handle("spaces:audit", () => spaces?.readAudit() ?? []);

/**
 * 設定空間成員子集(team vault、owner 限定):寫入 meta 名單後立刻輪換金鑰——
 * 新空間金鑰只包給名單內成員,名單外成員從此(前向)解不開該空間內容。null = 恢復開放全團隊。
 */
ipcMain.handle("spaces:setMembers", async (_e, spaceId: unknown, memberIds: unknown) => {
  if (typeof spaceId !== "string") throw new Error("非法請求");
  if (memberIds !== null && !(Array.isArray(memberIds) && memberIds.every((m) => typeof m === "string"))) {
    throw new Error("非法請求");
  }
  if (!(await isTeamOwner()) || !spaces) throw new Error("非團隊擁有者");
  spaces.setSpaceMembers(spaceId, memberIds === null ? undefined : memberIds);
  // 名單只是意圖,輪換才是密碼層生效點;輪換失敗回報 UI,名單保留、可按「輪換金鑰」重試
  return rotateNow();
});

// ── 團隊(2b):建立/加入/邀請/核准/移除。owner 管理走短命 TeamAdminSession,不動 doc 同步連線 ──

/**
 * 成員端收到 keyRotated(或重連發現 epoch 落後):SyncClient 已暫停推送,
 * 重跑 bootstrap 取新 epoch 的 root → rotateRoot 收斂(換金鑰 + 全量 repull)。
 * 信封未到(理論上 owner 在 commit 前已推好,此為網路容錯)→ 稍後重試。
 */
async function handleKeyRotated(epoch: number): Promise<void> {
  const rt = teamRuntime;
  const manager = syncManager;
  if (!rt || !manager || rt.epoch >= epoch) return; // owner 自己發起的輪換已就地處理
  try {
    const me = await getIdentity();
    const res = await bootstrapTeamKey({
      url: rt.settings.url,
      token: rt.settings.token,
      vaultId: rt.settings.vaultId,
      identity: me,
      ownerPubSign: rt.ownerPubSign,
      createSocket: createTeamSocket,
    });
    if (teamRuntime !== rt || syncManager !== manager) return; // 期間切了 vault,作廢
    if (res.status === "ready" && res.epoch >= epoch) {
      rt.root = res.root;
      rt.epoch = res.epoch;
      if (res.role) rt.role = res.role; // 輪換重簽的角色憑證(§9.5)一併帶回
      // 強制簽章政策(§7.3)綁 epoch,輪換重簽:以新代政策熱更新,並持久化
      rt.requireSigned = res.requireSignedWrites;
      if (session) persistRequireSigned(session.root, res.requireSignedWrites);
      manager.setRequireSignedWrites(res.requireSignedWrites);
      await manager.rotateRoot(res.root, res.epoch, true, res.spaceKeys, res.restrictedSpaceIds); // 受限空間金鑰與受限清單整組換到位
      // 空間存取可能變了(獲授權補物化、失授權移檔並隱藏空間):通知 renderer 重載側欄空間與檔案清單
      sendAll("spaces:changed");
      sendAll("index:updated");
      return;
    }
  } catch (err) {
    console.error("金鑰輪換後重新 bootstrap 失敗:", err);
  }
  clearTimeout(rotateRetryTimer);
  rotateRetryTimer = setTimeout(() => void handleKeyRotated(epoch), 5000);
}

/**
 * owner 端輪換(移除成員後自動觸發,或手動重試):換 newRoot、重包留任成員、commit、重加密全部 docs。
 * 失敗回 rotated:false 與原因;commit 前失敗不留半套狀態,commit 後的 rekey 中斷由 marker 續跑。
 */
async function rotateNow(): Promise<{ rotated: boolean; error?: string }> {
  const rt = teamRuntime;
  const manager = syncManager;
  if (!rt?.root || !manager) return { rotated: false, error: "尚未取得團隊金鑰或同步未啟用" };
  const markerPath = rekeyMarkerFile(requireSession().root);
  try {
    const me = await getIdentity();
    // 受限空間名單來自 vault-meta:每次輪換都對每個受限空間生新金鑰、只包給名單內成員
    const restrictedSpaces = meta
      ? readSpaces(meta.doc)
          .filter((s) => s.members !== undefined)
          .map((s) => ({ spaceId: s.id, memberIds: s.members! }))
      : [];
    await rotateTeamRoot({
      admin: { ...rt.settings, identity: me, createSocket: createTeamSocket },
      currentEpoch: rt.epoch,
      target: manager,
      restrictedSpaces,
      requireSignedWrites: rt.requireSigned, // 強制簽章政策綁 epoch,開啟態須隨輪換以新 epoch 重簽(§7.3)
      onCommitted: (root, epoch) => {
        // commit 即不可回頭:先落 crash marker 再前移執行態,rekey 中斷也能重啟續跑
        try {
          writeFileSync(markerPath, JSON.stringify({ epoch, at: Date.now() }));
        } catch (err) {
          console.error("輪換標記落盤失敗:", err);
        }
        rt.root = root;
        rt.epoch = epoch;
      },
    });
    rmSync(markerPath, { force: true });
    return { rotated: true };
  } catch (err) {
    console.error("金鑰輪換失敗:", err);
    return { rotated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 目前 vault 的 team 狀態,供 renderer 決定顯示哪些入口 */
ipcMain.handle("team:info", async () => {
  if (!teamRuntime) return { team: false as const };
  return {
    team: true as const,
    vaultId: teamRuntime.settings.vaultId,
    owner: await isTeamOwner(),
    role: teamRuntime.role, // 本人角色(供 renderer 收斂 viewer UI)
    ready: teamRuntime.root !== undefined, // false = pending(等擁有者授權)
    requireSigned: teamRuntime.requireSigned, // 強制簽章模式(§7.3);owner UI 顯示開關態
  };
});

/** 把目前 vault 轉為 team vault(建立者):生 root、self-wrap、認領 owner,寫 sync.json 後重載 */
ipcMain.handle("team:create", async (_e, url: unknown, token: unknown) => {
  if (typeof url !== "string" || typeof token !== "string" || url.length === 0 || token.length === 0) {
    throw new Error("非法請求:缺 url 或 token");
  }
  const root = requireSession().root;
  const me = await getIdentity();
  const vaultId = randomUUID();
  await createTeamVault({ url, token, vaultId, identity: me, createSocket: createTeamSocket });
  writeSyncConfig(root, {
    url,
    token,
    vaultId,
    vaultType: "team",
    ownerPubSign: Buffer.from(me.pubSign).toString("base64"),
    role: "owner",
    deviceId: randomUUID(),
    displayName: defaultDisplayName(), // 免得協作游標旁都叫「訪客-xxxx」;之後可在 sync.json 改
  });
  await switchVault(root); // 以 team 模式重載:bootstrap 由 self-envelope 復原 root → ready
  return { vaultId };
});

/** 加入 team vault(被邀請者):解析邀請 bundle,寫 sync.json(暫存邀請碼供首次 enroll)後重載 */
ipcMain.handle("team:join", async (_e, inviteText: unknown) => {
  if (typeof inviteText !== "string") throw new Error("非法請求");
  const invite = decodeInvite(inviteText);
  const root = requireSession().root;
  writeSyncConfig(root, {
    url: invite.url,
    token: invite.token,
    vaultId: invite.vaultId,
    vaultType: "team",
    ownerPubSign: invite.ownerPubSign,
    role: invite.role,
    deviceId: randomUUID(),
    enrollmentToken: invite.enrollToken,
    displayName: defaultDisplayName(),
  });
  await switchVault(root);
  return { vaultId: invite.vaultId, ready: teamRuntime?.root !== undefined };
});

/** owner 產生邀請 bundle(含一次性邀請碼 + ownerPubSign 信任錨 + 被邀者角色) */
ipcMain.handle("team:invite", async (_e, role: unknown, ttlSec: unknown) => {
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  const inviteRole: "editor" | "viewer" = role === "editor" ? "editor" : "viewer";
  const me = await getIdentity();
  const ttl = typeof ttlSec === "number" && ttlSec > 0 ? ttlSec : 24 * 60 * 60;
  const admin = await TeamAdminSession.open({ ...teamRuntime.settings, identity: me, createSocket: createTeamSocket });
  try {
    const enrollToken = await admin.inviteToken(ttl, inviteRole);
    return encodeInvite({
      url: teamRuntime.settings.url,
      token: teamRuntime.settings.token,
      vaultId: teamRuntime.settings.vaultId,
      ownerPubSign: Buffer.from(me.pubSign).toString("base64"),
      enrollToken,
      role: inviteRole,
    });
  } finally {
    admin.close();
  }
});

/** owner 列成員(附角色與 pubWrap 指紋,供核准前 out-of-band 核對) */
ipcMain.handle("team:members", async () => {
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  const me = await getIdentity();
  const admin = await TeamAdminSession.open({ ...teamRuntime.settings, identity: me, createSocket: createTeamSocket });
  try {
    return (await admin.members()).map((m) => ({
      memberId: m.memberId,
      fingerprint: fingerprintOf(m.pubWrap),
      role: m.role,
      isOwner: m.memberId === me.memberId,
      approved: m.approved, // false = 已 enroll 但 owner 尚未核准(未持有金鑰信封)
    }));
  } finally {
    admin.close();
  }
});

/** owner 改成員角色(editor/viewer);伺服器會踢對方活躍連線,重連後以新角色生效 */
ipcMain.handle("team:setRole", async (_e, memberId: unknown, role: unknown) => {
  if (typeof memberId !== "string" || (role !== "editor" && role !== "viewer")) throw new Error("非法請求");
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  const me = await getIdentity();
  const admin = await TeamAdminSession.open({ ...teamRuntime.settings, identity: me, createSocket: createTeamSocket });
  try {
    // 成員憑證(P4)綁 pubSign,先查該成員的 pubSign 再改角色 + 重簽 role/member 憑證
    const member = (await admin.members()).find((m) => m.memberId === memberId);
    if (!member) throw new Error("查無此成員");
    await admin.setRole(memberId, member.pubSign, role, teamRuntime.epoch);
  } finally {
    admin.close();
  }
});

/** owner 核准某成員:以 root 包給他(呼叫端 UI 應先讓 owner 核對指紋) */
ipcMain.handle("team:approve", async (_e, memberId: unknown) => {
  if (typeof memberId !== "string") throw new Error("非法請求");
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  if (!teamRuntime.root) throw new Error("尚未取得團隊金鑰,無法核准");
  const me = await getIdentity();
  const admin = await TeamAdminSession.open({ ...teamRuntime.settings, identity: me, createSocket: createTeamSocket });
  try {
    const member = (await admin.members()).find((m) => m.memberId === memberId);
    if (!member) throw new Error("查無此成員");
    await admin.approve(member, teamRuntime.root, teamRuntime.epoch);
  } finally {
    admin.close();
  }
});

/** owner 移除成員,隨後自動輪換金鑰(密碼層前向保密:被移除者的離線舊 root 從此解不開新內容) */
ipcMain.handle("team:remove", async (_e, memberId: unknown) => {
  if (typeof memberId !== "string") throw new Error("非法請求");
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  const me = await getIdentity();
  const admin = await TeamAdminSession.open({ ...teamRuntime.settings, identity: me, createSocket: createTeamSocket });
  try {
    await admin.remove(memberId);
  } finally {
    admin.close();
  }
  // 移除已生效(網路層隔離);輪換失敗不回滾,回報給 UI 讓 owner 稍後手動重試
  return rotateNow();
});

/** owner 手動輪換金鑰(移除後自動輪換失敗時的重試入口,或例行輪換) */
ipcMain.handle("team:rotate", async () => {
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  return rotateNow();
});

/**
 * owner 開關強制簽章模式(P4 §7.3):簽發綁當前 epoch 的 vault 政策並上傳。
 * 開啟後成員拒收 unsigned 寫入——owner 應在確認全員升級後再開,否則舊 client 的寫入會被擋。
 * 自身執行態一併熱更新並持久化;成員經重連重驗政策(近即時)或下次輪換套用。
 */
ipcMain.handle("team:setRequireSigned", async (_e, enabled: unknown) => {
  if (typeof enabled !== "boolean") throw new Error("非法請求");
  if (!(await isTeamOwner()) || !teamRuntime) throw new Error("非團隊擁有者");
  const rt = teamRuntime;
  const me = await getIdentity();
  const admin = await TeamAdminSession.open({ ...rt.settings, identity: me, createSocket: createTeamSocket });
  try {
    await admin.setRequireSignedWrites(enabled, rt.epoch);
  } finally {
    admin.close();
  }
  rt.requireSigned = enabled;
  if (session) persistRequireSigned(session.root, enabled);
  syncManager?.setRequireSignedWrites(enabled);
  sendAll("team:changed");
  return { requireSigned: enabled };
});

ipcMain.handle("vault:backlinks", (_e, rel: unknown) => {
  if (typeof rel !== "string") throw new Error("非法參數");
  return requireSession().backlinks(rel);
});

ipcMain.handle("vault:graph", () => requireSession().graph());

ipcMain.handle("vault:search", (_e, query: unknown) => requireSession().search(query));

ipcMain.handle("vault:daily", () => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return requireSession().daily(date);
});

ipcMain.handle("doc:open", (_e, rel: unknown) => requireSession().openDoc(rel));

ipcMain.handle("vault:create", (_e, rel: unknown) => requireSession().create(rel));

ipcMain.handle("vault:rename", (_e, oldRel: unknown, next: unknown) => requireSession().rename(oldRel, next));

ipcMain.handle("vault:delete", (_e, rel: unknown) => requireSession().delete(rel));

ipcMain.on("doc:push", (_e, rel: string, update: Uint8Array) => {
  session?.pushUpdate(rel, update);
});

ipcMain.handle("vault:choose", async (e) => {
  const opts = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const dir = result.filePaths[0];
  if (result.canceled || dir === undefined) return null;
  return switchVault(dir);
});

void app.whenReady().then(async () => {
  const dir = initialVaultDir();
  if (dir) {
    try {
      await switchVault(dir);
    } catch (err) {
      console.error(`開啟 vault 失敗 ${dir}:`, err); // 退到歡迎畫面,不擋啟動
    }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Stele",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  await win.loadFile(path.join(__dirname, "index.html"));

  if (SMOKE) {
    try {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // 先清掉前次失敗可能殘留的測試檔,確保每輪獨立
    for (const junk of ["未命名.md", "未命名 2.md", "煙霧改名.md", "煙霧測試新檔.md", "Obsidian.md"]) {
      rmSync(path.join(FIXTURES_VAULT, junk), { force: true });
    }
    rmSync(path.join(FIXTURES_VAULT, ".stele"), { recursive: true, force: true });
    await sleep(1800);
    const mounted = await win.webContents.executeJavaScript(
      `!!document.querySelector("#editor .ProseMirror") && document.querySelector("#editor .ProseMirror").textContent.length > 0`,
    );

    // 模擬真實鍵盤輸入 → 驗證鏡像寫回磁碟,結束後還原 fixture
    const firstFile = path.join(FIXTURES_VAULT, requireSession().list().files[0]!);
    const originalBytes = readFileSync(firstFile, "utf8");
    await win.webContents.executeJavaScript(`document.querySelector("#editor .ProseMirror").focus()`);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ω" });
    await sleep(150);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await sleep(150);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ψ" });
    let mirrored = false;
    for (let waited = 0; waited < 5000 && !mirrored; waited += 200) {
      await sleep(200);
      // Enter 切段:兩字被空行隔開;第二塊可能帶區塊前綴(如標題的「# 」)
      mirrored = /Ω\n\n[^\n]{0,3}Ψ/.test(readFileSync(firstFile, "utf8"));
    }
    await writeFile(firstFile, originalBytes);
    await sleep(300);

    // 反向連結面板:立項.md 被日記 2026-07-15 連到
    let backlinked = false;
    for (let waited = 0; waited < 5000 && !backlinked; waited += 200) {
      await sleep(200);
      backlinked = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".backlinks .file")].some((el) => el.textContent.includes("2026-07-15"))`,
      );
    }

    // 點擊 wikilink → 建立不存在的筆記並跳轉,驗證後清理
    const clickInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(".wikilink");
        if (!el) return { ok: false, editor: document.querySelector("#editor")?.innerHTML?.slice(0, 400) ?? "no-editor" };
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, opts));
        return { ok: true };
      })()`,
    )) as { ok: boolean; editor?: string };
    if (!clickInfo.ok) console.log("SMOKE DEBUG 找不到 .wikilink:", clickInfo.editor);
    let navigated = false;
    for (let waited = 0; waited < 5000 && !navigated; waited += 200) {
      await sleep(200);
      navigated = await win.webContents.executeJavaScript(
        `document.querySelector("#editor .ProseMirror h1")?.textContent === "Obsidian"`,
      );
    }
    const created = path.join(FIXTURES_VAULT, "Obsidian.md");
    const createdOk = existsSync(created);
    if (createdOk) rmSync(created);

    // 快速切換器:Cmd+P → 打「靈感」→ Enter,應切換到 靈感箱.md
    const typeInSwitcher = (text: string) => `(() => {
      const input = document.querySelector(".switcher input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`;
    const pressInSwitcher = (key: string) => `(() => {
      const input = document.querySelector(".switcher input");
      if (!input) return false;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;
    })()`;
    const openSwitcher = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, cancelable: true }))`;
    const activeSidebarText = `document.querySelector(".sidebar button.active")?.textContent ?? ""`;
    // 清單渲染有時序抖動:等預期項目出現在第一位才按 Enter
    const waitSwitcherItem = async (text: string) => {
      for (let waited = 0; waited < 5000; waited += 100) {
        const ready = await win.webContents.executeJavaScript(
          `document.querySelector(".switcher li button")?.textContent.includes(${JSON.stringify(text)}) ?? false`,
        );
        if (ready) return;
        await sleep(100);
      }
    };

    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    const switcherTyped = (await win.webContents.executeJavaScript(typeInSwitcher("靈感"))) as boolean;
    await waitSwitcherItem("靈感箱");
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    let switched = false;
    for (let waited = 0; waited < 5000 && !switched; waited += 200) {
      await sleep(200);
      switched = ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "靈感箱";
    }

    // 快速切換器建檔:查詢無符合 → 末項「建立筆記」→ Enter 建檔並開啟
    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("煙霧測試新檔"));
    await waitSwitcherItem("煙霧測試新檔");
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    const smokeNote = path.join(FIXTURES_VAULT, "煙霧測試新檔.md");
    let switcherCreated = false;
    for (let waited = 0; waited < 5000 && !switcherCreated; waited += 200) {
      await sleep(200);
      switcherCreated =
        existsSync(smokeNote) &&
        ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "煙霧測試新檔";
    }
    if (existsSync(smokeNote)) rmSync(smokeNote);

    // 源碼模式:切到 靈感箱 → Cmd+E 掛 CodeMirror → 打字鏡像到磁碟 → Cmd+E 切回 WYSIWYG
    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("靈感"));
    await waitSwitcherItem("靈感箱");
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    await sleep(400);
    const toggleMode = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, cancelable: true }))`;
    await win.webContents.executeJavaScript(toggleMode);
    let cmMounted = false;
    for (let waited = 0; waited < 5000 && !cmMounted; waited += 200) {
      await sleep(200);
      cmMounted = await win.webContents.executeJavaScript(
        `!!document.querySelector("#editor .cm-editor") && document.querySelector("#editor .cm-content").textContent.length > 0`,
      );
    }
    const inspFile = path.join(FIXTURES_VAULT, "靈感箱.md");
    const inspBytes = readFileSync(inspFile, "utf8");
    await win.webContents.executeJavaScript(`document.querySelector("#editor .cm-content").focus()`);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ψ" });
    let cmMirrored = false;
    for (let waited = 0; waited < 5000 && !cmMirrored; waited += 200) {
      await sleep(200);
      cmMirrored = readFileSync(inspFile, "utf8").includes("Ψ");
    }
    await writeFile(inspFile, inspBytes);
    await sleep(300);
    await win.webContents.executeJavaScript(toggleMode);
    let pmBack = false;
    for (let waited = 0; waited < 5000 && !pmBack; waited += 200) {
      await sleep(200);
      pmBack = await win.webContents.executeJavaScript(`!!document.querySelector("#editor .ProseMirror")`);
    }
    const sourceMode = cmMounted && cmMirrored && pmBack;

    // 關聯圖:Cmd+G 開啟 → canvas 掛載且節點數=筆記數 → Esc 關閉回編輯器
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", metaKey: true, cancelable: true }))`,
    );
    let graphShown = false;
    const expectedNodes = requireSession().list().files.length;
    for (let waited = 0; waited < 5000 && !graphShown; waited += 200) {
      await sleep(200);
      graphShown = await win.webContents.executeJavaScript(
        `!!document.querySelector(".graph canvas") && document.querySelector(".graph")?.dataset.nodeCount === "${expectedNodes}"`,
      );
    }
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))`,
    );
    await sleep(300);
    const graphClosed = await win.webContents.executeJavaScript(
      `!document.querySelector(".graph") && !!document.querySelector("#editor")`,
    );
    const graphOk = graphShown && graphClosed;

    // 每日筆記:Cmd+D → 建立並開啟今天的日記,驗證後清理
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, cancelable: true }))`,
    );
    const dailyFile = path.join(FIXTURES_VAULT, "日記", `${todayStr}.md`);
    let dailyOk = false;
    for (let waited = 0; waited < 5000 && !dailyOk; waited += 200) {
      await sleep(200);
      dailyOk =
        existsSync(dailyFile) &&
        readFileSync(dailyFile, "utf8").startsWith(`# ${todayStr}`) &&
        ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === `日記/${todayStr}`;
    }
    if (existsSync(dailyFile)) rmSync(dailyFile);

    // [[ 自動完成:先明確切到立項筆記(前一個測試可能停在已刪除的每日筆記上)
    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("立項"));
    await waitSwitcherItem("立項");
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    await sleep(400);
    const acFile = path.join(FIXTURES_VAULT, "專案", "Stele", "立項.md");
    const acBytes = readFileSync(acFile, "utf8");
    await win.webContents.executeJavaScript(`document.querySelector("#editor .ProseMirror").focus()`);
    win.webContents.sendInputEvent({ type: "char", keyCode: "[" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "[" });
    let suggestShown = false;
    for (let waited = 0; waited < 5000 && !suggestShown; waited += 200) {
      await sleep(200);
      suggestShown = await win.webContents.executeJavaScript(
        `document.querySelectorAll(".wikilink-suggest button").length > 0`,
      );
    }
    await win.webContents.executeJavaScript(
      `document.querySelector("#editor .ProseMirror").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`,
    );
    let suggestInserted = false;
    for (let waited = 0; waited < 5000 && !suggestInserted; waited += 200) {
      await sleep(200);
      suggestInserted = await win.webContents.executeJavaScript(
        `document.querySelectorAll("#editor .ProseMirror .wikilink").length > 0 && !document.querySelector(".wikilink-suggest")`,
      );
    }
    await sleep(300);
    await writeFile(acFile, acBytes);
    await sleep(400);
    const autocompleteOk = suggestShown && suggestInserted;

    // 右鍵選單:側欄 contextmenu → 新增筆記 → 未命名.md 建立並開啟,驗證後清理
    await win.webContents.executeJavaScript(
      `document.querySelector(".sidebar").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 300 }))`,
    );
    await sleep(200);
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll(".context-menu button")][0]?.click()`,
    );
    const untitled = path.join(FIXTURES_VAULT, "未命名.md");
    let contextCreated = false;
    for (let waited = 0; waited < 5000 && !contextCreated; waited += 200) {
      await sleep(200);
      contextCreated =
        existsSync(untitled) &&
        ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "未命名";
    }

    // 側欄項目是非同步刷新的:等按鈕出現再右鍵,否則 null.dispatchEvent 會讓整個自測懸空
    const contextMenuOn = async (rel: string): Promise<boolean> => {
      const selector = `.sidebar button[data-rel=${JSON.stringify(rel)}]`;
      for (let waited = 0; waited < 5000; waited += 200) {
        const ok = await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 300 }));
            return true;
          })()`,
        );
        if (ok) return true;
        await sleep(200);
      }
      return false;
    };

    // 改名:右鍵未命名 → 重新命名 → 改「煙霧改名」→ 檔案搬移
    await contextMenuOn("未命名.md");
    await sleep(200);
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll(".context-menu button")].find((b) => b.textContent === "重新命名")?.click()`,
    );
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("煙霧改名"));
    await sleep(200);
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    const renamed = path.join(FIXTURES_VAULT, "煙霧改名.md");
    let renameOk = false;
    for (let waited = 0; waited < 5000 && !renameOk; waited += 200) {
      await sleep(200);
      renameOk = existsSync(renamed) && !existsSync(untitled);
    }

    // 刪除:右鍵煙霧改名 → 刪除筆記(confirm 直接放行)→ 檔案消失
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined`);
    await contextMenuOn("煙霧改名.md");
    await sleep(200);
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll(".context-menu button")].find((b) => b.textContent === "刪除筆記")?.click()`,
    );
    let deleteOk = false;
    for (let waited = 0; waited < 5000 && !deleteOk; waited += 200) {
      await sleep(200);
      deleteOk = !existsSync(renamed);
    }
    if (existsSync(renamed)) rmSync(renamed);
    if (existsSync(untitled)) rmSync(untitled);

    // 分享連結 UI:右鍵 → 建立分享連結 → 對話框開啟。fixture 無同步,建立走錯誤路徑,再 Esc 關閉
    let shareUiOk = false;
    {
      const opened = await contextMenuOn("靈感箱.md");
      await sleep(200);
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".context-menu button")].find((b) => b.textContent === "建立分享連結")?.click()`,
      );
      let dialogShown = false;
      for (let waited = 0; waited < 5000 && !dialogShown; waited += 200) {
        await sleep(200);
        // 無同步時清單為空,對話框應顯示「尚無連結」提示
        dialogShown = await win.webContents.executeJavaScript(
          `!!document.querySelector(".switcher.share") && !!document.querySelector(".switcher.share .placeholder")`,
        );
      }
      await win.webContents.executeJavaScript(`document.querySelector(".switcher.share button.create")?.click()`);
      let errorShown = false;
      for (let waited = 0; waited < 5000 && !errorShown; waited += 200) {
        await sleep(200);
        errorShown = await win.webContents.executeJavaScript(`!!document.querySelector(".switcher.share .error")`);
      }
      await win.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))`,
      );
      await sleep(300);
      const closed = await win.webContents.executeJavaScript(`!document.querySelector(".switcher.share")`);
      shareUiOk = opened && dialogShown && errorShown && closed;
    }

    // 消費分享連結 UI:點側欄「開啟分享連結」→ 貼無效連結 → 顯示錯誤 → Esc 關閉(不需伺服器)
    let consumeUiOk = false;
    {
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".vault-header button")].find((b) => b.getAttribute("aria-label") === "開啟分享連結")?.click()`,
      );
      let dialogShown = false;
      for (let waited = 0; waited < 5000 && !dialogShown; waited += 200) {
        await sleep(200);
        dialogShown = await win.webContents.executeJavaScript(`!!document.querySelector(".switcher.consume input")`);
      }
      await win.webContents.executeJavaScript(typeInSwitcher("不是分享連結"));
      await sleep(100);
      await win.webContents.executeJavaScript(`document.querySelector(".switcher.consume button.primary")?.click()`);
      let errorShown = false;
      for (let waited = 0; waited < 5000 && !errorShown; waited += 200) {
        await sleep(200);
        errorShown = await win.webContents.executeJavaScript(`!!document.querySelector(".switcher.consume .error")`);
      }
      await win.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))`,
      );
      await sleep(300);
      const closed = await win.webContents.executeJavaScript(`!document.querySelector(".switcher.consume")`);
      consumeUiOk = dialogShown && errorShown && closed;
    }

    // 留言面板:點編輯器 💬 鈕開面板 → 面板掛載(無同步時為空狀態)→ 關閉
    let commentsUiOk = false;
    {
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".mode-toggle")].find((b) => b.getAttribute("aria-label") === "留言")?.click()`,
      );
      let panelShown = false;
      for (let waited = 0; waited < 5000 && !panelShown; waited += 200) {
        await sleep(200);
        panelShown = await win.webContents.executeJavaScript(
          `!!document.querySelector(".comments-panel") && !!document.querySelector(".comments-compose textarea")`,
        );
      }
      await win.webContents.executeJavaScript(`document.querySelector(".comments-close")?.click()`);
      await sleep(300);
      const closed = await win.webContents.executeJavaScript(`!document.querySelector(".comments-panel")`);
      commentsUiOk = panelShown && closed;
    }

    // 全文搜尋:Cmd+Shift+F → 中文 bigram 查詢 → Enter 開啟唯一命中
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true, cancelable: true }))`,
    );
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("自研"));
    let searchHit = false;
    for (let waited = 0; waited < 5000 && !searchHit; waited += 200) {
      await sleep(200);
      searchHit = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".switcher.search .file")].some((el) => el.textContent.includes("立項"))`,
      );
    }
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    let searchOpened = false;
    for (let waited = 0; waited < 5000 && !searchOpened; waited += 200) {
      await sleep(200);
      searchOpened = ((await win.webContents.executeJavaScript(activeSidebarText)) as string).includes("立項");
    }
    const searchOk = searchHit && searchOpened;

    // 換 vault:切到臨時 vault 驗證索引與反向連結,再切回 fixtures 確認 session 生滅正常
    const tmpVault = path.join(app.getPath("temp"), "stele-smoke-vault");
    rmSync(tmpVault, { recursive: true, force: true });
    mkdirSync(path.join(tmpVault, "子夾"), { recursive: true });
    writeFileSync(path.join(tmpVault, "唯一.md"), "# 唯一\n");
    writeFileSync(path.join(tmpVault, "子夾", "來源.md"), "連到 [[唯一]]\n");
    let vaultSwitched = false;
    try {
      const tmpList = await switchVault(tmpVault);
      const tmpBacklinks = requireSession().backlinks("唯一.md");
      const backList = await switchVault(FIXTURES_VAULT);
      vaultSwitched =
        tmpList.files.join(",") === "唯一.md,子夾/來源.md" &&
        tmpBacklinks.length === 1 &&
        tmpBacklinks[0]!.file === "子夾/來源.md" &&
        backList.files.length >= 3 &&
        requireSession().backlinks("專案/Stele/立項.md").length >= 1;
    } catch (err) {
      console.error("SMOKE 換 vault 失敗:", err);
    }
    rmSync(tmpVault, { recursive: true, force: true });

    // CRDT 持久化:這輪的編輯應已在 vault 內留下狀態;驗完清掉,fixtures 保持乾淨
    const persistedOk = existsSync(path.join(FIXTURES_VAULT, ".stele", "docs.json"));
    rmSync(path.join(FIXTURES_VAULT, ".stele"), { recursive: true, force: true });

    console.log(mounted ? "SMOKE ✅ 編輯器掛載且有內容" : "SMOKE ❌ 編輯器未就緒");
    console.log(mirrored ? "SMOKE ✅ 鍵盤輸入與 Enter 切段已鏡像到磁碟" : "SMOKE ❌ 輸入未寫回磁碟");
    console.log(navigated && createdOk ? "SMOKE ✅ 點擊 wikilink 建檔並跳轉" : "SMOKE ❌ wikilink 導航失敗");
    console.log(backlinked ? "SMOKE ✅ 反向連結面板顯示來源" : "SMOKE ❌ 反向連結未顯示");
    console.log(switcherTyped && switched ? "SMOKE ✅ Cmd+P 模糊搜尋切換筆記" : "SMOKE ❌ 快速切換器切換失敗");
    console.log(switcherCreated ? "SMOKE ✅ 快速切換器建檔並開啟" : "SMOKE ❌ 快速切換器建檔失敗");
    console.log(sourceMode ? "SMOKE ✅ 源碼模式編輯與雙向切換" : "SMOKE ❌ 源碼模式失敗");
    console.log(graphOk ? "SMOKE ✅ 關聯圖開啟節點數正確且可關閉" : "SMOKE ❌ 關聯圖失敗");
    console.log(dailyOk ? "SMOKE ✅ Cmd+D 建立並開啟每日筆記" : "SMOKE ❌ 每日筆記失敗");
    console.log(searchOk ? "SMOKE ✅ 全文搜尋中文查詢並開啟結果" : "SMOKE ❌ 全文搜尋失敗");
    console.log(autocompleteOk ? "SMOKE ✅ 雙括號自動完成插入 wikilink" : "SMOKE ❌ 自動完成失敗");
    console.log(contextCreated ? "SMOKE ✅ 右鍵選單新增筆記" : "SMOKE ❌ 右鍵新增失敗");
    console.log(renameOk ? "SMOKE ✅ 改名搬移檔案" : "SMOKE ❌ 改名失敗");
    console.log(deleteOk ? "SMOKE ✅ 刪除筆記進回收桶" : "SMOKE ❌ 刪除失敗");
    console.log(shareUiOk ? "SMOKE ✅ 分享對話框開啟建立與關閉" : "SMOKE ❌ 分享 UI 失敗");
    console.log(consumeUiOk ? "SMOKE ✅ 貼上分享連結對話框開啟與錯誤處理" : "SMOKE ❌ 消費分享 UI 失敗");
    console.log(commentsUiOk ? "SMOKE ✅ 留言面板開啟與關閉" : "SMOKE ❌ 留言面板失敗");
    console.log(vaultSwitched ? "SMOKE ✅ 換 vault session 生滅正常" : "SMOKE ❌ 換 vault 失敗");
    console.log(persistedOk ? "SMOKE ✅ CRDT 狀態持久化到 .stele" : "SMOKE ❌ CRDT 狀態未落盤");
    app.exit(
      mounted && mirrored && navigated && createdOk && backlinked && switcherTyped && switched && switcherCreated && sourceMode && graphOk && dailyOk && searchOk && autocompleteOk && contextCreated && renameOk && deleteOk && shareUiOk && consumeUiOk && commentsUiOk && vaultSwitched && persistedOk
        ? 0
        : 1,
    );
    } catch (err) {
      console.error("SMOKE 崩潰:", err);
      app.exit(1);
    }
  }
});

// 退出前 flush 所有未落盤的鏡像;destroy 完成後才真正退出
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !session) return;
  e.preventDefault();
  quitting = true;
  const closing = session;
  const closingManager = syncManager;
  const closingMeta = meta;
  const closingComments = comments;
  session = undefined;
  syncManager = undefined;
  meta = undefined;
  spaces = undefined;
  comments = undefined;
  void (closingManager ? closingManager.stop() : Promise.resolve())
    .catch((err: unknown) => console.error("退出前停止同步失敗:", err))
    .then(() => {
      closingComments?.stop();
      closingMeta?.stop(); // 同步停妥後才收留言與 meta,最後一批寫入才不會漏
    })
    .then(() => closing.destroy())
    .catch((err: unknown) => console.error("退出前 flush 失敗:", err))
    .finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());
