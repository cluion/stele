/** payload 進出同步引擎的加解密縫;docId 供每 doc 子金鑰衍生 */
export interface Cipher {
  encrypt(docId: string, plain: Uint8Array): Promise<Uint8Array>;
  decrypt(docId: string, data: Uint8Array): Promise<Uint8Array>;
}

/** 測試用:不加密 */
export const identityCipher: Cipher = {
  encrypt: (_docId, plain) => Promise.resolve(plain),
  decrypt: (_docId, data) => Promise.resolve(data),
};

/** 差分內容指紋,擋下重連時的無變更重推 */
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
