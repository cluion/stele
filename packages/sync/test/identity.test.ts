import { describe, it, expect } from "vitest";
import {
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  verifyChallenge,
  exportIdentity,
  importIdentity,
} from "../src/index.ts";

const nonce = () => new Uint8Array(32).fill(3);

describe("成員身分金鑰", () => {
  it("同種子確定性重生同 memberId 與公鑰", async () => {
    const seed = generateSeed();
    const a = await deriveIdentity(seed);
    const b = await deriveIdentity(seed.slice());
    expect(b.memberId).toBe(a.memberId);
    expect([...b.pubSign]).toEqual([...a.pubSign]);
    expect([...b.pubWrap]).toEqual([...a.pubWrap]);
  });

  it("不同種子得不同身分,公鑰長度正確", async () => {
    const a = await deriveIdentity(generateSeed());
    const b = await deriveIdentity(generateSeed());
    expect(a.memberId).not.toBe(b.memberId);
    expect(a.pubSign.length).toBe(32);
    expect(a.pubWrap.length).toBe(32);
    // 簽章與 wrap 是兩把獨立子金鑰,公鑰不相同
    expect([...a.pubSign]).not.toEqual([...a.pubWrap]);
  });

  it("memberId 是 64 hex(sha256)", async () => {
    const { memberId } = await deriveIdentity(generateSeed());
    expect(memberId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("簽章往返:對的驗得過,竄改任一項驗不過", async () => {
    const id = await deriveIdentity(generateSeed());
    const n = nonce();
    const sig = id.sign(identityChallengeBytes(n, "v1", id.memberId));

    expect(verifyChallenge(sig, n, "v1", id.memberId, id.pubSign)).toBe(true);
    // 竄改簽章 1 bit
    const bad = sig.slice();
    bad[0] = bad[0]! ^ 1;
    expect(verifyChallenge(bad, n, "v1", id.memberId, id.pubSign)).toBe(false);
    // 換 nonce(重放防線)
    expect(verifyChallenge(sig, new Uint8Array(32).fill(9), "v1", id.memberId, id.pubSign)).toBe(false);
    // 換 vaultId(跨 vault 挪用防線)
    expect(verifyChallenge(sig, n, "v2", id.memberId, id.pubSign)).toBe(false);
    // 換公鑰(別人的簽章)
    const other = await deriveIdentity(generateSeed());
    expect(verifyChallenge(sig, n, "v1", id.memberId, other.pubSign)).toBe(false);
  });

  it("export → import 往返得回同一身分", async () => {
    const seed = generateSeed();
    const id = await deriveIdentity(seed);
    const file = exportIdentity(seed, id.memberId);
    expect(file.format).toBe("stele-identity-v1");
    expect(file.enc).toBeNull();

    const back = importIdentity(file);
    expect([...back]).toEqual([...seed]);
    const reid = await deriveIdentity(back);
    expect(reid.memberId).toBe(id.memberId);
  });

  it("import 壞檔:格式/長度不符即拋", () => {
    expect(() => importIdentity(null)).toThrow();
    expect(() => importIdentity({ format: "x", seed: "AAAA" })).toThrow(/版本/);
    expect(() => importIdentity({ format: "stele-identity-v1", seed: "AAAA" })).toThrow(/長度/);
  });
});
