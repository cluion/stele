import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import {
  decodeClientMessage,
  encodeServerMessage,
  verifyChallenge,
  verifyOrgChallenge,
  verifyOrgAdminCert,
  verifyOrgTeamCert,
  orgIdFromRootPubSign,
  orgMemberCertSerial,
  orgPolicyFields,
  type ClientMessage,
  type ServerMessage,
  type MemberRole,
} from "@stele/sync";
import { SyncStore, type ShareScope } from "./store.ts";

/**
 * blind relay:認證、存加密 blob、配序號、廣播;完全不解讀 payload
 * 每條連線隸屬一個 vault,push 會廣播給同 vault 的其他連線
 * 同一 http 埠也提供唯讀分享檢視器的靜態頁(viewerDir 有設才提供);shareId 由前端解析,伺服器全盲
 */

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
/** 邀請碼有效期夾限:太短不便交付、太長擴大搶用面 */
const ENROLL_TTL_MIN = 60;
const ENROLL_TTL_MAX = 7 * 24 * 60 * 60;

/** 團隊金鑰分發與成員管理訊息(需身分認證,授權按 owner/self 把關) */
type TeamAdminMessage = Extract<
  ClientMessage,
  {
    type:
      | "claimOwner"
      | "envelopePush"
      | "envelopePull"
      | "memberList"
      | "memberRemove"
      | "enrollCreate"
      | "memberSetRole"
      | "rotateKey"
      | "credPush"
      | "memberCertPush"
      | "memberCertPull"
      | "policyPush";
  }
>;

const CONTENT_TYPE: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "viewer.js": "text/javascript; charset=utf-8",
  "viewer.js.map": "application/json; charset=utf-8",
};

