import { describe, it, expect, beforeAll } from "vitest";
import { generateSeed, deriveIdentity, signOrgAdminCert, signOrgMemberCert, verifyOrgMemberCert, type SyncIdentity } from "../src/index.ts";

/**
 * 組織名冊(3b-1):組織為「memberId ↔ 顯示名」背書,讓協作與留言上的名字從自我宣稱的字串
 * 升級為可驗資料(現況是 sync.json 的自選 displayName,任何人都能自稱任何名字)。
 * 不變量:非組織鏈簽的條目一律不採信;竄改名字驗不過;序號單調可反回滾;委任的 admin 也能簽。
 */

describe("組織名冊條目", () => {
  let root: SyncIdentity;
  let admin: SyncIdentity;
  let mallory: SyncIdentity;
  const NOW = 1_800_000_000;
  const MEMBER = "a".repeat(64);

  beforeAll(async () => {
    root = await deriveIdentity(generateSeed());
    admin = await deriveIdentity(generateSeed());
    mallory = await deriveIdentity(generateSeed());
  });

  const claims = () => ({ memberId: MEMBER, displayName: "王小明", department: "工程部", serial: 2 });

  it("正簽正驗:回可信的顯示名與部門", () => {
    const v = verifyOrgMemberCert(signOrgMemberCert(root.sign, claims(), undefined), root.pubSign, MEMBER, NOW);
    expect(v.displayName).toBe("王小明");
    expect(v.department).toBe("工程部");
    expect(v.serial).toBe(2);
  });

  it("委任的 admin 簽發同樣有效(root 可離線)", () => {
    const adminCert = signOrgAdminCert(root.sign, { adminPubSign: admin.pubSign, notAfter: 0 });
    const v = verifyOrgMemberCert(signOrgMemberCert(admin.sign, claims(), adminCert), root.pubSign, MEMBER, NOW);
    expect(v.displayName).toBe("王小明");
  });

  it("非組織鏈簽的條目驗不過(擋任何人自稱任何名字)", () => {
    expect(() => verifyOrgMemberCert(signOrgMemberCert(mallory.sign, claims(), undefined), root.pubSign, MEMBER, NOW)).toThrow(/驗證失敗/);
  });

  it("挪用他人的條目驗不過(memberId 綁進簽章,由驗證者自帶)", () => {
    const blob = signOrgMemberCert(root.sign, claims(), undefined);
    expect(() => verifyOrgMemberCert(blob, root.pubSign, "b".repeat(64), NOW)).toThrow(/驗證失敗/);
  });

  it("過期委任簽的條目驗不過(離職 admin 改不動名冊)", () => {
    const expired = signOrgAdminCert(root.sign, { adminPubSign: admin.pubSign, notAfter: NOW - 1 });
    expect(() => verifyOrgMemberCert(signOrgMemberCert(admin.sign, claims(), expired), root.pubSign, MEMBER, NOW)).toThrow(/已過期/);
  });

  it("部門可省略;顯示名長度上限擋灌爆版面", () => {
    const v = verifyOrgMemberCert(
      signOrgMemberCert(root.sign, { memberId: MEMBER, displayName: "小明", serial: 1 }, undefined),
      root.pubSign,
      MEMBER,
      NOW,
    );
    expect(v.department).toBeUndefined();
    expect(() => signOrgMemberCert(root.sign, { memberId: MEMBER, displayName: "長".repeat(200), serial: 1 }, undefined)).toThrow(/顯示名/);
  });

  it("截斷的條目驗不過(不完整即拒)", () => {
    const blob = signOrgMemberCert(root.sign, claims(), undefined);
    expect(() => verifyOrgMemberCert(blob.slice(0, blob.length - 8), root.pubSign, MEMBER, NOW)).toThrow(/不完整|驗證失敗/);
  });
});
