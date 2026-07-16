import { describe, it, expect } from "vitest";
import { deriveVaultKey, VaultCipher } from "../src/index.ts";

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
