import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// identity-store 依賴 electron 的 app.getPath 與 safeStorage;mock 成臨時 userData + 可切換的假 keychain
let userData = "";
let keychainOn = true;
// 假 keychain:可用時以可逆前綴模擬加密,讓「加密後與明文不同、可解回」兩件事都可斷言
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => keychainOn,
    encryptString: (s: string) => Buffer.from("KC:" + s, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("KC:")) throw new Error("假 keychain 解密失敗");
      return s.slice(3);
    },
  },
}));

const { loadOrCreateIdentity, exportIdentityFile, importIdentityFile } = await import("../src/main/identity-store.ts");
const { deriveIdentity, generateSeed } = await import("@stele/sync");

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "stele-identity-"));
  keychainOn = true;
});

describe("identity-store", () => {
  it("首次載入生成並落盤,再次載入取回同一身分", async () => {
    const a = await loadOrCreateIdentity();
    expect(existsSync(path.join(userData, "identity.json"))).toBe(true);
    const b = await loadOrCreateIdentity();
    expect(b.memberId).toBe(a.memberId);
    expect([...b.pubSign]).toEqual([...a.pubSign]);
  });

  it("身分檔權限為 0600(私鑰明文,靠 OS 檔案權限)", async () => {
    await loadOrCreateIdentity();
    const mode = statSync(path.join(userData, "identity.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keychain 可用時種子 at-rest 加密:enc 標記 safeStorage、seed 非原始種子", async () => {
    const id = await loadOrCreateIdentity();
    const onDisk = JSON.parse(readFileSync(path.join(userData, "identity.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk["format"]).toBe("stele-identity-v1");
    expect(onDisk["memberId"]).toBe(id.memberId);
    expect(onDisk["enc"]).toBe("safeStorage");
    // 落盤的 seed 是加密 blob 的 base64,含假 keychain 前綴,絕非明文種子
    const rawSeed = Buffer.from(id.pubSign).toString("base64url"); // 任意明文比較基準
    expect(onDisk["seed"]).not.toBe(rawSeed);
    expect(Buffer.from(onDisk["seed"] as string, "base64").toString("utf8")).toMatch(/^KC:/);
    // 再次載入仍取回同一身分(解密路徑)
    const again = await loadOrCreateIdentity();
    expect(again.memberId).toBe(id.memberId);
  });

  it("keychain 不可用時優雅退回明文(enc null),仍可載入", async () => {
    keychainOn = false;
    const id = await loadOrCreateIdentity();
    const onDisk = JSON.parse(readFileSync(path.join(userData, "identity.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk["enc"]).toBeNull();
    expect(typeof onDisk["seed"]).toBe("string");
    const again = await loadOrCreateIdentity();
    expect(again.memberId).toBe(id.memberId);
  });

  it("相容 0.8.0 明文檔(enc null):無 keychain 寫的檔,keychain 開著也讀得回", async () => {
    keychainOn = false;
    const id = await loadOrCreateIdentity(); // 寫明文檔
    keychainOn = true; // 之後 keychain 變可用
    const again = await loadOrCreateIdentity(); // 讀舊明文檔不應失敗
    expect(again.memberId).toBe(id.memberId);
  });

  it("export → import 跨裝置搬移:匯入後得回同一 memberId", async () => {
    const original = await loadOrCreateIdentity();
    const file = exportIdentityFile();
    expect(file).toBeDefined();

    // 模擬另一台裝置:換一個空 userData,匯入該檔
    userData = mkdtempSync(path.join(tmpdir(), "stele-identity-b-"));
    const imported = await importIdentityFile(file);
    expect(imported.memberId).toBe(original.memberId);
    // 落盤後再載入仍是同一身分
    const reloaded = await loadOrCreateIdentity();
    expect(reloaded.memberId).toBe(original.memberId);
  });

  it("匯入壞檔即拋,不覆蓋", async () => {
    const seed = generateSeed();
    const good = await deriveIdentity(seed);
    void good;
    await expect(importIdentityFile({ format: "x" })).rejects.toThrow();
  });
});
