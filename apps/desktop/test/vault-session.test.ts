import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { VaultSession } from "../src/main/vault-session.ts";

const noop = {
  broadcastDoc() {},
  notifyIndexUpdated() {},
  async trash(absPath: string) {
    const { rmSync } = await import("node:fs");
    rmSync(absPath);
  },
};

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

  it("adoptRemoteDoc 拒絕穿越、非 .md 與 symlink 逃逸", () => {
    const dir = makeVault();
    const outside = mkdtempSync(path.join(tmpdir(), "stele-outside-"));
    symlinkSync(outside, path.join(dir, "連結"));
    const session = new VaultSession(dir, noop);
    const ydoc = new Y.Doc();
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(() => session.adoptRemoteDoc("../外面.md", id, ydoc)).toThrow(/非法路徑/);
    expect(() => session.adoptRemoteDoc("壞.exe", id, ydoc)).toThrow(/非法路徑/);
    expect(() => session.adoptRemoteDoc("連結/x.md", id, ydoc)).toThrow(/非法路徑/);
  });

  it("create 拒絕遍歷分段並回傳補上副檔名的相對路徑", () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    expect(() => session.create("../外面")).toThrow(/非法路徑/);
    expect(session.create("新資料夾/新筆記")).toBe("新資料夾/新筆記.md");
    expect(readFileSync(path.join(dir, "新資料夾/新筆記.md"), "utf8")).toBe("# 新筆記\n");
  });
});

/**
 * 白板(JSON Canvas)走的是與筆記同一條管線:同一份 docId、同一套 CRDT 持久化、同一個同步通道。
 * 差別只在副檔名與內容格式——這是刻意的,否則同步、時光機、空間全都要為白板再實作一次。
 */
