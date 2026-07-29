import { extractWikilinks, resolveWikilink, createWikilinkResolver, rankFiles } from "@stele/editor-core";

/**
 * 行動端對「一堆筆記」的查詢:搜尋、wikilink 解析、反向連結。
 *
 * 全部是純函式,吃一個 `Note[]` 就好——不認識 Y.Doc、不認識同步、不碰儲存。
 * `MobileVault` 只負責把記憶體裡的 doc 攤成 `Note[]` 再呼叫這裡,於是這些規則
 * (檔名優先於內文、只框到一端的連結不算、解不到就不建檔)全部測得到。
 * 白板的幾何與編輯操作也是同一套做法。
 */

export interface Note {
  readonly docId: string;
  readonly rel: string;
  readonly text: string;
}

export interface Hit {
  readonly docId: string;
  readonly rel: string;
  /** 命中的那一行,或退而求其次的第一行非空白內容 */
  readonly line: string;
}

/**
 * 搜尋:**檔名的模糊比對排在前面**,再接內文命中。
 * 打「靈感」通常是想去那一篇,不是想看到所有提過「靈感」的段落。
 */
export function searchNotes(notes: readonly Note[], query: string, limit = 50): Hit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const byRel = new Map(notes.map((n) => [n.rel, n]));
  const contextOf = (note: Note): string => {
    const lines = note.text.split("\n");
    const hit = lines.find((l) => l.toLowerCase().includes(needle));
    return (hit ?? lines.find((l) => l.trim() !== "") ?? "").trim();
  };

  const out: Hit[] = [];
  const seen = new Set<string>();
  for (const rel of rankFiles(
    notes.map((n) => n.rel),
    query,
    limit,
  )) {
    const note = byRel.get(rel);
    if (!note) continue;
    seen.add(rel);
    out.push({ docId: note.docId, rel, line: contextOf(note) });
  }
  for (const note of notes) {
    if (seen.has(note.rel) || out.length >= limit) continue;
    if (!note.text.toLowerCase().includes(needle)) continue;
    out.push({ docId: note.docId, rel: note.rel, line: contextOf(note) });
  }
  return out;
}

/** 解析 wikilink 目標;解不到回 undefined——手機上不建檔,小螢幕的誤觸多過本意 */
export function resolveNote(notes: readonly Note[], target: string): Note | undefined {
  const rel = resolveWikilink(
    notes.map((n) => n.rel),
    target,
  );
  return rel === undefined ? undefined : notes.find((n) => n.rel === rel);
}

/** 反向連結:哪些筆記連到這一篇。同一篇連過來多次只算一列,面板上不需要重複 */
export function backlinksOf(notes: readonly Note[], rel: string): Hit[] {
  const resolver = createWikilinkResolver(notes.map((n) => n.rel));
  const out: Hit[] = [];
  for (const note of notes) {
    if (note.rel === rel) continue;
    const ref = extractWikilinks(note.text).find((r) => resolver(r.target) === rel);
    if (ref) out.push({ docId: note.docId, rel: note.rel, line: ref.line });
  }
  return out;
}
