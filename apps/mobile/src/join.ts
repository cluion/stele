import {
  decodeInvite,
  bootstrapTeamKey,
  bytesToBase64,
  base64ToBytes,
  type MemberRole,
  type SocketLike,
  type SyncIdentity,
  type TeamInvite,
} from "@stele/sync";
import type { TeamVaultSettings } from "./vault.ts";

/**
 * 團隊 vault 的加入與復原。
 *
 * 與個人 vault 最大的差別是 **root 不由使用者輸入的東西衍生**:它是 owner 用我的公鑰包好、
 * 放在伺服器上的一個信封,每次開 app 都得認證後拉下來解一次。因此手機上沒有「團隊密語」
 * 這種東西可問——能不能進來,取決於 Keychain 裡那把身分金鑰,以及 owner 有沒有核准我。
 *
 * 這一層刻意不碰儲存也不碰 UI:吃一個 `TeamRecord`,回一個新的 `TeamRecord`(信任錨可能被
 * 組織委任鏈換掉、政策 pin 可能前進),由呼叫端決定存到哪。
 */

/** 本機保存的團隊連線資訊。**不含 root**——root 每次 bootstrap 重取,不落盤 */
export interface TeamRecord {
  url: string;
  token: string;
  vaultId: string;
  /** 信任錨(base64);綁組織時會被委任鏈認定的當代 owner 取代 */
  ownerPubSign: string;
  /** 組織根公鑰(base64,綁組織的團隊才有):錨釘在組織而非某一任 owner */
  orgRootPubSign?: string;
  /** 見過的最大團隊憑證序號:反回滾 pin,擋重放舊憑證把 owner 指回離職者 */
  orgSerial?: number;
  /**
   * 強制簽章模式的本機 pin(§7.3)。政策缺席時**保留**既有值而不是當成關閉
   * ——惡意伺服器只要不送政策就能把已經收緊的成員偷偷降級回容忍 unsigned。
   */
  requireSigned?: boolean;
}

export type OpenTeamResult =
  | { status: "pending"; record: TeamRecord }
  | { status: "ready"; record: TeamRecord; settings: TeamVaultSettings; role?: MemberRole; rotationRequested: boolean };

/** 邀請碼 → 可保存的團隊紀錄;碼壞掉在 `decodeInvite` 就拋 */
export function recordFromInvite(text: string): { record: TeamRecord; invite: TeamInvite } {
  const invite = decodeInvite(text);
  const record: TeamRecord = {
    url: invite.url,
    token: invite.token,
    vaultId: invite.vaultId,
    ownerPubSign: invite.ownerPubSign,
    ...(invite.orgRootPubSign ? { orgRootPubSign: invite.orgRootPubSign } : {}),
  };
  return { record, invite };
}

/** WebView 與 Node 都有全域 WebSocket,不必 polyfill;型別上補成 SocketLike */
export const webSocketFactory = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

/**
 * 開一個團隊 vault:認證(首次帶邀請碼)→ 拉自己的 root 信封 → 驗 owner 簽章後解開。
 *
 * owner 還沒核准就是 `pending`——**這不是錯誤**,是加入流程的正常一站。呼叫端該把它顯示成
 * 「等待核准」並隔一陣子重試,而不是當成連線失敗把使用者退回設定畫面。
 */
export async function openTeamVault(
  record: TeamRecord,
  identity: SyncIdentity,
  opts: { enrollToken?: string; createSocket?: (url: string) => SocketLike } = {},
): Promise<OpenTeamResult> {
  const createSocket = opts.createSocket ?? webSocketFactory;
  const res = await bootstrapTeamKey({
    url: record.url,
    token: record.token,
    vaultId: record.vaultId,
    identity,
    ownerPubSign: base64ToBytes(record.ownerPubSign),
    ...(record.orgRootPubSign ? { orgRootPubSign: base64ToBytes(record.orgRootPubSign) } : {}),
    ...(record.orgSerial !== undefined ? { pinnedOrgSerial: record.orgSerial } : {}),
    ...(opts.enrollToken ? { enrollmentToken: opts.enrollToken } : {}),
    createSocket,
  });
  if (res.status === "pending") return { status: "pending", record };

  // 組織撤換 owner 後,當代信任錨與序號都要跟著前進(序號只進不退)
  const next: TeamRecord = {
    ...record,
    ...(res.orgOwner
      ? {
          ownerPubSign: bytesToBase64(res.orgOwner.ownerPubSign),
          orgSerial: Math.max(record.orgSerial ?? 0, res.orgOwner.serial),
        }
      : {}),
    // 政策缺席保留既有 pin;首次加入無 pin 則沿用預設(容忍 unsigned)
    requireSigned: res.requireSignedWrites ?? record.requireSigned,
  };

  const settings: TeamVaultSettings = {
    url: next.url,
    token: next.token,
    vaultId: next.vaultId,
    identity,
    ownerPubSign: base64ToBytes(next.ownerPubSign),
    root: res.root,
    epoch: res.epoch,
    spaceKeys: res.spaceKeys,
    restrictedSpaceIds: res.restrictedSpaceIds,
    ...(next.requireSigned !== undefined ? { requireSignedWrites: next.requireSigned } : {}),
  };
  return {
    status: "ready",
    record: next,
    settings,
    ...(res.role ? { role: res.role } : {}),
    rotationRequested: res.rotationRequested,
  };
}
