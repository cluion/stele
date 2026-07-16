import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { VaultSession } from "../src/main/vault-session.ts";

const noop = { broadcastDoc() {}, notifyIndexUpdated() {} };

function makeVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "stele-vault-"));
  writeFileSync(path.join(dir, "a.md"), "# A\n");
  return dir;
}

describe("VaultSession", () => {
  it("destroy 會 flush debounce 中的鏡像,最後一刻的編輯不遺失", async () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc("a.md"));
    const text = replica.getText("md");
    text.insert(text.length, "最後一刻的編輯\n");
    session.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));

    await session.destroy(); // 立刻銷毀,不等 120ms debounce

    expect(readFileSync(path.join(dir, "a.md"), "utf8")).toContain("最後一刻的編輯");
  });

  it("openDoc 拒絕路徑遍歷與絕對路徑", () => {
    const session = new VaultSession(makeVault(), noop);
    expect(() => session.openDoc("../etc/passwd.md")).toThrow(/非法路徑/);
    expect(() => session.openDoc("/etc/passwd.md")).toThrow(/非法路徑/);
    expect(() => session.openDoc("a.txt")).toThrow(/非法路徑/);
  });

  it("create 拒絕遍歷分段並回傳補上副檔名的相對路徑", () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    expect(() => session.create("../外面")).toThrow(/非法路徑/);
    expect(session.create("新資料夾/新筆記")).toBe("新資料夾/新筆記.md");
    expect(readFileSync(path.join(dir, "新資料夾/新筆記.md"), "utf8")).toBe("# 新筆記\n");
  });
});

describe("每日筆記", () => {
  it("無模板時以預設內容建立,並回傳日記路徑", () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    const rel = session.daily("2026-07-16");
    expect(rel).toBe("日記/2026-07-16.md");
    expect(readFileSync(path.join(dir, rel), "utf8")).toBe("# 2026-07-16\n");
  });

  it("已存在時不覆寫既有內容", () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    const rel = session.daily("2026-07-16");
    writeFileSync(path.join(dir, rel), "已寫的內容\n");
    expect(session.daily("2026-07-16")).toBe(rel);
    expect(readFileSync(path.join(dir, rel), "utf8")).toBe("已寫的內容\n");
  });

  it("有模板時套用並替換 {{date}}", () => {
    const dir = makeVault();
    const tplDir = path.join(dir, "模板");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(path.join(tplDir, "每日.md"), "---\ntags: [daily]\n---\n\n# {{date}}\n\n- [ ] 今天要做\n");
    const session = new VaultSession(dir, noop);
    const content = readFileSync(path.join(dir, session.daily("2026-07-16")), "utf8");
    expect(content).toContain("# 2026-07-16");
    expect(content).toContain("- [ ] 今天要做");
    expect(content).not.toContain("{{date}}");
  });

  it(".stele/config.json 可自訂日記資料夾", () => {
    const dir = makeVault();
    mkdirSync(path.join(dir, ".stele"), { recursive: true });
    writeFileSync(path.join(dir, ".stele", "config.json"), JSON.stringify({ dailyFolder: "journal" }));
    const session = new VaultSession(dir, noop);
    expect(session.daily("2026-07-16")).toBe("journal/2026-07-16.md");
  });

  it("非法日期與逃逸的 dailyFolder 被拒", () => {
    const dir = makeVault();
    mkdirSync(path.join(dir, ".stele"), { recursive: true });
    writeFileSync(path.join(dir, ".stele", "config.json"), JSON.stringify({ dailyFolder: "../外面" }));
    const session = new VaultSession(dir, noop);
    expect(() => session.daily("16-07-2026")).toThrow(/非法日期/);
    expect(() => session.daily("2026-07-16")).toThrow(/非法路徑/);
  });
});
