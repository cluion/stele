import { describe, it, expect } from "vitest";
import { wrapKey, unwrapKey, type WrapContext } from "../src/index.ts";
import { deriveIdentity, generateSeed } from "../src/index.ts";
import { x25519 } from "@noble/curves/ed25519.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rootKey = () => new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

/** 一個成員的 x25519 秘鑰對(測試用):秘鑰供 unwrap,公鑰供 wrap */
function member() {
  const secret = x25519.utils.randomSecretKey();
  return { secret, pubWrap: x25519.getPublicKey(secret) };
}

const ctx = (over: Partial<WrapContext> = {}): WrapContext => ({
  vaultId: "vault-A",
  keyId: "root",
  epoch: 0,
  recipientMemberId: "member-64hex",
  ...over,
});

describe("空間金鑰信封 wrap/unwrap", () => {
  it("round-trip:owner 包給某成員,該成員解回原 root", async () => {
    const owner = await deriveIdentity(generateSeed());
    const m = member();
    const root = rootKey();
    const env = await wrapKey(root, m.pubWrap, owner.sign, ctx());
    const back = await unwrapKey(env, m.secret, owner.pubSign, ctx());
    expect(hex(back)).toBe(hex(root));
  });

  it("信封對伺服器不透明:密文不含 root 明文", async () => {
    const owner = await deriveIdentity(generateSeed());
    const m = member();
    const root = rootKey();
    const env = await wrapKey(root, m.pubWrap, owner.sign, ctx());
    expect(hex(env)).not.toContain(hex(root));
  });

  it("不同 recipient 的 xSecret 解不出(ECDH 綁 recipient)", async () => {
    const owner = await deriveIdentity(generateSeed());
    const m = member();
    const other = member();
    const env = await wrapKey(rootKey(), m.pubWrap, owner.sign, ctx());
    await expect(unwrapKey(env, other.secret, owner.pubSign, ctx())).rejects.toThrow();
  });

  it("context 綁定:跨 vault / 跨 keyId / 跨 epoch / 換 recipientMemberId 挪用必失敗", async () => {
    const owner = await deriveIdentity(generateSeed());
    const m = member();
    const env = await wrapKey(rootKey(), m.pubWrap, owner.sign, ctx());
    await expect(unwrapKey(env, m.secret, owner.pubSign, ctx({ vaultId: "vault-B" }))).rejects.toThrow();
    await expect(unwrapKey(env, m.secret, owner.pubSign, ctx({ keyId: "space-x" }))).rejects.toThrow();
    await expect(unwrapKey(env, m.secret, owner.pubSign, ctx({ epoch: 1 }))).rejects.toThrow();
    await expect(unwrapKey(env, m.secret, owner.pubSign, ctx({ recipientMemberId: "someone-else" }))).rejects.toThrow();
  });

  it("owner 簽章:換 owner pubSign 驗不過(擋盲中繼偽造整個 vault)", async () => {
    const owner = await deriveIdentity(generateSeed());
    const impostor = await deriveIdentity(generateSeed());
    const m = member();
    const env = await wrapKey(rootKey(), m.pubWrap, owner.sign, ctx());
    await expect(unwrapKey(env, m.secret, impostor.pubSign, ctx())).rejects.toThrow();
  });

  it("篡改 ephPub 必拒(簽章涵蓋 ephPub)", async () => {
    const owner = await deriveIdentity(generateSeed());
    const m = member();
    const env = await wrapKey(rootKey(), m.pubWrap, owner.sign, ctx());
    const tampered = env.slice();
    tampered[1] = tampered[1]! ^ 1; // ephPub 第一 byte
    await expect(unwrapKey(tampered, m.secret, owner.pubSign, ctx())).rejects.toThrow();
  });

  it("篡改密文必拒(GCM tag / 簽章)", async () => {
    const owner = await deriveIdentity(generateSeed());
    const m = member();
    const env = await wrapKey(rootKey(), m.pubWrap, owner.sign, ctx());
    const tampered = env.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await expect(unwrapKey(tampered, m.secret, owner.pubSign, ctx())).rejects.toThrow();
  });

  it("self-envelope:owner 用自己的 pubWrap 包、自己的 xSecret 解(跨裝置復原路徑)", async () => {
    const seed = generateSeed();
    const owner = await deriveIdentity(seed);
    const root = rootKey();
    const env = await wrapKey(root, owner.pubWrap, owner.sign, ctx({ recipientMemberId: owner.memberId }));
    // 另一裝置匯入同 seed → 同身分 → 同 unwrap 能力
    const back = await owner.unwrap(env, owner.pubSign, ctx({ recipientMemberId: owner.memberId }));
    expect(hex(back)).toBe(hex(root));
  });

  it("identity.unwrap 與 unwrapKey 等價(xSecret 留閉包)", async () => {
    const owner = await deriveIdentity(generateSeed());
    const recipient = await deriveIdentity(generateSeed());
    const root = rootKey();
    const c = ctx({ recipientMemberId: recipient.memberId });
    const env = await wrapKey(root, recipient.pubWrap, owner.sign, c);
    const back = await recipient.unwrap(env, owner.pubSign, c);
    expect(hex(back)).toBe(hex(root));
  });
});