describe("白板(.canvas)", () => {
  const canvasWith = (file: string): string =>
    JSON.stringify({
      nodes: [
        { id: "n1", type: "text", x: 0, y: 0, width: 260, height: 120, text: "白板上的想法" },
        { id: "n2", type: "file", x: 400, y: 0, width: 300, height: 200, file },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
    });

  it("白板檔出現在筆記清單裡(側欄要看得到)", () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    expect(session.list().files).toEqual(["a.md", "圖.canvas"]);
  });

  it("create 依副檔名決定新檔內容:白板生出合規的空 JSON Canvas", () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    expect(session.create("研究/新白板.canvas")).toBe("研究/新白板.canvas");
    const raw = JSON.parse(readFileSync(path.join(dir, "研究/新白板.canvas"), "utf8")) as unknown;
    expect(raw).toEqual({ nodes: [], edges: [] });
  });

  it("白板與筆記共用 CRDT 管線:openDoc 拿得到內容,寫回會鏡像落盤", async () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc("圖.canvas"));
    expect(replica.getText("md").toString()).toContain("白板上的想法");
    replica.getText("md").insert(0, " ");
    session.pushUpdate("圖.canvas", Y.encodeStateAsUpdate(replica));
    await session.destroy();
    expect(readFileSync(path.join(dir, "圖.canvas"), "utf8").startsWith(" ")).toBe(true);
  });

  it("改名白板沿用原副檔名,不會變成 .md", async () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    expect(await session.rename("圖.canvas", "架構圖")).toBe("架構圖.canvas");
    await session.destroy();
  });

  it("筆記改名時,白板裡指向它的 file 節點跟著改寫", async () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    await session.rename("a.md", "資料夾/新A");
    const raw = JSON.parse(readFileSync(path.join(dir, "圖.canvas"), "utf8")) as { nodes: Array<{ file?: string }> };
    expect(raw.nodes[1]!.file).toBe("資料夾/新A.md");
    await session.destroy();
  });

  it("白板的 file 節點算一條連結:反向連結面板列得出「被哪張白板引用」", () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    expect(session.backlinks("a.md").map((b) => b.file)).toContain("圖.canvas");
  });

  it("關聯圖含白板節點與白板→筆記的邊", () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    const { nodes, edges } = session.graph();
    const from = nodes.indexOf("圖.canvas");
    const to = nodes.indexOf("a.md");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(edges).toContainEqual([from, to]);
  });

  it("白板上的文字進得了全文搜尋(不然白板寫的東西等於消失)", () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    expect(session.search("白板上的想法").map((r) => r.file)).toEqual(["圖.canvas"]);
  });

  it("壞掉的白板不擋索引重建:其餘檔案照常", () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "壞.canvas"), "{這不是 JSON");
    const session = new VaultSession(dir, noop);
    expect(session.list().files).toContain("壞.canvas");
    expect(session.backlinks("a.md")).toEqual([]);
  });

  it("白板不是查詢視圖的頁面:查詢只跑 Markdown 筆記", () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "圖.canvas"), canvasWith("a.md"));
    const session = new VaultSession(dir, noop);
    const result = session.runQuery("LIST");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.rows.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("路徑檢核只放行 .md 與 .canvas,其餘副檔名照樣拒絕", () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    const ydoc = new Y.Doc();
    expect(() => session.openDoc("a.txt")).toThrow(/非法路徑/);
    expect(() => session.adoptRemoteDoc("壞.exe", "12345678-1234-1234-1234-123456789abc", ydoc)).toThrow(/非法路徑/);
    expect(session.adoptRemoteDoc("遠端.canvas", "12345678-1234-1234-1234-123456789abc", ydoc)).toBe("遠端.canvas");
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

describe("CRDT 持久化", () => {
  it("關閉再開啟,CRDT 歷史延續,舊 replica 合併不重複", async () => {
    const dir = makeVault();
    const s1 = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, s1.openDoc("a.md"));
    const text = replica.getText("md");
    text.insert(text.length, "第一段編輯\n");
    s1.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));
    await s1.destroy();

    const s2 = new VaultSession(dir, noop);
    Y.applyUpdate(replica, s2.openDoc("a.md"));
    expect(replica.getText("md").toString()).toBe("# A\n第一段編輯\n");
    await s2.destroy();
  });

  it("關檔期間的外部修改在重開時吸收,新舊 replica 都收斂到磁碟內容", async () => {
    const dir = makeVault();
    const s1 = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, s1.openDoc("a.md"));
    replica.getText("md").insert(replica.getText("md").length, "編輯\n");
    s1.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));
    await s1.destroy();
    appendFileSync(path.join(dir, "a.md"), "外部追加\n");

    const s2 = new VaultSession(dir, noop);
    const snapshot = s2.openDoc("a.md");
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, snapshot);
    expect(fresh.getText("md").toString()).toBe("# A\n編輯\n外部追加\n");
    Y.applyUpdate(replica, snapshot);
    expect(replica.getText("md").toString()).toBe("# A\n編輯\n外部追加\n");
    await s2.destroy();
  });

  it("改名保留 CRDT 歷史", async () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc("a.md"));
    replica.getText("md").insert(replica.getText("md").length, "編輯\n");
    session.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));
    const newRel = await session.rename("a.md", "改名後");
    Y.applyUpdate(replica, session.openDoc(newRel));
    expect(replica.getText("md").toString()).toBe("# A\n編輯\n");
    await session.destroy();
  });

  it("刪除筆記清掉持久化狀態", async () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    session.openDoc("a.md");
    await session.delete("a.md");
    await session.destroy();
    const manifest = JSON.parse(readFileSync(path.join(dir, ".stele", "docs.json"), "utf8")) as {
      docs: Record<string, string>;
    };
    expect(manifest.docs).not.toHaveProperty("a.md");
  });

  it(".ybin 損毀時不拋錯,改由磁碟內容重播種", async () => {
    const dir = makeVault();
    const s1 = new VaultSession(dir, noop);
    s1.openDoc("a.md");
    await s1.destroy();
    const manifest = JSON.parse(readFileSync(path.join(dir, ".stele", "docs.json"), "utf8")) as {
      docs: Record<string, string>;
    };
    writeFileSync(path.join(dir, ".stele", "docs", `${manifest.docs["a.md"]!}.ybin`), Buffer.from([255, 254, 253]));

    const s2 = new VaultSession(dir, noop);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, s2.openDoc("a.md"));
    expect(fresh.getText("md").toString()).toBe("# A\n");
    await s2.destroy();
  });

  it("刪掉 .stele 之後 vault 仍可開,重新播種", async () => {
    const dir = makeVault();
    const s1 = new VaultSession(dir, noop);
    s1.openDoc("a.md");
    await s1.destroy();
    rmSync(path.join(dir, ".stele"), { recursive: true, force: true });

    const s2 = new VaultSession(dir, noop);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, s2.openDoc("a.md"));
    expect(fresh.getText("md").toString()).toBe("# A\n");
    await s2.destroy();
  });
});

