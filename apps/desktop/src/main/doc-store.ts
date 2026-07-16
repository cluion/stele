import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";

/** DocHost 的持久化介面:綁定單一筆記,讓 DocHost 不認識整個 store */
export interface DocPersistence {
  load(): Uint8Array | undefined;
  save(state: Uint8Array): Promise<void>;
}

/**
 * 每篇筆記的 CRDT 二進位狀態庫:.stele/docs.json 記路徑對照,.stele/docs/<id>.ybin 存狀態
 * doc id 是穩定 UUID,改名不變,是未來同步協議在伺服器端唯一可見的識別
 * 刪掉整個 .stele 不影響 vault:下次開檔從 .md 重新播種
 */
export class DocStore {
  private readonly manifestFile: string;
  private readonly dir: string;
  private docs: Record<string, string>;

  constructor(root: string) {
    this.manifestFile = path.join(root, ".stele", "docs.json");
    this.dir = path.join(root, ".stele", "docs");
    this.docs = this.readManifest();
  }

  idFor(rel: string): string {
    const existing = this.docs[rel];
    if (existing) return existing;
    const id = randomUUID();
    this.docs = { ...this.docs, [rel]: id };
    this.writeManifest();
    return id;
  }

  load(rel: string): Uint8Array | undefined {
    const id = this.docs[rel];
    if (!id) return undefined;
    try {
      return readFileSync(this.stateFile(id));
    } catch {
      return undefined;
    }
  }

  async save(rel: string, state: Uint8Array): Promise<void> {
    const file = this.stateFile(this.idFor(rel));
    mkdirSync(this.dir, { recursive: true });
    await writeFile(file + ".tmp", state);
    await rename(file + ".tmp", file);
  }

  /** 改名只動對照,id 與狀態檔不變:CRDT 歷史跟著筆記走 */
  rename(oldRel: string, newRel: string): void {
    const id = this.docs[oldRel];
    if (!id) return;
    this.docs = Object.fromEntries(
      Object.entries(this.docs).map(([rel, docId]) => (rel === oldRel ? [newRel, docId] : [rel, docId])),
    );
    this.writeManifest();
  }

  remove(rel: string): void {
    const id = this.docs[rel];
    if (!id) return;
    this.docs = Object.fromEntries(Object.entries(this.docs).filter(([r]) => r !== rel));
    this.writeManifest();
    rmSync(this.stateFile(id), { force: true });
  }

  private stateFile(id: string): string {
    return path.join(this.dir, `${id}.ybin`);
  }

  private readManifest(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.manifestFile, "utf8")) as { docs?: unknown };
      if (raw.docs === null || typeof raw.docs !== "object") return {};
      const out: Record<string, string> = {};
      for (const [rel, id] of Object.entries(raw.docs as Record<string, unknown>)) {
        if (typeof id === "string") out[rel] = id;
      }
      return out;
    } catch {
      // 首次開啟或 manifest 損毀:重建,狀態檔成為孤兒但不影響正確性
      return {};
    }
  }

  private writeManifest(): void {
    mkdirSync(path.dirname(this.manifestFile), { recursive: true });
    const tmp = this.manifestFile + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, docs: this.docs }, null, 2));
    renameSync(tmp, this.manifestFile);
  }
}
