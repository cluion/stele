import { describe, it, expect, beforeAll } from "vitest";
import { generateSeed, deriveIdentity, signRoleCredential, verifyRoleCredential, type SyncIdentity } from "../src/index.ts";

/**
 * 角色憑證(§9.5):owner 簽 {vaultId, memberId, role, epoch},成員對信任錨驗證。
 * 不變量:正簽正驗;非 owner 簽、跨 vault/成員/角色/紀元挪用、截斷竄改一律拒。
 */

describe("角色憑證簽發與驗證", () => {
  let owner: SyncIdentity;
  let mallory: SyncIdentity;
  const claims = { vaultId: "team-v", memberId: "m".repeat(64), role: "editor" as const, epoch: 2 };

  beforeAll(async () => {
    owner = await deriveIdentity(generateSeed());
    mallory = await deriveIdentity(generateSeed());
  });

  it("正簽正驗:回簽發時的 role 與 epoch", () => {
    const blob = signRoleCredential(owner.sign, claims);
    expect(verifyRoleCredential(blob, owner.pubSign, claims.vaultId, claims.memberId)).toEqual({ role: "editor", epoch: 2 });
  });

  it("非 owner 簽的憑證驗不過(盲中繼無法捏造角色)", () => {
    const forged = signRoleCredential(mallory.sign, claims);
    expect(() => verifyRoleCredential(forged, owner.pubSign, claims.vaultId, claims.memberId)).toThrow(/驗證失敗/);
  });

  it("跨 vault / 跨成員挪用驗不過(context 綁進簽章)", () => {
    const blob = signRoleCredential(owner.sign, claims);
    expect(() => verifyRoleCredential(blob, owner.pubSign, "other-vault", claims.memberId)).toThrow(/驗證失敗/);
    expect(() => verifyRoleCredential(blob, owner.pubSign, claims.vaultId, "x".repeat(64))).toThrow(/驗證失敗/);
  });

  it("blob 內 role 或 epoch 被改寫即驗不過(伺服器不能把 viewer 憑證改成 editor)", () => {
    const blob = signRoleCredential(owner.sign, { ...claims, role: "viewer" });
    // blob[1] 是 role tag(version 之後):viewer(2) 改成 editor(1)
    const tampered = blob.slice();
    tampered[1] = 1;
    expect(() => verifyRoleCredential(tampered, owner.pubSign, claims.vaultId, claims.memberId)).toThrow(/驗證失敗/);
    // epoch 改寫同拒
    const blob2 = signRoleCredential(owner.sign, claims);
    const tampered2 = blob2.slice();
    tampered2[2] = claims.epoch + 1; // epoch varuint(單位元組範圍)
    expect(() => verifyRoleCredential(tampered2, owner.pubSign, claims.vaultId, claims.memberId)).toThrow(/驗證失敗/);
  });

  it("截斷或版本不符即拋,不靜默", () => {
    const blob = signRoleCredential(owner.sign, claims);
    expect(() => verifyRoleCredential(blob.slice(0, blob.length - 1), owner.pubSign, claims.vaultId, claims.memberId)).toThrow(/不完整/);
    expect(() => verifyRoleCredential(new Uint8Array(), owner.pubSign, claims.vaultId, claims.memberId)).toThrow();
    const wrongVer = blob.slice();
    wrongVer[0] = 9;
    expect(() => verifyRoleCredential(wrongVer, owner.pubSign, claims.vaultId, claims.memberId)).toThrow(/版本/);
  });
});
