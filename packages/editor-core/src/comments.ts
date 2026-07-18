import * as Y from "yjs";

/**
 * 留言與討論的 CRDT 資料模型 + 文字範圍錨定
 * 留言存在「伴生 doc」(與筆記本體不同的 Y.Doc),不污染筆記 CRDT、不進 .md 鏡像
 * 錨定用 relative position 綁在「筆記本體」的 Y.Text:插字自動位移、範圍被刪則解不出(視為原文已刪)
 */

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface Anchor {
  /** 起點 relative position(base64) */
  a: string;
  /** 終點 relative position(base64) */
  h: string;
}

/** 把筆記 Y.Text 的字元範圍 [from,to] 編碼成 relative position 錨(存進留言) */
export function encodeAnchor(ytext: Y.Text, from: number, to: number): Anchor {
  const rel = (i: number) => toB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, i)));
  return { a: rel(from), h: rel(to) };
}

/** 對「筆記本體」的 Y.Doc/Y.Text 解回目前字元範圍;結構已不在(原文被刪)回 null */
export function decodeAnchor(noteDoc: Y.Doc, ytext: Y.Text, anchor: Anchor): { from: number; to: number } | null {
  try {
    const resolve = (s: string): number | null => {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromB64(s)), noteDoc);
      return abs && abs.type === ytext ? abs.index : null;
    };
    const from = resolve(anchor.a);
    const to = resolve(anchor.h);
    if (from === null || to === null) return null;
    return from <= to ? { from, to } : { from: to, to: from };
  } catch {
    return null;
  }
}

export interface Reply {
  id: string;
  author: string;
  name: string;
  body: string;
  createdAt: number;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  resolved: boolean;
  createdAt: number;
  author: string;
  name: string;
  body: string;
  replies: Reply[];
}

const THREADS = "threads";

function threadsArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray(THREADS);
}

function findThread(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
  for (const m of threadsArray(doc)) if (m.get("id") === id) return m;
  return undefined;
}

export interface NewThread {
  id: string;
  anchor: Anchor;
  author: string;
  name: string;
  body: string;
  createdAt: number;
}

/** 新增一則討論串(含根留言) */
export function addThread(doc: Y.Doc, t: NewThread): void {
  const m = new Y.Map<unknown>();
  m.set("id", t.id);
  m.set("anchorA", t.anchor.a);
  m.set("anchorH", t.anchor.h);
  m.set("resolved", false);
  m.set("createdAt", t.createdAt);
  m.set("author", t.author);
  m.set("name", t.name);
  m.set("body", t.body);
  m.set("replies", new Y.Array<Y.Map<unknown>>());
  threadsArray(doc).push([m]);
}

/** 對某討論串加一則回覆 */
export function addReply(doc: Y.Doc, threadId: string, r: Reply): void {
  const m = findThread(doc, threadId);
  if (!m) return;
  const replies = m.get("replies") as Y.Array<Y.Map<unknown>>;
  const rm = new Y.Map<unknown>();
  rm.set("id", r.id);
  rm.set("author", r.author);
  rm.set("name", r.name);
  rm.set("body", r.body);
  rm.set("createdAt", r.createdAt);
  replies.push([rm]);
}

export function setResolved(doc: Y.Doc, threadId: string, resolved: boolean): void {
  findThread(doc, threadId)?.set("resolved", resolved);
}

export function deleteThread(doc: Y.Doc, threadId: string): void {
  const arr = threadsArray(doc);
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i).get("id") === threadId) {
      arr.delete(i, 1);
      return;
    }
  }
}

/** 讀出全部討論串的純 JS 快照(給 UI);依建立時間排序 */
export function readThreads(doc: Y.Doc): Thread[] {
  const out: Thread[] = [];
  for (const m of threadsArray(doc)) {
    const replies: Reply[] = [];
    for (const rm of m.get("replies") as Y.Array<Y.Map<unknown>>) {
      replies.push({
        id: String(rm.get("id")),
        author: String(rm.get("author")),
        name: String(rm.get("name")),
        body: String(rm.get("body")),
        createdAt: Number(rm.get("createdAt")),
      });
    }
    out.push({
      id: String(m.get("id")),
      anchor: { a: String(m.get("anchorA")), h: String(m.get("anchorH")) },
      resolved: Boolean(m.get("resolved")),
      createdAt: Number(m.get("createdAt")),
      author: String(m.get("author")),
      name: String(m.get("name")),
      body: String(m.get("body")),
      replies: replies.sort((x, y) => x.createdAt - y.createdAt),
    });
  }
  return out.sort((x, y) => x.createdAt - y.createdAt);
}