/**
 * 檢視器渲染的是別人的筆記,CSP 是內容層淨化之外的第二道防線
 * 下在 header 而非 <meta>:frame-ancestors 在 meta 版會被瀏覽器忽略
 * connect-src 'self' 涵蓋回同源伺服器的 ws/wss;style 走 index.html 的 inline <style>
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** 靜態檔案只認允許清單,不吃使用者路徑,天然免於路徑穿越 */
function makeRequestHandler(viewerDir: string | undefined) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // 分享頁一律回同一份 shell,shareId 只在前端解析
    const file =
      url === "/viewer.js" || url === "/viewer.js.map"
        ? url.slice(1)
        : url === "/" || url.startsWith("/s/")
          ? "index.html"
          : undefined;
    if (!viewerDir || !file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(join(viewerDir, file));
      res.writeHead(200, {
        "content-type": CONTENT_TYPE[file] ?? "application/octet-stream",
        "cache-control": file === "index.html" ? "no-cache" : "public, max-age=3600",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer", // 金鑰在 fragment,但外連圖片/連結一律不帶 referrer
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  };
}

/** 收斂字元集:id 不進伺服器路徑,但協議層就該擋掉 / 與 .. 這類穿越素材 */
const validId = (id: string): boolean => id.length <= MAX_ID_LENGTH && /^[\p{L}\p{N}._-]+$/u.test(id) && !id.includes("..");

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(opts: { port: number; token: string; store: SyncStore; viewerDir?: string }): Promise<RunningServer> {
  const httpServer = createServer(makeRequestHandler(opts.viewerDir));
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  const vaults = new Map<string, Set<WebSocket>>();
  const alive = new WeakSet<WebSocket>();
  // 分享連線的 doc 作用域:值為受限 docId 時,只收得到該 doc 的廣播;owner 連線不入此表(全收)
  const restrictedDoc = new WeakMap<WebSocket, string>();
  // shareId → 以它認證的連線:撤銷要能即時踢人,否則作用域只在認證當下查一次,已連線者可續讀到天荒地老
  const shareConns = new Map<string, Set<WebSocket>>();
  const genShareId = (): string => randomBytes(16).toString("base64url");
  // (vaultId → memberId → 連線):移除/改角色時即時踢對方活躍連線(2c),照 shareConns 的踢人 pattern
  const memberConns = new Map<string, Map<string, Set<WebSocket>>>();
  const trackMember = (vault: string, member: string, ws: WebSocket): void => {
    const byMember = memberConns.get(vault) ?? new Map<string, Set<WebSocket>>();
    const set = byMember.get(member) ?? new Set<WebSocket>();
    set.add(ws);
    byMember.set(member, set);
    memberConns.set(vault, byMember);
  };
  const untrackMember = (vault: string, member: string, ws: WebSocket): void => {
    const byMember = memberConns.get(vault);
    const set = byMember?.get(member);
    set?.delete(ws);
    if (set && set.size === 0) byMember!.delete(member);
    if (byMember && byMember.size === 0) memberConns.delete(vault);
  };
  /** 踢掉某成員在某 vault 的所有活躍連線(移除/降級用);不影響其他成員 */
  const kickMember = (vault: string, member: string, code: string, message: string): void => {
    for (const peer of memberConns.get(vault)?.get(member) ?? []) {
      if (peer.readyState !== WebSocket.OPEN) continue;
      peer.send(encodeServerMessage({ type: "error", code, message }));
      peer.close();
    }
  };

  /**
   * 踢掉某 vault 全體成員的活躍連線(3a 撤換 owner 用)。
   * 為何是全體:撤換後新 owner 會以自己的簽章重發全員憑證,任何仍抱著舊信任錨的連線,
   * 一旦重拉目錄就會整份驗不過而丟棄寫入。與其留一個「最終會自癒」的窗口,不如當場斷線,
   * 讓每個人確定性地重跑 bootstrap 換錨(與 memberSetRole 踢人同一套 pattern)。
   */
  const kickVaultMembers = (vault: string, code: string, message: string): void => {
    for (const member of memberConns.get(vault)?.keys() ?? []) kickMember(vault, member, code, message);
  };

  // 死連線偵測:兩輪沒回 pong 就終止,避免 vaults 累積殭屍連線
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("connection", (ws) => {
    // vaultId 是連線所屬 vault;share 連線 scope 非 undefined,被鎖在單一 doc 與權限
    let vaultId: string | undefined;
    let scope: ShareScope | undefined;
    let shareId: string | undefined;
    // 已認證的成員身分(authId 路徑);team 管理與金鑰信封的授權都比對它。share/legacy 連線為 undefined
    let memberId: string | undefined;
    // 此連線的角色(2c),authProof 當下讀入;claimOwner 成功後更新為 owner。逐訊息讀寫授權據此把關
    let memberRole: MemberRole | undefined;
    // 帶身分認證的兩階段中間態(challenge-response);存 closure 內不用全域 Map,免洩漏
    let pendingNonce: Uint8Array | undefined;
    let pendingIdentity:
      | { vaultId: string; memberId: string; pubSign: Uint8Array; pubWrap: Uint8Array; enrollmentToken: string }
      | undefined;
    // 組織管理連線(3a):認證後只能推團隊憑證,doc 內容一律拒——治理平面與金鑰平面分離
    let orgScope: { orgId: string } | undefined;
    let pendingOrg: { orgId: string; adminMemberId: string; adminPubSign: Uint8Array } | undefined;
    const authTimer = setTimeout(() => ws.close(4401, "未認證"), AUTH_TIMEOUT_MS);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    // 沒有 error listener 時,單一 client 的 socket 異常會以 uncaught exception 炸掉整個行程
    ws.on("error", (err) => {
      console.error("連線錯誤:", err);
    });

    const send = (msg: ServerMessage): void => {
      ws.send(encodeServerMessage(msg));
    };
    const refuse = (code: string, message: string): void => {
      send({ type: "error", code, message });
      ws.close();
    };

    const joinVault = (vault: string): void => {
      const peers = vaults.get(vault) ?? new Set<WebSocket>();
      peers.add(ws);
      vaults.set(vault, peers);
    };

    const handleAuth = (msg: ClientMessage & { type: "auth" }): void => {
      if (vaultId !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      if (!tokenMatches(msg.token, opts.token)) {
        refuse("bad-token", "token 錯誤");
        return;
      }
      if (!validId(msg.vaultId)) {
        refuse("bad-vault", "非法 vault id");
        return;
      }
      // team vault(已有 owner)一律走身分認證:擋掉 legacy token-only 連線,
      // 使「已認證 = 已 enroll = 是成員」,堵掉匿名 token 持有者的 snapshotPush 截斷 DoS
      if (opts.store.ownerOf(msg.vaultId) !== undefined) {
        refuse("team-vault", "團隊 vault 需身分認證");
        return;
      }
      vaultId = msg.vaultId;
      clearTimeout(authTimer);
      joinVault(vaultId);
      send({ type: "authOk", docs: opts.store.headSeqs(vaultId), epoch: opts.store.epochOf(vaultId) });
    };

    // 帶身分認證第一階段:token 准入 + 宣稱身分 → 回每連線新生的 nonce 供簽章(防重放)
    const handleAuthId = (msg: ClientMessage & { type: "authId" }): void => {
      if (vaultId !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      if (!tokenMatches(msg.token, opts.token)) {
        refuse("bad-token", "token 錯誤");
        return;
      }
      if (!validId(msg.vaultId) || !validId(msg.memberId)) {
        refuse("bad-vault", "非法 id");
        return;
      }
      if (msg.pubSign.length !== 32 || msg.pubWrap.length !== 32) {
        refuse("bad-message", "非法公鑰");
        return;
      }
      // memberId 必須 = hex(sha256(pubSign)):否則攻擊者可挑任意 memberId 配自己的金鑰搶註,
      // 讓 2b 的邀請者把空間金鑰包給攻擊者的 pubWrap。綁定後 memberId 不再是自選 label,
      // 搶註別人 memberId 需 sha256 碰撞;順帶讓 challenge 的 memberId 固定 64 hex,拼接無歧義。
      if (msg.memberId !== createHash("sha256").update(msg.pubSign).digest("hex")) {
        refuse("bad-member", "memberId 與公鑰不符");
        return;
      }
      pendingIdentity = {
        vaultId: msg.vaultId,
        memberId: msg.memberId,
        pubSign: msg.pubSign,
        pubWrap: msg.pubWrap,
        enrollmentToken: msg.enrollmentToken,
      };
      pendingNonce = randomBytes(32);
      send({ type: "authChallenge", nonce: pendingNonce });
    };

    // 帶身分認證第二階段:驗簽 → TOFU 入表 → 鎖 vault。members 表在 2a 為 advisory,授權仍靠 token
    const handleAuthProof = (msg: ClientMessage & { type: "authProof" }): void => {
      if (vaultId !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      // nonce 一次性:取出即清,無論成敗都不留給下一則 authProof 重試(防禦深度)
      const nonce = pendingNonce;
      const p = pendingIdentity;
      pendingNonce = undefined;
      pendingIdentity = undefined;
      if (!nonce || !p) {
        refuse("bad-message", "未先發起身分認證");
        return;
      }
      if (!verifyChallenge(msg.signature, nonce, p.vaultId, p.memberId, p.pubSign)) {
        refuse("bad-proof", "身分簽章驗證失敗");
        return;
      }
      // team vault 的新成員准入閘:pubWrap 是 owner 包裝空間金鑰的信任錨,不可信純 TOFU 自註冊。
      // 已有 owner(=team)且此成員既非既有成員、也非 owner 本人 → 必須憑一次性邀請碼(綁此 vault、未用、未過期)。
      // 邀請碼帶角色(2c):新成員的角色即碼指定的 editor/viewer。個人/legacy vault 與已註冊成員維持原行為。
      const owner = opts.store.ownerOf(p.vaultId);
      const existing = opts.store.getMember(p.vaultId, p.memberId);
      let role: MemberRole;
      if (owner !== undefined && p.memberId === owner) {
        // owner 永遠是 owner,不受 members.role 漂移影響。
        // 自癒:0.9.0→2c 遷移把 role 預設為 viewer,owner 的 members.role 需回填,否則列表/後續讀取會錯
        role = "owner";
        if (existing && existing.role !== "owner") opts.store.setRole(p.vaultId, p.memberId, "owner");
      } else if (existing) {
        role = existing.role; // 既有成員:沿用 DB 角色(改角色走 setRole,enrollMember 不動既有 role)
      } else if (owner !== undefined) {
        const tokenRole = opts.store.consumeEnrollmentToken(p.enrollmentToken, p.vaultId);
        if (p.enrollmentToken === "" || tokenRole === undefined) {
          refuse("enroll-required", "加入團隊 vault 需有效邀請碼");
          return;
        }
        role = tokenRole;
      } else {
        role = "viewer"; // 個人 vault / 團隊創建者(claimOwner 隨後升 owner)
      }
      if (opts.store.enrollMember(p.vaultId, p.memberId, p.pubSign, p.pubWrap, role) === "conflict") {
        refuse("member-conflict", "此成員公鑰與註冊紀錄不符");
        return;
      }
      // 只記**首次**入表:既有成員每次重連都會走 enrollMember,逐次記錄會把管理日誌灌成連線日誌
      if (!existing) opts.store.recordAdminEvent(p.vaultId, "member-enrolled", p.memberId, "", role);
      vaultId = p.vaultId;
      memberId = p.memberId;
      memberRole = role;
      trackMember(vaultId, memberId, ws);
      clearTimeout(authTimer);
      joinVault(vaultId);
      // epoch 隨 authOk 告知:錯過輪換的成員(離線期間被 bump)據此發現須重跑 bootstrap 取新 root
      send({ type: "authOk", docs: opts.store.headSeqs(vaultId), epoch: opts.store.epochOf(vaultId) });
    };

    /**
     * 組織管理連線第一階段(3a):token 准入 + 宣稱 org admin 身分 → 回 nonce。
     * 伺服器需已知此 org 的根公鑰(至少一個 vault 綁過);未知 org 一律拒,不讓人憑空宣稱組織。
     */
    const handleAuthOrg = (msg: ClientMessage & { type: "authOrg" }): void => {
      if (vaultId !== undefined || orgScope !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      if (!tokenMatches(msg.token, opts.token)) {
        refuse("bad-token", "token 錯誤");
        return;
      }
      if (!validId(msg.orgId) || msg.adminPubSign.length !== 32) {
        refuse("bad-message", "非法組織 id 或公鑰");
        return;
      }
      const rootPubSign = opts.store.orgRootOf(msg.orgId);
      if (!rootPubSign) {
        refuse("no-org", "查無此組織");
        return;
      }
      // 操作者為 root 本人 → 公鑰須等於 org root;否則須持 root 簽的委任且委任內公鑰相符(未過期)
      const adminMemberId = createHash("sha256").update(msg.adminPubSign).digest("hex");
      if (msg.adminCert.length === 0) {
        if (!Buffer.from(msg.adminPubSign).equals(Buffer.from(rootPubSign))) {
          refuse("forbidden", "非組織根,需管理員委任");
          return;
        }
      } else {
        try {
          const v = verifyOrgAdminCert(msg.adminCert, rootPubSign, Math.floor(Date.now() / 1000));
          if (!Buffer.from(v.adminPubSign).equals(Buffer.from(msg.adminPubSign))) {
            refuse("forbidden", "委任與宣稱公鑰不符");
            return;
          }
        } catch (err) {
          refuse("forbidden", `管理員委任無效:${err instanceof Error ? err.message : "未知錯誤"}`);
          return;
        }
      }
      pendingOrg = { orgId: msg.orgId, adminMemberId, adminPubSign: msg.adminPubSign };
      pendingNonce = randomBytes(32);
      send({ type: "authChallenge", nonce: pendingNonce });
    };

    /** 組織管理連線第二階段:驗 challenge 簽章(獨立於 vault 認證的簽章域)→ 鎖 org 作用域 */
    const handleOrgProof = (msg: ClientMessage & { type: "authProof" }): void => {
      const nonce = pendingNonce;
      const p = pendingOrg;
      pendingNonce = undefined;
      pendingOrg = undefined;
      if (!nonce || !p) {
        refuse("bad-message", "未先發起組織認證");
        return;
      }
      if (!verifyOrgChallenge(msg.signature, nonce, p.orgId, p.adminMemberId, p.adminPubSign)) {
        refuse("bad-proof", "組織身分簽章驗證失敗");
        return;
      }
      orgScope = { orgId: p.orgId };
      clearTimeout(authTimer);
      send({ type: "orgAuthOk", orgId: p.orgId });
    };

    /**
     * 組織團隊憑證上傳(3a)。兩條授權路徑:
     *  - vault owner 連線:首次綁定(此 vault 尚未屬於任何組織),或組織內的自我更新;
     *  - 組織管理連線:vault 已綁在該組織 → **授權即簽章**,無須任何團隊成員配合(owner 離職可撤換)。
     * 兩路皆須鏈驗證通過、serial 嚴格遞增(反回滾),且憑證指向的 owner 必須是既有成員且公鑰相符。
     */
    const handleOrgCertPush = (msg: ClientMessage & { type: "orgCertPush" }, from: { vault: string; isOwner: boolean } | { org: string }): void => {
      if (!validId(msg.vaultId) || msg.orgRootPubSign.length !== 32) {
        refuse("bad-message", "非法 vault id 或組織公鑰");
        return;
      }
      const binding = opts.store.orgBinding(msg.vaultId);
      if ("vault" in from) {
        if (msg.vaultId !== from.vault) {
          refuse("forbidden", "不可為其他 vault 綁定組織");
          return;
        }
        if (!from.isOwner) {
          refuse("forbidden", "僅團隊擁有者可綁定組織");
          return;
        }
      } else if (!binding || binding.orgId !== from.org) {
        // 組織連線只管得到自己組織已綁的 vault:首次綁定一律需該團隊 owner 同意
        refuse("forbidden", "此 vault 不屬於本組織");
        return;
      }
      if (binding && !Buffer.from(binding.rootPubSign).equals(Buffer.from(msg.orgRootPubSign))) {
        refuse("forbidden", "此 vault 已綁定其他組織"); // 換組織需先解綁(3b),不容默默轉手
        return;
      }
      let verified;
      try {
        verified = verifyOrgTeamCert(msg.cert, msg.orgRootPubSign, msg.vaultId, Math.floor(Date.now() / 1000));
      } catch (err) {
        // 簽給別的團隊或別的組織時,簽章位元組對不上,錯誤會是籠統的「簽章驗證失敗」——補上最可能的成因
        refuse("bad-cert", `團隊憑證無效(可能是簽給其他團隊或其他組織):${err instanceof Error ? err.message : "未知錯誤"}`);
        return;
      }
      if (binding && verified.serial <= binding.serial) {
        // 帶上伺服器目前的序號:組織管理員據此知道下一張該用多少,不必猜
        refuse("stale-cert", `團隊憑證序號須遞增(伺服器目前為 ${binding.serial})`); // 反回滾:擋重放舊憑證把 owner 指回離職者
        return;
      }
      // 憑證指向的 owner 必須是既有成員、且註冊公鑰與憑證一致:否則會產生沒人簽得動信封的幽靈 owner
      const target = opts.store.getMember(msg.vaultId, verified.ownerMemberId);
      if (!target || !Buffer.from(target.pubSign).equals(Buffer.from(verified.ownerPubSign))) {
        refuse("no-member", "憑證指向的 owner 不是此團隊成員");
        return;
      }
      const prevOwner = opts.store.ownerOf(msg.vaultId);
      if (prevOwner !== undefined && prevOwner !== verified.ownerMemberId && !opts.store.transferOwner(msg.vaultId, verified.ownerMemberId)) {
        refuse("no-member", "無法轉移擁有者");
        return;
      }
      const orgIdNow = orgIdFromRootPubSign(msg.orgRootPubSign);
      opts.store.putOrgBinding(msg.vaultId, orgIdNow, msg.orgRootPubSign, msg.cert, verified.serial, verified.ownerMemberId);
      // 綁定後才記:recordAdminEvent 取當下綁定當歸屬,先記的話首次綁定會落成孤兒事件(組織拉不到)
      if (prevOwner === undefined || prevOwner === verified.ownerMemberId) {
        opts.store.recordAdminEvent(msg.vaultId, "org-bound", orgIdNow, verified.ownerMemberId, String(verified.serial));
      } else {
        opts.store.recordAdminEvent(msg.vaultId, "owner-transferred", orgIdNow, verified.ownerMemberId, prevOwner);
      }
      // 角色已變的兩位:踢掉活躍連線,重連後以新角色生效(同 memberSetRole 的作法)
      if (prevOwner !== undefined && prevOwner !== verified.ownerMemberId) {
        // 全體斷線:前後任的角色變了,其餘成員的信任錨也變了(新 owner 即將重簽全部憑證)
        kickVaultMembers(msg.vaultId, "role-changed", "團隊擁有者已由組織變更,請重新連線");
      }
      send({ type: "ok", reqId: msg.reqId });
    };

    // 收件人以 shareId 認證:解析出作用域後併入該 doc 所屬 vault 的 peer 集,只是廣播被 restrictedDoc 過濾
    const handleShareAuth = (msg: ClientMessage & { type: "shareAuth" }): void => {
      if (vaultId !== undefined) {
        refuse("bad-message", "重複認證");
        return;
      }
      if (!validId(msg.shareId)) {
        refuse("bad-share", "非法 share id");
        return;
      }
      const resolved = opts.store.resolveShare(msg.shareId);
      if (!resolved) {
        refuse("no-share", "分享不存在或已失效");
        return;
      }
      scope = resolved;
      vaultId = resolved.vaultId;
      shareId = msg.shareId;
      restrictedDoc.set(ws, resolved.docId);
      const conns = shareConns.get(msg.shareId) ?? new Set<WebSocket>();
      conns.add(ws);
      shareConns.set(msg.shareId, conns);
      clearTimeout(authTimer);
      joinVault(vaultId);
      const head = opts.store.headSeqs(vaultId).find((d) => d.docId === resolved.docId);
      send({
        type: "shareAuthOk",
        docId: resolved.docId,
        permission: resolved.permission,
        headSeq: head?.headSeq ?? 0,
        snapshotSeq: head?.snapshotSeq ?? 0,
      });
    };

    const relayToPeers = (vault: string, docId: string, msg: ServerMessage): void => {
      const frame = encodeServerMessage(msg);
      for (const peer of vaults.get(vault) ?? []) {
        if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
        const limit = restrictedDoc.get(peer);
        if (limit !== undefined && limit !== docId) continue; // share 連線只收自己那篇
        peer.send(frame);
      }
    };

    // 分享管理僅限 owner 連線;share 連線不得觸碰
    const handleShareAdmin = (vault: string, msg: ClientMessage): void => {
      switch (msg.type) {
        case "shareCreate": {
          if (!validId(msg.docId)) {
            refuse("bad-message", "非法 id");
            return;
          }
          const shareId = genShareId();
          opts.store.createShare(shareId, vault, msg.docId, msg.permission);
          send({ type: "shareCreated", reqId: msg.reqId, shareId });
          break;
        }
        case "shareList":
          send({ type: "shareCatalog", reqId: msg.reqId, shares: opts.store.listShares(vault) });
          break;
        case "shareRevoke": {
          // 只有真的撤銷到(shareId 確實屬於此 vault)才踢連線,否則猜中他人 shareId 就能跨 vault 誤踢
          if (opts.store.revokeShare(vault, msg.shareId)) {
            // 落盤撤銷只擋新連線;既有連線得當場切斷,否則撤銷形同虛設
            for (const peer of shareConns.get(msg.shareId) ?? []) {
              if (peer.readyState !== WebSocket.OPEN) continue;
              peer.send(encodeServerMessage({ type: "error", code: "no-share", message: "分享不存在或已失效" }));
              peer.close();
            }
            shareConns.delete(msg.shareId);
          }
          send({ type: "shareCatalog", reqId: msg.reqId, shares: opts.store.listShares(vault) });
          break;
        }
      }
    };

    // 團隊金鑰分發與成員管理(2b):envelopePull 限本人、其餘限 owner。
    // 授權真相在客戶端驗 owner 簽章;此處 owner 檢查只防濫用/DoS(伺服器不可信)。
    const handleTeamAdmin = (vault: string, self: string, msg: TeamAdminMessage): void => {
      const isOwner = opts.store.ownerOf(vault) === self;
      const requireOwner = (): boolean => {
        if (!isOwner) {
          refuse("forbidden", "僅團隊擁有者可執行");
          return false;
        }
        return true;
      };
      switch (msg.type) {
        case "claimOwner": {
          // TOFU:首位認領者釘選為 owner + 升 owner 角色;已有 owner 則回既有(不覆蓋)
          const ownerNow = opts.store.claimOwner(vault, self);
          if (ownerNow === self) {
            memberRole = "owner"; // 更新本連線快取,免創建者自身停在 viewer
            opts.store.recordAdminEvent(vault, "owner-claimed", self);
          }
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "envelopePull":
          // 只回自己的信封與角色憑證:A 絕不能拉到 B 的 blob;受限空間清單只有 id,無機密
          send({
            type: "envelopeList",
            reqId: msg.reqId,
            envelopes: opts.store.envelopesFor(vault, self),
            roleCred: opts.store.roleCredentialFor(vault, self) ?? new Uint8Array(),
            restrictedSpaceIds: opts.store.restrictedSpaceIds(vault),
            policy: opts.store.vaultPolicy(vault) ?? new Uint8Array(),
            orgTeamCert: opts.store.orgTeamCert(vault) ?? new Uint8Array(),
            orgPolicy: (() => {
              const b = opts.store.orgBinding(vault);
              return (b && opts.store.orgPolicy(b.orgId)) ?? new Uint8Array();
            })(),
            rotationRequested: opts.store.pendingRotation(vault),
          });
          break;
        case "envelopePush": {
          if (!requireOwner()) return;
          if (!validId(msg.keyId) || !validId(msg.memberId)) {
            refuse("bad-message", "非法 id");
            return;
          }
          // 核准 = **首次**取得金鑰信封;輪換的重包與自己給自己的 self-envelope 都不算,
          // 否則一次輪換就會替每位成員各記一筆,真正的管理動作被例行換鑰淹沒(走查實測)
          const firstEnvelope = msg.memberId !== self && opts.store.getMember(vault, msg.memberId)?.approved === false;
          opts.store.putEnvelope(vault, msg.keyId, msg.memberId, msg.epoch, msg.blob);
          if (firstEnvelope) opts.store.recordAdminEvent(vault, "member-approved", self, msg.memberId);
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "credPush": {
          // 角色憑證(§9.5):owner 簽章 blob,伺服器只存放與發還本人;授權真相在成員端驗簽
          if (!requireOwner()) return;
          if (!validId(msg.memberId)) {
            refuse("bad-message", "非法 id");
            return;
          }
          opts.store.putRoleCredential(vault, msg.memberId, msg.blob);
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "memberCertPush": {
          // 成員憑證(P4):owner 背書 memberId↔pubSign 的 blob,伺服器只存放;驗證在成員端
          if (!requireOwner()) return;
          if (!validId(msg.memberId)) {
            refuse("bad-message", "非法 id");
            return;
          }
          opts.store.putMemberCert(vault, msg.memberId, msg.blob);
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "memberCertPull":
          // 成員憑證目錄:任何認證成員可拉(pubSign 公開,blob 自帶 owner 簽章擋捏造)
          send({ type: "memberCertList", reqId: msg.reqId, certs: opts.store.listMemberCerts(vault) });
          break;
        case "policyPush": {
          // Vault 政策(P4 §7.3):owner 簽章 blob,伺服器只存放與發還成員;授權真相在成員端驗簽。
          // require_signed 明碼供伺服器自身縱深防禦(拒 unsigned),非安全邊界
          if (!requireOwner()) return;
          opts.store.putVaultPolicy(vault, msg.blob, msg.requireSigned);
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "memberList":
          if (!requireOwner()) return;
          send({ type: "memberCatalog", reqId: msg.reqId, members: opts.store.listMembers(vault) });
          break;
        case "memberRemove": {
          if (!requireOwner()) return;
          if (msg.memberId === self) {
            refuse("bad-message", "不可移除自己");
            return;
          }
          // 刪 member 列 + 其信封,並**踢掉其活躍連線**(2c):被移除者重連落回新成員分支,舊碼已消耗 → 被拒。
          // root 未輪換留 2c-2,故被移除者的離線舊快取仍能解舊內容(密碼層前向保密另切)。
          opts.store.removeMember(vault, msg.memberId);
          opts.store.recordAdminEvent(vault, "member-removed", self, msg.memberId);
          kickMember(vault, msg.memberId, "removed", "已被移出此團隊 vault");
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "memberSetRole": {
          if (!requireOwner()) return;
          if (msg.memberId === self) {
            refuse("bad-message", "不可改自己的角色"); // owner 轉移未做
            return;
          }
          if (msg.role === "owner") {
            refuse("bad-message", "不可指派 owner 角色"); // owner 唯一,由 claimOwner 釘選
            return;
          }
          if (!opts.store.setRole(vault, msg.memberId, msg.role)) {
            refuse("no-member", "查無此成員");
            return;
          }
          opts.store.recordAdminEvent(vault, "role-changed", self, msg.memberId, msg.role);
          // 踢掉對方活躍連線:其快取角色已過期(降級尤其危險),重連後以新角色生效
          kickMember(vault, msg.memberId, "role-changed", "你的角色已變更,請重新連線");
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "rotateKey": {
          // 金鑰輪換 commit(2c-2):CAS bump epoch,即為寫入柵欄點——此後舊 epoch 寫入一律被拒。
          // owner 呼叫前已為留任成員推好新 epoch 信封,故廣播 keyRotated 時成員必能 bootstrap 到新 root
          if (!requireOwner()) return;
          if (!opts.store.bumpEpoch(vault, msg.epoch)) {
            refuse("bad-epoch", "epoch 須恰為當前+1");
            return;
          }
          opts.store.setPendingRotation(vault, false); // 組織要求的輪換已完成
          opts.store.recordAdminEvent(vault, "key-rotated", self, "", String(msg.epoch));
          const rotated = encodeServerMessage({ type: "keyRotated", epoch: msg.epoch });
          for (const peer of vaults.get(vault) ?? []) {
            if (peer.readyState !== WebSocket.OPEN) continue;
            if (restrictedDoc.has(peer)) {
              // 分享連線:doc 金鑰由 root 衍生,輪換即作廢;當場踢掉,resolveShare 綁 epoch 擋重連
              peer.send(encodeServerMessage({ type: "error", code: "no-share", message: "分享不存在或已失效" }));
              peer.close();
            } else if (peer !== ws) {
              peer.send(rotated);
            }
          }
          send({ type: "ok", reqId: msg.reqId });
          break;
        }
        case "enrollCreate": {
          if (!requireOwner()) return;
          const token = randomBytes(24).toString("base64url");
          const ttl = Math.min(Math.max(msg.ttlSec, ENROLL_TTL_MIN), ENROLL_TTL_MAX);
          // owner 不得用邀請碼發 owner 角色(owner 唯一);editor/viewer 皆可
          const role: MemberRole = msg.role === "editor" ? "editor" : "viewer";
          opts.store.createEnrollmentToken(token, vault, role, Math.floor(Date.now() / 1000) + ttl);
          send({ type: "enrollCreated", reqId: msg.reqId, token });
          break;
        }
      }
    };

    const handle = (vault: string, msg: Exclude<ClientMessage, { type: "auth" | "authId" | "authProof" | "shareAuth" | "authOrg" }>): void => {
      // 組織綁定/憑證換發(3a):走成員連線的這條是「團隊 owner 主動綁組織」;
      // 組織端撤換 owner 走 orgScope 連線(見分派),兩路共用同一套鏈驗證與反回滾
      // 名冊拉取:任何已認證成員都可拉自己團隊所屬組織的名冊(推送仍限組織鏈)
      if (msg.type === "orgMemberCertPull") {
        const binding = opts.store.orgBinding(vault);
        send({ type: "orgMemberCertList", reqId: msg.reqId, entries: binding ? opts.store.listOrgMemberCerts(binding.orgId) : [] });
        return;
      }
      if (
        msg.type === "orgMemberCertPush" ||
        msg.type === "orgVaultList" ||
        msg.type === "orgMemberList" ||
        msg.type === "orgRevoke" ||
        msg.type === "orgPolicyPush" ||
        // 管理事件(3b-3)只給組織連線:它橫跨組織全部團隊,不是單一團隊成員該看得到的範圍
        msg.type === "orgEventPull" ||
        // 批次產碼(3b-4)跨團隊,同樣只給組織連線
        msg.type === "orgEnrollCreate"
      ) {
        refuse("forbidden", "組織治理動作僅限組織管理連線");
        return;
      }
      if (msg.type === "orgCertPush") {
        if (scope !== undefined) {
          refuse("forbidden", "分享連線不得管理組織");
          return;
        }
        if (memberId === undefined) {
          refuse("forbidden", "組織綁定需身分認證");
          return;
        }
        handleOrgCertPush(msg, { vault, isOwner: opts.store.ownerOf(vault) === memberId });
        return;
      }
      if (
        msg.type === "claimOwner" ||
        msg.type === "envelopePush" ||
        msg.type === "envelopePull" ||
        msg.type === "memberList" ||
        msg.type === "memberRemove" ||
        msg.type === "enrollCreate" ||
        msg.type === "memberSetRole" ||
        msg.type === "rotateKey" ||
        msg.type === "credPush" ||
        msg.type === "memberCertPush" ||
        msg.type === "memberCertPull" ||
        msg.type === "policyPush"
      ) {
        if (scope !== undefined) {
          refuse("forbidden", "分享連線不得管理團隊");
          return;
        }
        if (memberId === undefined) {
          refuse("forbidden", "團隊管理需身分認證");
          return;
        }
        handleTeamAdmin(vault, memberId, msg);
        return;
      }
      if (msg.type === "shareCreate" || msg.type === "shareList" || msg.type === "shareRevoke") {
        if (scope !== undefined) {
          refuse("forbidden", "分享連線不得管理分享");
          return;
        }
        handleShareAdmin(vault, msg);
        return;
      }
      if (!validId(msg.docId) || (msg.type === "push" && !validId(msg.deviceId))) {
        refuse("bad-message", "非法 id");
        return;
      }
      // share 連線鎖定單一 doc:別的 doc 一律拒;唯讀分享只准讀取類訊息
      if (scope !== undefined) {
        if (msg.docId !== scope.docId) {
          refuse("forbidden", "超出分享範圍");
          return;
        }
        // 白名單:唯讀作用域只放行 pull/snapshotPull/awareness,push 與 snapshotPush 等寫入型一律拒
        if (scope.permission !== "write" && msg.type !== "pull" && msg.type !== "snapshotPull" && msg.type !== "awareness") {
          refuse("forbidden", "唯讀分享不得寫入");
          return;
        }
      }
      // 角色寫入柵欄(2c):team vault(有 owner)上,只有 owner/editor 能寫 doc(含 vault-meta);viewer 唯讀。
      // 個人 vault(無 owner)無角色概念,不套此柵欄。share 連線走上面的 scope 權限,不在此列。
      if (
        scope === undefined &&
        (msg.type === "push" || msg.type === "snapshotPush") &&
        opts.store.ownerOf(vault) !== undefined &&
        memberRole !== "owner" &&
        memberRole !== "editor"
      ) {
        // 軟拒(不關線):誠實 client 的 UI 已收斂唯讀;離線期間累積本地編輯的 viewer 重連補推時,
        // 若關線會落入「拒→踢→重連→再推」的無限迴圈,讀取連線也一併陪葬。拒寫但保留讀取
        send({ type: "error", code: "forbidden", message: "唯讀成員不得寫入" });
        return;
      }
      // epoch 寫入柵欄(2c-2):team vault 的 doc 寫入須帶當前 epoch,防輪換窗口內舊 root 密文
      // 接在新快照後永久污染共享日誌。share 連線不套(輪換當下已被踢 + resolveShare 綁 epoch 擋重連);
      // 個人 vault 無紀元概念(epochOf 恆 0、client 恆送 0),不受影響
      if (
        scope === undefined &&
        (msg.type === "push" || msg.type === "snapshotPush") &&
        opts.store.ownerOf(vault) !== undefined &&
        msg.epoch !== opts.store.epochOf(vault)
      ) {
        refuse("stale-epoch", "金鑰已輪換,請重新取得團隊金鑰");
        return;
      }
      // 強制簽章縱深防禦(P4 §7.3):owner 開啟後,伺服器一併拒 unsigned 寫入。真正的安全邊界在成員端
      // 驗簽(惡意伺服器本可繞過此檢查),此處只擋誠實伺服器上遺漏簽章的舊 client、減少 poison-skip 折騰。
      // 軟拒(不關線):同唯讀成員軟拒,免舊 client 落入拒→踢→重連無限迴圈,讀取連線也一併陪葬
      if (
        scope === undefined &&
        (msg.type === "push" || msg.type === "snapshotPush") &&
        opts.store.ownerOf(vault) !== undefined &&
        opts.store.requiresSignedWritesEffective(vault) &&
        msg.authorMemberId === ""
      ) {
        send({ type: "error", code: "signature-required", message: "此團隊要求簽章寫入,請升級用戶端" });
        return;
      }
      switch (msg.type) {
        case "push": {
          // 伺服器全盲不驗簽(驗在收件端);只存作者宣稱的 authorMemberId + sig 並原樣轉發
          const seq = opts.store.appendUpdate(vault, msg.docId, msg.deviceId, msg.counter, msg.payload, msg.authorMemberId, msg.sig);
          send({ type: "ack", docId: msg.docId, counter: msg.counter, seq });
          relayToPeers(vault, msg.docId, {
            type: "update",
            docId: msg.docId,
            seq,
            authorMemberId: msg.authorMemberId,
            sig: msg.sig,
            payload: msg.payload,
          });
          break;
        }
        case "awareness": {
          // ephemeral:只轉發給同 vault 其他連線,不落盤、不配 seq
          relayToPeers(vault, msg.docId, { type: "awareness", docId: msg.docId, payload: msg.payload });
          break;
        }
        case "pull": {
          for (const u of opts.store.updatesSince(vault, msg.docId, msg.fromSeq)) {
            send({ type: "update", docId: msg.docId, seq: u.seq, authorMemberId: u.authorMemberId, sig: u.sig, payload: u.payload });
          }
          break;
        }
        case "snapshotPush": {
          opts.store.saveSnapshot(vault, msg.docId, msg.uptoSeq, msg.payload, msg.authorMemberId, msg.sig);
          send({ type: "snapshotAck", docId: msg.docId, uptoSeq: msg.uptoSeq });
          // 廣播新快照給同 vault 其他連線:快照(壓縮、或輪換 rekey)會截斷增量,否則落後的成員
          // 收不到「快照前進了」的通知,卡在舊 seq——增量已被截斷,他們的 pull 拿到空回覆而不自知
          relayToPeers(vault, msg.docId, {
            type: "snapshot",
            docId: msg.docId,
            uptoSeq: msg.uptoSeq,
            authorMemberId: msg.authorMemberId,
            sig: msg.sig,
            payload: msg.payload,
          });
          break;
        }
        case "snapshotPull": {
          const snap = opts.store.snapshot(vault, msg.docId);
          send({
            type: "snapshot",
            docId: msg.docId,
            uptoSeq: snap?.uptoSeq ?? 0,
            authorMemberId: snap?.authorMemberId ?? "",
            sig: snap?.sig ?? new Uint8Array(),
            payload: snap?.payload ?? new Uint8Array(),
          });
          break;
        }
      }
    };

    ws.on("message", (data: RawData) => {
      let msg: ClientMessage;
      try {
        msg = decodeClientMessage(toBytes(data));
      } catch {
        refuse("bad-message", "訊息解析失敗");
        return;
      }
      try {
        if (msg.type === "auth") handleAuth(msg);
        else if (msg.type === "authId") handleAuthId(msg);
        else if (msg.type === "authOrg") handleAuthOrg(msg);
        else if (msg.type === "authProof") (pendingOrg !== undefined ? handleOrgProof : handleAuthProof)(msg);
        else if (msg.type === "shareAuth") handleShareAuth(msg);
        else if (orgScope !== undefined) {
          // 組織管理連線的能力上限:只有團隊憑證換發。doc 讀寫、成員管理、金鑰信封一律拒——
          // 治理模式下組織不持有 root,拿到內容也解不開,但仍在協議層明確擋住,不留曖昧
          if (msg.type === "orgCertPush") handleOrgCertPush(msg, { org: orgScope.orgId });
          else if (msg.type === "orgMemberCertPush") {
            // 名冊條目:序號須遞增(反回滾——改名的用意常常就是要蓋掉舊身分)
            if (!validId(msg.memberId)) {
              refuse("bad-message", "非法 member id");
              return;
            }
            const serial = orgMemberCertSerial(msg.blob);
            if (serial === undefined) {
              refuse("bad-message", "名冊條目格式錯誤");
              return;
            }
            if (!opts.store.putOrgMemberCert(orgScope.orgId, msg.memberId, msg.blob, serial)) {
              refuse("stale-cert", "名冊條目序號須遞增");
              return;
            }
            send({ type: "ok", reqId: msg.reqId });
          } else if (msg.type === "orgVaultList") {
            send({ type: "orgVaultCatalog", reqId: msg.reqId, vaults: opts.store.vaultsOfOrg(orgScope.orgId) });
          } else if (msg.type === "orgMemberList") {
            // 只列本組織已綁定的 vault:組織看不到別的組織,也看不到未綁定的個人/團隊 vault
            const binding = opts.store.orgBinding(msg.vaultId);
            if (!binding || binding.orgId !== orgScope.orgId) {
              refuse("forbidden", "此 vault 不屬於本組織");
              return;
            }
            send({ type: "memberCatalog", reqId: msg.reqId, members: opts.store.listMembers(msg.vaultId) });
          } else if (msg.type === "orgRevoke") {
            /**
             * 一次全撤(離職):把此人從本組織每個團隊移除、當場踢線,並標記各團隊待輪換。
             * **跳過他是擁有者的團隊**——移除擁有者會讓該團隊無人簽得動憑證與信封;
             * 組織應先指派新擁有者(orgCertPush)再撤,回報中明列這些團隊供管理員處理。
             */
            if (!validId(msg.memberId)) {
              refuse("bad-message", "非法 member id");
              return;
            }
            const removed: string[] = [];
            const skippedOwner: string[] = [];
            for (const v of opts.store.vaultsOfOrg(orgScope.orgId)) {
              if (!opts.store.getMember(v.vaultId, msg.memberId)) continue;
              if (opts.store.ownerOf(v.vaultId) === msg.memberId) {
                skippedOwner.push(v.vaultId);
                continue;
              }
              opts.store.removeMember(v.vaultId, msg.memberId);
              // 移除只切斷伺服器層存取;被撤者手上的舊 root 要靠輪換才作廢,故標記催促擁有者
              opts.store.setPendingRotation(v.vaultId, true);
              opts.store.recordAdminEvent(v.vaultId, "org-revoked", orgScope.orgId, msg.memberId);
              kickMember(v.vaultId, msg.memberId, "removed", "已被組織移出此團隊");
              // 推送給留任者:不推的話,在線的擁有者要等重開 app 才知道該輪換(走查實測)
              const notice = encodeServerMessage({ type: "orgNotice", rotationRequested: true });
              for (const peer of vaults.get(v.vaultId) ?? []) {
                if (peer.readyState === WebSocket.OPEN && !restrictedDoc.has(peer)) peer.send(notice);
              }
              removed.push(v.vaultId);
            }
            send({ type: "orgRevokeResult", reqId: msg.reqId, removed, skippedOwner });
          } else if (msg.type === "orgPolicyPush") {
            const fields = orgPolicyFields(msg.blob);
            if (!fields) {
              refuse("bad-message", "組織政策格式錯誤");
              return;
            }
            if (!opts.store.putOrgPolicy(orgScope.orgId, msg.blob, fields.requireSignedWrites, fields.serial)) {
              refuse("stale-cert", "組織政策序號須遞增");
              return;
            }
            for (const v of opts.store.vaultsOfOrg(orgScope.orgId)) {
              opts.store.recordAdminEvent(v.vaultId, "org-policy-set", orgScope.orgId, "", fields.requireSignedWrites ? "require-signed" : "off");
            }
            send({ type: "ok", reqId: msg.reqId });
          } else if (msg.type === "orgMemberCertPull") {
            send({ type: "orgMemberCertList", reqId: msg.reqId, entries: opts.store.listOrgMemberCerts(orgScope.orgId) });
          } else if (msg.type === "orgEnrollCreate") {
            /**
             * 一次入職(3b-4):為本組織的多個團隊各產一張一次性邀請碼。
             * **這不是「組織可以加人」**:碼只讓對方 enroll 成待核准成員,金鑰信封仍要各團隊擁有者
             * 親自包(需要 root,組織沒有)。組織買到的是「不必逐一去拜託每位擁有者產碼」,
             * 不是繞過核准——後者在密碼學上就做不到。
             */
            const owned = opts.store.vaultsOfOrg(orgScope.orgId);
            const wanted = msg.vaultIds.length === 0 ? owned.map((v) => v.vaultId) : msg.vaultIds;
            const allowed = new Set(owned.map((v) => v.vaultId));
            const unknown = wanted.filter((v) => !allowed.has(v));
            if (unknown.length > 0) {
              // 不逐一回報哪些不屬於本組織:那等於讓組織拿它去探測他組織的 vault 是否存在
              refuse("forbidden", "指定的團隊不屬於本組織");
              return;
            }
            // 組織不得用邀請碼發 owner 角色(owner 由 claimOwner/組織憑證釘選),與團隊產碼同一條規則
            const role: MemberRole = msg.role === "editor" ? "editor" : "viewer";
            const ttl = Math.min(Math.max(msg.ttlSec, ENROLL_TTL_MIN), ENROLL_TTL_MAX);
            const expiresAt = Math.floor(Date.now() / 1000) + ttl;
            const entries: { vaultId: string; token: string; ownerPubSign: Uint8Array }[] = [];
            for (const vaultId of wanted) {
              const ownerId = opts.store.ownerOf(vaultId);
              const owner = ownerId ? opts.store.getMember(vaultId, ownerId) : undefined;
              if (!owner) continue; // 無擁有者的團隊產碼沒有意義(沒人能核准),靜默略過
              const token = randomBytes(24).toString("base64url");
              opts.store.createEnrollmentToken(token, vaultId, role, expiresAt);
              opts.store.recordAdminEvent(vaultId, "enroll-batch-created", orgScope.orgId, "", role);
              entries.push({ vaultId, token, ownerPubSign: owner.pubSign });
            }
            send({ type: "orgEnrollTokens", reqId: msg.reqId, entries });
          } else if (msg.type === "orgEventPull") {
            // vaultId 空字串 = 全組織;給定時 store 仍以組織範圍把關(拿本組織連線撈他組織的 vault 一律空)
            const events = opts.store.adminEvents(orgScope.orgId, msg.vaultId === "" ? undefined : msg.vaultId, msg.limit);
            send({ type: "orgEventList", reqId: msg.reqId, events });
          } else refuse("forbidden", "組織管理連線僅可治理,不得存取內容");
        } else if (vaultId === undefined) refuse("unauthorized", "尚未認證");
        else handle(vaultId, msg);
      } catch (err) {
        console.error("處理訊息失敗:", err);
        refuse("internal", "伺服器錯誤");
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      restrictedDoc.delete(ws);
      if (shareId !== undefined) {
        const conns = shareConns.get(shareId);
        conns?.delete(ws);
        if (conns && conns.size === 0) shareConns.delete(shareId); // 不留空 Set,shareConns 是強引用 Map
      }
      if (vaultId === undefined) return;
      if (memberId !== undefined) untrackMember(vaultId, memberId, ws);
      const peers = vaults.get(vaultId);
      peers?.delete(ws);
      if (peers && peers.size === 0) vaults.delete(vaultId);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, () => {
      httpServer.off("error", reject);
      // 啟動後的 reject 已無作用,換成會留下紀錄的 handler,不靜默吞錯
      httpServer.on("error", (err) => console.error("HTTP 伺服器錯誤:", err));
      wss.on("error", (err) => console.error("WebSocketServer 錯誤:", err));
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of wss.clients) client.terminate();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}

/** 長度不同 timingSafeEqual 會拋錯,比較雜湊消除長度側信道 */
function tokenMatches(given: string, expected: string): boolean {
  const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
