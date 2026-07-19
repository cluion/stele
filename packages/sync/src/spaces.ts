import * as Y from "yjs";
import { DEFAULT_SPACE_ID } from "./crypto.ts";

/**
 * 空間模型:「vault → 空間 → 筆記」三層的中繼資料層,存在 vault-meta doc 上。
 * 空間 = 一級「帶金鑰單元」(金鑰在 crypto.ts,見 deriveSpaceKey)。此處只管歸屬與稽核。
 * 純函式操作 meta doc;呼叫端(SyncManager)自行包 transact 控 origin,與 comments.ts 同慣例。
 *
 * 資料結構(皆在 meta doc):
 * - spaces:Y.Map<spaceId, Y.Map>  每空間一個巢狀 Y.Map { name, createdAt, color? }(逐欄 LWW)
 * - docSpaces:Y.Map<docId, spaceId>  筆記歸屬;缺席 = 落在預設空間(預設是隱含落點,不佔條目)
 * - spaceAudit:Y.Array<SpaceAuditEvent>  append-only 稽核紀錄
 */

const SPACES = "spaces";
const DOC_SPACES = "docSpaces";
const AUDIT = "spaceAudit";

export interface Space {
  id: string;
  /** 顯示名;預設空間未改名時為 ""(由 UI 依 i18n 補預設標籤) */
  name: string;
  createdAt: number;
  color?: string;
  isDefault: boolean;
}

export type SpaceAuditKind = "space-created" | "space-renamed" | "note-moved" | "note-copied";

export interface SpaceAuditEvent {
  at: number;
  kind: SpaceAuditKind;
  docId?: string;
  spaceId?: string;
  fromSpaceId?: string;
  name?: string;
}

function spacesMap(meta: Y.Doc): Y.Map<Y.Map<unknown>> {
  return meta.getMap(SPACES);
}

function docSpacesMap(meta: Y.Doc): Y.Map<string> {
  return meta.getMap(DOC_SPACES);
}

function auditArray(meta: Y.Doc): Y.Array<SpaceAuditEvent> {
  return meta.getArray(AUDIT);
}

function pushAudit(meta: Y.Doc, e: SpaceAuditEvent): void {
  auditArray(meta).push([e]);
}

function assertSpaceExists(meta: Y.Doc, spaceId: string): void {
  if (spaceId === DEFAULT_SPACE_ID) return;
  if (!spacesMap(meta).has(spaceId)) throw new Error(`空間不存在:${spaceId}`);
}

/** 某筆記所屬空間;未登記 → 預設空間 */
export function spaceOf(meta: Y.Doc, docId: string): string {
  return docSpacesMap(meta).get(docId) ?? DEFAULT_SPACE_ID;
}

/** 讀出全部空間(含預設空間,永遠在最前),依建立時間排序 */
export function readSpaces(meta: Y.Doc): Space[] {
  const sm = spacesMap(meta);
  const custom: Space[] = [];
  let defaultName = "";
  for (const [id, m] of sm) {
    const name = (m.get("name") as string | undefined) ?? "";
    if (id === DEFAULT_SPACE_ID) {
      defaultName = name;
      continue;
    }
    custom.push({
      id,
      name,
      createdAt: (m.get("createdAt") as number | undefined) ?? 0,
      color: m.get("color") as string | undefined,
      isDefault: false,
    });
  }
  custom.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return [{ id: DEFAULT_SPACE_ID, name: defaultName, createdAt: 0, isDefault: true }, ...custom];
}

/** 建立新空間(id 由呼叫端生成,不可為預設空間 id、不可重複) */
export function createSpace(meta: Y.Doc, s: { id: string; name: string; color?: string; at: number }): void {
  if (s.id === DEFAULT_SPACE_ID) throw new Error("預設空間已存在,不可重建");
  if (spacesMap(meta).has(s.id)) throw new Error(`空間已存在:${s.id}`);
  const m = new Y.Map<unknown>();
  m.set("name", s.name);
  m.set("createdAt", s.at);
  if (s.color !== undefined) m.set("color", s.color);
  spacesMap(meta).set(s.id, m);
  pushAudit(meta, { at: s.at, kind: "space-created", spaceId: s.id, name: s.name });
}

/** 改名:預設空間可改名(必要時建其登記條目);不存在的自訂空間拒絕 */
export function renameSpace(meta: Y.Doc, spaceId: string, name: string, at: number): void {
  const sm = spacesMap(meta);
  const existing = sm.get(spaceId);
  if (existing) {
    existing.set("name", name);
  } else if (spaceId === DEFAULT_SPACE_ID) {
    const m = new Y.Map<unknown>();
    m.set("name", name);
    m.set("createdAt", 0);
    sm.set(DEFAULT_SPACE_ID, m);
  } else {
    throw new Error(`空間不存在:${spaceId}`);
  }
  pushAudit(meta, { at, kind: "space-renamed", spaceId, name });
}

/** 移動筆記到某空間(僅改歸屬中繼資料;重新加密由上層處理)。目標須為預設或既有空間。 */
export function moveNote(meta: Y.Doc, docId: string, toSpaceId: string, at: number): void {
  assertSpaceExists(meta, toSpaceId);
  const from = spaceOf(meta, docId);
  if (from === toSpaceId) return; // 無變化不產事件
  const dsm = docSpacesMap(meta);
  if (toSpaceId === DEFAULT_SPACE_ID) dsm.delete(docId); // 回預設 = 移除登記(預設為隱含落點)
  else dsm.set(docId, toSpaceId);
  pushAudit(meta, { at, kind: "note-moved", docId, fromSpaceId: from, spaceId: toSpaceId });
}

/** 記錄「複製到空間」:新 docId 歸屬目標空間(內容複製與加密由上層處理),原筆記不動 */
export function recordCopy(meta: Y.Doc, p: { fromDocId: string; newDocId: string; toSpaceId: string; at: number }): void {
  assertSpaceExists(meta, p.toSpaceId);
  const from = spaceOf(meta, p.fromDocId);
  if (p.toSpaceId !== DEFAULT_SPACE_ID) docSpacesMap(meta).set(p.newDocId, p.toSpaceId);
  pushAudit(meta, { at: p.at, kind: "note-copied", docId: p.newDocId, fromSpaceId: from, spaceId: p.toSpaceId });
}

/** 讀稽核紀錄(append-only)純 JS 快照,依發生順序 */
export function readAudit(meta: Y.Doc): SpaceAuditEvent[] {
  return auditArray(meta)
    .toArray()
    .map((e) => ({ ...e }));
}
