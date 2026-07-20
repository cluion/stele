import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SPACE_ID } from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";
import { SpacesService } from "../src/main/spaces-service.ts";

/**
 * 空間不需要同步:未啟用同步的純本地 vault,建立/改名/移動/複製/稽核全部可用。
 * 這是 meta doc 從同步層抽離的驗收不變量——回歸的話,側欄會退回平面清單。
 */

const noop = {
  broadcastDoc() {},
  notifyIndexUpdated() {},
  trash(absPath: string) {
    rmSync(absPath, { force: true });
    return Promise.resolve();
  },
};

interface Local {
  dir: string;
  session: VaultSession;
  meta: VaultMeta;
  spaces: SpacesService;
}

const opened: Local[] = [];

/** 開一個純本地 vault:沒有 SyncManager、沒有 setSyncHooks */
function openLocal(seed: Record<string, string> = {}, dir = mkdtempSync(path.join(tmpdir(), "stele-local-"))): Local {
  for (const [rel, c] of Object.entries(seed)) writeFileSync(path.join(dir, rel), c);
  const session = new VaultSession(dir, noop);
  const meta = new VaultMeta(dir);
  const local = { dir, session, meta, spaces: new SpacesService(meta, session) };
  opened.push(local);
  return local;
}

const read = (l: Local, rel: string): string => readFileSync(path.join(l.dir, rel), "utf8");

afterEach(async () => {
  for (const l of opened.splice(0)) {
    l.meta.stop();
    await l.session.destroy();
  }
});

describe("空間在未啟用同步時完整可用", () => {
  it("建立與改名空間", () => {
    const { spaces } = openLocal();
    expect(spaces.listSpaces().map((s) => s.id)).toEqual([DEFAULT_SPACE_ID]);

    const id = spaces.createSpace("工作");
    expect(spaces.listSpaces().find((s) => s.id === id)?.name).toBe("工作");

    spaces.renameSpace(id, "工作區");
    expect(spaces.listSpaces().find((s) => s.id === id)?.name).toBe("工作區");
  });

  it("移動筆記改歸屬,沒有同步也不拋錯", async () => {
    const { spaces } = openLocal({ "筆記.md": "內容\n" });
    expect(spaces.spaceOfNote("筆記.md")).toBe(DEFAULT_SPACE_ID);

    const id = spaces.createSpace("工作");
    await spaces.moveNoteToSpace("筆記.md", id);

    expect(spaces.spaceOfNote("筆記.md")).toBe(id);
    expect(spaces.overview().assignments["筆記.md"]).toBe(id);
  });

  it("複製筆記到空間:副本落在目標空間,原筆記原封不動", () => {
    const local = openLocal({ "計畫.md": "計畫內容\n" });
    const id = local.spaces.createSpace("工作");

    const copyRel = local.spaces.copyNoteToSpace("計畫.md", id);

    expect(copyRel).not.toBe("計畫.md");
    expect(read(local, copyRel)).toBe("計畫內容\n");
    expect(read(local, "計畫.md")).toBe("計畫內容\n");
    expect(local.spaces.spaceOfNote(copyRel)).toBe(id);
    expect(local.spaces.spaceOfNote("計畫.md")).toBe(DEFAULT_SPACE_ID);
  });

  it("稽核紀錄逐筆留存建立、改名、移動、複製", async () => {
    const { spaces } = openLocal({ "筆記.md": "內容\n" });
    const id = spaces.createSpace("工作");
    spaces.renameSpace(id, "工作區");
    await spaces.moveNoteToSpace("筆記.md", id);
    spaces.copyNoteToSpace("筆記.md", DEFAULT_SPACE_ID);

    expect(spaces.readAudit().map((e) => e.kind)).toEqual(["space-created", "space-renamed", "note-moved", "note-copied"]);
  });

  it("關掉再開:空間與歸屬從 .stele/meta.ybin 讀回", async () => {
    const first = openLocal({ "筆記.md": "內容\n" });
    const id = first.spaces.createSpace("工作");
    await first.spaces.moveNoteToSpace("筆記.md", id);
    const { dir } = first;

    first.meta.stop();
    await first.session.destroy();
    opened.length = 0;

    const again = openLocal({}, dir);
    expect(again.spaces.listSpaces().find((s) => s.id === id)?.name).toBe("工作");
    expect(again.spaces.spaceOfNote("筆記.md")).toBe(id);
  });
});
