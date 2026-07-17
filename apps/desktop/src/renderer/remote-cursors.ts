/**
 * 遠端游標的位置編碼:以 Y.Text 的 relative position 表示,並發編輯下不漂移
 * relative position 綁在 CRDT 結構上,對方插字時我的游標會跟著位移
 */
import * as Y from "yjs";

/** base64(encodeRelativePosition) 的 anchor / head;交集型別讓它可當 Record 傳過 IPC */
export type CursorPayload = Record<string, unknown> & { a: string; h: string };

export interface RemoteCursor {
  clientId: number;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

/** leading + trailing 節流:立刻送第一次,期間合併,最後一次保證送出(游標精確) */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): {
  call: (...args: A) => void;
  cancel: () => void;
} {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  const run = (): void => {
    last = Date.now();
    timer = undefined;
    if (pending) {
      const args = pending;
      pending = null;
      fn(...args);
    }
  };
  return {
    call: (...args: A): void => {
      pending = args;
      const wait = last + ms - Date.now();
      if (wait <= 0) run();
      else if (timer === undefined) timer = setTimeout(run, wait);
    },
    cancel: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function encodeCursor(ytext: Y.Text, anchor: number, head: number): CursorPayload {
  const rel = (i: number) => toB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, i)));
  return { a: rel(anchor), h: rel(head) };
}

/** 解不出(結構已不在)回 null;呼叫端跳過該游標 */
export function decodeCursor(doc: Y.Doc, ytext: Y.Text, cur: CursorPayload): { anchor: number; head: number } | null {
  try {
    const resolve = (s: string): number | null => {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromB64(s)), doc);
      return abs && abs.type === ytext ? abs.index : null;
    };
    const anchor = resolve(cur.a);
    const head = resolve(cur.h);
    return anchor === null || head === null ? null : { anchor, head };
  } catch {
    return null;
  }
}

/** 從 onPresence 的 participant 抽出可渲染的遠端游標(有 cur 欄位者) */
export function participantCursor(
  doc: Y.Doc,
  ytext: Y.Text,
  p: { clientId: number; name: string; color: string; state: Record<string, unknown> },
): RemoteCursor | null {
  const cur = p.state["cur"];
  if (!cur || typeof cur !== "object") return null;
  const payload = cur as CursorPayload;
  if (typeof payload.a !== "string" || typeof payload.h !== "string") return null;
  const pos = decodeCursor(doc, ytext, payload);
  return pos && { clientId: p.clientId, name: p.name, color: p.color, ...pos };
}
