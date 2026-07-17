/** 解析分享連結:shareId 在路徑,doc 金鑰在 URL fragment(#k=...),金鑰永不進伺服器 */

export interface ShareLink {
  shareId: string;
  key: Uint8Array;
}

export function parseShareLink(pathname: string, hash: string): ShareLink | undefined {
  const m = /\/s\/([A-Za-z0-9_-]+)/.exec(pathname);
  if (!m) return undefined;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const k = params.get("k");
  if (!k) return undefined;
  try {
    const key = b64urlDecode(k);
    return key.length === 32 ? { shareId: m[1]!, key } : undefined;
  } catch {
    return undefined;
  }
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
