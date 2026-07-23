import { TeamAdminSession, type TeamAdminOptions } from "@stele/sync";

/**
 * 金鑰輪換編排(2c-2,owner 端):踢人後換 newRoot、重加密全部 docs,補上密碼層前向保密。
 * 唯一安全順序(見 plan §9.2,防舊 root 密文污染共享日誌):
 *   1. 前置:owner 對每個 doc 都已拉齊;任一不齊 → 中止、epoch 不 bump、舊 root 續用
 *   2. 為所有「已核准」留任成員(含 owner 自己)推 epoch=N+1 信封
 *   3. rotateKey commit:伺服器 bump epoch(柵欄點)、拒舊 epoch 寫入、廣播 keyRotated
 *   4. owner 在柵欄下逐 doc 以新 root 重推快照(rekeyAll,全冪等)
 * 崩潰復原:呼叫端在 commit 前落 marker、rekey 全完成後清除;重啟見 marker 就重跑 rekeyUntilDone。
 */

export interface RotateTarget {
  allCaughtUp(): boolean;
  rotateRoot(
    newRoot: Uint8Array,
    epoch: number,
    repull?: boolean,
    spaceKeys?: ReadonlyMap<string, Uint8Array>,
    restrictedSpaceIds?: readonly string[],
  ): Promise<void>;
  rekeyAll(): Promise<boolean>;
}

/** 一個受限空間的輪換需求:此空間的新隨機金鑰只包給名單內成員(owner 恆含) */
export interface RestrictedSpace {
  spaceId: string;
  memberIds: string[];
}

export interface RotateOptions {
  admin: TeamAdminOptions;
  currentEpoch: number;
  target: RotateTarget;
  /** 受限空間清單(來自 vault-meta 的空間名單);每次輪換都對每個空間生新金鑰、只包給其名單 */
  restrictedSpaces?: RestrictedSpace[];
  /** 強制簽章模式(P4 §7.3):政策綁 epoch,開啟狀態須每次輪換以新 epoch 重簽,否則輪換後靜默失效 */
  requireSignedWrites?: boolean;
  /**
   * commit 已成功(epoch 已 bump)後立刻回呼:呼叫端據此更新 teamRuntime 的 root/epoch——
   * 之後就算 rekey 中途失敗,狀態也已前移到新紀元,重試/重啟續跑即可
   */
  onCommitted(root: Uint8Array, epoch: number, spaceKeys: ReadonlyMap<string, Uint8Array>): void;
  /** 測試可注入決定性金鑰;預設隨機 32B */
  generateKey?: () => Uint8Array;
  /** rekeyAll 未全數完成(暫時離線/未拉齊)時的重試間隔與次數上限 */
  retryMs?: number;
  maxRetries?: number;
}

/** 全套輪換;回傳新 root 與 epoch。commit 前的任何失敗都不留半套狀態(epoch 未動、舊 root 續用) */
export async function rotateTeamRoot(opts: RotateOptions): Promise<{ root: Uint8Array; epoch: number }> {
  if (!opts.target.allCaughtUp()) throw new Error("尚有筆記未拉齊,金鑰輪換中止(稍後重試)");
  const genKey = opts.generateKey ?? (() => crypto.getRandomValues(new Uint8Array(32)));
  const newRoot = genKey();
  const spaceKeys = new Map<string, Uint8Array>();
  for (const s of opts.restrictedSpaces ?? []) spaceKeys.set(s.spaceId, genKey());
  const epoch = opts.currentEpoch + 1;
  const admin = await TeamAdminSession.open(opts.admin);
  try {
    // 只重包已核准成員:pending 成員仍待 owner 核對指紋後 approve,輪換不得繞過這道核可
    const members = (await admin.members()).filter((m) => m.approved);
    for (const m of members) await admin.approve(m, newRoot, epoch);
    // 受限空間金鑰只包給名單內成員;owner 恆含(owner 要能重加密該空間的 docs)
    for (const s of opts.restrictedSpaces ?? []) {
      const allowed = new Set([...s.memberIds, opts.admin.identity.memberId]);
      for (const m of members) {
        if (allowed.has(m.memberId)) await admin.approveSpace(m, s.spaceId, spaceKeys.get(s.spaceId)!, epoch);
      }
    }
    // 強制簽章政策綁 epoch:每次輪換都以新 epoch 重簽當前狀態(on 或 off),在柵欄前推妥。
    // 為何連 off 也重簽:成員以「政策缺席即保留既有 pin」抗降級(fail-closed),若只重簽 on,
    // 「owner 關閉後又輪換」會使新紀元無政策 → 錯過關閉的成員永久卡在 pin true。重簽 off 讓關閉也跨紀元傳播。
    await admin.setRequireSignedWrites(opts.requireSignedWrites ?? false, epoch);
    await admin.rotateKey(epoch); // 柵欄點:成功即 commit,不可回頭
  } finally {
    admin.close();
  }
  opts.onCommitted(newRoot, epoch, spaceKeys);
  await opts.target.rotateRoot(newRoot, epoch, false, spaceKeys, [...spaceKeys.keys()]); // owner 自己重加密,不 repull
  await rekeyUntilDone(opts.target, opts.retryMs ?? 3000, opts.maxRetries ?? 20);
  return { root: newRoot, epoch };
}

/** 逐輪重跑 rekeyAll(冪等)直到每個 doc 都以新金鑰重推完成;供輪換本體與重啟續跑共用 */
export async function rekeyUntilDone(target: Pick<RotateTarget, "rekeyAll">, retryMs: number, maxRetries: number): Promise<void> {
  for (let i = 0; ; i++) {
    if (await target.rekeyAll()) return;
    if (i >= maxRetries) throw new Error("金鑰輪換後的重加密未全數完成,重啟後會自動續跑");
    await new Promise((r) => setTimeout(r, retryMs));
  }
}
