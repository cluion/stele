/**
 * 管理事件的種類與人話標籤(3b-3)。
 *
 * 種類與標籤刻意放在同一個檔案:走查抓過一次——新增了事件種類卻忘了補 CLI 標籤,
 * 管理員看到的是 `enroll-batch-created` 這種原始代號。同住一處 + 完備性測試,漏了就紅。
 *
 * 範圍界線:這裡只有**伺服器看得見的管理平面動作**。內容操作(誰讀寫哪篇筆記、空間稽核)
 * 在 vault-meta 是密文,組織解不開,因此永遠不會、也不該出現在這份清單。
 */

export const ADMIN_EVENT_KINDS = [
  "member-enrolled",
  "member-approved",
  "member-removed",
  "role-changed",
  "key-rotated",
  "owner-claimed",
  "owner-transferred",
  "org-bound",
  "org-policy-set",
  "org-revoked",
  "enroll-batch-created",
] as const;

export type AdminEventKind = (typeof ADMIN_EVENT_KINDS)[number];

/** CLI 呈現用的標籤;每個種類都必須有,由 admin-events.test.ts 的完備性測試把關 */
export const ADMIN_EVENT_LABEL: Record<AdminEventKind, string> = {
  "member-enrolled": "成員加入",
  "member-approved": "核准成員",
  "member-removed": "移除成員",
  "role-changed": "改角色",
  "key-rotated": "金鑰輪換",
  "owner-claimed": "認領擁有者",
  "owner-transferred": "組織撤換擁有者",
  "org-bound": "綁定組織",
  "org-policy-set": "組織政策",
  "org-revoked": "組織一次全撤",
  "enroll-batch-created": "組織批次產碼",
};
