import { describe, it, expect } from "vitest";
import { ADMIN_EVENT_KINDS, ADMIN_EVENT_LABEL } from "../src/admin-events.ts";

/**
 * 管理事件標籤的完備性。走查抓過一次:新增事件種類卻忘了補標籤,
 * 管理員在 CLI 看到的是 `enroll-batch-created` 這種原始代號。型別檢查擋不住
 * (Record 的鍵漏了才會紅,但當時標籤表在別的檔、鍵是寬鬆的 string),固化成測試。
 */

describe("管理事件標籤", () => {
  it("每個種類都有人話標籤,且不是原始代號", () => {
    for (const kind of ADMIN_EVENT_KINDS) {
      const label = ADMIN_EVENT_LABEL[kind];
      expect(label, `種類 ${kind} 缺標籤`).toBeTruthy();
      expect(label, `種類 ${kind} 的標籤還是原始代號`).not.toBe(kind);
      expect(label).not.toMatch(/[a-z]+-[a-z]/); // kebab-case 代號漏進來就是沒翻
    }
  });

  it("標籤表沒有多餘的鍵(種類刪掉後標籤要跟著清)", () => {
    expect(Object.keys(ADMIN_EVENT_LABEL).sort()).toEqual([...ADMIN_EVENT_KINDS].sort());
  });
});
