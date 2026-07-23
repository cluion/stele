import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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
  MasterKeySpaces,
  DEFAULT_SPACE_ID,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";
import { VaultSession } from "../src/main/vault-session.ts";
import { SyncManager, type SyncSettings } from "../src/main/sync-manager.ts";
import { VaultMeta } from "../src/main/vault-meta.ts";
import { rotateTeamRoot } from "../src/main/team-rotate.ts";

/**
 * 金牌(2c-2):金鑰輪換的完整鏈路,經真伺服器驗證 §9.6 全部不變量——
 * 輪換後 newRoot≠oldRoot、留任成員收斂到新金鑰、被移除者(留著 oldRoot)解不開重加密內容、
 * rekey 冪等、owner 未拉齊即中止(epoch 不 bump)、離線錯過輪換的成員重連後自癒。
 */

const TOKEN = "金鑰輪換-team-rotation-token-1234567890";
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

async function until(cond: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`逾時等待:${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("金牌:金鑰輪換(2c-2)", () => {
  let server: RunningServer;
  let store: SyncStore;
  const managers: SyncManager[] = [];
  const sessions: VaultSession[] = [];

  const url = (): string => `ws://127.0.0.1:${server.port}`;

  interface Member {
    dir: string;
    session: VaultSession;
    manager: SyncManager;
    spaces: MasterKeySpaces;
    /** 目前金鑰紀元(模擬 main.ts 的 teamRuntime.epoch) */
    epoch: number;
  }

  /**
   * 模擬 main.ts 的成員接線:onKeyRotated → 重跑 bootstrap 取新 root → rotateRoot 收斂。
   * epoch 起點與 root 由呼叫端給(加入時的 bootstrap 結果)。
   */
  function makeMember(vaultId: string, deviceId: string, root: Uint8Array, epoch: number, identity: SyncIdentity, ownerPubSign: Uint8Array, seed: Record<string, string> = {}): Member {
    const dir = mkdtempSync(path.join(tmpdir(), "stele-rot-"));
    for (const [rel, content] of Object.entries(seed)) writeFileSync(path.join(dir, rel), content);
    const session = new VaultSession(dir, noop);
    const settings: SyncSettings = { url: url(), token: TOKEN, vaultId, deviceId };
    const spaces = new MasterKeySpaces(root);
    const member: Partial<Member> = { dir, session, spaces, epoch };
    const manager = new SyncManager(session, settings, new VaultMeta(dir), undefined, {
      spaces,
      identity,
      epoch,
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
                await manager.rotateRoot(res.root, res.epoch);
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
    manager.start();
    managers.push(manager);
    sessions.push(session);
    member.manager = manager;
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

  it("移除成員後輪換:留任者收斂新金鑰、被移除者舊 root 解不開、rekey 冪等、離線者重連自癒", async () => {
    const vaultId = "rot-gold";
    const owner = await deriveIdentity(generateSeed());
    const bob = await deriveIdentity(generateSeed());
    const carol = await deriveIdentity(generateSeed());

    // 建 vault、bob 與 carol 以 editor 加入並核准(epoch 0)
    const oldRoot = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    for (const joiner of [bob, carol]) {
      const tok = await admin.inviteToken(3600, "editor");
      await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: joiner, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
      const rec = (await admin.members()).find((m) => m.memberId === joiner.memberId)!;
      await admin.approve(rec, oldRoot, 0);
    }
    // approved 標記:三人皆已核准
    expect((await admin.members()).every((m) => m.approved)).toBe(true);
    admin.close();

    // 三個成員各起 SyncManager 收斂一篇筆記
    const a = makeMember(vaultId, "own-dev", oldRoot, 0, owner, owner.pubSign, { "機密.md": "# 機密\n輪換前內容\n" });
    const b = makeMember(vaultId, "bob-dev", oldRoot, 0, bob, owner.pubSign);
    const c = makeMember(vaultId, "carol-dev", oldRoot, 0, carol, owner.pubSign);
    await until(() => content(b.dir, "機密.md") === "# 機密\n輪換前內容\n", "bob 收斂");
    await until(() => content(c.dir, "機密.md") === "# 機密\n輪換前內容\n", "carol 收斂");

    // bob 被移除(伺服器踢連線),隨後 owner 輪換(模擬 main.ts 的 team:remove 流程)
    const admin2 = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    await admin2.remove(bob.memberId);
    admin2.close();

    let committed: { root: Uint8Array; epoch: number } | undefined;
    const rotated = await rotateTeamRoot({
      admin: { url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket },
      currentEpoch: a.epoch,
      target: a.manager,
      onCommitted: (root, epoch) => {
        committed = { root, epoch };
        a.epoch = epoch;
      },
      retryMs: 100,
    });
    expect(committed?.epoch).toBe(1);
    expect(store.epochOf(vaultId)).toBe(1);
    // 輪換後 newRoot ≠ oldRoot
    expect(Buffer.from(rotated.root).equals(Buffer.from(oldRoot))).toBe(false);

    // 被移除者即使留著 oldRoot:伺服器上重加密後的快照 blob 解不開(密碼層前向保密)
    const secretDocId = a.session.docId("機密.md");
    const snap = store.snapshot(vaultId, secretDocId);
    expect(snap).toBeDefined();
    const stale = new MasterKeySpaces(oldRoot);
    await expect(stale.cipher(DEFAULT_SPACE_ID).then((ci) => ci.decrypt(secretDocId, snap!.payload))).rejects.toThrow();
    // 新 root 解得開同一份 blob(留任者的視角)
    const fresh = new MasterKeySpaces(rotated.root);
    const plain = await fresh.cipher(DEFAULT_SPACE_ID).then((ci) => ci.decrypt(secretDocId, snap!.payload));
    expect(plain.length).toBeGreaterThan(0);

    // 留任的 carol 經 keyRotated → bootstrap → rotateRoot 自癒;owner 輪換後的新編輯要能到 carol
    await until(() => c.epoch === 1, "carol 轉到新紀元");
    const replica = new Y.Doc();
    Y.applyUpdate(replica, a.session.openDoc("機密.md"));
    const text = replica.getText("md");
    text.insert(text.length, "輪換後新增\n");
    a.session.pushUpdate("機密.md", Y.encodeStateAsUpdate(replica));
    await until(() => content(c.dir, "機密.md") === "# 機密\n輪換前內容\n輪換後新增\n", "carol 收到輪換後編輯");

    // carol 也能寫回(新 epoch 寫入被伺服器放行)
    const cr = new Y.Doc();
    Y.applyUpdate(cr, c.session.openDoc("機密.md"));
    cr.getText("md").insert(cr.getText("md").length, "carol 回覆\n");
    c.session.pushUpdate("機密.md", Y.encodeStateAsUpdate(cr));
    await until(() => content(a.dir, "機密.md")?.includes("carol 回覆") === true, "owner 收到 carol 的新 epoch 編輯");

    // rekey 冪等:owner 再跑一輪 rekeyAll,內容與可解性不變
    expect(await a.manager.rekeyAll()).toBe(true);
    const snap2 = store.snapshot(vaultId, secretDocId)!;
    const plain2 = await fresh.cipher(DEFAULT_SPACE_ID).then((ci) => ci.decrypt(secretDocId, snap2.payload));
    expect(plain2.length).toBeGreaterThan(0);
    await expect(stale.cipher(DEFAULT_SPACE_ID).then((ci) => ci.decrypt(secretDocId, snap2.payload))).rejects.toThrow();

    // 離線錯過輪換的成員:dave 在輪換前核准但從未上線;現在以舊 root 起動 → authOk 發現 epoch 落後 → 自癒
    // (dave 的信封已在輪換時重包為 epoch 1——他在留任名單上)
    const dave = await deriveIdentity(generateSeed());
    const admin3 = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const tok = await admin3.inviteToken(3600, "editor");
    await bootstrapTeamKey({ url: url(), token: TOKEN, vaultId, identity: dave, ownerPubSign: owner.pubSign, enrollmentToken: tok, createSocket: wsSocket });
    const daveRec = (await admin3.members()).find((m) => m.memberId === dave.memberId)!;
    await admin3.approve(daveRec, rotated.root, 1);
    admin3.close();
    // dave 拿舊 root、舊 epoch 起動(模擬長期離線後帶著過期金鑰回來)
    const d = makeMember(vaultId, "dave-dev", oldRoot, 0, dave, owner.pubSign);
    await until(() => d.epoch === 1, "dave 發現落後並轉到新紀元");
    await until(() => content(d.dir, "機密.md")?.includes("輪換後新增") === true, "dave 以新金鑰收斂全部內容");
  }, 30_000);

  it("owner 未拉齊:輪換中止、epoch 不 bump、舊 root 續用", async () => {
    const vaultId = "rot-abort";
    const owner = await deriveIdentity(generateSeed());
    await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const stub = {
      allCaughtUp: () => false,
      rotateRoot: () => Promise.reject(new Error("不應走到")),
      rekeyAll: () => Promise.reject(new Error("不應走到")),
    };
    await expect(
      rotateTeamRoot({
        admin: { url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket },
        currentEpoch: 0,
        target: stub,
        onCommitted: () => {
          throw new Error("不應 commit");
        },
      }),
    ).rejects.toThrow(/未拉齊/);
    expect(store.epochOf(vaultId)).toBe(0);
  });
});
