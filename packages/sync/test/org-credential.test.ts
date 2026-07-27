import { describe, it, expect, beforeAll } from "vitest";
import {
  generateSeed,
  deriveIdentity,
  orgIdFromRootPubSign,
  signOrgAdminCert,
  verifyOrgAdminCert,
  signOrgTeamCert,
  verifyOrgTeamCert,
  type SyncIdentity,
} from "../src/index.ts";

/**
 * 組織委任鏈(Slice 3a):orgRoot -簽-> orgAdminCert -簽-> orgTeamCert{vaultId, ownerPubSign, serial}。
 * 買到的能力:團隊的當代 owner 由組織指派且成員端可密碼學驗證(owner 可撤換,不必重建 vault)。
 * 不變量:鏈上任一環偽造/過期/跨 vault 挪用皆拒;root 可直簽(不經 admin);orgId 由 root 公鑰導出。
 */

describe("組織委任鏈", () => {
  let root: SyncIdentity;
  let admin: SyncIdentity;
  let owner: SyncIdentity;
  let mallory: SyncIdentity;
  const NOW = 1_800_000_000;

  beforeAll(async () => {
    root = await deriveIdentity(generateSeed());
    admin = await deriveIdentity(generateSeed());
    owner = await deriveIdentity(generateSeed());
    mallory = await deriveIdentity(generateSeed());
  });

  const adminCert = (notAfter = 0, signer: SyncIdentity = root) =>
    signOrgAdminCert(signer.sign, { adminPubSign: admin.pubSign, notAfter });
  const teamClaims = () => ({ vaultId: "team-v", ownerPubSign: owner.pubSign, serial: 3 });

  it("orgId 由 root 公鑰導出:自我認證,不需伺服器背書", () => {
    expect(orgIdFromRootPubSign(root.pubSign)).toHaveLength(64);
    expect(orgIdFromRootPubSign(root.pubSign)).not.toBe(orgIdFromRootPubSign(admin.pubSign));
  });

  it("admin 委任正簽正驗:回可信 adminPubSign 與 memberId", () => {
    const v = verifyOrgAdminCert(adminCert(), root.pubSign, NOW);
    expect(Buffer.from(v.adminPubSign).equals(Buffer.from(admin.pubSign))).toBe(true);
    expect(v.adminMemberId).toBe(admin.memberId);
    expect(v.notAfter).toBe(0); // 0 = 永久
  });

  it("非 root 簽的 admin 委任驗不過(擋自封管理員)", () => {
    expect(() => verifyOrgAdminCert(adminCert(0, mallory), root.pubSign, NOW)).toThrow(/驗證失敗/);
  });

  it("過期的 admin 委任驗不過(離職 admin 自然失效)", () => {
    expect(() => verifyOrgAdminCert(adminCert(NOW - 1), root.pubSign, NOW)).toThrow(/已過期/);
  });

  it("root 直簽團隊憑證:回當代 owner 公鑰與序號", () => {
    const blob = signOrgTeamCert(root.sign, teamClaims(), undefined);
    const v = verifyOrgTeamCert(blob, root.pubSign, "team-v", NOW);
    expect(Buffer.from(v.ownerPubSign).equals(Buffer.from(owner.pubSign))).toBe(true);
    expect(v.ownerMemberId).toBe(owner.memberId);
    expect(v.serial).toBe(3);
  });

  it("完整委任鏈:root 簽 admin、admin 簽團隊憑證,成員端只錨 root 即可驗到 owner", () => {
    const blob = signOrgTeamCert(admin.sign, teamClaims(), adminCert());
    const v = verifyOrgTeamCert(blob, root.pubSign, "team-v", NOW);
    expect(v.ownerMemberId).toBe(owner.memberId);
    expect(v.issuerMemberId).toBe(admin.memberId); // 稽核:是誰指派的
  });

  it("附合法委任卻由他人簽的團隊憑證驗不過(委任不可被冒用)", () => {
    const blob = signOrgTeamCert(mallory.sign, teamClaims(), adminCert());
    expect(() => verifyOrgTeamCert(blob, root.pubSign, "team-v", NOW)).toThrow(/驗證失敗/);
  });

  it("附偽造委任(非 root 簽)的團隊憑證驗不過(鏈上每一環都驗)", () => {
    const blob = signOrgTeamCert(admin.sign, teamClaims(), adminCert(0, mallory));
    expect(() => verifyOrgTeamCert(blob, root.pubSign, "team-v", NOW)).toThrow(/驗證失敗/);
  });

  it("已過期 admin 簽的團隊憑證驗不過(委任過期即整條鏈失效)", () => {
    const blob = signOrgTeamCert(admin.sign, teamClaims(), adminCert(NOW - 1));
    expect(() => verifyOrgTeamCert(blob, root.pubSign, "team-v", NOW)).toThrow(/已過期/);
  });

  it("跨 vault 挪用驗不過(vaultId 綁進簽章,由驗證者自帶)", () => {
    const blob = signOrgTeamCert(root.sign, teamClaims(), undefined);
    expect(() => verifyOrgTeamCert(blob, root.pubSign, "other-vault", NOW)).toThrow(/驗證失敗/);
  });

  it("竄改 owner 公鑰驗不過(惡意伺服器無法把 vault 指向自己的 owner)", () => {
    const blob = signOrgTeamCert(root.sign, teamClaims(), undefined);
    const tampered = Uint8Array.from(blob);
    const at = tampered.indexOf(owner.pubSign[0]!);
    tampered.set(mallory.pubSign, at);
    expect(() => verifyOrgTeamCert(tampered, root.pubSign, "team-v", NOW)).toThrow();
  });

  it("截斷的憑證驗不過(不完整即拒,不靜默略過)", () => {
    const blob = signOrgTeamCert(root.sign, teamClaims(), undefined);
    expect(() => verifyOrgTeamCert(blob.slice(0, blob.length - 10), root.pubSign, "team-v", NOW)).toThrow(/不完整|驗證失敗/);
  });
});
