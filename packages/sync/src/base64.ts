/**
 * base64 / base64url 的位元組與字串轉換。
 *
 * 為什麼不用 `Buffer`:`packages/sync` 是**共用**的同步層,桌面(Node)、瀏覽器分享檢視器與
 * 行動端 WebView 跑的是同一份程式碼。`Buffer` 只有 Node 有,打進 WebView 的包裡不會編譯失敗
 * ——它會在真的走到那一行時才炸成 ReferenceError,而那一行是團隊 vault 的邀請碼解析與
 * 在場簽章驗證,是使用者最不該踩到的地方。用兩邊都有的 `btoa` / `atob` 就沒有這個分岔。
 *
 * 都是 Latin-1 語意,所以文字一律先過 `TextEncoder` 變位元組再編碼,不直接把字串餵給 `btoa`
 * ——邀請碼裡有中文團隊名時,直接餵會直接拋。
 */

/** 一次轉太多位元組會把 apply 的參數表撐爆,分段組字串 */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64url:`+/` 換成 `-_`、去掉 padding。與 Node 的 `toString("base64url")` 位元相同 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  // atob 不接受缺 padding 的輸入,補回來;Node 的 base64url 輸出一律無 padding
  return base64ToBytes(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
}

export const utf8ToBase64Url = (text: string): string => bytesToBase64Url(new TextEncoder().encode(text));

export const base64UrlToUtf8 = (b64url: string): string => new TextDecoder().decode(base64UrlToBytes(b64url));
