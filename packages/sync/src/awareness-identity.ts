import { ed25519 } from "@noble/curves/ed25519.js";
import * as encoding from "lib0/encoding";

/**
 * 游標名簽章(3b-1 收尾):成員對自己在某 doc 的在場宣告(memberId + 顯示名 + 顏色)的 Ed25519 簽章。
 *
 * 為何需要:awareness 走的是同一把 doc 金鑰加密的盲中繼,內容卻是**自我宣告**——任何持金鑰者
 * 都能自稱任何名字,協作游標旁的名字因此完全不可驗。簽章讓收件端以成員目錄(memberCert)查得
 * 該 memberId 的可信 pubSign 後驗章:驗過才顯示為已驗身分,偽造的直接丟棄,絕不畫出假名字。
 *
 * 綁 clientId 是關鍵:awareness 以 Yjs clientID 為槽位鍵,不綁的話任何人都能把他人的宣告
 * 原封複製到自己的槽位,同一份簽章就成了冒名工具。綁 docId 防跨 doc 挪用、綁 epoch 防跨紀元
 * 重放(被移出者的舊宣告在輪換後即失效)。
 *
 * 簽的是**身分,不是游標位置**:游標每動一次都重簽既無必要也昂貴(節流後仍是每 ~90ms 一次)。
 * 因此合法成員仍可謊報自己的游標落在哪一段——那不構成冒名,是可接受的殘留面。
 */

const AWARENESS_DOMAIN = new TextEncoder().encode("stele-awareness-v1");
const SIG_LEN = 64;
/** 顯示名長度上限:與組織名冊一致;名字會進游標標籤與在場列,過長灌爆版面 */
const MAX_NAME = 64;
/** 顏色是短字串(#rrggbb 或具名色),留寬鬆上限擋灌爆 */
const MAX_COLOR = 32;

export interface AwarenessIdentityClaims {
  docId: string;
  /** vault 金鑰紀元:輪換即讓舊宣告失效 */
  epoch: number;
  /** Yjs awareness 槽位鍵;綁死才能擋「複製他人宣告到自己槽位」 */
  clientId: number;
  memberId: string;
  name: string;
  color: string;
}

/** 待簽位元組(lib0 length-prefixed,無歧義);簽驗兩端共用保位元組一致 */
function awarenessBytes(c: AwarenessIdentityClaims): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, AWARENESS_DOMAIN);
  encoding.writeVarString(enc, c.docId);
  encoding.writeVarUint(enc, c.epoch);
  encoding.writeVarUint(enc, c.clientId);
  encoding.writeVarString(enc, c.memberId);
  encoding.writeVarString(enc, c.name);
  encoding.writeVarString(enc, c.color);
  return encoding.toUint8Array(enc);
}

/** 成員簽自己的在場宣告;sign 傳入既有 identity.sign,不外露私鑰 */
export function signAwarenessIdentity(sign: (message: Uint8Array) => Uint8Array, claims: AwarenessIdentityClaims): Uint8Array {
  if (claims.name.length === 0 || claims.name.length > MAX_NAME) throw new Error(`顯示名長度須為 1..${MAX_NAME}`);
  if (claims.color.length > MAX_COLOR) throw new Error(`顏色長度上限 ${MAX_COLOR}`);
  return sign(awarenessBytes(claims));
}

/**
 * 驗一筆在場宣告:任一欄位不符、簽章無效、或名字/顏色超長即 false(不拋,呼叫端據此丟棄該筆)。
 * 長度上限在驗證端**再擋一次**:發話端的檢查只約束誠實的用戶端,換掉用戶端就繞過了。
 */
export function verifyAwarenessIdentity(sig: Uint8Array, memberPubSign: Uint8Array, claims: AwarenessIdentityClaims): boolean {
  if (sig.length !== SIG_LEN) return false;
  if (claims.name.length === 0 || claims.name.length > MAX_NAME) return false;
  if (claims.color.length > MAX_COLOR) return false;
  try {
    return ed25519.verify(sig, awarenessBytes(claims), memberPubSign);
  } catch {
    return false;
  }
}
