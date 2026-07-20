import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { generateSeed, deriveIdentity, exportIdentity, importIdentity, type SyncIdentity, type IdentityFile } from "@stele/sync";

/**
 * 成員身分(app 級、跨 vault 的長期非對稱金鑰)的本機存放。
 *
 * 存 userData 下獨立檔 identity.json——不是 per-vault 的 sync.json、也不是瑣碎偏好的 settings.json,
 * 讓「匯出/備份 = 複製一個檔」最乾淨。首次呼叫自動生成並落盤。
 *
 * MVP 明文存(mode 0600),與現況 sync.json 明文存 passphrase 同級威脅模型;
 * IdentityFile 的 enc 欄位預留未來 OS keychain / passphrase 包裝。
 */

const identityFile = (): string => path.join(app.getPath("userData"), "identity.json");

function readFile(): IdentityFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(identityFile(), "utf8"));
    // importIdentity 會驗格式/長度;不合法就當沒有,由呼叫端重生
    importIdentity(parsed);
    return parsed as IdentityFile;
  } catch {
    return undefined;
  }
}

function writeFile(file: IdentityFile): void {
  mkdirSync(path.dirname(identityFile()), { recursive: true });
  writeFileSync(identityFile(), JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** 載入本機成員身分,首次呼叫時隨機生成並落盤;回傳可簽章的身分 */
export async function loadOrCreateIdentity(): Promise<SyncIdentity> {
  const existing = readFile();
  if (existing) return deriveIdentity(importIdentity(existing));
  const seed = generateSeed();
  const identity = await deriveIdentity(seed);
  writeFile(exportIdentity(seed, identity.memberId));
  return identity;
}

/** 匯出目前身分檔(供跨裝置搬移);沒有身分則回 undefined */
export function exportIdentityFile(): IdentityFile | undefined {
  return readFile();
}

/** 匯入身分檔(跨裝置搬移):驗證後覆蓋本機身分,回傳匯入的身分 */
export async function importIdentityFile(file: unknown): Promise<SyncIdentity> {
  const seed = importIdentity(file); // 驗格式/長度,失敗即拋
  const identity = await deriveIdentity(seed);
  writeFile(exportIdentity(seed, identity.memberId));
  return identity;
}
