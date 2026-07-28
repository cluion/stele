import { describe, it, expect, beforeAll } from "vitest";
import {
  generateSeed,
  deriveIdentity,
  signAwarenessIdentity,
  verifyAwarenessIdentity,
  type SyncIdentity,
  type AwarenessIdentityClaims,
} from "../src/index.ts";

/**
 * 游標名簽章(3b-1 收尾):成員對「我在這個 doc 以這個名字在場」的簽章。
 * 不變量:正簽正驗;換公鑰、改名字/顏色/memberId、跨 doc/紀元/clientId 皆驗不過。
 * 綁 clientId 是重點:否則任何人能把他人的宣告複製到自己的 awareness 槽位上冒名。
 */

describe("游標名簽章", () => {
  let member: SyncIdentity;
  let other: SyncIdentity;

  beforeAll(async () => {
    member = await deriveIdentity(generateSeed());
    other = await deriveIdentity(generateSeed());
  });

  const base = (): AwarenessIdentityClaims => ({
    docId: "doc-1",
    epoch: 2,
    clientId: 12345,
    memberId: member.memberId,
    name: "阿甲",
    color: "#0e7b93",
  });

  it("正簽正驗", () => {
    const sig = signAwarenessIdentity(member.sign, base());
    expect(verifyAwarenessIdentity(sig, member.pubSign, base())).toBe(true);
  });

  it("換公鑰驗不過(擋冒名)", () => {
    const sig = signAwarenessIdentity(member.sign, base());
    expect(verifyAwarenessIdentity(sig, other.pubSign, base())).toBe(false);
  });

  it("改名字或顏色即驗不過(名字被簽章綁死,中繼改不了)", () => {
    const sig = signAwarenessIdentity(member.sign, base());
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), name: "阿乙" })).toBe(false);
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), color: "#ff0000" })).toBe(false);
  });

  it("挪用到別的 doc / 紀元 / clientId 驗不過", () => {
    const sig = signAwarenessIdentity(member.sign, base());
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), docId: "doc-2" })).toBe(false);
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), epoch: 3 })).toBe(false);
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), clientId: 999 })).toBe(false);
  });

  it("改 memberId 驗不過(不能宣稱是別人)", () => {
    const sig = signAwarenessIdentity(member.sign, base());
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), memberId: other.memberId })).toBe(false);
  });

  it("長度不符或亂數簽章一律 false,不拋", () => {
    expect(verifyAwarenessIdentity(new Uint8Array(10), member.pubSign, base())).toBe(false);
    expect(verifyAwarenessIdentity(new Uint8Array(64), member.pubSign, base())).toBe(false);
  });

  it("顯示名超長拒簽(名字會進游標標籤,過長灌爆版面)", () => {
    expect(() => signAwarenessIdentity(member.sign, { ...base(), name: "字".repeat(65) })).toThrow();
  });

  it("驗證端也擋超長名字(對方換掉自己的用戶端就繞過了本地檢查)", () => {
    const sig = signAwarenessIdentity(member.sign, base());
    expect(verifyAwarenessIdentity(sig, member.pubSign, { ...base(), name: "字".repeat(65) })).toBe(false);
  });
});
