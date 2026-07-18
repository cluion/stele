import { describe, it, expect } from "vitest";
import { parseConsumeLink } from "../src/main/share-link.ts";

const KEY32 = Buffer.alloc(32, 7).toString("base64url");

describe("parseConsumeLink", () => {
  it("從完整 https 分享連結取出 wsUrl、shareId、32-byte 金鑰", () => {
    const link = parseConsumeLink(`https://sync.example.com/s/abc123XYZ_-#k=${KEY32}`);
    expect(link).toBeDefined();
    expect(link!.wsUrl).toBe("wss://sync.example.com/");
    expect(link!.shareId).toBe("abc123XYZ_-");
    expect(link!.key.length).toBe(32);
  });

  it("http 連結對應 ws、帶埠號保留 host", () => {
    const link = parseConsumeLink(`http://localhost:4800/s/xyz#k=${KEY32}`);
    expect(link!.wsUrl).toBe("ws://localhost:4800/");
    expect(link!.shareId).toBe("xyz");
  });

  it("金鑰在 fragment 而非 query,伺服器拿不到", () => {
    const link = parseConsumeLink(`https://h/s/id#k=${KEY32}`);
    expect(link!.key.every((b) => b === 7)).toBe(true);
  });

  it("缺金鑰、金鑰長度不符、非分享路徑、爛 URL 一律 undefined", () => {
    expect(parseConsumeLink("https://h/s/id")).toBeUndefined();
    expect(parseConsumeLink(`https://h/s/id#k=${Buffer.alloc(16).toString("base64url")}`)).toBeUndefined();
    expect(parseConsumeLink(`https://h/notshare#k=${KEY32}`)).toBeUndefined();
    expect(parseConsumeLink("這不是網址")).toBeUndefined();
    expect(parseConsumeLink("")).toBeUndefined();
  });
});
