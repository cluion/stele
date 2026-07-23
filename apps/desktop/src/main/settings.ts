import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { colorFor } from "./presence-color.ts";
import path from "node:path";

export interface Settings {
  lastVault?: string;
  /** 本機身分:未啟用同步時的留言作者(啟用同步則以 sync.json 的 deviceId 為準,與在場指示一致) */
  deviceId?: string;
  displayName?: string;
}

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/** 讀取設定;首次啟動、壞檔或型別不符一律回空設定,不擋啟動 */
export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const raw = parsed as Record<string, unknown>;
      const out: Settings = {};
      if (typeof raw["lastVault"] === "string") out.lastVault = raw["lastVault"];
      if (typeof raw["deviceId"] === "string") out.deviceId = raw["deviceId"];
      if (typeof raw["displayName"] === "string") out.displayName = raw["displayName"];
      return out;
    }
  } catch {
    /* 沒有設定檔就是全新狀態 */
  }
  return {};
}

/** 合併寫入:呼叫端只給要改的欄位,其餘保留(避免存 lastVault 時洗掉本機身分) */
export function saveSettings(patch: Settings): void {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...patch }, null, 2));
}

/**
 * 本機身分,首次呼叫時配發並寫回設定。
 * 形狀與 SyncManager.identity() 一致(含 color,同一 deviceId 得同色),
 * 兩者都填 renderer 的 CommentIdentity,純本地留言作者才不會缺色。
 */
export function localIdentity(): { deviceId: string; name: string; color: string; memberId: string } {
  const saved = loadSettings();
  const deviceId = saved.deviceId ?? randomUUID();
  if (!saved.deviceId) saveSettings({ deviceId });
  // memberId 為空:純本地/個人 vault 無團隊成員身分,留言作者不可驗(顯示端不標記已驗證)
  return { deviceId, name: saved.displayName ?? `我-${deviceId.slice(0, 4)}`, color: colorFor(deviceId), memberId: "" };
}
