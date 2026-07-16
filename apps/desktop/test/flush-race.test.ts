import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";

// 拖慢鏡像寫回的 writeFile,重現「flush 已觸發、磁碟 I/O 未完成」的競態窗口
const io = vi.hoisted(() => ({ writeDelayMs: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (io.writeDelayMs > 0) await new Promise((r) => setTimeout(r, io.writeDelayMs));
      return real.writeFile(...args);
    },
  };
});

import { VaultSession } from "../src/main/vault-session.ts";

const noop = {
  broadcastDoc() {},
  notifyIndexUpdated() {},
  async trash(absPath: string) {
    const { rmSync } = await import("node:fs");
    rmSync(absPath);
  },
};

describe("flush 競態", () => {
  it("rename 等待 in-flight flush:舊路徑不復活,manifest 無鬼影項目", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-race-"));
    writeFileSync(path.join(dir, "a.md"), "# A\n");
    const session = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc("a.md"));
    replica.getText("md").insert(replica.getText("md").length, "競態編輯\n");

    io.writeDelayMs = 250;
    session.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));
    await new Promise((r) => setTimeout(r, 150)); // debounce 已觸發,writeFile 還卡著
    const newRel = await session.rename("a.md", "改名後");
    io.writeDelayMs = 0;
    await new Promise((r) => setTimeout(r, 500)); // 若 destroy 沒等 in-flight flush,舊檔會在這期間復活

    expect(existsSync(path.join(dir, "a.md"))).toBe(false);
    expect(readFileSync(path.join(dir, newRel), "utf8")).toContain("競態編輯");
    const manifest = JSON.parse(readFileSync(path.join(dir, ".stele", "docs.json"), "utf8")) as {
      docs: Record<string, string>;
    };
    expect(manifest.docs).not.toHaveProperty("a.md");
    expect(manifest.docs).toHaveProperty(newRel);
    await session.destroy();
  });

  it("delete 等待 in-flight flush:刪掉的筆記不復活", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-race-"));
    writeFileSync(path.join(dir, "a.md"), "# A\n");
    const session = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc("a.md"));
    replica.getText("md").insert(replica.getText("md").length, "臨終編輯\n");

    io.writeDelayMs = 250;
    session.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));
    await new Promise((r) => setTimeout(r, 150));
    await session.delete("a.md");
    io.writeDelayMs = 0;
    await new Promise((r) => setTimeout(r, 500));

    expect(existsSync(path.join(dir, "a.md"))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(dir, ".stele", "docs.json"), "utf8")) as {
      docs: Record<string, string>;
    };
    expect(manifest.docs).not.toHaveProperty("a.md");
    await session.destroy();
  });
});
