import { describe, it, expect } from "vitest";
import { loadOrCreateIdentity, hasIdentity } from "../src/identity.ts";
import type { SecretStore } from "../src/secrets.ts";

/**
 * 身分保管的規則只有兩條,但兩條都攸關「使用者會不會突然變成陌生人」:
 * 同一台裝置必須拿到同一個 memberId,而讀不出來的身分要當場拋、不准默默重生。
 */

class MemorySecrets implements SecretStore {
  readonly items = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.items.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.items.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.items.delete(key);
    return Promise.resolve();
  }
}

describe("行動端身分保管", () => {
  it("第一次生成並存起來,第二次拿到同一個身分", async () => {
    const secrets = new MemorySecrets();
    expect(await hasIdentity(secrets)).toBe(false);

    const first = await loadOrCreateIdentity(secrets);
    expect(await hasIdentity(secrets)).toBe(true);

    const second = await loadOrCreateIdentity(secrets);
    expect(second.memberId).toBe(first.memberId);
    expect(second.pubSign).toEqual(first.pubSign);
    expect(second.pubWrap).toEqual(first.pubWrap);
  });

  it("不同裝置是不同身分(種子是隨機的)", async () => {
    const a = await loadOrCreateIdentity(new MemorySecrets());
    const b = await loadOrCreateIdentity(new MemorySecrets());
    expect(a.memberId).not.toBe(b.memberId);
  });

  it("存的是版本化信封,不是裸種子", async () => {
    const secrets = new MemorySecrets();
    const identity = await loadOrCreateIdentity(secrets);
    const stored = JSON.parse(secrets.items.get("member-identity")!) as Record<string, unknown>;
    expect(stored["format"]).toBe("stele-identity-v1");
    expect(stored["memberId"]).toBe(identity.memberId);
    expect(typeof stored["seed"]).toBe("string");
  });

  it("身分壞掉就拋,不默默換一個新身分", async () => {
    const secrets = new MemorySecrets();
    const original = await loadOrCreateIdentity(secrets);

    for (const broken of ["{}", "不是 JSON", JSON.stringify({ format: "stele-identity-v1", seed: "太短", enc: null })]) {
      secrets.items.set("member-identity", broken);
      await expect(loadOrCreateIdentity(secrets)).rejects.toThrow();
      // 而且不能順手把壞的蓋掉——蓋掉就等於重生
      expect(secrets.items.get("member-identity")).toBe(broken);
    }

    expect(original.memberId).toHaveLength(64); // hex(SHA-256(pubSign))
  });
});
