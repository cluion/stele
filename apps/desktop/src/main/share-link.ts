/**
 * 消費端分享連結解析(main/Node):把貼上的完整分享網址拆成 wsUrl + shareId + doc 金鑰
 * 金鑰只在 URL fragment(#k=...),new URL 不會把 fragment 送伺服器;規則對齊 apps/viewer/src/share-link.ts
 * 有別於 viewer 版依賴瀏覽器 atob,這裡用 Node 的 Buffer.from(base64url)
 */

export interface ConsumeLink {
  /** 由連結 origin 推出的 WebSocket 位址,分享頁與 WS 同台同埠 */
  wsUrl: string;
  shareId: string;
  /** 32-byte 單 doc 原始金鑰 */
  key: Uint8Array;
}

export function parseConsumeLink(input: string): ConsumeLink | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  const m = /\/s\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (!m) return undefined;
  const k = new URLSearchParams(url.hash.replace(/^#/, "")).get("k");
  if (!k) return undefined;
  let key: Uint8Array;
  try {
    key = new Uint8Array(Buffer.from(k, "base64url"));
  } catch {
    return undefined;
  }
  if (key.length !== 32) return undefined;
  const wsUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/`;
  return { wsUrl, shareId: m[1]!, key };
}
