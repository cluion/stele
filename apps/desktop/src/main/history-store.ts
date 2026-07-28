import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 筆記版本歷史(時光機):`.stele/history/<docId>/<時間戳>.md`,每個版本一個**純 Markdown 檔**。
 *
 * 為何不是 Yjs 快照:Yjs 要能還原舊版本必須關掉垃圾回收(`gc: false`),而
 * ①既有筆記被刪掉的內容早就回收了,救不回來;②永不回收會讓長期編輯的筆記狀態無限膨脹;
 * ③那是不可逆的儲存策略改變。純文字快照則對既有 vault 立刻生效、體積可控。
 *
 * 更重要的是它符合本專案的承諾:使用者用檔案總管就能翻自己的歷史,即使 Stele 不在了也讀得懂。
 * 歷史版本存成二進位 CRDT 反而是把知識綁在工具上。
 */

/** doc id 會組進檔案路徑,寬鬆格式 = 路徑穿越面(與 DocStore 同一條規則) */
const VALID_DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 兩次自動存檔的最小間隔:再密只會產生一堆中間態,對「找回上週那版」沒有幫助 */
export const MIN_GAP_MS = 5 * 60 * 1000;

/** 每篇筆記的版本數硬上限:分層稀釋之外的兜底,免得極端編輯量吃掉磁碟 */
export const MAX_VERSIONS_PER_DOC = 200;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface VersionEntry {
  /** unix 毫秒 */
  ts: number;
  bytes: number;
}

/** 時間戳 ↔ 檔名:`20260728T153045Z.md`,可排序、可讀、無非法字元 */
function tsToName(ts: number): string {
  const iso = new Date(ts).toISOString(); // 2026-07-28T15:30:45.123Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z.md`;
}

function nameToTs(name: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.md$/.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/**
 * 分層稀釋:回傳**該刪掉**的時間戳。近期密集、久遠稀疏——使用者想找的是「上週那一版」,
 * 不是上週的每一次自動存檔。
 *
 * 一小時內全留 / 一天內每小時留一個 / 一個月內每天留一個 / 更久每週留一個;
 * 再套用總數硬上限(從最舊開始刪)。永遠保留最新的那一版。
 */
export function thinVersions(timestamps: number[], now: number): number[] {
  if (timestamps.length === 0) return [];
  const sorted = [...timestamps].sort((a, b) => b - a); // 新到舊
  const newest = sorted[0]!;
  const bucketOf = (ts: number): string => {
    const age = now - ts;
    if (age < HOUR) return `raw:${ts}`; // 每個自成一桶 = 全留
    if (age < DAY) return `h:${Math.floor(ts / HOUR)}`;
    if (age < 30 * DAY) return `d:${Math.floor(ts / DAY)}`;
    return `w:${Math.floor(ts / (7 * DAY))}`;
  };
  const seen = new Set<string>();
  const drop = new Set<number>();
  for (const ts of sorted) {
    const bucket = bucketOf(ts);
    // 同一桶內只留最新的(sorted 由新到舊,先看到的就是最新)
    if (seen.has(bucket)) drop.add(ts);
    else seen.add(bucket);
  }
  // 硬上限:分層留下來的仍太多時,從最舊開始再刪,但最新一版永遠保留
  const kept = sorted.filter((ts) => !drop.has(ts));
  for (let i = MAX_VERSIONS_PER_DOC; i < kept.length; i++) {
    const ts = kept[i]!;
    if (ts !== newest) drop.add(ts);
  }
  return [...drop];
}

export class HistoryStore {
  private readonly root: string;

  constructor(vaultRoot: string) {
    this.root = path.join(vaultRoot, ".stele", "history");
  }

  /** 某篇筆記的歷史目錄(測試與「在檔案總管開啟」用) */
  dirFor(docId: string): string {
    if (!VALID_DOC_ID.test(docId)) throw new Error(`非法 doc id:${docId}`);
    return path.join(this.root, docId);
  }

  /**
   * 記一個版本。跳過的情況:內容空白、與最新版相同、距上次不足 `MIN_GAP_MS`(除非 force)。
   * force 用於關檔/切換筆記——那時要捕捉最後狀態,否則短暫的編輯 session 會完全沒有歷史。
   * 回傳是否真的寫入。
   */
  record(docId: string, text: string, now: number, force = false): boolean {
    if (!VALID_DOC_ID.test(docId)) throw new Error(`非法 doc id:${docId}`);
    if (text.trim().length === 0) return false;
    const versions = this.list(docId);
    const latest = versions[0];
    if (latest) {
      if (!force && now - latest.ts < MIN_GAP_MS) return false;
      if (this.read(docId, latest.ts) === text) return false; // 內容沒變,不留重複版本
    }
    const dir = this.dirFor(docId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, tsToName(now)), text);
    this.prune(docId, now);
    return true;
  }

  /** 版本清單,新到舊;無歷史或路徑不合法都回空陣列(呼叫端不必特別處理) */
  list(docId: string): VersionEntry[] {
    if (!VALID_DOC_ID.test(docId)) return [];
    let names: string[];
    try {
      names = readdirSync(path.join(this.root, docId));
    } catch {
      return [];
    }
    const out: VersionEntry[] = [];
    for (const name of names) {
      const ts = nameToTs(name);
      if (ts === undefined) continue;
      try {
        out.push({ ts, bytes: statSync(path.join(this.root, docId, name)).size });
      } catch {
        // 剛好被清掉:略過
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  /** 讀某一版的內容;不存在回 undefined */
  read(docId: string, ts: number): string | undefined {
    if (!VALID_DOC_ID.test(docId)) return undefined;
    try {
      return readFileSync(path.join(this.root, docId, tsToName(ts)), "utf8");
    } catch {
      return undefined;
    }
  }

  /** 清掉某篇筆記的全部歷史 */
  remove(docId: string): void {
    if (!VALID_DOC_ID.test(docId)) return;
    rmSync(path.join(this.root, docId), { recursive: true, force: true });
  }

  private prune(docId: string, now: number): void {
    const drop = thinVersions(
      this.list(docId).map((v) => v.ts),
      now,
    );
    for (const ts of drop) {
      try {
        rmSync(path.join(this.root, docId, tsToName(ts)), { force: true });
      } catch {
        // 清理失敗不影響主流程
      }
    }
  }
}
