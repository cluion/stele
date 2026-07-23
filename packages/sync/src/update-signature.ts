import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as encoding from "lib0/encoding";

/**
 * 逐寫入作者簽章(P4 第二階段):作者對每筆 doc 寫入(增量 update / 快照)的 Ed25519 簽章。
 * 驗證者以成員目錄(memberCert)查得作者可信 pubSign 後驗此簽章——證明「這筆確實是這位成員寫的」,
 * 擋惡意中繼注入他 vault/被移除者的密文、擋非授權寫入。伺服器全盲不驗,驗在收件端。
 *
 * 簽 **ciphertext 的雜湊**而非明文:驗證者不必先解密即可驗作者(先驗簽再解密);GCM 已保內容完整,
 * 簽章專責作者 + 綁定。綁 docId(防跨 doc)、epoch(防跨紀元重放)、payload 雜湊(綁內容)。
 * 不綁 seq/deviceId:轉發的 update 不帶它們,且 CRDT applyUpdate 冪等——把同簽章+payload 重放到
 * 不同序列位置對已收斂的 doc 無害,故無需以序號防重放。
 */

const UPDATE_SIG_DOMAIN = new TextEncoder().encode("stele-update-v1");

/** 寫入種類:增量 update 與快照,kind 綁進簽章防兩者混淆 */
export type WriteKind = "update" | "snapshot";
const KIND_TAG: Record<WriteKind, number> = { update: 0, snapshot: 1 };

export interface WriteAuthFields {
  kind: WriteKind;
  docId: string;
  epoch: number;
  /** 密文(送出的 payload) */
  payload: Uint8Array;
}

/** 待簽位元組(lib0 length-prefixed,無歧義);簽驗兩端共用保位元組一致 */
function writeAuthBytes(f: WriteAuthFields): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, UPDATE_SIG_DOMAIN);
  encoding.writeVarUint(enc, KIND_TAG[f.kind]);
  encoding.writeVarString(enc, f.docId);
  encoding.writeVarUint(enc, f.epoch);
  encoding.writeVarUint8Array(enc, sha256(f.payload));
  return encoding.toUint8Array(enc);
}

/** 作者對一筆寫入簽章;sign 傳入既有 identity.sign,不外露私鑰 */
export function signWrite(sign: (message: Uint8Array) => Uint8Array, fields: WriteAuthFields): Uint8Array {
  return sign(writeAuthBytes(fields));
}

/** 驗證一筆寫入的作者簽章;任一欄位不符或簽章無效即 false(不拋,呼叫端據此丟棄) */
export function verifyWrite(sig: Uint8Array, authorPubSign: Uint8Array, fields: WriteAuthFields): boolean {
  if (sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, writeAuthBytes(fields), authorPubSign);
  } catch {
    return false;
  }
}
