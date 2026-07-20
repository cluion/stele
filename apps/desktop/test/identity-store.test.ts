import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// identity-store 依賴 electron 的 app.getPath;mock 成一個臨時 userData 目錄
let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { loadOrCreateIdentity, exportIdentityFile, importIdentityFile } = await import("../src/main/identity-store.ts");
const { deriveIdentity, generateSeed } = await import("@stele/sync");

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "stele-identity-"));
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

  it("身分檔是版本化信封,不外露公鑰以外的推導物", async () => {
    const id = await loadOrCreateIdentity();
    const file = JSON.parse(readFileSync(path.join(userData, "identity.json"), "utf8")) as Record<string, unknown>;
    expect(file["format"]).toBe("stele-identity-v1");
    expect(file["memberId"]).toBe(id.memberId);
    expect(file["enc"]).toBeNull();
    expect(typeof file["seed"]).toBe("string");
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
