import { encodeClientMessage, decodeServerMessage, type ClientMessage, type ServerMessage, type MemberInfo } from "./protocol.ts";
import type { SocketLike } from "./client.ts";
import type { SyncIdentity } from "./identity.ts";
import { orgChallengeBytes, orgIdFromRootPubSign, signOrgTeamCert, signOrgMemberCert, signOrgPolicy } from "./org-credential.ts";

/**
 * 組織管理連線(3a):org admin 對**組織根**證明身分後取得的連線,只能治理、碰不到任何 doc 內容。
 *
 * 為何需要獨立連線:org admin 通常不是該團隊 vault 的成員(這正是重點——owner 離職時,
 * 組織必須能在沒有任何團隊成員配合的情況下指派新 owner),因此走不了 authId 的成員認證路徑。
 *
 * 能力邊界(治理優先,見 spec §3):可換發團隊憑證(指派當代 owner);**不能**加人、輪換、讀寫內容
 * ——那些需要 root 金鑰,而治理模式下組織沒有。要代管得另行開啟託管(3c)。
 */

const OPEN_TIMEOUT_MS = 15_000;

export interface OrgAdminOptions {
  url: string;
  token: string;
  /** 組織根簽章公鑰(信任錨本身;orgId 由它導出) */
  orgRootPubSign: Uint8Array;
  /** 這條連線的操作者身分:root 自己,或持有 root 委任的 admin */
  identity: SyncIdentity;
  /** root 簽的管理員委任;操作者即 root 本人時省略 */
  adminCert?: Uint8Array;
  createSocket: (url: string) => SocketLike;
}

/** 一筆管理事件(3b-3);actor/target 為 memberId,組織發起時 actor 為 orgId */
export interface AdminEventInfo {
  id: number;
  vaultId: string;
  /** unix 秒;伺服器時鐘 */
  ts: number;
  kind: string;
  actor: string;
  target: string;
  detail: string;
}

interface Pending {
  resolve: (msg: ServerMessage) => void;
  reject: (err: unknown) => void;
}

export class OrgAdminSession {
  private reqSeq = 0;
  private readonly pending = new Map<number, Pending>();
  private authed = false;
  private settled = false;
  private authResolve!: () => void;
  private authReject!: (err: unknown) => void;
  private readonly ready: Promise<void>;
  readonly orgId: string;

