import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  generateSeed,
  deriveIdentity,
  exportIdentity,
  importIdentity,
  IDENTITY_FORMAT,
  type SyncIdentity,
  type IdentityFile,
} from "@stele/sync";

/**
 * 成員身分(app 級、跨 vault 的長期非對稱金鑰)的本機存放。
 *
 * 存 userData 下獨立檔 identity.json——不是 per-vault 的 sync.json、也不是瑣碎偏好的 settings.json,
 * 讓「匯出/備份 = 複製一個檔」最乾淨。首次呼叫自動生成並落盤。
 *
 * **At-rest 加密(2b):種子預設以 OS keychain 包裝**(macOS Keychain / Windows DPAPI,經 Electron safeStorage)。
 * 威脅模型比 sync.json 的 passphrase 更廣:此種子是 per-member、跨 vault 的秘密,洩漏可冒充此成員於所有已加入的
 * vault,且解開所有曾以此成員 pubWrap 包裝的空間金鑰(2b 起 blast radius 跨 vault)。故種子不再明文落盤。
 *
 * 落盤格式(此模組自有的 at-rest 信封,與 packages/sync 的明文 IdentityFile 區分):
 *   - `enc: "safeStorage"`:seed = base64(safeStorage 加密後的「種子 base64url 字串」)。預設路徑。
 *   - `enc: null`:seed = 種子 base64url 明文。keychain 不可用(如 Linux 無 keyring)時的優雅退回,
 *     並相容 0.8.0 既有明文檔。
 * 檔案權限維持 0600(縱深防禦)。匯出/匯入一律走明文 IdentityFile,keychain 綁本機、不隨檔搬移。
 */

const identityFile = (): string => path.join(app.getPath("userData"), "identity.json");

/** OS keychain 是否可用;不可用(Linux 無 keyring 等)則退回明文,不讓落盤失敗 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 讀身分檔並還原成**明文 IdentityFile**(enc=null、seed 為原始種子 base64url),不論 at-rest 是否加密。
 * 不存在回 undefined;格式/長度不符或 keychain 解密失敗即拋——絕不靜默重生,免無聲換掉身分。
 */
function readPlaintext(): IdentityFile | undefined {
  const file = identityFile();
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (parsed["enc"] === "safeStorage") {
    if (typeof parsed["memberId"] !== "string" || typeof parsed["seed"] !== "string") {
      throw new Error("身分檔(加密)欄位缺失");
    }
    const seedB64url = safeStorage.decryptString(Buffer.from(parsed["seed"], "base64"));
    const plain: IdentityFile = { format: IDENTITY_FORMAT, memberId: parsed["memberId"], seed: seedB64url, enc: null };
    importIdentity(plain); // 驗格式/長度,壞檔在此拋
    return plain;
  }
  // enc null(0.8.0 明文檔)或其他:交 importIdentity 驗證
  importIdentity(parsed);
  return parsed as IdentityFile;
}

/** 原子寫(tmp + rename);keychain 可用則加密種子後落盤,否則明文退回。輸入是明文 IdentityFile */
function persist(plain: IdentityFile): void {
  const stored = encryptionAvailable()
    ? {
        format: plain.format,
        memberId: plain.memberId,
        enc: "safeStorage" as const,
        seed: safeStorage.encryptString(plain.seed).toString("base64"),
      }
    : plain;
  const dest = identityFile();
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest + ".tmp", JSON.stringify(stored, null, 2), { mode: 0o600 });
  renameSync(dest + ".tmp", dest);
}

/** 載入本機成員身分,首次(檔案不存在)才隨機生成並落盤;回傳可簽章/解封的身分 */
export async function loadOrCreateIdentity(): Promise<SyncIdentity> {
  const existing = readPlaintext();
  if (existing) return deriveIdentity(importIdentity(existing));
  const seed = generateSeed();
  const identity = await deriveIdentity(seed);
  persist(exportIdentity(seed, identity.memberId));
  return identity;
}

/** 匯出目前身分檔(明文,供跨裝置搬移;keychain 綁本機不隨檔走);沒有身分則回 undefined */
export function exportIdentityFile(): IdentityFile | undefined {
  return readPlaintext();
}

/** 匯入身分檔(跨裝置搬移):驗證後以本機 at-rest 策略落盤,回傳匯入的身分 */
export async function importIdentityFile(file: unknown): Promise<SyncIdentity> {
  const seed = importIdentity(file); // 驗格式/長度,失敗即拋
  const identity = await deriveIdentity(seed);
  persist(exportIdentity(seed, identity.memberId));
  return identity;
}
