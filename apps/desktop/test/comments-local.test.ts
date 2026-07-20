import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { addThread, addReply, readThreads } from "@stele/editor-core";
import { VaultSession } from "../src/main/vault-session.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";
import { CommentStore } from "../src/main/comment-store.ts";

/**
 * 留言不需要同步:未啟用同步的純本地 vault 一樣能留言、回覆、跨重啟保存,
 * 且留言絕不進 .md。這是留言 doc 從同步層抽離的驗收不變量。
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
  comments: CommentStore;
}

const opened: Local[] = [];

function openLocal(seed: Record<string, string> = {}, dir = mkdtempSync(path.join(tmpdir(), "stele-cmt-local-"))): Local {
  for (const [rel, c] of Object.entries(seed)) writeFileSync(path.join(dir, rel), c);
  const session = new VaultSession(dir, noop);
  const meta = new VaultMeta(dir);
  const local = { dir, session, meta, comments: new CommentStore(meta, session) };
  opened.push(local);
  return local;
}

async function closeAll(): Promise<void> {
  for (const l of opened.splice(0)) {
    l.comments.stop();
    l.meta.stop();
    await l.session.destroy();
  }
}

/** 以 renderer 的方式對留言 doc 下一筆變更 */
function edit(l: Local, rel: string, mutate: (doc: Y.Doc) => void): void {
  const rep = new Y.Doc();
  Y.applyUpdate(rep, l.comments.open(rel));
  const sv = Y.encodeStateVector(rep);
  mutate(rep);
  l.comments.push(rel, Y.encodeStateAsUpdate(rep, sv));
}

const threadsOf = (l: Local, rel: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, l.comments.open(rel));
  return readThreads(doc);
};

afterEach(closeAll);

describe("留言在未啟用同步時完整可用", () => {
  it("留言與回覆存得住,且不進 .md", () => {
    const local = openLocal({ "文.md": "原文一行\n" });

    edit(local, "文.md", (doc) =>
      addThread(doc, { id: "t1", anchor: { a: "AA", h: "BB" }, author: "me", name: "我", body: "這裡要改", createdAt: 1 }),
    );
    edit(local, "文.md", (doc) => addReply(doc, "t1", { id: "r1", author: "me", name: "我", body: "補充", createdAt: 2 }));

    const threads = threadsOf(local, "文.md");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.body).toBe("這裡要改");
    expect(threads[0]!.replies[0]!.body).toBe("補充");
    expect(readFileSync(path.join(local.dir, "文.md"), "utf8")).toBe("原文一行\n");
  });

  it("關掉再開:留言從 .stele/comments/<id>.ybin 讀回", async () => {
    const first = openLocal({ "文.md": "原文\n" });
    edit(first, "文.md", (doc) =>
      addThread(doc, { id: "t1", anchor: { a: "AA", h: "BB" }, author: "me", name: "我", body: "留著", createdAt: 1 }),
    );
    const { dir } = first;
    await closeAll();

    const again = openLocal({}, dir);
    expect(threadsOf(again, "文.md").map((t) => t.body)).toEqual(["留著"]);
  });
});
