import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import { deriveVaultKey, VaultCipher } from "@stele/sync";
import { addThread, encodeAnchor, decodeAnchor, readThreads, type Thread } from "@stele/editor-core";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";
import { CommentStore } from "../src/main/comment-store.ts";

const TOKEN = "留言同步-token-1234567890";
const noop = {
  broadcastDoc() {},
  notifyIndexUpdated() {},
  trash(absPath: string) {
    rmSync(absPath, { force: true });
    return Promise.resolve();
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`逾時:${what}`);
    await sleep(30);
  }
}

interface Device {
  dir: string;
  session: VaultSession;
  manager: SyncManager;
  meta: VaultMeta;
  comments: CommentStore;
}

describe("留言 doc 端對端同步", () => {
  let server: RunningServer;
  let store: SyncStore;
  const devices: Device[] = [];

  async function makeDevice(vaultId: string, deviceId: string, seed: Record<string, string> = {}): Promise<Device> {
    const cipher = new VaultCipher(await deriveVaultKey("留言密語", vaultId, 12));
    const dir = mkdtempSync(path.join(tmpdir(), "stele-comment-"));
    for (const [rel, c] of Object.entries(seed)) writeFileSync(path.join(dir, rel), c);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: `ws://127.0.0.1:${server.port}`, token: TOKEN, vaultId, deviceId };
    const meta = new VaultMeta(dir);
    const comments = new CommentStore(meta, session);
    const manager = new SyncManager(session, settings, meta, undefined, {
      pushDebounceMs: 20,
      cipher,
      exportDocKey: (d: string) => cipher.exportDocKey(d),
      comments,
    });
    comments.setSyncHooks(manager);
    manager.start();
    const device = { dir, session, manager, meta, comments };
    devices.push(device);
    return device;
  }
  const content = (d: Device, rel: string): string | undefined => {
    try {
      return readFileSync(path.join(d.dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  const threadsOf = (d: Device, rel: string): Thread[] => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, d.comments.open(rel));
    return readThreads(doc);
  };

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    for (const d of devices) {
      await d.manager.stop();
      d.comments.stop();
      d.meta.stop();
      await d.session.destroy();
    }
    await server.close();
    store.close();
  });

  it("A 對文字範圍下留言 → 同步到 B;B 解得出錨定範圍與引用原文", async () => {
    const a = await makeDevice("v-cmt", "devA", { "文.md": "# 文\n這一句要被留言\n" });
    const b = await makeDevice("v-cmt", "devB");
    await until(() => content(b, "文.md") === "# 文\n這一句要被留言\n", "B 物化筆記");

    // A:對「這一句」下留言(錨定 Y.Text 範圍)
    const noteA = new Y.Doc();
    Y.applyUpdate(noteA, a.session.openDoc("文.md"));
    const ytA = noteA.getText("md");
    const from = ytA.toString().indexOf("這一句");
    const cdoc = new Y.Doc();
    Y.applyUpdate(cdoc, a.comments.open("文.md"));
    const sv = Y.encodeStateVector(cdoc);
    addThread(cdoc, { id: "t1", anchor: encodeAnchor(ytA, from, from + 3), author: "devA", name: "甲", body: "這裡要改", createdAt: 1 });
    a.comments.push("文.md", Y.encodeStateAsUpdate(cdoc, sv));

    // B:等留言同步過來
    let tb: Thread[] = [];
    await until(() => (tb = threadsOf(b, "文.md")).length === 1, "B 收到留言");
    expect(tb[0]!.body).toBe("這裡要改");
    expect(tb[0]!.name).toBe("甲");

    // B:錨定解回原文範圍
    const noteB = new Y.Doc();
    Y.applyUpdate(noteB, b.session.openDoc("文.md"));
    const ytB = noteB.getText("md");
    const range = decodeAnchor(noteB, ytB, tb[0]!.anchor);
    expect(range).not.toBeNull();
    expect(ytB.toString().slice(range!.from, range!.to)).toBe("這一句");
  });

  it("B 回覆 → A 收到;留言不進 .md、不污染筆記內容", async () => {
    const a = await makeDevice("v-cmt2", "devA", { "文.md": "原文一行\n" });
    const b = await makeDevice("v-cmt2", "devB");
    await until(() => content(b, "文.md") === "原文一行\n", "B 物化");

    // A 建串
    const c1 = new Y.Doc();
    Y.applyUpdate(c1, a.comments.open("文.md"));
    let sv = Y.encodeStateVector(c1);
    addThread(c1, { id: "t1", anchor: { a: "AA", h: "BB" }, author: "devA", name: "甲", body: "問一下", createdAt: 1 });
    a.comments.push("文.md", Y.encodeStateAsUpdate(c1, sv));
    await until(() => threadsOf(b, "文.md").length === 1, "B 收到串");

    // B 回覆
    const c2 = new Y.Doc();
    Y.applyUpdate(c2, b.comments.open("文.md"));
    sv = Y.encodeStateVector(c2);
    const { addReply } = await import("@stele/editor-core");
    addReply(c2, "t1", { id: "r1", author: "devB", name: "乙", body: "我來答", createdAt: 2 });
    b.comments.push("文.md", Y.encodeStateAsUpdate(c2, sv));

    // A 收到回覆
    await until(() => threadsOf(a, "文.md")[0]?.replies.length === 1, "A 收到回覆");
    expect(threadsOf(a, "文.md")[0]!.replies[0]!.body).toBe("我來答");

    // 留言完全不進 .md
    expect(content(a, "文.md")).toBe("原文一行\n");
    expect(content(b, "文.md")).toBe("原文一行\n");
  });
});
