import { describe, it, expect, beforeAll } from "vitest";
import { generateSeed, deriveIdentity, signWrite, verifyWrite, type SyncIdentity, type WriteAuthFields } from "../src/index.ts";

/**
 * 逐寫入作者簽章(P4 第二階段):作者簽 ciphertext 雜湊 + 綁定,驗證者查目錄公鑰後驗。
 * 不變量:正簽正驗;換公鑰、改任一綁定欄位(docId/epoch/seq/deviceId)、改 payload 皆驗不過。
 */

describe("逐寫入作者簽章", () => {
  let author: SyncIdentity;
  let other: SyncIdentity;

  beforeAll(async () => {
    author = await deriveIdentity(generateSeed());
    other = await deriveIdentity(generateSeed());
  });

  const base = (): WriteAuthFields => ({
    kind: "update",
    docId: "doc-1",
    epoch: 2,
    payload: new Uint8Array([1, 2, 3, 4]),
  });

  it("正簽正驗", () => {
    const sig = signWrite(author.sign, base());
    expect(verifyWrite(sig, author.pubSign, base())).toBe(true);
  });

  it("換作者公鑰驗不過(擋冒名)", () => {
    const sig = signWrite(author.sign, base());
    expect(verifyWrite(sig, other.pubSign, base())).toBe(false);
  });

  it("綁定欄位任一被改即驗不過(跨 doc / 跨紀元 / 混淆 update 與 snapshot)", () => {
    const sig = signWrite(author.sign, base());
    expect(verifyWrite(sig, author.pubSign, { ...base(), docId: "doc-2" })).toBe(false);
    expect(verifyWrite(sig, author.pubSign, { ...base(), epoch: 3 })).toBe(false);
    expect(verifyWrite(sig, author.pubSign, { ...base(), kind: "snapshot" })).toBe(false);
  });

  it("payload 被竄改即驗不過(綁 ciphertext 雜湊)", () => {
    const sig = signWrite(author.sign, base());
    expect(verifyWrite(sig, author.pubSign, { ...base(), payload: new Uint8Array([1, 2, 3, 5]) })).toBe(false);
  });

  it("快照簽章:同一函式以 kind=snapshot", () => {
    const snap: WriteAuthFields = { kind: "snapshot", docId: "doc-1", epoch: 1, payload: new Uint8Array([9, 9]) };
    const sig = signWrite(author.sign, snap);
    expect(verifyWrite(sig, author.pubSign, snap)).toBe(true);
    expect(verifyWrite(sig, author.pubSign, { ...snap, payload: new Uint8Array([9, 8]) })).toBe(false);
  });

  it("非法簽章長度即 false,不拋", () => {
    expect(verifyWrite(new Uint8Array(10), author.pubSign, base())).toBe(false);
    expect(verifyWrite(new Uint8Array(64), author.pubSign, base())).toBe(false);
  });
});
