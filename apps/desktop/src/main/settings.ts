import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface Settings {
  lastVault?: string;
}

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/** 讀取設定;首次啟動、壞檔或型別不符一律回空設定,不擋啟動 */
export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const lastVault = (parsed as Record<string, unknown>)["lastVault"];
      if (typeof lastVault === "string") return { lastVault };
    }
  } catch {
    /* 沒有設定檔就是全新狀態 */
  }
  return {};
}

export function saveSettings(settings: Settings): void {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}
