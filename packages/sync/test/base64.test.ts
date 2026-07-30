import { describe, it, expect } from "vitest";
import {
  bytesToBase64,
  base64ToBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  utf8ToBase64Url,
  base64UrlToUtf8,
} from "../src/base64.ts";

/**
 * 這一層存在的理由是「同一份同步層要在 Node 與 WebView 都跑得動」,所以測試的重點不是
 * 「自己跟自己往返得回來」——那太容易對——而是**與 Node 的 `Buffer` 位元相同**。
 * 已經發出去的邀請碼是拿 Buffer 編的,對不上就等於把既有的碼全部作廢。
 */

const samples: Uint8Array[] = [
  new Uint8Array(0),
  new Uint8Array([0]),
  new Uint8Array([0xff, 0x00, 0xfe]),
  new Uint8Array([1, 2, 3, 4]), // 長度 4 的倍數:base64url 無 padding
  new Uint8Array(32).fill(7), // 公鑰的長度
  Uint8Array.from({ length: 255 }, (_, i) => i),
];

describe("base64", () => {
  it("與 Node Buffer 的 base64 輸出完全一致", () => {
    for (const bytes of samples) {
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("與 Node Buffer 的 base64url 輸出完全一致(含無 padding)", () => {
    for (const bytes of samples) {
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("解得回 Buffer 編出來的東西(舊邀請碼不會作廢)", () => {
    for (const bytes of samples) {
      expect(base64ToBytes(Buffer.from(bytes).toString("base64"))).toEqual(bytes);
      expect(base64UrlToBytes(Buffer.from(bytes).toString("base64url"))).toEqual(bytes);
    }
  });

  it("往返不失真", () => {
    for (const bytes of samples) {
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("非 ASCII 文字先過 UTF-8 才編碼(團隊名有中文是常態,不是邊角)", () => {
    for (const text of ["", "hello", "設計部的知識庫", "emoji 🗿 也要活著回來", '{"a":"引號與\\\\反斜線"}']) {
      expect(utf8ToBase64Url(text)).toBe(Buffer.from(text, "utf8").toString("base64url"));
      expect(base64UrlToUtf8(utf8ToBase64Url(text))).toBe(text);
    }
  });

  it("不是合法 base64 就拋,不默默回半截資料", () => {
    expect(() => base64ToBytes("!!!not base64!!!")).toThrow();
  });
});
