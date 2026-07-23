import { describe, it, expect } from "vitest";
import { signVaultPolicy, verifyVaultPolicy, generateSeed, deriveIdentity } from "../src/index.ts";

/**
 * Vault 政策憑證(P4 §7.3):owner 簽章的 requireSignedWrites 開關,成員以信任錨 ownerPubSign 驗。
 * 驗真實性(合法簽發驗過)+ 防竄改(偽簽/跨 vault/截斷/竄改旗標一律拒)。
 */
describe("vault 政策憑證", () => {
  it("owner 簽的政策:同 vaultId 驗過,得回 flags 與 epoch", async () => {
    const owner = await deriveIdentity(generateSeed());
    const blob = signVaultPolicy(owner.sign, { vaultId: "v1", requireSignedWrites: true, epoch: 3 });
    const v = verifyVaultPolicy(blob, owner.pubSign, "v1");
    expect(v.requireSignedWrites).toBe(true);
    expect(v.epoch).toBe(3);
  });

  it("requireSignedWrites=false 亦如實還原", async () => {
    const owner = await deriveIdentity(generateSeed());
    const blob = signVaultPolicy(owner.sign, { vaultId: "v1", requireSignedWrites: false, epoch: 0 });
    const v = verifyVaultPolicy(blob, owner.pubSign, "v1");
    expect(v.requireSignedWrites).toBe(false);
    expect(v.epoch).toBe(0);
  });

  it("跨 vault 挪用:同 blob 換 vaultId 驗必拋", async () => {
    const owner = await deriveIdentity(generateSeed());
    const blob = signVaultPolicy(owner.sign, { vaultId: "v1", requireSignedWrites: true, epoch: 1 });
    expect(() => verifyVaultPolicy(blob, owner.pubSign, "v2")).toThrow();
  });

  it("非 owner 簽(偽造)驗必拋", async () => {
    const owner = await deriveIdentity(generateSeed());
    const mallory = await deriveIdentity(generateSeed());
    const blob = signVaultPolicy(mallory.sign, { vaultId: "v1", requireSignedWrites: true, epoch: 1 });
    expect(() => verifyVaultPolicy(blob, owner.pubSign, "v1")).toThrow();
  });

  it("竄改旗標位元:簽章對不上,驗必拋", async () => {
    const owner = await deriveIdentity(generateSeed());
    const blob = signVaultPolicy(owner.sign, { vaultId: "v1", requireSignedWrites: false, epoch: 1 });
    // blob = [ver][flags][epoch][sig];翻 flags 那個 byte(index 1)
    const tampered = new Uint8Array(blob);
    tampered[1] = (tampered[1]! ^ 0x01) & 0xff;
    expect(() => verifyVaultPolicy(tampered, owner.pubSign, "v1")).toThrow();
  });

  it("截斷的 blob 驗必拋", async () => {
    const owner = await deriveIdentity(generateSeed());
    const blob = signVaultPolicy(owner.sign, { vaultId: "v1", requireSignedWrites: true, epoch: 1 });
    expect(() => verifyVaultPolicy(blob.slice(0, blob.length - 4), owner.pubSign, "v1")).toThrow();
  });
});
