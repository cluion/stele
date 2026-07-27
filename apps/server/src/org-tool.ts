import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import {
  generateSeed,
  deriveIdentity,
  exportIdentity,
  importIdentity,
  orgIdFromRootPubSign,
  signOrgAdminCert,
  signOrgTeamCert,
  OrgAdminSession,
  type SocketLike,
  type SyncIdentity,
} from "@stele/sync";

/**
 * 組織管理 CLI(3a)。**在管理者自己的機器上執行,不要放在伺服器上**——
 * 組織根金鑰是整條委任鏈的信任錨,它一旦與伺服器同處一地,「伺服器不可信」的前提就破了。
 * 本工具只需要對伺服器的網路連線。
 *
 * 用法(於 apps/server 下):
 *   pnpm org init <根金鑰檔>                                   產生組織根身分,印出 orgId 與根公鑰
 *   pnpm org admin-cert <根金鑰檔> <adminPubSign(b64)> [天數]   簽發管理員委任(0/省略 = 永久)
 *   pnpm org bundle <根金鑰檔> <vaultId> <ownerPubSign(b64)> [serial]
 *                                                             產生綁定碼,交給團隊擁有者貼進 app
 *   pnpm org assign <根金鑰檔> <url> <token> <vaultId> <newOwnerPubSign(b64)> <serial> [prevOwnerPubSign(b64)]
 *                                                             直接連線指派新擁有者(不需團隊配合)
 */

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

function loadRoot(file: string): Promise<SyncIdentity> {
  const seed = importIdentity(JSON.parse(readFileSync(file, "utf8")));
  return deriveIdentity(seed);
}

/** 綁定碼:與桌面端 org-bundle.ts 同格式(base64url(JSON)) */
function encodeBundle(orgRootPubSign: Uint8Array, cert: Uint8Array): string {
  return Buffer.from(JSON.stringify({ orgRootPubSign: b64(orgRootPubSign), cert: b64(cert) }), "utf8").toString("base64url");
}

const createSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "init": {
      const [file] = args;
      if (!file) throw new Error("用法:init <根金鑰檔>");
      const seed = generateSeed();
      const identity = await deriveIdentity(seed);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(exportIdentity(seed, identity.memberId), null, 2));
      chmodSync(file, 0o600); // 根金鑰只給本人讀寫
      console.log(`組織根金鑰已寫入 ${file}(請離線備份,遺失即無法再指派任何團隊擁有者)`);
      console.log(`orgId:        ${orgIdFromRootPubSign(identity.pubSign)}`);
      console.log(`根公鑰(b64): ${b64(identity.pubSign)}`);
      break;
    }
    case "admin-cert": {
      const [file, adminPub, days] = args;
      if (!file || !adminPub) throw new Error("用法:admin-cert <根金鑰檔> <adminPubSign(b64)> [天數]");
      const root = await loadRoot(file);
      const notAfter = days && Number(days) > 0 ? Math.floor(Date.now() / 1000) + Number(days) * 86400 : 0;
      const cert = signOrgAdminCert(root.sign, { adminPubSign: fromB64(adminPub), notAfter });
      console.log(b64(cert));
      break;
    }
    case "bundle": {
      const [file, vaultId, ownerPub, serial] = args;
      if (!file || !vaultId || !ownerPub) throw new Error("用法:bundle <根金鑰檔> <vaultId> <ownerPubSign(b64)> [serial]");
      const root = await loadRoot(file);
      const cert = signOrgTeamCert(root.sign, { vaultId, ownerPubSign: fromB64(ownerPub), serial: Number(serial ?? 1) }, undefined);
      console.log(encodeBundle(root.pubSign, cert));
      break;
    }
    case "assign": {
      const [file, url, token, vaultId, ownerPub, serial, prevOwnerPub] = args;
      if (!file || !url || !token || !vaultId || !ownerPub || !serial) {
        throw new Error("用法:assign <根金鑰檔> <url> <token> <vaultId> <newOwnerPubSign(b64)> <serial> [prevOwnerPubSign(b64)]");
      }
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        // prevOwnerPubSign 強烈建議帶上:組織以此背書前任簽的金鑰信封在接管完成前仍可採信,
        // 否則撤換當下連新擁有者自己都解不開 root,整個團隊會鎖死到有人拿得出舊金鑰為止
        await session.assignOwner(vaultId, fromB64(ownerPub), Number(serial), prevOwnerPub ? fromB64(prevOwnerPub) : undefined);
        console.log(`已指派 ${vaultId} 的擁有者(憑證序號 ${serial});請通知新擁有者在 app 內執行「接管重簽」`);
      } finally {
        session.close();
      }
      break;
    }
    default:
      console.error("指令:init / admin-cert / bundle / assign(詳見 org-tool.ts 檔頭)");
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
