import { describe, it, expect } from "vitest";
import { parseShareLink, b64urlDecode } from "../src/share-link.ts";

const key32 = Buffer.from(new Uint8Array(32).map((_, i) => i));
const k = key32.toString("base64url");

describe("parseShareLink", () => {
  it("從路徑取 shareId、從 fragment 取 32 bytes 金鑰", () => {
    const link = parseShareLink("/s/AbC123_-", `#k=${k}`);
    expect(link).toBeDefined();
    expect(link!.shareId).toBe("AbC123_-");
    expect(Buffer.from(link!.key).toString("base64url")).toBe(k);
  });

  it("金鑰只讀 fragment:金鑰若在 query,hash 為空則解析失敗(伺服器拿不到)", () => {
    // 檢視器只餵 location.hash;金鑰放 query 時 hash 為空,自然解不出金鑰
    expect(parseShareLink("/s/AbC123", "")).toBeUndefined();
  });

  it("缺 shareId 或缺金鑰都回 undefined", () => {
    expect(parseShareLink("/", `#k=${k}`)).toBeUndefined();
    expect(parseShareLink("/s/AbC123", "#")).toBeUndefined();
    expect(parseShareLink("/s/AbC123", "")).toBeUndefined();
  });

  it("金鑰長度不是 32 bytes 一律拒絕", () => {
    const short = Buffer.from(new Uint8Array(16)).toString("base64url");
    expect(parseShareLink("/s/AbC123", `#k=${short}`)).toBeUndefined();
  });

  it("非法 base64 不丟例外,回 undefined", () => {
    expect(parseShareLink("/s/AbC123", "#k=!!!not base64!!!")).toBeUndefined();
  });

  it("b64urlDecode 還原位元組", () => {
    expect(Array.from(b64urlDecode(k))).toEqual(Array.from(key32));
  });
});
