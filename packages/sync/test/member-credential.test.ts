import { describe, it, expect, beforeAll } from "vitest";
import { generateSeed, deriveIdentity, signMemberCredential, verifyMemberCredential, type SyncIdentity } from "../src/index.ts";

/**
 * 成員憑證(P4 寫入真實性第一階段):owner 背書 memberId↔pubSign,供成員驗他人寫入作者。
 * 不變量:正簽正驗且 memberId 由 pubSign 導出;非 owner 簽、跨 vault、pubSign/角色竄改、截斷皆拒。
 */

describe("成員憑證簽發與驗證", () => {
  let owner: SyncIdentity;
  let member: SyncIdentity;
  let mallory: SyncIdentity;

  beforeAll(async () => {
    owner = await deriveIdentity(generateSeed());
    member = await deriveIdentity(generateSeed());
    mallory = await deriveIdentity(generateSeed());
  });

  const claims = () => ({ vaultId: "team-v", pubSign: member.pubSign, role: "editor" as const, epoch: 2 });

  it("正簽正驗:回可信 pubSign/role/epoch,memberId 由 pubSign 導出且等於成員自己的 memberId", () => {
    const blob = signMemberCredential(owner.sign, claims());
    const v = verifyMemberCredential(blob, owner.pubSign, "team-v");
    expect(v.role).toBe("editor");
    expect(v.epoch).toBe(2);
    expect(Buffer.from(v.pubSign).equals(Buffer.from(member.pubSign))).toBe(true);
    expect(v.memberId).toBe(member.memberId); // memberId = hex(sha256(pubSign)),與 identity 一致
  });

  it("非 owner 簽的憑證驗不過(盲中繼無法捏造成員公鑰目錄)", () => {
    const forged = signMemberCredential(mallory.sign, claims());
    expect(() => verifyMemberCredential(forged, owner.pubSign, "team-v")).toThrow(/驗證失敗/);
  });

  it("跨 vault 挪用驗不過(vaultId 綁進簽章,驗證者自帶)", () => {
    const blob = signMemberCredential(owner.sign, claims());
    expect(() => verifyMemberCredential(blob, owner.pubSign, "other-vault")).toThrow(/驗證失敗/);
  });

  it("blob 內 pubSign 被抽換即驗不過(惡意中繼無法把成員的公鑰換成攻擊者的)", () => {
    const blob = signMemberCredential(owner.sign, claims());
    const tampered = blob.slice();
    // pubSign 在 [版本1][role1][epoch1] 之後的 32B;把第一個位元組翻掉
    tampered[3] = (tampered[3]! ^ 0xff) & 0xff;
    expect(() => verifyMemberCredential(tampered, owner.pubSign, "team-v")).toThrow(/驗證失敗/);
  });

  it("role 或 epoch 被改寫即驗不過", () => {
    const blob = signMemberCredential(owner.sign, { ...claims(), role: "viewer" });
    const tampered = blob.slice();
    tampered[1] = 1; // viewer(2) → editor(1)
    expect(() => verifyMemberCredential(tampered, owner.pubSign, "team-v")).toThrow(/驗證失敗/);
  });

  it("截斷或版本不符即拋,不靜默", () => {
    const blob = signMemberCredential(owner.sign, claims());
    expect(() => verifyMemberCredential(blob.slice(0, blob.length - 1), owner.pubSign, "team-v")).toThrow(/不完整/);
    expect(() => verifyMemberCredential(new Uint8Array(), owner.pubSign, "team-v")).toThrow();
    const wrongVer = blob.slice();
    wrongVer[0] = 9;
    expect(() => verifyMemberCredential(wrongVer, owner.pubSign, "team-v")).toThrow(/版本/);
  });

  it("非法 pubSign 長度簽發即拒", () => {
    expect(() => signMemberCredential(owner.sign, { vaultId: "v", pubSign: new Uint8Array(16), role: "editor", epoch: 0 })).toThrow(/長度/);
  });
});
