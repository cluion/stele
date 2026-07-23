import { encodeClientMessage, decodeServerMessage, type ClientMessage, type ServerMessage, type MemberRole } from "./protocol.ts";
import type { SocketLike } from "./client.ts";
import { identityChallengeBytes, type SyncIdentity } from "./identity.ts";
import { wrapKey, type WrapContext } from "./crypto.ts";
import { verifyRoleCredential, signMemberCredential } from "./role-credential.ts";
import { verifyVaultPolicy } from "./vault-policy.ts";

/**
 * 團隊 vault 的金鑰 bootstrap(2b):在建 SyncManager **之前**跑完的獨立握手。
 *
 * 為何獨立於 SyncClient:SyncClient 一收 authOk 就立即用空間金鑰(=root)解 vault-meta;
 * 但 root 要「認證後 pull 信封並 unwrap」才拿得到——需要 root 的那條連線正是負責送來 root 的連線,
 * 塞進 SyncClient 會死結。故先在此把 root 拿到手,再以 MasterKeySpaces(root) 照舊建 SyncManager,下游不動。
 */

const HANDSHAKE_TIMEOUT_MS = 15_000;
export const KEY_ID_ROOT = "root";

/** root 信封的 WrapContext:epoch 為金鑰紀元(2c-2 輪換遞增;建立與 2b 相容預設 0) */
export function rootWrapContext(vaultId: string, recipientMemberId: string, epoch = 0): WrapContext {
  return { vaultId, keyId: KEY_ID_ROOT, epoch, recipientMemberId };
}

export interface TeamBootstrapOptions {
  url: string;
  token: string;
  vaultId: string;
  identity: SyncIdentity;
  /** out-of-band 已知的 owner pubSign(信任錨,驗信封簽章);建立者自建時即自己的 pubSign */
  ownerPubSign: Uint8Array;
  /** 新成員首次加入帶一次性邀請碼;已 enroll 成員/建立者留空或省略 */
  enrollmentToken?: string;
  createSocket: (url: string) => SocketLike;
}

/**
 * ready=拿到 root 可協作(epoch 為信封的金鑰紀元,doc 寫入須帶它);pending=已認證但 owner 尚未包 root 給我。
 * role(§9.5)= 驗過 owner 簽章的角色憑證所載角色;undefined = owner 尚未簽發(升級前核准的舊成員),
 * 呼叫端 fallback 本地既知角色。憑證存在但驗不過(偽造/挪用)→ 整個 bootstrap 拋錯。
 * spaceKeys = 受限空間的獨立金鑰(keyId=spaceId 的信封,只有名單內成員有);未授權的空間就是不在 map 裡。
 * restrictedSpaceIds = 當前紀元的受限空間集合(信封層權威,與金鑰原子取得):在其中而不在 spaceKeys
 * = 受限但我沒份,絕不能拿 root fallback 加解密。
 */
export type TeamBootstrapResult =
  | {
      status: "ready";
      root: Uint8Array;
      epoch: number;
      role?: MemberRole;
      spaceKeys: Map<string, Uint8Array>;
      restrictedSpaceIds: string[];
      /**
       * 強制簽章模式(§7.3):當代 owner 簽章 vault 政策的明確值(true=拒 unsigned、false=容忍);
       * **undefined = 未收到當代政策**(從未設定,或惡意伺服器抑制)——呼叫端據此保留既有強制態(fail-closed pin),
       * 不把「政策缺席」當成關閉,擋惡意伺服器以抑制政策偷降級已 pin 的成員。
       */
      requireSignedWrites: boolean | undefined;
    }
  | { status: "pending" };

/**
 * 加入者/既有成員的 bootstrap:認證(可帶邀請碼)→ pull 自己的 root 信封 → 驗 owner 簽章後 unwrap。
 * 無信封 → pending(重連或收到通知時重試)。owner 簽章驗不過或 context 不符 → 拋(擋盲中繼偽造)。
 */
