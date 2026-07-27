/**
 * 組織綁定 bundle(3a):組織交給團隊 owner 的一段字串(out-of-band 交付,如複製貼上)。
 * 內含組織根公鑰與該組織為此 vault 簽發的團隊憑證——owner 貼上即完成綁定,信任錨自此上提到組織。
 *
 * 編碼 = base64url(JSON);不加密(全是公開可驗資料,安全性來自憑證上的組織簽章)。
 */
export interface OrgBundle {
  orgRootPubSign: Uint8Array;
  cert: Uint8Array;
}

/** 解析並驗證組織 bundle 的形狀;缺欄位、格式錯或公鑰長度不符即拋(內容真偽由伺服器與 bootstrap 驗鏈) */
export function decodeOrgBundle(text: string): OrgBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("組織綁定碼格式錯誤");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("組織綁定碼格式錯誤");
  const p = parsed as Record<string, unknown>;
  for (const key of ["orgRootPubSign", "cert"] as const) {
    if (typeof p[key] !== "string" || p[key].length === 0) throw new Error(`組織綁定碼缺欄位:${key}`);
  }
  const orgRootPubSign = new Uint8Array(Buffer.from(p["orgRootPubSign"] as string, "base64"));
  if (orgRootPubSign.length !== 32) throw new Error("組織根公鑰長度不符");
  return { orgRootPubSign, cert: new Uint8Array(Buffer.from(p["cert"] as string, "base64")) };
}

/** 產生 bundle(供組織端工具使用) */
export function encodeOrgBundle(bundle: OrgBundle): string {
  return Buffer.from(
    JSON.stringify({
      orgRootPubSign: Buffer.from(bundle.orgRootPubSign).toString("base64"),
      cert: Buffer.from(bundle.cert).toString("base64"),
    }),
    "utf8",
  ).toString("base64url");
}
