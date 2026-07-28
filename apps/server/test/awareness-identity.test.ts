import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  SyncClient,
  VaultCipher,
  generateSeed,
  deriveIdentity,
  createTeamVault,
  bootstrapTeamKey,
  TeamAdminSession,
  type SocketLike,
  type SyncDocState,
  type SyncHost,
  type SyncIdentity,
  type AwarenessState,
} from "@stele/sync";
import { SyncStore } from "../src/store.ts";
import { startServer, type RunningServer } from "../src/server.ts";

/**
 * 游標名簽章(3b-1 收尾)端到端:成員在場宣告帶自己的簽章,收件端查成員目錄驗證。
 * 不變量:真成員的名字帶 verified;冒名者複製他人簽章到自己槽位 → 整筆丟棄;
 * 未簽的舊版用戶端 → 顯示為未驗證且不帶 memberId(免得借到組織名冊背書)。
 */

const TOKEN = "awareness-id-token-1234567890";
const DOC = "5f8e0000-0000-4000-8000-0000000aaaaa";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待逾時:${what}`);
    await sleep(25);
  }
}

describe("游標名簽章(3b-1 收尾):在場身分可驗", () => {
  let server: RunningServer;
  let store: SyncStore;
  const url = (): string => `ws://127.0.0.1:${server.port}`;

  beforeAll(async () => {
    store = new SyncStore(":memory:");
    server = await startServer({ port: 0, token: TOKEN, store });
  });
  afterAll(async () => {
    await server.close();
    store.close();
  });

  /** 一台裝置:共享 Y.Doc + 記下驗證後的遠端 awareness */
  function makeDevice(
    vaultId: string,
    deviceId: string,
    root: Uint8Array,
    opts: { identity?: SyncIdentity; ownerPubSign?: Uint8Array; epoch?: number } = {},
  ) {
    const docs = new Map<string, Y.Doc>();
    const seen = new Map<string, Map<number, AwarenessState>>();
    const host: SyncHost = {
      openDoc: (docId) => {
        let doc = docs.get(docId);
        if (!doc) {
          doc = new Y.Doc();
          docs.set(docId, doc);
        }
        return Promise.resolve(doc);
      },
      listDocIds: () => Promise.resolve([...docs.keys()]),
      loadState: (): SyncDocState | undefined => undefined,
      saveState: () => undefined,
    };
    const client = new SyncClient({
      url: url(),
      token: TOKEN,
      vaultId,
      deviceId,
      host,
      createSocket: wsSocket,
      cipher: new VaultCipher(root),
      pushDebounceMs: 15,
      ...opts,
      onAwareness: (docId, states) => seen.set(docId, states),
    });
    return { client, seen };
  }

  /** owner + n 名已核准的 editor 成員,全員拿到同一把 root 與當代目錄 */
  async function team(vaultId: string, n = 1) {
    const owner = await deriveIdentity(generateSeed());
    const root = await createTeamVault({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const admin = await TeamAdminSession.open({ url: url(), token: TOKEN, vaultId, identity: owner, createSocket: wsSocket });
    const members: SyncIdentity[] = [];
    let epoch = 0;
    for (let i = 0; i < n; i++) {
      const member = await deriveIdentity(generateSeed());
      const tok = await admin.inviteToken(3600, "editor");
      const enroll = { url: url(), token: TOKEN, vaultId, identity: member, ownerPubSign: owner.pubSign, createSocket: wsSocket };
      await bootstrapTeamKey({ ...enroll, enrollmentToken: tok });
      const rec = (await admin.members()).find((m) => m.memberId === member.memberId)!;
      await admin.approve(rec, root, 0);
      const boot = await bootstrapTeamKey(enroll);
      if (boot.status !== "ready") throw new Error(`成員 bootstrap 未就緒:${boot.status}`);
      epoch = boot.epoch;
      members.push(member);
    }
    admin.close();
    return { owner, members, root, epoch };
  }

  it("真成員的名字帶 verified,且 memberId 是簽章證明的那一位", async () => {
    const vaultId = "aware-id-ok";
    const { owner, members, root, epoch } = await team(vaultId);
    const a = makeDevice(vaultId, "devOwner", root, { identity: owner, ownerPubSign: owner.pubSign, epoch });
    const b = makeDevice(vaultId, "devMember", root, { identity: members[0]!, ownerPubSign: owner.pubSign, epoch });
    a.client.start();
    b.client.start();
    await sleep(300);

    a.client.setLocalAwareness(DOC, { deviceId: "devOwner", name: "老闆", color: "#0e7b93" });
    await until(() => [...(b.seen.get(DOC)?.values() ?? [])].some((s) => s["name"] === "老闆"), "成員看到擁有者在場");

    const seen = [...b.seen.get(DOC)!.values()].find((s) => s["name"] === "老闆")!;
    expect(seen["verified"]).toBe(true);
    expect(seen["memberId"]).toBe(owner.memberId);

    await a.client.stop();
    await b.client.stop();
  }, 15000);

  it("冒名:合法成員把他人的簽章原封複製到自己的槽位 → 收件端整筆丟棄", async () => {
    const vaultId = "aware-id-forge";
    const { owner, members, root, epoch } = await team(vaultId, 2);
    const a = makeDevice(vaultId, "devOwner", root, { identity: owner, ownerPubSign: owner.pubSign, epoch });
    const b = makeDevice(vaultId, "devMember", root, { identity: members[0]!, ownerPubSign: owner.pubSign, epoch });
    a.client.start();
    b.client.start();
    await sleep(300);

    a.client.setLocalAwareness(DOC, { deviceId: "devOwner", name: "老闆", color: "#0e7b93" });
    await until(() => [...(b.seen.get(DOC)?.values() ?? [])].some((s) => s["name"] === "老闆"), "先取得擁有者的宣告");
    const stolen = [...b.seen.get(DOC)!.values()].find((s) => s["name"] === "老闆")!;
    expect(typeof stolen["sig"]).toBe("string");

    // 冒名者是持同一把 doc 金鑰的合法成員(帶身分才連得上團隊 vault),但用改造過的用戶端:
    // 省略 ownerPubSign 就不會覆寫 memberId/sig,得以把竊得的宣告原樣貼到自己的槽位
    const evil = makeDevice(vaultId, "devEvil", root, { identity: members[1]!, epoch });
    evil.client.start();
    await sleep(300);
    evil.client.setLocalAwareness(DOC, {
      deviceId: "devEvil",
      name: "老闆",
      color: "#0e7b93",
      memberId: owner.memberId,
      sig: stolen["sig"],
    });
    await sleep(800);

    // 成員端看到的「老闆」只有一位:真的那位(clientId 對得上簽章),冒名的那筆被丟棄
    const bosses = [...(b.seen.get(DOC)?.values() ?? [])].filter((s) => s["name"] === "老闆");
    expect(bosses).toHaveLength(1);
    expect(bosses[0]!["deviceId"]).toBe("devOwner");

    await a.client.stop();
    await b.client.stop();
    await evil.client.stop();
  }, 20000);

  it("未簽的舊版用戶端 → 未驗證,且 memberId 被抹掉(不能借組織名冊的背書)", async () => {
    const vaultId = "aware-id-legacy";
    const { owner, members, root, epoch } = await team(vaultId, 2);
    // 舊版用戶端也是合法成員,只是不帶信任錨 → 不簽在場宣告
    const legacy = makeDevice(vaultId, "devLegacy", root, { identity: members[1]!, epoch });
    const b = makeDevice(vaultId, "devMember", root, { identity: members[0]!, ownerPubSign: owner.pubSign, epoch });
    legacy.client.start();
    b.client.start();
    await sleep(300);

    // 自報他人 memberId 卻無簽章:名字仍顯示(過渡相容),但一律未驗證且 memberId 不外流
    legacy.client.setLocalAwareness(DOC, { deviceId: "devLegacy", name: "自稱老闆", color: "#888", memberId: owner.memberId });
    await until(() => [...(b.seen.get(DOC)?.values() ?? [])].some((s) => s["name"] === "自稱老闆"), "成員看到未簽的在場");

    const seen = [...b.seen.get(DOC)!.values()].find((s) => s["name"] === "自稱老闆")!;
    expect(seen["verified"]).toBe(false);
    expect(seen["memberId"]).toBeUndefined();

    await legacy.client.stop();
    await b.client.stop();
  }, 20000);

  it("強制簽章模式:未簽的在場宣告連顯示都不給", async () => {
    const vaultId = "aware-id-strict";
    const { owner, members, root, epoch } = await team(vaultId, 2);
    const legacy = makeDevice(vaultId, "devLegacy", root, { identity: members[1]!, epoch });
    const b = makeDevice(vaultId, "devMember", root, { identity: members[0]!, ownerPubSign: owner.pubSign, epoch });
    b.client.setRequireSignedWrites(true);
    legacy.client.start();
    b.client.start();
    await sleep(300);

    legacy.client.setLocalAwareness(DOC, { deviceId: "devLegacy", name: "無名氏", color: "#888" });
    await sleep(600);
    expect([...(b.seen.get(DOC)?.values() ?? [])].some((s) => s["name"] === "無名氏")).toBe(false);

    await legacy.client.stop();
    await b.client.stop();
  }, 20000);
});