export function bootstrapTeamKey(opts: TeamBootstrapOptions): Promise<TeamBootstrapResult> {
  const { identity, vaultId } = opts;
  return driveHandshake<TeamBootstrapResult>(opts.createSocket, opts.url, authIdMessage(opts), (sock, done, fail) => async (msg) => {
    switch (msg.type) {
      case "authChallenge":
        sock.send(encodeClientMessage({ type: "authProof", signature: proofFor(identity, msg.nonce, vaultId) }));
        break;
      case "authOk":
        sock.send(encodeClientMessage({ type: "envelopePull", reqId: 1 }));
        break;
      case "envelopeList": {
        const env = msg.envelopes.find((e) => e.keyId === KEY_ID_ROOT);
        if (!env) {
          done({ status: "pending" });
          return;
        }
        // context 用信封宣稱的 epoch:偽造 epoch 會使 HKDF info 不符 → GCM 驗不過而拒絕,不會靜默拿錯 root
        const root = await identity.unwrap(env.blob, opts.ownerPubSign, rootWrapContext(vaultId, identity.memberId, env.epoch));
        // 受限空間金鑰(keyId=spaceId 的信封):同一信任錨驗簽解封;舊紀元殘留(輪換後
        // envelopesFor 理論上只回最新,但防禦深度仍比對)略過。偽造信封 unwrap 必拋,不靜默
        const spaceKeys = new Map<string, Uint8Array>();
        for (const e of msg.envelopes) {
          if (e.keyId === KEY_ID_ROOT || e.epoch !== env.epoch) continue;
          spaceKeys.set(e.keyId, await identity.unwrap(e.blob, opts.ownerPubSign, { vaultId, keyId: e.keyId, epoch: e.epoch, recipientMemberId: identity.memberId }));
        }
        // 角色憑證(§9.5):驗 owner 簽章;偽造/挪用即拋(擋盲中繼捏造角色)。
        // 憑證 epoch 必須等於信封 epoch——舊紀元憑證(真簽但已被輪換作廢)視同未簽發,擋降級/升級重放
        let role: MemberRole | undefined;
        if (msg.roleCred.length > 0) {
          const cred = verifyRoleCredential(msg.roleCred, opts.ownerPubSign, vaultId, identity.memberId);
          if (cred.epoch === env.epoch) role = cred.role;
        }
        // Vault 政策(§7.3):驗 owner 簽章;偽造/挪用即拋(擋盲中繼捏造政策)。
        // 政策缺席或非當代 → undefined(呼叫端保留既有強制態):惡意伺服器抑制政策無法偷降級,
        // 舊紀元政策(真簽但已被輪換作廢)也不採信,擋降級/升級重放。只有當代明確政策才決定 on/off。
        let requireSignedWrites: boolean | undefined;
        if (msg.policy.length > 0) {
          const pol = verifyVaultPolicy(msg.policy, opts.ownerPubSign, vaultId);
          if (pol.epoch === env.epoch) requireSignedWrites = pol.requireSignedWrites;
        }
        done({ status: "ready", root, epoch: env.epoch, role, spaceKeys, restrictedSpaceIds: msg.restrictedSpaceIds, requireSignedWrites });
        break;
      }
      case "error":
        fail(new Error(`bootstrap 失敗:${msg.code} ${msg.message}`));
        break;
    }
  });
}

export interface CreateTeamVaultOptions {
  url: string;
  token: string;
  vaultId: string;
  identity: SyncIdentity;
  createSocket: (url: string) => SocketLike;
  /** 測試可注入決定性 root;預設隨機 32B */
  generateRoot?: () => Uint8Array;
}

/**
 * 建立團隊 vault(owner 一次性):認證 → claimOwner(TOFU 釘選為 owner)→ 生隨機 root →
 * 自封(用自己的 pubWrap 包、自己簽)→ push。root 的持久之家就是這封 self-envelope,
 * owner 換裝置/重灌時走 bootstrapTeamKey 復原(與被邀者同一條路徑)。回傳 root。
 */
