/**
 * 團隊邀請 bundle 的格式定義已移至 `@stele/sync`(組織批次產碼的 CLI 也要產同一種 bundle,
 * 格式必須只有一份真相,否則兩邊會漂移)。此處重新匯出,維持既有匯入路徑不變。
 */
export { encodeInvite, decodeInvite, type TeamInvite } from "@stele/sync";
