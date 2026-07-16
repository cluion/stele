import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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
