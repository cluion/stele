import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  readSpaces,
  spaceOf,
  readAudit,
  createSpace as createSpaceModel,
  renameSpace as renameSpaceModel,
  moveNote as moveNoteModel,
  recordCopy as recordCopyModel,
  setSpaceMembers as setSpaceMembersModel,
  assignDocSpace,
  SPACES_MAP,
  DOC_SPACES_MAP,
  type Space,
  type SpaceAuditEvent,
} from "@stele/sync";
import type { VaultSession } from "./vault-session.ts";
import { VaultMeta, setPath } from "./vault-meta.ts";

/**
 * 空間(vault → 空間 → 筆記三層的中繼資料)操作。
 *
 * 只吃 VaultMeta + VaultSession,**不需要同步**——空間在純本地 vault 一樣完整可用。
 * 同步啟用時,SyncManager 以 SpaceSyncHooks 掛上兩個副作用:移動後重推快照、新生 doc 納入同步。
 */

/** 同步啟用時才有的副作用;未啟用同步則兩者都不需要(本來就沒東西要推) */
export interface SpaceSyncHooks {
  /** 移動後以新空間金鑰重推快照、截斷舊金鑰增量;離線時由實作登記待辦 */
  rekeyAfterMove(docId: string): Promise<void>;
  /** 新生的 doc 納入同步 */
  trackNewDoc(docId: string): void;
}

/** 複製筆記的目標路徑:「a/b.md」→「a/b (副本).md」(進一步撞名由 VaultSession freeVariant 退讓) */
function copyPathFor(rel: string): string {
  const dir = path.dirname(rel);
  const name = `${path.basename(rel).replace(/\.md$/, "")} (副本).md`;
  return dir === "." ? name : `${dir}/${name}`;
}

export class SpacesService {
  private readonly docSpaces: Y.Map<string>;
  private sync: SpaceSyncHooks | undefined;

  constructor(
    private readonly meta: VaultMeta,
    private readonly session: VaultSession,
    /** 空間登記或筆記歸屬有變(本地或遠端),供 main 通知 renderer 刷新側欄 */
    onChange?: () => void,
  ) {
    this.docSpaces = meta.doc.getMap(DOC_SPACES_MAP);
    if (onChange) {
      this.docSpaces.observe(() => onChange());
      // 空間登記變更(建立/改名/顏色,含巢狀欄位);observeDeep 才抓得到改名
      meta.doc.getMap(SPACES_MAP).observeDeep(() => onChange());
    }
  }

  /** 同步啟用/停用時掛上或卸下副作用 */
  setSyncHooks(hooks: SpaceSyncHooks | undefined): void {
    this.sync = hooks;
  }

  /** 全部空間(含預設空間,永遠在最前) */
  listSpaces(): Space[] {
    return readSpaces(this.meta.doc);
  }

  /** 空間總覽:全部空間 + 每篇筆記歸屬(rel → spaceId,僅非預設空間) */
  overview(): { spaces: Space[]; assignments: Record<string, string> } {
    const assignments: Record<string, string> = {};
    for (const [docId, spaceId] of this.docSpaces.entries()) {
      const rel = this.session.relForDocId(docId);
      if (rel !== undefined) assignments[rel] = spaceId;
    }
    return { spaces: this.listSpaces(), assignments };
  }

  /** 建立新空間,回傳新 spaceId(id 由此處生成 UUID) */
  createSpace(name: string, color?: string): string {
    const id = randomUUID();
    this.meta.transact(() => createSpaceModel(this.meta.doc, { id, name, color, at: Date.now() }));
    return id;
  }

  renameSpace(spaceId: string, name: string): void {
    this.meta.transact(() => renameSpaceModel(this.meta.doc, spaceId, name, Date.now()));
  }

  /** 某筆記所屬空間 id(未指派 → 預設空間) */
  spaceOfNote(rel: string): string {
    return spaceOf(this.meta.doc, this.docIdFor(rel));
  }

  /**
   * 把筆記移到某空間:改歸屬(路由 cipher 之後對此 docId 改用新空間金鑰),
   * 同步啟用時再以新金鑰重推快照,使其他裝置能以新空間金鑰解出。
   */
  async moveNoteToSpace(rel: string, spaceId: string): Promise<void> {
    const docId = this.docIdFor(rel);
    if (spaceOf(this.meta.doc, docId) === spaceId) return;
    // 伴生留言 doc 跟著移:受限空間筆記的留言必須同一把空間金鑰,否則留言以 root 加密即洩漏
    const commentDocId = this.meta.doc.getMap<string>("comments").get(docId);
    this.meta.transact(() => {
      moveNoteModel(this.meta.doc, docId, spaceId, Date.now());
      if (commentDocId) assignDocSpace(this.meta.doc, commentDocId, spaceId);
    });
    await this.sync?.rekeyAfterMove(docId);
    if (commentDocId) await this.sync?.rekeyAfterMove(commentDocId);
  }

  /**
   * 設定空間成員子集(team vault、owner 限定,授權由 main 把關):
   * memberIds = 受限名單;undefined = 恢復開放全團隊。只改 meta 名單——金鑰面(生新空間金鑰、
   * 只包給名單、全庫重加密)由呼叫端接著跑金鑰輪換,名單變更才真正生效於密碼層。
   */
  setSpaceMembers(spaceId: string, memberIds: string[] | undefined): void {
    this.meta.transact(() => setSpaceMembersModel(this.meta.doc, spaceId, memberIds, Date.now()));
  }

  /**
   * 複製筆記到某空間:目標空間生一篇全新筆記(新 docId、內容複製),原筆記原封不動。
   * 自出生即以目標空間金鑰加密——先 recordCopy 登記歸屬,再建檔開 host、納入同步,
   * 確保第一次 push 就走目標空間的金鑰。回傳副本的相對路徑。
   */
  copyNoteToSpace(rel: string, spaceId: string): string {
    const fromDocId = this.docIdFor(rel);
    const md = this.session.docFor(rel).getText("md").toString();
    const copy = new Y.Doc();
    copy.getText("md").insert(0, md);
    const newDocId = randomUUID();
    // 先登記歸屬:讓第一次 push 就以目標空間金鑰加密,免得先用預設金鑰再重推
    this.meta.transact(() => recordCopyModel(this.meta.doc, { fromDocId, newDocId, toSpaceId: spaceId, at: Date.now() }));
    const landed = this.session.adoptRemoteDoc(copyPathFor(rel), newDocId, copy);
    setPath(this.meta, newDocId, landed);
    this.sync?.trackNewDoc(newDocId);
    return landed;
  }

  /** 空間變更稽核紀錄(append-only)供 UI 追查 */
  readAudit(): SpaceAuditEvent[] {
    return readAudit(this.meta.doc);
  }

  private docIdFor(rel: string): string {
    return this.session.peekDocId(rel) ?? this.session.docId(rel);
  }
}
