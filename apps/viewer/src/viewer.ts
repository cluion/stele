import * as Y from "yjs";
import { ShareClient, ShareCipher, type SocketLike, type SyncStatus } from "@stele/sync";
import { parseShareLink } from "./share-link.ts";
import { renderMarkdown } from "./render.ts";

/**
 * 分享檢視器:唯讀開啟一則分享
 * shareId 走路徑、doc 金鑰走 fragment(不進伺服器);ShareClient 拉密文,ShareCipher 在瀏覽器解密
 */

const STATUS_TEXT: Record<SyncStatus, string> = {
  connecting: "連線中…",
  online: "已連線",
  offline: "已離線",
};

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node;
}

function fatal(message: string): void {
  el("status").textContent = "";
  el("content").replaceChildren();
  const box = el("error");
  box.textContent = message;
  box.hidden = false;
}

function main(): void {
  const link = parseShareLink(location.pathname, location.hash);
  if (!link) {
    fatal("連結不完整或無效,請確認分享網址是否完整(含 # 之後的金鑰)。");
    return;
  }

  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  const content = el("content");
  const rerender = (): void => renderMarkdown(content, ytext.toString());
  ytext.observe(rerender);

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
  const client = new ShareClient({
    url: wsUrl,
    shareId: link.shareId,
    doc,
    cipher: new ShareCipher(link.key),
    deviceId: "viewer",
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onStatus: (s) => (el("status").textContent = STATUS_TEXT[s]),
    onSynced: () => {
      rerender();
      document.body.dataset["ready"] = "1";
    },
    onClosed: (code) => fatal(code === "no-share" ? "這則分享已失效或不存在。" : "無法開啟此分享。"),
  });
  client.start();
}

main();