  private constructor(
    private readonly sock: SocketLike,
    private readonly token: string,
    private readonly orgRootPubSign: Uint8Array,
    private readonly identity: SyncIdentity,
    private readonly adminCert: Uint8Array,
  ) {
    this.orgId = orgIdFromRootPubSign(orgRootPubSign);
    this.ready = new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
    sock.binaryType = "arraybuffer";
    sock.onopen = () =>
      this.rawSend({
        type: "authOrg",
        token: this.token,
        orgId: this.orgId,
        adminPubSign: this.identity.pubSign,
        adminCert: this.adminCert,
      });
    sock.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
        msg = decodeServerMessage(data);
      } catch (err) {
        this.failAll(err);
        return;
      }
      this.onMessage(msg);
    };
    sock.onclose = () => this.failAll(new Error("組織管理連線中斷"));
    sock.onerror = (err) => this.failAll(err ?? new Error("組織管理連線錯誤"));
  }

  /** 開一條認證好的組織管理連線;伺服器需已知此 org(至少一個 vault 綁定過)否則拒 */
  static async open(opts: OrgAdminOptions): Promise<OrgAdminSession> {
    const session = new OrgAdminSession(
      opts.createSocket(opts.url),
      opts.token,
      opts.orgRootPubSign,
      opts.identity,
      opts.adminCert ?? new Uint8Array(),
    );
    const timer = setTimeout(() => session.authReject(new Error("組織管理連線逾時")), OPEN_TIMEOUT_MS);
    try {
      await session.ready;
    } finally {
      clearTimeout(timer);
    }
    return session;
  }

  /**
   * 指派某 vault 的當代 owner:簽發並上傳團隊憑證。serial 須大於伺服器已存的(反回滾)。
   * 新 owner 必須已是該 vault 的成員(否則無公鑰、拿不到 root,伺服器會拒)。
   *
   * prevOwnerPubSign:交接時務必帶上前任公鑰——組織以此背書「前任簽的金鑰信封在接管完成前仍可採信」,
   * 否則撤換當下連新 owner 自己都解不開 root(他的信封是前任包的),整個團隊會鎖死。
   * 範圍僅止於信封;角色/政策憑證過渡期一律視同未簽發,前任卸任後改不動任何權限。
   */
  async assignOwner(vaultId: string, ownerPubSign: Uint8Array, serial: number, prevOwnerPubSign?: Uint8Array): Promise<void> {
    const cert = signOrgTeamCert(
      this.identity.sign,
      { vaultId, ownerPubSign, serial, ...(prevOwnerPubSign ? { prevOwnerPubSign } : {}) },
      this.adminCert.length > 0 ? this.adminCert : undefined,
    );
    await this.request((reqId) => ({ type: "orgCertPush", reqId, vaultId, orgRootPubSign: this.orgRootPubSign, cert }), "ok");
  }

  /**
   * 設定某人在組織名冊上的顯示名(3b-1)。serial 須大於伺服器已存的(反回滾)。
   * 名冊只是「組織說這個 memberId 叫什麼」——不含金鑰,也不影響任何授權。
   */
  async setMemberName(memberId: string, displayName: string, serial: number, department?: string): Promise<void> {
    const blob = signOrgMemberCert(
      this.identity.sign,
      { memberId, displayName, ...(department ? { department } : {}), serial },
      this.adminCert.length > 0 ? this.adminCert : undefined,
    );
    await this.request((reqId) => ({ type: "orgMemberCertPush", reqId, memberId, blob }), "ok");
  }

  /** 本組織的團隊總覽(管理平面:vault、當代 owner、成員數、憑證序號) */
  async vaults(): Promise<{ vaultId: string; ownerMemberId: string; memberCount: number; serial: number }[]> {
    const msg = await this.request((reqId) => ({ type: "orgVaultList", reqId }), "orgVaultCatalog");
    return msg.vaults;
  }

  /** 某團隊的成員清單(需該 vault 屬於本組織);含角色與是否已核准,不含任何金鑰 */
  async members(vaultId: string): Promise<MemberInfo[]> {
    const msg = await this.request((reqId) => ({ type: "orgMemberList", reqId, vaultId }), "memberCatalog");
    return msg.members;
  }

  /**
   * 一次全撤(3b-2):把某人從本組織**所有**團隊移除並當場踢線。
   * 回報 removed(已移除)與 skippedOwner(他是該團隊擁有者而略過——請先指派新擁有者再撤)。
   * 移除是伺服器層即時生效;被撤者手上的舊 root 要各團隊擁有者輪換才作廢,伺服器已標記催促。
   */
  async revokeEverywhere(memberId: string): Promise<{ removed: string[]; skippedOwner: string[] }> {
    const msg = await this.request((reqId) => ({ type: "orgRevoke", reqId, memberId }), "orgRevokeResult");
    return { removed: msg.removed, skippedOwner: msg.skippedOwner };
  }

  /**
   * 下發組織政策(3b-2):與各團隊自己的政策**取較嚴者**,組織只能加嚴不能放寬。
   * serial 須大於伺服器已存的(反回滾)。
   */
  async setRequireSignedWrites(enabled: boolean, serial: number): Promise<void> {
    const blob = signOrgPolicy(this.identity.sign, { requireSignedWrites: enabled, serial }, this.adminCert.length > 0 ? this.adminCert : undefined);
    await this.request((reqId) => ({ type: "orgPolicyPush", reqId, requireSigned: enabled, blob }), "ok");
  }

  /**
   * 管理事件彙整(3b-3):拉本組織的管理平面事件,新到舊。vaultId 省略 = 全組織。
   *
   * **這是伺服器自己的紀錄,不是密碼學證據**——惡意伺服器能捏造、刪改自己的日誌,它的用途是
   * 誠實伺服器下的營運稽核。範圍也僅止於伺服器看得見的管理動作:誰加入、被移除、改角色、
   * 憑證換發、輪換、組織治理。**內容操作看不到**(誰讀了哪篇筆記、空間稽核都在密文裡)。
   */
  async events(vaultId?: string, limit = 200): Promise<AdminEventInfo[]> {
    const msg = await this.request((reqId) => ({ type: "orgEventPull", reqId, vaultId: vaultId ?? "", limit }), "orgEventList");
    return msg.events;
  }

  close(): void {
    this.settled = true;
    try {
      this.sock.close();
    } catch {
      /* 已收尾 */
    }
  }

  private onMessage(msg: ServerMessage): void {
    if (!this.authed) {
      if (msg.type === "authChallenge") {
        this.rawSend({ type: "authProof", signature: this.identity.sign(orgChallengeBytes(msg.nonce, this.orgId, this.identity.memberId)) });
      } else if (msg.type === "orgAuthOk") {
        this.authed = true;
        this.authResolve();
      } else if (msg.type === "error") {
        this.failAll(new Error(`組織管理認證失敗:${msg.code} ${msg.message}`));
      }
      return;
    }
    if ("reqId" in msg && typeof msg.reqId === "number") {
      const p = this.pending.get(msg.reqId);
      if (p) {
        this.pending.delete(msg.reqId);
        p.resolve(msg);
      }
      return;
    }
    if (msg.type === "error") this.failAll(new Error(`組織管理失敗:${msg.code} ${msg.message}`));
  }

  private request<K extends ServerMessage["type"]>(
    build: (reqId: number) => ClientMessage,
    expect: K,
  ): Promise<ServerMessage & { type: K }> {
    if (this.settled) return Promise.reject(new Error("組織管理連線已關閉"));
    const reqId = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: (m) => (m.type === expect ? resolve(m as ServerMessage & { type: K }) : reject(new Error(`預期 ${expect} 卻得 ${m.type}`))),
        reject,
      });
      this.rawSend(build(reqId));
    });
  }

  private rawSend(msg: ClientMessage): void {
    this.sock.send(encodeClientMessage(msg));
  }

  private failAll(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    const e = err instanceof Error ? err : new Error(String(err));
    if (!this.authed) this.authReject(e);
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
