import { generateSeed, deriveIdentity, exportIdentity, importIdentity, type SyncIdentity } from "@stele/sync";
import type { SecretStore } from "./secrets.ts";

/**
 * 成員身分在手機上的保管。與桌面 `identity-store.ts` 是同一套語意,只是落點不同
 * ——桌面是 userData 底下的 identity.json(種子經 OS keychain 包裝),這裡直接進 Keychain。
 *
 * 身分是 **app 級、跨 vault** 的長期金鑰,不屬於任何一個 vault:同一個人加入三個團隊,
 * 用的是同一個 memberId。因此它與 vault 設定分開保管,換 vault 不會換身分。
 */

const IDENTITY_KEY = "member-identity";

/**
 * 載入本機身分,沒有才生成。
 *
 * **壞掉的身分檔一律拋,絕不默默重生**——重生等於無聲換掉這台裝置的 memberId,
 * 所有已加入的團隊都會把他當陌生人,得由 owner 重新核准一次,而使用者完全不知道發生了什麼。
 * 寧可當場報錯讓人知道「身分讀不出來」。
 */
export async function loadOrCreateIdentity(secrets: SecretStore): Promise<SyncIdentity> {
  const raw = await secrets.get(IDENTITY_KEY);
  if (raw !== null) {
    const seed = importIdentity(JSON.parse(raw)); // 格式/長度不符即拋
    return deriveIdentity(seed);
  }
  const seed = generateSeed();
  const identity = await deriveIdentity(seed);
  await secrets.set(IDENTITY_KEY, JSON.stringify(exportIdentity(seed, identity.memberId)));
  return identity;
}

/** 這台裝置目前有沒有身分(還沒有 = 從沒加入過團隊);不生成 */
export const hasIdentity = async (secrets: SecretStore): Promise<boolean> => (await secrets.get(IDENTITY_KEY)) !== null;
