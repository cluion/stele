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
  encodeInvite,
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
 *   pnpm org name <根金鑰檔> <url> <token> <memberId> <顯示名> <serial> [部門]
 *                                                             設定名冊上的顯示名(組織背書,成員端可驗)
 *   pnpm org vaults <根金鑰檔> <url> <token>                    列出本組織的團隊(擁有者、成員數、憑證序號)
 *   pnpm org revoke <根金鑰檔> <url> <token> <memberId>          離職一次全撤:從本組織所有團隊移除並踢線
 *   pnpm org policy <根金鑰檔> <url> <token> <on|off> <serial>   組織級強制簽章(與團隊政策取較嚴者)
 *   pnpm org events <根金鑰檔> <url> <token> [vaultId] [筆數]     管理事件彙整(伺服器紀錄,非密碼學證據)
 *   pnpm org invite <根金鑰檔> <url> <token> <editor|viewer> [天數] [vaultId,...]
 *                                                             一次入職:為多個團隊批次產邀請碼
 *   pnpm org pending <根金鑰檔> <url> <token>                    跨團隊待核准佇列(誰卡在哪個團隊)
 */

import { ADMIN_EVENT_LABEL } from "./admin-events.ts";

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
    case "name": {
      const [file, url, token, memberId, displayName, serial, department] = args;
      if (!file || !url || !token || !memberId || !displayName || !serial) {
        throw new Error("用法:name <根金鑰檔> <url> <token> <memberId> <顯示名> <serial> [部門]");
      }
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        await session.setMemberName(memberId, displayName, Number(serial), department);
        console.log(`已設定 ${memberId.slice(0, 12)}… 的組織顯示名為「${displayName}」(序號 ${serial})`);
      } finally {
        session.close();
      }
      break;
    }
    case "vaults": {
      const [file, url, token] = args;
      if (!file || !url || !token) throw new Error("用法:vaults <根金鑰檔> <url> <token>");
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        const vaults = await session.vaults();
        if (vaults.length === 0) console.log("本組織尚無綁定的團隊");
        for (const v of vaults) {
          console.log(`${v.vaultId}\t擁有者 ${v.ownerMemberId.slice(0, 12)}…\t成員 ${v.memberCount}\t憑證序號 ${v.serial}`);
        }
      } finally {
        session.close();
      }
      break;
    }
    case "revoke": {
      const [file, url, token, memberId] = args;
      if (!file || !url || !token || !memberId) throw new Error("用法:revoke <根金鑰檔> <url> <token> <memberId>");
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        const res = await session.revokeEverywhere(memberId);
        console.log(res.removed.length > 0 ? `已從這些團隊移除:${res.removed.join("、")}` : "此人不在本組織任何團隊中");
        if (res.skippedOwner.length > 0) {
          console.log(`⚠️  以下團隊已略過(此人是擁有者,請先指派新擁有者再撤):${res.skippedOwner.join("、")}`);
        }
        if (res.removed.length > 0) {
          console.log("提醒:移除只切斷了伺服器層存取;請通知各團隊擁有者輪換金鑰,對方手上的舊金鑰才會失效。");
        }
      } finally {
        session.close();
      }
      break;
    }
    case "policy": {
      const [file, url, token, onOff, serial] = args;
      if (!file || !url || !token || !onOff || !serial) throw new Error("用法:policy <根金鑰檔> <url> <token> <on|off> <serial>");
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        await session.setRequireSignedWrites(onOff === "on", Number(serial));
        console.log(`組織強制簽章已設為 ${onOff}(序號 ${serial});與各團隊自己的設定取較嚴者`);
      } finally {
        session.close();
      }
      break;
    }
    case "events": {
      const [file, url, token, vaultId, limit] = args;
      if (!file || !url || !token) throw new Error("用法:events <根金鑰檔> <url> <token> [vaultId] [筆數]");
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        const events = await session.events(vaultId, limit ? Number(limit) : undefined);
        if (events.length === 0) console.log("沒有管理事件");
        for (const e of events) {
          const when = new Date(e.ts * 1000).toISOString().replace("T", " ").slice(0, 19);
          const who = e.actor ? `${e.actor.slice(0, 12)}…` : "-";
          const whom = e.target ? `${e.target.slice(0, 12)}…` : "";
          console.log(`${when}\t${e.vaultId}\t${ADMIN_EVENT_LABEL[e.kind as keyof typeof ADMIN_EVENT_LABEL] ?? e.kind}\t${who}${whom ? ` → ${whom}` : ""}${e.detail ? `\t(${e.detail})` : ""}`);
        }
        // 兩個邊界都必須說,否則管理員會把這份清單當成它不是的東西
        console.log("\n範圍:只涵蓋伺服器看得見的管理動作。**內容操作看不到**——誰讀寫了哪篇筆記都在密文裡。");
        console.log("性質:這是伺服器自己的紀錄,不是密碼學證據;能竄改伺服器的人也能竄改這份日誌。");
      } finally {
        session.close();
      }
      break;
    }
    case "invite": {
      const [file, url, token, role, days, vaultList] = args;
      if (!file || !url || !token || (role !== "editor" && role !== "viewer")) {
        throw new Error("用法:invite <根金鑰檔> <url> <token> <editor|viewer> [天數] [vaultId,...]");
      }
      const root = await loadRoot(file);
      const ttlSec = Math.round((days ? Number(days) : 1) * 24 * 60 * 60);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        const vaultIds = vaultList ? vaultList.split(",").map((v) => v.trim()).filter(Boolean) : undefined;
        const entries = await session.createEnrollTokens(vaultIds, role, ttlSec);
        if (entries.length === 0) {
          console.log("沒有產出任何邀請碼(本組織沒有團隊,或指定的團隊都還沒有擁有者)");
          break;
        }
        for (const e of entries) {
          const invite = encodeInvite({
            url,
            token,
            vaultId: e.vaultId,
            ownerPubSign: b64(e.ownerPubSign),
            enrollToken: e.token,
            role,
            orgRootPubSign: b64(root.pubSign),
          });
          console.log(`\n團隊 ${e.vaultId}(角色 ${role}):`);
          console.log(invite);
        }
        console.log(`\n共 ${entries.length} 張,有效期 ${days ? Number(days) : 1} 天。請新人在 app 內逐一貼上加入。`);
        // 這是本功能最容易被誤解的地方,寧可每次都講
        console.log("注意:產碼**不等於加入**。對方貼上後只會進入各團隊的待核准佇列,");
        console.log("      真正的核准要各團隊擁有者親自做(核准 = 把 root 金鑰包給他,組織沒有 root)。");
        console.log("      用 `pnpm org pending` 追蹤還有誰卡在哪個團隊。");
      } finally {
        session.close();
      }
      break;
    }
    case "pending": {
      const [file, url, token] = args;
      if (!file || !url || !token) throw new Error("用法:pending <根金鑰檔> <url> <token>");
      const root = await loadRoot(file);
      const session = await OrgAdminSession.open({ url, token, orgRootPubSign: root.pubSign, identity: root, createSocket });
      try {
        const vaults = await session.vaults();
        let total = 0;
        for (const v of vaults) {
          const waiting = (await session.members(v.vaultId)).filter((m) => !m.approved);
          if (waiting.length === 0) continue;
          total += waiting.length;
          console.log(`${v.vaultId}\t擁有者 ${v.ownerMemberId.slice(0, 12)}…\t待核准 ${waiting.length}`);
          for (const m of waiting) console.log(`  └ ${m.memberId.slice(0, 16)}…\t${m.role}`);
        }
        console.log(total === 0 ? "沒有待核准的成員" : `\n共 ${total} 位待核准;請通知各團隊擁有者在 app 內核對指紋後核准。`);
      } finally {
        session.close();
      }
      break;
    }
    default:
      console.error("指令:init / admin-cert / bundle / assign / name / vaults / revoke / policy / events / invite / pending(詳見 org-tool.ts 檔頭)");
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
