import { describe, it, expect } from "vitest";
import { VaultCipher, deriveSpaceKey, DEFAULT_SPACE_ID, MasterKeySpaces, WrappedKeySpaces } from "../src/index.ts";

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

describe("金鑰輪換(2c-2):MasterKeySpaces.rotate", () => {
  const newRoot = () => new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);

  it("rotate 後新密文舊 root 解不開、舊密文新 root 解不開(密碼層前向保密)", async () => {
    const spaces = new MasterKeySpaces(master());
    const before = await (await spaces.cipher(DEFAULT_SPACE_ID)).encrypt("doc-1", utf8("輪換前內容"));
    spaces.rotate(newRoot());
    const after = await (await spaces.cipher(DEFAULT_SPACE_ID)).encrypt("doc-1", utf8("輪換後內容"));
    const oldSpaces = new MasterKeySpaces(master()); // 被移除者留存的舊 root
    await expect((await oldSpaces.cipher(DEFAULT_SPACE_ID)).decrypt("doc-1", after)).rejects.toThrow();
    await expect((await spaces.cipher(DEFAULT_SPACE_ID)).decrypt("doc-1", before)).rejects.toThrow();
  });

  it("rotate 清空間 cipher 快取:自訂空間也換到新 root 衍生的金鑰", async () => {
    const spaces = new MasterKeySpaces(master());
    const sealedOld = await (await spaces.cipher("work")).encrypt("doc-1", utf8("舊金鑰空間內容"));
    spaces.rotate(newRoot());
    // 新 root 下同 spaceId 的 cipher 已換金鑰,舊密文解不開
    await expect((await spaces.cipher("work")).decrypt("doc-1", sealedOld)).rejects.toThrow();
    // 與「直接以新 root 建的實例」互通:留任成員 rotate 與重啟重建等價
    const fresh = new MasterKeySpaces(newRoot());
    const sealedNew = await (await spaces.cipher("work")).encrypt("doc-1", utf8("新金鑰空間內容"));
    expect(Buffer.from(await (await fresh.cipher("work")).decrypt("doc-1", sealedNew)).toString("utf8")).toBe("新金鑰空間內容");
  });
});

describe("WrappedKeySpaces(per-space 成員子集)", () => {
  const spaceKey = () => new Uint8Array(32).map((_, i) => (i * 31 + 11) & 0xff);

  it("零遷移守門:無 per-space 金鑰時與 MasterKeySpaces 每 doc 金鑰位元組相同", async () => {
    const wrapped = new WrappedKeySpaces(master());
    const legacy = new MasterKeySpaces(master());
    for (const sid of [DEFAULT_SPACE_ID, "work"]) {
      const a = await (await wrapped.cipher(sid)).exportDocKey("doc-1");
      const b = await (await legacy.cipher(sid)).exportDocKey("doc-1");
      expect(hex(a)).toBe(hex(b));
    }
    expect(wrapped.hasSpaceKey("work")).toBe(false);
  });

  it("受限空間走獨立金鑰:名單外成員以 root fallback 解不開;其餘空間不受影響", async () => {
    const restricted = new WrappedKeySpaces(master(), new Map([["secret", spaceKey()]]));
    const outsider = new WrappedKeySpaces(master()); // 同 root、無 secret 空間金鑰
    expect(restricted.hasSpaceKey("secret")).toBe(true);
    const sealed = await (await restricted.cipher("secret")).encrypt("doc-1", utf8("只給小圈子"));
    await expect((await outsider.cipher("secret")).decrypt("doc-1", sealed)).rejects.toThrow();
    // 同持 per-space 金鑰的兩實例互解
    const peer = new WrappedKeySpaces(master(), new Map([["secret", spaceKey()]]));
    expect(Buffer.from(await (await peer.cipher("secret")).decrypt("doc-1", sealed)).toString("utf8")).toBe("只給小圈子");
    // 未受限空間雙方互通(root 衍生)
    const open = await (await restricted.cipher("open")).encrypt("doc-2", utf8("全團隊可見"));
    expect(Buffer.from(await (await outsider.cipher("open")).decrypt("doc-2", open)).toString("utf8")).toBe("全團隊可見");
  });

  it("rotate 整組換到位:失去授權的空間金鑰消失、新授權的出現", async () => {
    const spaces = new WrappedKeySpaces(master(), new Map([["secret", spaceKey()]]));
    const sealedOld = await (await spaces.cipher("secret")).encrypt("doc-1", utf8("輪換前"));
    const nextKey = new Uint8Array(32).fill(42);
    spaces.rotate(newRoot(), new Map([["another", nextKey]]));
    expect(spaces.hasSpaceKey("secret")).toBe(false);
    expect(spaces.hasSpaceKey("another")).toBe(true);
    // secret 空間 fallback 新 root 衍生 → 舊 per-space 金鑰密文解不開(被撤銷者視角)
    await expect((await spaces.cipher("secret")).decrypt("doc-1", sealedOld)).rejects.toThrow();
  });

  function newRoot(): Uint8Array {
    return new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
  }
});
