import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const TOKEN = "測試用-token-1234567890";

function fetchText(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on("error", reject);
  });
}

describe("分享檢視器靜態服務", () => {
  let server: RunningServer;
  let store: SyncStore;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "stele-viewer-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Stele 分享</title><body>SHELL</body>");
    writeFileSync(join(dir, "viewer.js"), "console.log('viewer')");
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store, viewerDir: dir });
  });

  afterAll(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("健康檢查回 200", async () => {
    const res = await fetchText(server.port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("/s/<id> 一律回同一份 shell,shareId 不出現在回應中(伺服器全盲)", async () => {
    const res = await fetchText(server.port, "/s/AbC123secret");
    expect(res.status).toBe(200);
    expect(res.body).toContain("SHELL");
    expect(res.body).not.toContain("AbC123secret"); // shareId 只在前端解析,不回進頁面
  });

  it("/viewer.js 供得到 bundle", async () => {
    const res = await fetchText(server.port, "/viewer.js");
    expect(res.status).toBe(200);
    expect(res.body).toContain("viewer");
  });

  it("分享頁帶 CSP:預設全擋、腳本只信同源、不可被內嵌", async () => {
    const csp = String((await fetchText(server.port, "/s/AbC123")).headers["content-security-policy"] ?? "");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'"); // 沒有 unsafe-inline/unsafe-eval
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("connect-src 'self'"); // ws 回同源伺服器
    expect(csp).toContain("frame-ancestors 'none'"); // meta 版會被忽略,故下在 header
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("靜態回應帶 nosniff", async () => {
    const res = await fetchText(server.port, "/viewer.js");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("未知路徑回 404,不吃使用者路徑", async () => {
    expect((await fetchText(server.port, "/../../etc/passwd")).status).toBe(404);
    expect((await fetchText(server.port, "/random")).status).toBe(404);
  });
});
