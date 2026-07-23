import { ed25519 } from "@noble/curves/ed25519.js";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * Vault 政策憑證(P4 強制簽章模式,§7.3):owner 對 {vaultId, flags, epoch} 的 Ed25519 簽章。
 * 經盲中繼分發、成員以 out-of-band 信任錨 ownerPubSign 驗證——讓 owner 的 vault 級開關防竄改。
 *
 * 目前唯一旗標 requireSignedWrites:開啟後成員拒收 unsigned 寫入(authorMemberId 空),
 * 關閉逐 update 作者驗證的過渡容忍窗口(否則惡意中繼可把注入寫入的作者欄清空冒充舊 client 繞過)。
 *
 * blob 格式:[版本 1B][flags varuint][epoch varuint][簽章 64B]
 *
 * 綁 epoch:輪換作廢整代政策(與角色/成員憑證同機制),owner 每紀元重簽;
 * vaultId 綁進簽章卻不佔 blob,由收件人自帶自證(防跨 vault 挪用)。惡意中繼捏造/竄改 → 驗不過 → 拒。
 */

const POLICY_VERSION = 1;
const SIG_LEN = 64;
const POLICY_DOMAIN = new TextEncoder().encode("stele-vault-policy-v1");

/** 旗標位元:bit 0 = 強制簽章寫入(拒 unsigned) */
const FLAG_REQUIRE_SIGNED = 1;

export interface VaultPolicyClaims {
  vaultId: string;
  requireSignedWrites: boolean;
  epoch: number;
}

export interface VerifiedPolicy {
  requireSignedWrites: boolean;
  epoch: number;
}

const flagsOf = (requireSignedWrites: boolean): number => (requireSignedWrites ? FLAG_REQUIRE_SIGNED : 0);

/** 待簽位元組(lib0 length-prefixed,無歧義);簽驗兩端共用保位元組一致 */
function policyBytes(vaultId: string, flags: number, epoch: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint8Array(enc, POLICY_DOMAIN);
  encoding.writeVarString(enc, vaultId);
  encoding.writeVarUint(enc, flags);
  encoding.writeVarUint(enc, epoch);
  return encoding.toUint8Array(enc);
}

/** owner 簽發 vault 政策;ownerSign 傳入既有 identity.sign,不外露私鑰 */
export function signVaultPolicy(ownerSign: (message: Uint8Array) => Uint8Array, claims: VaultPolicyClaims): Uint8Array {
  const flags = flagsOf(claims.requireSignedWrites);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, POLICY_VERSION);
  encoding.writeVarUint(enc, flags);
  encoding.writeVarUint(enc, claims.epoch);
  const head = encoding.toUint8Array(enc);
  const sig = ownerSign(policyBytes(claims.vaultId, flags, claims.epoch));
  const out = new Uint8Array(head.length + SIG_LEN);
  out.set(head, 0);
  out.set(sig, head.length);
  return out;
}

/**
 * 成員驗證 vault 政策:以 blob 宣稱的 flags/epoch 重組待簽位元組、對 ownerPubSign 驗章。
 * vaultId 由收件人自帶(不是信 blob)——挪用他 vault 的政策必然驗不過。偽簽/截斷/跨 vault 一律拋。
 */
export function verifyVaultPolicy(blob: Uint8Array, ownerPubSign: Uint8Array, vaultId: string): VerifiedPolicy {
  const dec = decoding.createDecoder(blob);
  let flags: number;
  let epoch: number;
  try {
    const version = decoding.readVarUint(dec);
    if (version !== POLICY_VERSION) throw new Error(`未知的 vault 政策版本:${version}`);
    flags = decoding.readVarUint(dec);
    epoch = decoding.readVarUint(dec);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("未知的 vault 政策版本") ? err : new Error("vault 政策不完整");
  }
  const sig = blob.slice(dec.pos);
  if (sig.length !== SIG_LEN) throw new Error("vault 政策不完整");
  const ok = (() => {
    try {
      return ed25519.verify(sig, policyBytes(vaultId, flags, epoch), ownerPubSign);
    } catch {
      return false;
    }
  })();
  if (!ok) throw new Error("vault 政策簽章驗證失敗");
  return { requireSignedWrites: (flags & FLAG_REQUIRE_SIGNED) !== 0, epoch };
}
