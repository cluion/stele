import { describe, it, expect } from "vitest";
import { deriveVaultKey, VaultCipher, ShareCipher } from "../src/index.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("E2EE 加密層", () => {
  it("同密語同 vault 衍生同一把主金鑰,任一變了金鑰就不同", async () => {
    const a = await deriveVaultKey("正確的馬 電池 釘書針", "vault-1", 12);
    const b = await deriveVaultKey("正確的馬 電池 釘書針", "vault-1", 12);
    const c = await deriveVaultKey("錯的密語", "vault-1", 12);
    const d = await deriveVaultKey("正確的馬 電池 釘書針", "vault-2", 12);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(c).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(d).toString("hex"));
    expect(a).toHaveLength(32);
  });

  it("加解密往返不失真,密文不含明文", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const plain = utf8("極機密的筆記內容");
    const sealed = await cipher.encrypt("doc-1", plain);
    expect(Buffer.from(sealed).includes(Buffer.from(plain))).toBe(false);
    const opened = await cipher.decrypt("doc-1", sealed);
    expect(Buffer.from(opened).toString("utf8")).toBe("極機密的筆記內容");
  });

  it("同一明文兩次加密的密文不同,nonce 不重用", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const plain = utf8("同樣的內容");
    const one = await cipher.encrypt("doc-1", plain);
    const two = await cipher.encrypt("doc-1", plain);
    expect(Buffer.from(one).toString("hex")).not.toBe(Buffer.from(two).toString("hex"));
  });

  it("每 doc 子金鑰不同:doc 甲的密文用 doc 乙的身分解不開", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const sealed = await cipher.encrypt("doc-1", utf8("內容"));
    await expect(cipher.decrypt("doc-2", sealed)).rejects.toThrow();
  });

  it("錯的密語解不開", async () => {
    const good = new VaultCipher(await deriveVaultKey("正確密語", "v1", 12));
    const bad = new VaultCipher(await deriveVaultKey("錯誤密語", "v1", 12));
    const sealed = await good.encrypt("doc-1", utf8("內容"));
    await expect(bad.decrypt("doc-1", sealed)).rejects.toThrow();
  });

  it("被竄改的密文解不開", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const sealed = await cipher.encrypt("doc-1", utf8("內容"));
    sealed[sealed.length - 1]! ^= 0xff;
    await expect(cipher.decrypt("doc-1", sealed)).rejects.toThrow();
  });

  it("未知版本位與過短的密文直接拒絕", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const unknownVersion = new Uint8Array(40).fill(1);
    unknownVersion[0] = 9;
    await expect(cipher.decrypt("doc-1", unknownVersion)).rejects.toThrow(/版本/);
    await expect(cipher.decrypt("doc-1", new Uint8Array([1, 2]))).rejects.toThrow(/不完整/);
  });

  it("空明文也能往返,快照與小差分都安全", async () => {
    const cipher = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const opened = await cipher.decrypt("doc-1", await cipher.encrypt("doc-1", new Uint8Array()));
    expect(opened).toHaveLength(0);
  });
});

describe("分享金鑰(ShareCipher)", () => {
  it("匯出的 doc 金鑰能解開 VaultCipher 的密文,收件人不需主金鑰", async () => {
    const vault = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const sealed = await vault.encrypt("doc-1", utf8("分享出去的內容"));
    const share = new ShareCipher(await vault.exportDocKey("doc-1"));
    const opened = await share.decrypt("doc-1", sealed);
    expect(Buffer.from(opened).toString("utf8")).toBe("分享出去的內容");
  });

  it("匯出金鑰為 32 bytes,且不同 doc 匯出不同", async () => {
    const vault = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const a = await vault.exportDocKey("doc-1");
    const b = await vault.exportDocKey("doc-2");
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  it("ShareCipher 加密的內容 VaultCipher 也解得開,可編輯分享雙向互通", async () => {
    const vault = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const share = new ShareCipher(await vault.exportDocKey("doc-1"));
    const sealed = await share.encrypt("doc-1", utf8("協作者寫回的內容"));
    const opened = await vault.decrypt("doc-1", sealed);
    expect(Buffer.from(opened).toString("utf8")).toBe("協作者寫回的內容");
  });

  it("拿錯 doc 的金鑰解不開", async () => {
    const vault = new VaultCipher(await deriveVaultKey("測試密語", "v1", 12));
    const sealed = await vault.encrypt("doc-1", utf8("內容"));
    const wrong = new ShareCipher(await vault.exportDocKey("doc-2"));
    await expect(wrong.decrypt("doc-1", sealed)).rejects.toThrow();
  });
});
