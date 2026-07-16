import { describe, it, expect } from "vitest";
import { resources } from "../src/renderer/i18n.ts";

const keysOf = (obj: Record<string, unknown>): string[] => Object.keys(obj).sort();

describe("i18n 缺譯檢查", () => {
  const languages = Object.keys(resources) as Array<keyof typeof resources>;

  it("至少有 zh-TW 與 en 兩個語系", () => {
    expect(languages).toContain("zh-TW");
    expect(languages).toContain("en");
  });

  it("所有語系的 key 完全對等,沒有缺譯", () => {
    const base = keysOf(resources["zh-TW"].translation);
    for (const lang of languages) {
      expect(keysOf(resources[lang].translation), `語系 ${lang} 與 zh-TW 的 key 不一致`).toEqual(base);
    }
  });

  it("沒有空字串的翻譯", () => {
    for (const lang of languages) {
      for (const [key, value] of Object.entries(resources[lang].translation)) {
        expect(String(value).trim(), `${lang}.${key} 是空的`).not.toBe("");
      }
    }
  });
});
