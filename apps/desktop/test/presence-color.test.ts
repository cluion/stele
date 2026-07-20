import { describe, it, expect } from "vitest";
import { colorFor } from "../src/main/presence-color.ts";

/**
 * 在場指示與留言作者共用同一套色相衍生:同一 deviceId 必得同色、必為非空色碼。
 * 這是留言作者上色時純本地身分不缺色的守門(見 settings.localIdentity 與 SyncManager.identity)。
 */
describe("colorFor", () => {
  it("對同一 deviceId 穩定同色", () => {
    expect(colorFor("device-abc")).toBe(colorFor("device-abc"));
  });

  it("永遠回非空色碼(# 開頭)", () => {
    for (const id of ["", "x", "device-abc", "00000000-0000-0000-0000-000000000000"]) {
      expect(colorFor(id)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("不同 deviceId 至少能落在不同色相(不是全部同一色)", () => {
    const colors = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(colorFor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
