import { app } from "electron";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { generateSeed, deriveIdentity, exportIdentity, importIdentity, type SyncIdentity, type IdentityFile } from "@stele/sync";

/**
 * 成員身分(app 級、跨 vault 的長期非對稱金鑰)的本機存放。
 *
 * 存 userData 下獨立檔 identity.json——不是 per-vault 的 sync.json、也不是瑣碎偏好的 settings.json,
 * 讓「匯出/備份 = 複製一個檔」最乾淨。首次呼叫自動生成並落盤。
 *
 * MVP 明文存(mode 0600),enc 欄位預留未來 OS keychain / passphrase 包裝。
 * ⚠ 威脅模型比 sync.json 的 passphrase 更廣:passphrase 洩漏只失守單一 vault 的內容金鑰;
 * 此種子是 per-member、跨 vault 的秘密,洩漏可冒充此成員於所有已加入的 vault,且(2b 起)
 * 解開所有曾以此成員 pubWrap 包裝的空間金鑰。故 2b 之前應優先上 keychain 包裝。
 */

const identityFile = (): string => path.join(app.getPath("userData"), "identity.json");

/** 讀身分檔;不存在回 undefined。存在但壞掉/格式不符則拋——絕不靜默重生,免無聲換掉身分 */
function readFile(): IdentityFile | undefined {
  const file = identityFile();
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  importIdentity(parsed); // 驗格式/長度,壞檔在此拋
  return parsed as IdentityFile;
}

/** 原子寫(tmp + rename),與 vault-meta/sync-state 落盤一致,避免中途崩潰留半截檔 */
function writeFile(file: IdentityFile): void {
  const dest = identityFile();
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest + ".tmp", JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(dest + ".tmp", dest);
}

/** 載入本機成員身分,首次(檔案不存在)才隨機生成並落盤;回傳可簽章的身分 */
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
