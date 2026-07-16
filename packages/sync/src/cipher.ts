/** payload 進出同步引擎的加解密縫:P2-2 換成 AES-GCM 實作,引擎與協議不動 */
export interface Cipher {
  encrypt(plain: Uint8Array): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<Uint8Array>;
}

/** P2-2 之前的過渡:不加密 */
export const identityCipher: Cipher = {
  encrypt: (plain) => Promise.resolve(plain),
  decrypt: (data) => Promise.resolve(data),
};

/** 差分內容指紋,擋下重連時的無變更重推 */
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
