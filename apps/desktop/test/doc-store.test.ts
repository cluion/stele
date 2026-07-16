import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DocStore } from "../src/main/doc-store.ts";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "stele-docstore-"));
}

describe("DocStore", () => {
  it("idFor 對同一路徑穩定,且跨實例持久", () => {
    const root = makeRoot();
    const id = new DocStore(root).idFor("a.md");
    expect(new DocStore(root).idFor("a.md")).toBe(id);
    expect(new DocStore(root).idFor("b.md")).not.toBe(id);
  });

  it("save 後 load 取回同樣的位元組", async () => {
    const root = makeRoot();
    await new DocStore(root).save("a.md", new Uint8Array([1, 2, 3]));
    const loaded = new DocStore(root).load("a.md");
    expect(loaded && Array.from(loaded)).toEqual([1, 2, 3]);
  });

  it("沒存過的路徑 load 回傳 undefined", () => {
    expect(new DocStore(makeRoot()).load("沒有.md")).toBeUndefined();
  });

  it("rename 保留 doc id 與狀態", async () => {
    const root = makeRoot();
    const store = new DocStore(root);
    const id = store.idFor("a.md");
    await store.save("a.md", new Uint8Array([9]));
    store.rename("a.md", "資料夾/b.md");
    const reopened = new DocStore(root);
    expect(reopened.idFor("資料夾/b.md")).toBe(id);
    const loaded = reopened.load("資料夾/b.md");
    expect(loaded && Array.from(loaded)).toEqual([9]);
    expect(reopened.idFor("a.md")).not.toBe(id);
  });

  it("remove 清掉對照與狀態檔", async () => {
    const root = makeRoot();
    const store = new DocStore(root);
    const id = store.idFor("a.md");
    await store.save("a.md", new Uint8Array([7]));
    store.remove("a.md");
    expect(store.load("a.md")).toBeUndefined();
    expect(existsSync(path.join(root, ".stele", "docs", `${id}.ybin`))).toBe(false);
    expect(new DocStore(root).idFor("a.md")).not.toBe(id);
  });

  it("損毀的 manifest 不拋錯,重建後可續用", async () => {
    const root = makeRoot();
    await new DocStore(root).save("a.md", new Uint8Array([1]));
    writeFileSync(path.join(root, ".stele", "docs.json"), "{壞掉的 json");
    const store = new DocStore(root);
    expect(store.load("a.md")).toBeUndefined();
    await store.save("a.md", new Uint8Array([2]));
    const loaded = new DocStore(root).load("a.md");
    expect(loaded && Array.from(loaded)).toEqual([2]);
  });

  it("狀態檔以 doc id 命名,不洩漏筆記路徑", async () => {
    const root = makeRoot();
    const store = new DocStore(root);
    await store.save("機密/薪資.md", new Uint8Array([1]));
    for (const name of readdirSync(path.join(root, ".stele", "docs"))) {
      expect(name).toMatch(/^[0-9a-f-]+\.ybin$/);
    }
    const manifest = readFileSync(path.join(root, ".stele", "docs.json"), "utf8");
    expect(JSON.parse(manifest)).toHaveProperty(["docs", "機密/薪資.md"]);
  });
});
