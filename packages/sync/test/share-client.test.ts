import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  ShareClient,
  identityCipher,
  encodeServerMessage,
  decodeClientMessage,
  type SocketLike,
  type ClientMessage,
  type ServerMessage,
  type SharePermission,
} from "../src/index.ts";

/**
 * 記憶體版 blind relay:直接說協議,免 ws 依賴
 * 單一 doc 的增量日誌 + 廣播,足以驗 ShareClient 的 bootstrap/即時/寫回/失效路徑
 */
class FakeRelay {
  readonly log: Array<{ seq: number; payload: Uint8Array }> = [];
  private readonly socks = new Set<FakeSocket>();
  permission: SharePermission = "read";
  valid = true;
  readonly docId = "doc-1";

  seed(payload: Uint8Array): void {
    this.log.push({ seq: this.log.length + 1, payload });
  }

  attach(sock: FakeSocket): void {
    this.socks.add(sock);
  }
  detach(sock: FakeSocket): void {
    this.socks.delete(sock);
  }

  private head(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.seq;
  }

  handle(from: FakeSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case "shareAuth":
        if (!this.valid) return from.deliver({ type: "error", code: "no-share", message: "失效" });
        return from.deliver({ type: "shareAuthOk", docId: this.docId, permission: this.permission, headSeq: this.head(), snapshotSeq: 0 });
      case "pull":
        for (const u of this.log) if (u.seq > msg.fromSeq) from.deliver({ type: "update", docId: this.docId, seq: u.seq, authorMemberId: "", sig: new Uint8Array(), payload: u.payload });
        return;
      case "snapshotPull":
        return from.deliver({ type: "snapshot", docId: this.docId, uptoSeq: 0, authorMemberId: "", sig: new Uint8Array(), payload: new Uint8Array() });
      case "push": {
        const seq = this.log.length + 1;
        this.log.push({ seq, payload: msg.payload });
        from.deliver({ type: "ack", docId: this.docId, counter: msg.counter, seq });
        for (const s of this.socks) if (s !== from) s.deliver({ type: "update", docId: this.docId, seq, authorMemberId: "", sig: new Uint8Array(), payload: msg.payload });
        return;
      }
      case "awareness":
        for (const s of this.socks) if (s !== from) s.deliver({ type: "awareness", docId: this.docId, payload: msg.payload });
        return;
    }
  }
}

class FakeSocket implements SocketLike {
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | Uint8Array }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;

  constructor(private readonly relay: FakeRelay) {
    this.relay.attach(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: Uint8Array): void {
    this.relay.handle(this, decodeClientMessage(data));
  }

  deliver(msg: ServerMessage): void {
    queueMicrotask(() => this.onmessage?.({ data: encodeServerMessage(msg) }));
  }

  close(): void {
    this.relay.detach(this);
    queueMicrotask(() => this.onclose?.());
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

describe("ShareClient", () => {
  it("唯讀 bootstrap:拉齊既有內容並回報同步完成", async () => {
    const relay = new FakeRelay();
    const owner = new Y.Doc();
    owner.getText("t").insert(0, "碑文");
    relay.seed(Y.encodeStateAsUpdate(owner));

    const doc = new Y.Doc();
    let synced = false;
    let permission: SharePermission | undefined;
    const client = new ShareClient({
      url: "x",
      shareId: "s1",
      doc,
      cipher: identityCipher,
      deviceId: "guest",
      createSocket: () => new FakeSocket(relay),
      onSynced: () => (synced = true),
      onPermission: (p) => (permission = p),
    });
    client.start();
    await tick();
    expect(synced).toBe(true);
    expect(permission).toBe("read");
    expect(doc.getText("t").toString()).toBe("碑文");
    await client.stop();
  });

  it("空分享:沒有任何增量也能立刻回報同步完成", async () => {
    const relay = new FakeRelay();
    let synced = false;
    const client = new ShareClient({
      url: "x",
      shareId: "s1",
      doc: new Y.Doc(),
      cipher: identityCipher,
      deviceId: "guest",
      createSocket: () => new FakeSocket(relay),
      onSynced: () => (synced = true),
    });
    client.start();
    await tick();
    expect(synced).toBe(true);
    await client.stop();
  });

  it("唯讀連線不推送本地編輯", async () => {
    const relay = new FakeRelay();
    relay.permission = "read";
    const doc = new Y.Doc();
    const client = new ShareClient({
      url: "x",
      shareId: "s1",
      doc,
      cipher: identityCipher,
      deviceId: "guest",
      createSocket: () => new FakeSocket(relay),
    });
    client.start();
    await tick();
    doc.getText("t").insert(0, "偷改"); // 唯讀:不該進 relay
    await tick();
    expect(relay.log.length).toBe(0);
    await client.stop();
  });

  it("可編輯:本地編輯推回 relay,另一連線即時收到", async () => {
    const relay = new FakeRelay();
    relay.permission = "write";
    const owner = new Y.Doc();
    owner.getText("t").insert(0, "起始");
    relay.seed(Y.encodeStateAsUpdate(owner));

    const writerDoc = new Y.Doc();
    const writer = new ShareClient({
      url: "x", shareId: "s1", doc: writerDoc, cipher: identityCipher, deviceId: "writer",
      createSocket: () => new FakeSocket(relay), pushDebounceMs: 0,
    });
    writer.start();
    await tick();

    const readerDoc = new Y.Doc();
    const reader = new ShareClient({
      url: "x", shareId: "s1", doc: readerDoc, cipher: identityCipher, deviceId: "reader",
      createSocket: () => new FakeSocket(relay),
    });
    reader.start();
    await tick();

    writerDoc.getText("t").insert(2, "追加");
    await tick();
    await tick();
    expect(readerDoc.getText("t").toString()).toBe("起始追加");
    await writer.stop();
    await reader.stop();
  });

  it("分享失效:shareAuth 收到 no-share,觸發 onClosed 且不重連", async () => {
    const relay = new FakeRelay();
    relay.valid = false;
    let closedCode: string | undefined;
    const client = new ShareClient({
      url: "x",
      shareId: "s1",
      doc: new Y.Doc(),
      cipher: identityCipher,
      deviceId: "guest",
      createSocket: () => new FakeSocket(relay),
      onClosed: (code) => (closedCode = code),
    });
    client.start();
    await tick();
    expect(closedCode).toBe("no-share");
    await client.stop();
  });
});
