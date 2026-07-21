/**
 * 團隊邀請 bundle:owner 產給被邀請者的一段字串(out-of-band 交付,如複製貼上)。
 * 攜帶加入所需的一切:伺服器位址、准入 token、vaultId、一次性邀請碼,以及
 * **ownerPubSign(信任錨)**——被邀請者以它驗證空間金鑰信封的 owner 簽章,擋惡意伺服器偽造 vault。
 *
 * 編碼 = base64url(JSON);不加密(內含的是准入資訊而非金鑰,真正的機密性在信封 + owner 簽章)。
 */
export interface TeamInvite {
  url: string;
  token: string;
  vaultId: string;
  /** owner Ed25519 公鑰的 base64;被邀請者 unwrap 時的信任錨 */
  ownerPubSign: string;
  /** 一次性邀請碼 */
  enrollToken: string;
  /** 被邀者加入後的角色(editor/viewer);2c owner 產碼時決定 */
  role: "editor" | "viewer";
}

export function encodeInvite(invite: TeamInvite): string {
  return Buffer.from(JSON.stringify(invite), "utf8").toString("base64url");
}

/** 解析並驗證邀請 bundle;缺欄位或格式錯即拋 */
export function decodeInvite(text: string): TeamInvite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("邀請碼格式錯誤");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("邀請碼格式錯誤");
  const p = parsed as Record<string, unknown>;
  for (const key of ["url", "token", "vaultId", "ownerPubSign", "enrollToken"] as const) {
    if (typeof p[key] !== "string" || p[key].length === 0) throw new Error(`邀請碼缺欄位:${key}`);
  }
  // role 舊 bundle 可能缺(向前相容)→ 預設 viewer;非法值也收斂為 viewer
  const role: "editor" | "viewer" = p["role"] === "editor" ? "editor" : "viewer";
  return {
    url: p["url"] as string,
    token: p["token"] as string,
    vaultId: p["vaultId"] as string,
    ownerPubSign: p["ownerPubSign"] as string,
    enrollToken: p["enrollToken"] as string,
    role,
  };
}
