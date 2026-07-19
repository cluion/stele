import { describe, it, expect } from "vitest";
import { VaultCipher, deriveSpaceKey, DEFAULT_SPACE_ID, MasterKeySpaces } from "../src/index.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// 固定 32 bytes 當主金鑰:這裡測的是「空間 → doc」金鑰層,不是 scrypt,免拖慢
const master = () => new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

describe("空間金鑰衍生", () => {
  it("零遷移守門:預設空間金鑰 = 主金鑰本身(位元組相同)", async () => {
    const mk = master();
    const spaceKey = await deriveSpaceKey(mk, DEFAULT_SPACE_ID);
    expect(hex(spaceKey)).toBe(hex(mk));
  });

  it("零遷移守門:預設空間的每 doc 金鑰與舊 VaultCipher(主金鑰) 位元組完全相同", async () => {
    const mk = master();
    const legacy = new VaultCipher(mk); // 今天的行為:HKDF(主金鑰, docId)
    const spaces = new MasterKeySpaces(mk);
    const defaultCipher = await spaces.cipher(DEFAULT_SPACE_ID);
    for (const docId of ["doc-1", "筆記-中文", "doc-3"]) {
      expect(hex(await defaultCipher.exportDocKey(docId))).toBe(hex(await legacy.exportDocKey(docId)));
    }
  });

  it("零遷移守門:舊 VaultCipher 加密的密文,預設空間 cipher 解得開(反之亦然)", async () => {
    const mk = master();
    const legacy = new VaultCipher(mk);
    const defaultCipher = await new MasterKeySpaces(mk).cipher(DEFAULT_SPACE_ID);
    const sealed = await legacy.encrypt("doc-1", utf8("開啟既有 vault 的舊筆記"));
    expect(Buffer.from(await defaultCipher.decrypt("doc-1", sealed)).toString("utf8")).toBe("開啟既有 vault 的舊筆記");
    const reSealed = await defaultCipher.encrypt("doc-1", utf8("新寫的一段"));
    expect(Buffer.from(await legacy.decrypt("doc-1", reSealed)).toString("utf8")).toBe("新寫的一段");
  });

  it("新空間金鑰為 32 bytes、非主金鑰、可重現、不同空間互異", async () => {
    const mk = master();
    const work1 = await deriveSpaceKey(mk, "work");
    const work2 = await deriveSpaceKey(mk, "work");
    const home = await deriveSpaceKey(mk, "home");
    expect(work1).toHaveLength(32);
    expect(hex(work1)).not.toBe(hex(mk)); // 未洩漏主金鑰
    expect(hex(work1)).toBe(hex(work2)); // 同主金鑰同 spaceId 穩定可重現(跨裝置)
    expect(hex(work1)).not.toBe(hex(home)); // 不同空間互異
  });

  it("跨空間互不可解:某空間密文用別的空間 cipher 解不開,含預設空間", async () => {
    const spaces = new MasterKeySpaces(master());
    const work = await spaces.cipher("work");
    const home = await spaces.cipher("home");
    const def = await spaces.cipher(DEFAULT_SPACE_ID);
    const sealed = await work.encrypt("doc-1", utf8("工作空間的機密"));
    await expect(home.decrypt("doc-1", sealed)).rejects.toThrow();
    await expect(def.decrypt("doc-1", sealed)).rejects.toThrow();
    expect(Buffer.from(await work.decrypt("doc-1", sealed)).toString("utf8")).toBe("工作空間的機密");
  });

  it("空間內每 doc 子金鑰仍互異:doc 甲密文用 doc 乙身分解不開", async () => {
    const work = await new MasterKeySpaces(master()).cipher("work");
    const sealed = await work.encrypt("doc-1", utf8("內容"));
    await expect(work.decrypt("doc-2", sealed)).rejects.toThrow();
  });

  it("取得介面:同 spaceId 拿到的 cipher 互解、快取穩定", async () => {
    const spaces = new MasterKeySpaces(master());
    const a = await spaces.cipher("work");
    const b = await spaces.cipher("work");
    const sealed = await a.encrypt("doc-1", utf8("同空間往返"));
    expect(Buffer.from(await b.decrypt("doc-1", sealed)).toString("utf8")).toBe("同空間往返");
  });
});
