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

  /**
   * i18next 的插值語法是雙大括號 {{name}};寫成單括號會原樣顯示在畫面上(0.20.0 真機走查踩到)。
   * 這種錯編譯與型別都攔不住,只有渲染出來才看得見——所以在此把規則固化。
   */
  it("插值佔位一律用雙大括號(單括號會原樣顯示給使用者)", () => {
    const singleBrace = /(?<!\{)\{[A-Za-z]\w*\}(?!\})/;
    for (const lang of languages) {
      for (const [key, value] of Object.entries(resources[lang].translation)) {
        expect(singleBrace.test(String(value)), `${lang}.${key} 用了單括號佔位:${String(value)}`).toBe(false);
      }
    }
  });

  it("同一 key 的插值變數在各語系一致(漏帶變數會顯示空白)", () => {
    const varsOf = (v: string): string[] => [...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
    const base = resources["zh-TW"].translation as Record<string, string>;
    for (const lang of languages) {
      const other = resources[lang].translation as Record<string, string>;
      for (const key of Object.keys(base)) {
        expect(varsOf(other[key] ?? ""), `${lang}.${key} 的插值變數與 zh-TW 不一致`).toEqual(varsOf(base[key]!));
      }
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
