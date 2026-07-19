import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_SPACE_ID,
  readSpaces,
  spaceOf,
  createSpace,
  renameSpace,
  moveNote,
  recordCopy,
  readAudit,
} from "../src/index.ts";

const meta = () => new Y.Doc();

describe("空間模型:登記與歸屬", () => {
  it("空 vault:只有一個預設空間、任何筆記都落在預設空間", () => {
    const m = meta();
    const spaces = readSpaces(m);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: DEFAULT_SPACE_ID, isDefault: true });
    expect(spaceOf(m, "doc-任意")).toBe(DEFAULT_SPACE_ID);
  });

  it("建立空間:出現在清單、預設永遠第一、依建立時間排序", () => {
    const m = meta();
    createSpace(m, { id: "s-work", name: "工作", at: 200 });
    createSpace(m, { id: "s-life", name: "生活", at: 100 });
    const spaces = readSpaces(m);
    expect(spaces.map((s) => s.id)).toEqual([DEFAULT_SPACE_ID, "s-life", "s-work"]);
    expect(spaces[2]).toMatchObject({ id: "s-work", name: "工作", isDefault: false });
  });

  it("重複 id 或以預設 id 建立都被拒絕", () => {
    const m = meta();
    createSpace(m, { id: "s-work", name: "工作", at: 1 });
    expect(() => createSpace(m, { id: "s-work", name: "又一個", at: 2 })).toThrow();
    expect(() => createSpace(m, { id: DEFAULT_SPACE_ID, name: "偽預設", at: 3 })).toThrow();
  });

  it("預設空間可改名、自訂空間可改名、改不存在空間被拒", () => {
    const m = meta();
    renameSpace(m, DEFAULT_SPACE_ID, "個人", 10);
    expect(readSpaces(m)[0]).toMatchObject({ id: DEFAULT_SPACE_ID, name: "個人", isDefault: true });
    createSpace(m, { id: "s-work", name: "工作", at: 20 });
    renameSpace(m, "s-work", "職場", 30);
    expect(readSpaces(m).find((s) => s.id === "s-work")?.name).toBe("職場");
    expect(() => renameSpace(m, "s-none", "x", 40)).toThrow();
  });

  it("移動筆記:歸屬變更;移回預設=移除登記;移到不存在空間被拒", () => {
    const m = meta();
    createSpace(m, { id: "s-work", name: "工作", at: 1 });
    moveNote(m, "doc-1", "s-work", 2);
    expect(spaceOf(m, "doc-1")).toBe("s-work");
    moveNote(m, "doc-1", DEFAULT_SPACE_ID, 3);
    expect(spaceOf(m, "doc-1")).toBe(DEFAULT_SPACE_ID);
    expect(() => moveNote(m, "doc-1", "s-none", 4)).toThrow();
  });

  it("複製筆記:新 docId 歸屬目標空間、原筆記歸屬不變", () => {
    const m = meta();
    createSpace(m, { id: "s-work", name: "工作", at: 1 });
    moveNote(m, "doc-1", "s-work", 2);
    recordCopy(m, { fromDocId: "doc-1", newDocId: "doc-1-copy", toSpaceId: DEFAULT_SPACE_ID, at: 3 });
    expect(spaceOf(m, "doc-1")).toBe("s-work"); // 原篇留在工作
    expect(spaceOf(m, "doc-1-copy")).toBe(DEFAULT_SPACE_ID); // 副本在個人
  });
});

describe("空間模型:稽核紀錄", () => {
  it("每個操作各產一筆 append-only 事件,含 from/to,依序累積", () => {
    const m = meta();
    createSpace(m, { id: "s-work", name: "工作", at: 1 });
    moveNote(m, "doc-1", "s-work", 2);
    recordCopy(m, { fromDocId: "doc-1", newDocId: "doc-2", toSpaceId: DEFAULT_SPACE_ID, at: 3 });
    renameSpace(m, "s-work", "職場", 4);
    const audit = readAudit(m);
    expect(audit.map((e) => e.kind)).toEqual(["space-created", "note-moved", "note-copied", "space-renamed"]);
    expect(audit[1]).toMatchObject({ kind: "note-moved", docId: "doc-1", fromSpaceId: DEFAULT_SPACE_ID, spaceId: "s-work" });
    expect(audit[2]).toMatchObject({ kind: "note-copied", docId: "doc-2", spaceId: DEFAULT_SPACE_ID });
  });

  it("無變化的移動不產生事件", () => {
    const m = meta();
    moveNote(m, "doc-1", DEFAULT_SPACE_ID, 1); // 本就在預設
    expect(readAudit(m)).toHaveLength(0);
  });
});

describe("空間模型:CRDT 合併", () => {
  it("兩裝置各自建空間、各移筆記,合併後收斂", () => {
    const a = meta();
    const b = meta();
    createSpace(a, { id: "s-work", name: "工作", at: 1 });
    moveNote(a, "doc-1", "s-work", 2);
    createSpace(b, { id: "s-life", name: "生活", at: 1 });
    moveNote(b, "doc-2", "s-life", 2);
    // 交換更新
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    for (const m of [a, b]) {
      expect(readSpaces(m).map((s) => s.id).sort()).toEqual([DEFAULT_SPACE_ID, "s-life", "s-work"]);
      expect(spaceOf(m, "doc-1")).toBe("s-work");
      expect(spaceOf(m, "doc-2")).toBe("s-life");
    }
  });
});