export function createTeamVault(opts: CreateTeamVaultOptions): Promise<Uint8Array> {
  const { identity, vaultId } = opts;
  const genRoot = opts.generateRoot ?? (() => crypto.getRandomValues(new Uint8Array(32)));
  let root: Uint8Array | undefined;
  const authId: ClientMessage = {
    type: "authId",
    token: opts.token,
    vaultId,
    memberId: identity.memberId,
    pubSign: identity.pubSign,
    pubWrap: identity.pubWrap,
    enrollmentToken: "",
  };
  return driveHandshake<Uint8Array>(opts.createSocket, opts.url, authId, (sock, done, fail) => async (msg) => {
    switch (msg.type) {
      case "authChallenge":
        sock.send(encodeClientMessage({ type: "authProof", signature: proofFor(identity, msg.nonce, vaultId) }));
        break;
      case "authOk":
        sock.send(encodeClientMessage({ type: "claimOwner", reqId: 1 }));
        break;
      case "ok":
        if (msg.reqId === 1) {
          root = genRoot();
          const env = await wrapKey(root, identity.pubWrap, identity.sign, rootWrapContext(vaultId, identity.memberId));
          sock.send(encodeClientMessage({ type: "envelopePush", reqId: 2, keyId: KEY_ID_ROOT, memberId: identity.memberId, epoch: 0, blob: env }));
        } else if (msg.reqId === 2) {
          // owner 自簽成員憑證(P4):owner 也寫入,需在目錄裡有可驗的 pubSign;輪換後透過 approve 重簽
          const cert = signMemberCredential(identity.sign, { vaultId, pubSign: identity.pubSign, role: "owner", epoch: 0 });
          sock.send(encodeClientMessage({ type: "memberCertPush", reqId: 3, memberId: identity.memberId, blob: cert }));
        } else if (msg.reqId === 3 && root) {
          done(root);
        }
        break;
      case "error":
        fail(new Error(`建立團隊 vault 失敗:${msg.code} ${msg.message}`));
        break;
    }
  });
}

function authIdMessage(opts: TeamBootstrapOptions): ClientMessage {
  return {
    type: "authId",
    token: opts.token,
    vaultId: opts.vaultId,
    memberId: opts.identity.memberId,
    pubSign: opts.identity.pubSign,
    pubWrap: opts.identity.pubWrap,
    enrollmentToken: opts.enrollmentToken ?? "",
  };
}

function proofFor(identity: SyncIdentity, nonce: Uint8Array, vaultId: string): Uint8Array {
  return identity.sign(identityChallengeBytes(nonce, vaultId, identity.memberId));
}

/** 一次性握手骨架:開連線→送 authId→驅動訊息處理;done/fail 收尾並關連線,附逾時 */
function driveHandshake<T>(
  createSocket: (url: string) => SocketLike,
  url: string,
  authId: ClientMessage,
  makeHandler: (sock: SocketLike, done: (v: T) => void, fail: (e: unknown) => void) => (msg: ServerMessage) => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sock = createSocket(url);
    sock.binaryType = "arraybuffer";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {
        /* 關連線失敗無妨,已收尾 */
      }
    };
    const done = (v: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error("bootstrap 逾時")), HANDSHAKE_TIMEOUT_MS);
    const handler = makeHandler(sock, done, fail);
    sock.onopen = () => sock.send(encodeClientMessage(authId));
    sock.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
        msg = decodeServerMessage(data);
      } catch (e) {
        fail(e);
        return;
      }
      Promise.resolve(handler(msg)).catch(fail);
    };
    sock.onclose = () => fail(new Error("bootstrap 連線中斷"));
    sock.onerror = (err) => fail(err ?? new Error("bootstrap 連線錯誤"));
  });
}
