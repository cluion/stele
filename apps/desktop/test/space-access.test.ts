import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import WebSocket from "ws";
import { startServer, SyncStore, type RunningServer } from "@stele/server";
import {
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  WrappedKeySpaces,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";
import { SpacesService } from "../src/main/spaces-service.ts";
import { rotateTeamRoot } from "../src/main/team-rotate.ts";

/**
 * 金牌(per-space 成員子集):受限空間的完整鏈路,經真伺服器——
 * 名單內成員以獨立空間金鑰收斂;名單外成員拿不到金鑰,新筆記不物化、既有筆記停在受限前狀態、
 * 伺服器密文以 root fallback 解不開;撤銷授權後再輪換,舊空間金鑰對新內容失效。
 */

const TOKEN = "空間存取-space-access-token-1234567890";
const noop = { broadcastDoc() {}, notifyIndexUpdated() {}, async trash() {} };

function wsSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock: SocketLike = {
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (d) => ws.send(d),
    close: () => ws.close(),
  };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data) => sock.onmessage?.({ data: new Uint8Array(data as Buffer) }));
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (e) => sock.onerror?.(e));
  return sock;
}

// pnpm check 全 workspace 並行時 CPU 最緊,輪換收斂鏈(bootstrap+rotate+repull+gap-fill)拉長,上限放寬
async function until(cond: () => boolean, label: string | (() => string), timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`逾時等待:${typeof label === "function" ? label() : label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("金牌:空間存取(per-space 成員子集)", () => {
  let server: RunningServer;
  let store: SyncStore;
  const managers: SyncManager[] = [];
  const sessions: VaultSession[] = [];

  const url = (): string => `ws://127.0.0.1:${server.port}`;

  interface Member {
    dir: string;
    session: VaultSession;
    manager: SyncManager;
    spacesService: SpacesService;
    epoch: number;
    /** 最後一次 bootstrap 拿到的受限空間金鑰(模擬 main 的執行態) */
    spaceKeys: Map<string, Uint8Array>;
  }

  function makeMember(vaultId: string, deviceId: string, root: Uint8Array, identity: SyncIdentity, ownerPubSign: Uint8Array, seed: Record<string, string> = {}): Member {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-sac-"));
    for (const [rel, content] of Object.entries(seed)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const meta = new VaultMeta(dir);
    const settings: SyncSettings = { url: url(), token: TOKEN, vaultId, deviceId };
    const member: Partial<Member> = { dir, session, epoch: 0, spaceKeys: new Map() };
    const manager = new SyncManager(session, settings, meta, undefined, {
      spaces: new WrappedKeySpaces(root),
      identity,
      epoch: 0,
      pushDebounceMs: 20,
      repullRetryMs: 100,
      onKeyRotated: (newEpoch) => {
        if ((member.epoch ?? 0) >= newEpoch) return; // owner 自己發起的輪換已就地處理(同 main.ts 防護)
        // 失敗要重試(同 main.ts 的 retry 迴圈):並行測試負載下單次 bootstrap 可能逾時,沒重試就永遠停在暫停態
        const attempt = (left: number): void => {
          void bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity, ownerPubSign, createSocket: wsSocket })
            .then(async (res) => {
              if (res.status === "ready" && res.epoch >= newEpoch) {
                member.epoch = res.epoch;
                member.spaceKeys = res.spaceKeys;
                await manager.rotateRoot(res.root, res.epoch, true, res.spaceKeys, res.restrictedSpaceIds);
              } else if (left > 0) {
                setTimeout(() => attempt(left - 1), 300);
              }
            })
            .catch(() => {
              if (left > 0) setTimeout(() => attempt(left - 1), 300);
            });
        };
        attempt(20);
      },
    });
    const spacesService = new SpacesService(meta, session);
    spacesService.setSyncHooks(manager);
    manager.start();
    managers.push(manager);
    sessions.push(session);
    member.manager = manager;
    member.spacesService = spacesService;
    return member as Member;
  }

  const content = (dir: string, rel: string): string | undefined => {
    try {
      return readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    for (const m of managers) await m.stop();
    for (const s of sessions) await s.destroy();
    await server.close();
    store.close();
  });

  it("受限空間:名單內解密收斂、名單外不物化且 root 解不開、撤銷後舊空間金鑰失效", async () => {
    const vaultId = "space-access-gold";
    const owner = await deriveIdentity(generateSeed());
    const alice = await deriveIdentity(generateSeed());
    const bob = await deriveIdentity(generateSeed());

    const oldRoot = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    for (const joiner of [alice, bob]) {
      const tok = await admin.inviteToken(3600, "editor");
      await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: joiner, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
      const rec = (await admin.members()).find((m) => m.memberId === joiner.memberId)!;
      await admin.approve(rec, oldRoot, 0);
    }
    admin.close();

    const o = makeMember(vaultId, "own-dev", oldRoot, owner, owner.pubSign, { "機密.md": "# 機密\n受限前內容\n" });
    const a = makeMember(vaultId, "ali-dev", oldRoot, alice, owner.pubSign);
    const b = makeMember(vaultId, "bob-dev", oldRoot, bob, owner.pubSign);
    await until(() => content(a.dir, "機密.md") === "# 機密\n受限前內容\n", "alice 收斂");
    await until(() => content(b.dir, "機密.md") === "# 機密\n受限前內容\n", "bob 收斂");

    // owner 建空間、把筆記移入、名單只放 alice → 輪換(模擬 main.ts 的 spaces:setMembers 流程)
    const spaceId = o.spacesService.createSpace("小圈子");
    await o.spacesService.moveNoteToSpace("機密.md", spaceId);
    o.spacesService.setSpaceMembers(spaceId, [alice.memberId]);
    const rotated = await rotateTeamRoot({
      admin: { url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket },
      currentEpoch: o.epoch,
      target: o.manager,
      restrictedSpaces: [{ spaceId, memberIds: [alice.memberId] }],
      onCommitted: (root, epoch, spaceKeys) => {
        o.epoch = epoch;
        o.spaceKeys = new Map(spaceKeys);
        void root;
      },
      retryMs: 100,
      maxRetries: 120, // 全 workspace 並行下 CPU 飢餓,重加密需更多輪重試(非邏輯問題,見 [[p4-1-slice-2b-progress]])
    });
    expect(rotated.epoch).toBe(1);

    // alice(名單內):bootstrap 拿到空間金鑰,owner 的新編輯照樣收斂
    await until(() => a.epoch === 1 && a.spaceKeys.has(spaceId), "alice 拿到空間金鑰");
    // bob(名單外):bootstrap 無空間金鑰
    await until(() => b.epoch === 1, "bob 轉到新紀元");
    expect(b.spaceKeys.has(spaceId)).toBe(false);

    const replica = new Y.Doc();
    Y.applyUpdate(replica, o.session.openDoc("機密.md"));
    replica.getText("md").insert(replica.getText("md").length, "受限後新增\n");
    o.session.pushUpdate("機密.md", Y.encodeStateAsUpdate(replica));
    {
      // 失敗診斷:server 端該 doc 的增量作者與快照點
      const docId = o.session.docId("機密.md");
      const db = (store as unknown as { db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } }).db;
      const dump = (): string =>
        JSON.stringify({
          updates: db.prepare("SELECT seq, device_id FROM updates WHERE vault_id=? AND doc_id=?").all(vaultId, docId),
          snap: store.snapshot(vaultId, docId)?.uptoSeq,
        });
      await until(() => content(a.dir, "機密.md") === "# 機密\n受限前內容\n受限後新增\n", () => `alice 收到受限空間的新編輯 ${dump()}`);
    }

    // bob:檔案停在受限前狀態(新內容解不開也不套用),稍等確認不再前進
    await new Promise((r) => setTimeout(r, 400));
    expect(content(b.dir, "機密.md")).toBe("# 機密\n受限前內容\n");

    // 伺服器上的受限空間密文:以 root fallback(bob 的視角)解不開;alice 的空間金鑰解得開
    const secretDocId = o.session.docId("機密.md");
    const snap = store.snapshot(vaultId, secretDocId)!;
    const bobView = new WrappedKeySpaces(rotated.root);
    await expect(bobView.cipher(spaceId).then((ci) => ci.decrypt(secretDocId, snap.payload))).rejects.toThrow();
    const aliceView = new WrappedKeySpaces(rotated.root, a.spaceKeys);
    const plain = await aliceView.cipher(spaceId).then((ci) => ci.decrypt(secretDocId, snap.payload));
    expect(plain.length).toBeGreaterThan(0);

    // 受限空間裡的「新筆記」(複製產生):alice 物化、bob 完全不落地
    const copyRel = o.spacesService.copyNoteToSpace("機密.md", spaceId);
    await until(() => content(a.dir, copyRel) !== undefined, "alice 物化受限空間的新筆記");
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(path.join(b.dir, copyRel))).toBe(false);

    // 撤銷 alice:名單清空再輪換 → alice 舊空間金鑰對之後的內容失效
    const aliceOldSpaceKey = a.spaceKeys.get(spaceId)!;
    o.spacesService.setSpaceMembers(spaceId, []);
    const rotated2 = await rotateTeamRoot({
      admin: { url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket },
      currentEpoch: o.epoch,
      target: o.manager,
      restrictedSpaces: [{ spaceId, memberIds: [] }],
      onCommitted: (_root, epoch, spaceKeys) => {
        o.epoch = epoch;
        o.spaceKeys = new Map(spaceKeys);
      },
      retryMs: 100,
      maxRetries: 120, // 同上:併發下重加密的重試預算
    });
    await until(() => a.epoch === 2, "alice 轉到紀元 2");
    expect(a.spaceKeys.has(spaceId)).toBe(false);

    const snap2 = store.snapshot(vaultId, secretDocId)!;
    const staleAlice = new WrappedKeySpaces(rotated2.root, new Map([[spaceId, aliceOldSpaceKey]]));
    await expect(staleAlice.cipher(spaceId).then((ci) => ci.decrypt(secretDocId, snap2.payload))).rejects.toThrow();
    // owner(名單空仍恆含自己)還解得開
    const ownerView = new WrappedKeySpaces(rotated2.root, o.spaceKeys);
    expect((await ownerView.cipher(spaceId).then((ci) => ci.decrypt(secretDocId, snap2.payload))).length).toBeGreaterThan(0);
  }, 90_000);
});
