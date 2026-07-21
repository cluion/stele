import { encodeClientMessage, decodeServerMessage, type ClientMessage, type ServerMessage, type MemberInfo } from "./protocol.ts";
import type { SocketLike } from "./client.ts";
import { identityChallengeBytes, type SyncIdentity } from "./identity.ts";
import { wrapKey } from "./crypto.ts";
import { rootWrapContext, KEY_ID_ROOT } from "./bootstrap.ts";

/**
 * 團隊擁有者的管理連線(2b):一條認證好的連線,發邀請碼、列成員、核准(把 root 包給成員)、移除成員。
 * 授權由伺服器按 owner 把關;此類只負責協議往返。與 SyncClient 分開,不污染 doc 同步連線。
 */

const OPEN_TIMEOUT_MS = 15_000;

export interface TeamAdminOptions {
  url: string;
  token: string;
  vaultId: string;
  identity: SyncIdentity;
  createSocket: (url: string) => SocketLike;
}

interface Pending {
  resolve: (msg: ServerMessage) => void;
  reject: (err: unknown) => void;
}

export class TeamAdminSession {
  private reqSeq = 0;
  private readonly pending = new Map<number, Pending>();
  private authed = false;
  private settled = false;
  private authResolve!: () => void;
  private authReject!: (err: unknown) => void;
  private readonly ready: Promise<void>;

  private constructor(
    private readonly sock: SocketLike,
    private readonly token: string,
    private readonly vaultId: string,
    private readonly identity: SyncIdentity,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
    sock.binaryType = "arraybuffer";
    sock.onopen = () =>
      this.rawSend({
        type: "authId",
        token: this.token,
        vaultId: this.vaultId,
        memberId: this.identity.memberId,
        pubSign: this.identity.pubSign,
        pubWrap: this.identity.pubWrap,
        enrollmentToken: "",
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
    sock.onclose = () => this.failAll(new Error("團隊管理連線中斷"));
    sock.onerror = (err) => this.failAll(err ?? new Error("團隊管理連線錯誤"));
  }

  /** 開一條認證好的 owner 管理連線;認證失敗或逾時即拋 */
  static async open(opts: TeamAdminOptions): Promise<TeamAdminSession> {
    const session = new TeamAdminSession(opts.createSocket(opts.url), opts.token, opts.vaultId, opts.identity);
    const timer = setTimeout(() => session.authReject(new Error("團隊管理連線逾時")), OPEN_TIMEOUT_MS);
    try {
      await session.ready;
    } finally {
      clearTimeout(timer);
    }
    return session;
  }

  /** 產生一次性邀請碼(owner-only),供 out-of-band 交付被邀請者 */
  async inviteToken(ttlSec: number): Promise<string> {
    const msg = await this.request((reqId) => ({ type: "enrollCreate", reqId, ttlSec }), "enrollCreated");
    return msg.token;
  }

  /** 列出成員(含 pubWrap,供核准時包裝 root) */
  async members(): Promise<MemberInfo[]> {
    const msg = await this.request((reqId) => ({ type: "memberList", reqId }), "memberCatalog");
    return msg.members;
  }

  /** 核准某成員:以其 pubWrap 把 root 包成 owner 簽章信封並 push(核准前 UI 應先讓 owner 核對 pubWrap 指紋) */
  async approve(member: MemberInfo, root: Uint8Array): Promise<void> {
    const blob = await wrapKey(root, member.pubWrap, this.identity.sign, rootWrapContext(this.vaultId, member.memberId));
    await this.request((reqId) => ({ type: "envelopePush", reqId, keyId: KEY_ID_ROOT, memberId: member.memberId, epoch: 0, blob }), "ok");
  }

  /** 移除成員(刪 member 列 + 其信封;root 未輪換,留 2c) */
  async remove(memberId: string): Promise<void> {
    await this.request((reqId) => ({ type: "memberRemove", reqId, memberId }), "ok");
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
        this.rawSend({ type: "authProof", signature: this.identity.sign(identityChallengeBytes(msg.nonce, this.vaultId, this.identity.memberId)) });
      } else if (msg.type === "authOk") {
        this.authed = true;
        this.authResolve();
      } else if (msg.type === "error") {
        this.failAll(new Error(`團隊管理認證失敗:${msg.code} ${msg.message}`));
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
    // 無 reqId 的 error(伺服器 refuse 後即關連線):拒絕所有在途請求
    if (msg.type === "error") this.failAll(new Error(`團隊管理失敗:${msg.code} ${msg.message}`));
  }

  private request<K extends ServerMessage["type"]>(
    build: (reqId: number) => ClientMessage,
    expect: K,
  ): Promise<ServerMessage & { type: K }> {
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
