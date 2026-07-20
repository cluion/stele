import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VaultMeta, LOCAL_ORIGIN } from "../src/main/vault-meta.ts";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "stele-meta-"));
}

describe("VaultMeta", () => {
  it("stop 後落盤,新實例讀回同樣內容", () => {
    const root = makeRoot();
    const a = new VaultMeta(root);
    a.transact(() => a.doc.getMap("paths").set("doc-1", "a.md"));
    a.stop();

    expect(existsSync(path.join(root, ".stele", "meta.ybin"))).toBe(true);
    const b = new VaultMeta(root);
    expect(b.doc.getMap("paths").get("doc-1")).toBe("a.md");
    b.stop();
  });

  it("空 vault 開得起來,不因缺檔而拋錯", () => {
    const meta = new VaultMeta(makeRoot());
    expect(meta.doc.getMap("paths").size).toBe(0);
    meta.stop();
  });

  it("transact 帶 LOCAL_ORIGIN,遠端變更的觀察者不會被本地寫入誤觸發", () => {
    const meta = new VaultMeta(makeRoot());
    const origins: unknown[] = [];
    meta.doc.getMap("paths").observe((_event, tx) => origins.push(tx.origin));

    meta.transact(() => meta.doc.getMap("paths").set("doc-1", "a.md"));
    meta.doc.transact(() => meta.doc.getMap("paths").set("doc-2", "b.md"), "sync");

    expect(origins).toEqual([LOCAL_ORIGIN, "sync"]);
    meta.stop();
  });
});