describe("改名與刪除", () => {
  it("改名搬移檔案並改寫全 vault 指向它的連結", async () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "b.md"), "參考 [[a|老A]] 和 ![[a#^x]]。\n");
    const session = new VaultSession(dir, noop);
    const newRel = await session.rename("a.md", "資料夾/新A");
    expect(newRel).toBe("資料夾/新A.md");
    expect(readFileSync(path.join(dir, "資料夾/新A.md"), "utf8")).toBe("# A\n");
    expect(readFileSync(path.join(dir, "b.md"), "utf8")).toBe("參考 [[資料夾/新A|老A]] 和 ![[資料夾/新A#^x]]。\n");
  });

  it("開啟中的筆記改名:未落盤的編輯先 flush 再搬,舊路徑不復活", async () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, session.openDoc("a.md"));
    replica.getText("md").insert(replica.getText("md").length, "最後編輯\n");
    session.pushUpdate("a.md", Y.encodeStateAsUpdate(replica));
    const newRel = await session.rename("a.md", "改名後");
    expect(readFileSync(path.join(dir, newRel), "utf8")).toContain("最後編輯");
    await new Promise((r) => setTimeout(r, 300));
    expect(() => readFileSync(path.join(dir, "a.md"))).toThrow(); // 舊檔不存在也沒被鏡像復活
  });

  it("改名到既有筆記或非法路徑被拒", async () => {
    const dir = makeVault();
    writeFileSync(path.join(dir, "b.md"), "x\n");
    const session = new VaultSession(dir, noop);
    await expect(session.rename("a.md", "b")).rejects.toThrow(/已存在/);
    await expect(session.rename("a.md", "../外面")).rejects.toThrow(/非法路徑/);
  });

  it("刪除筆記:檔案進 trash,開啟中的文件不復活", async () => {
    const dir = makeVault();
    const session = new VaultSession(dir, noop);
    session.openDoc("a.md");
    await session.delete("a.md");
    await new Promise((r) => setTimeout(r, 300));
    expect(() => readFileSync(path.join(dir, "a.md"))).toThrow();
    expect(session.list().files).not.toContain("a.md");
  });

  it("`.stele` 底下的檔案不是筆記:版本歷史用 .md 存,不可出現在筆記清單", async () => {
    const dir = makeVault();
    // 時光機把版本快照存成純 Markdown(使用者自己翻也讀得懂),正因如此掃描必須排除隱藏目錄——
    // 否則歷史版本會出現在側欄與搜尋,還會被配 docId 上傳到同步伺服器
    mkdirSync(path.join(dir, ".stele", "history", "5f8e0000-0000-4000-8000-00000000aaaa"), { recursive: true });
    writeFileSync(path.join(dir, ".stele", "history", "5f8e0000-0000-4000-8000-00000000aaaa", "20260728T153045Z.md"), "# 舊版\n");
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "COMMIT_EDITMSG.md"), "not a note\n");

    const session = new VaultSession(dir, noop);
    const files = session.list().files;
    expect(files).toContain("a.md");
    expect(files.some((f) => f.includes(".stele"))).toBe(false);
    expect(files.some((f) => f.includes(".git"))).toBe(false);
    await session.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
});