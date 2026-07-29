import { renderMarkdownTo, rankFiles } from "@stele/editor-core";
import type { SyncStatus } from "@stele/sync";
import { CapacitorStorage } from "./storage.ts";
import { MobileVault, type VaultSettings } from "./vault.ts";

/**
 * 行動端 UI。首版就兩件事:**翻一下**與**馬上記一筆**——那是手機真正會被拿來做的兩件事。
 * WYSIWYG 留在桌面:行動輸入法與 ProseMirror 的手感是另一場獨立的仗,不在首版扛。
 *
 * 純 DOM 不引入框架:畫面只有三個(清單、閱讀、編輯),為此帶進 React 只會讓包更大、
 * 冷啟更慢,而冷啟速度正是手機上最有感的東西。
 */

const SETTINGS_KEY = "vault-settings";
const DEVICE_KEY = "device-id";

const storage = new CapacitorStorage();
let vault: MobileVault | undefined;
let status: SyncStatus = "connecting";
let query = "";
let open: { docId: string; rel: string } | undefined;
let editing = false;

const app = (): HTMLElement => document.getElementById("app")!;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string },
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const STATUS_TEXT: Record<SyncStatus, string> = { connecting: "連線中…", online: "已同步", offline: "離線" };

/** 顯示用檔名:與桌面同一套規則 */
const displayName = (rel: string): string => rel.replace(/\.(md|canvas)$/, "");

function render(): void {
  if (!vault) return renderSetup();
  if (open && editing) return renderEditor();
  if (open) return renderNote();
  renderList();
}

// ── 設定:連上一個既有的 vault ──
function renderSetup(message?: string): void {
  const url = el("input", { type: "url", placeholder: "wss://sync.example.com", autocapitalize: "off" });
  const vaultId = el("input", { type: "text", placeholder: "vault id", autocapitalize: "off" });
  const token = el("input", { type: "password", placeholder: "伺服器 token" });
  const passphrase = el("input", { type: "password", placeholder: "vault 密語" });
  const submit = el("button", { className: "primary", textContent: "連線" });

  submit.onclick = () => {
    const settings: VaultSettings = {
      url: url.value.trim(),
      vaultId: vaultId.value.trim(),
      token: token.value,
      passphrase: passphrase.value,
    };
    if (!settings.url || !settings.vaultId || !settings.passphrase) return renderSetup("請填完伺服器位址、vault id 與密語。");
    submit.disabled = true;
    submit.textContent = "連線中…";
    void connect(settings).catch((err: unknown) => renderSetup(`連線失敗:${String(err)}`));
  };

  app().replaceChildren(
    el("header", { className: "bar" }, el("h1", { textContent: "Stele" })),
    el(
      "section",
      { className: "setup" },
      el("p", {
        className: "hint",
        textContent: "手機是既有知識庫的第二個端點:連上你已經在用的 vault,內容會解密後存成這台裝置上的 Markdown 檔。",
      }),
      url,
      vaultId,
      token,
      passphrase,
      submit,
      ...(message ? [el("p", { className: "error", textContent: message })] : []),
    ),
  );
}

async function connect(settings: VaultSettings): Promise<void> {
  let deviceId = await storage.readSetting(DEVICE_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await storage.writeSetting(DEVICE_KEY, deviceId);
  }
  const next = new MobileVault(
    storage,
    {
      onStatus: (s) => {
        status = s;
        render();
      },
      onChanged: () => render(),
    },
    deviceId,
  );
  await next.start(settings);
  vault = next;
  // 密語不落盤:它是主金鑰的來源,存起來等於把整個 vault 的鑰匙放在檔案系統裡。
  // 其餘連線資訊可以留,下次開啟只要再輸入密語。
  await storage.writeSetting(SETTINGS_KEY, JSON.stringify({ url: settings.url, vaultId: settings.vaultId, token: settings.token }));
  render();
}

// ── 清單 ──
function renderList(): void {
  const items = vault!.list();
  const byRel = new Map(items.map((i) => [i.rel, i.docId]));
  /**
   * 有查詢時走全文搜尋(檔名 + 內文),沒有時列全部。檔名的模糊比對排在前面:
   * 打「靈感」通常是想去那一篇,不是想看到所有提過「靈感」的段落。
   */
  const ranked = query ? rankFiles(items.map((i) => i.rel), query, 50) : [];
  const hits = query ? vault!.search(query) : [];
  const context = new Map(hits.map((h) => [h.rel, h.line]));
  const shown = query
    ? [...ranked, ...hits.map((h) => h.rel).filter((rel) => !ranked.includes(rel))]
    : items.map((i) => i.rel);

  const search = el("input", { className: "search", type: "search", placeholder: "搜尋筆記…", value: query });
  search.oninput = () => {
    query = search.value;
    renderList();
    // 重繪後把焦點與游標位置放回去,否則每打一個字鍵盤就收起來
    const next = document.querySelector<HTMLInputElement>(".search");
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  };

  const list = el("ul", { className: "notes" });
  for (const rel of shown) {
    const docId = byRel.get(rel);
    if (!docId) continue;
    const line = context.get(rel);
    const button = el(
      "button",
      {},
      el("span", { className: "name", textContent: displayName(rel) }),
      ...(query && line ? [el("span", { className: "context", textContent: line })] : []),
    );
    button.onclick = () => {
      open = { docId, rel };
      editing = false;
      render();
    };
    list.append(el("li", {}, button));
  }

  const compose = el("button", { className: "fab", textContent: "+", title: "新增筆記" });
  compose.onclick = () => alert("新建筆記在下一個 slice(需要先解決身分種子的保管)。");

  app().replaceChildren(
    el(
      "header",
      { className: "bar" },
      el("h1", { textContent: "筆記" }),
      el("span", { className: `status ${status}`, textContent: STATUS_TEXT[status] }),
    ),
    search,
    items.length === 0
      ? el("p", { className: "hint", textContent: "尚未同步到任何筆記。" })
      : shown.length === 0
        ? el("p", { className: "hint", textContent: "沒有符合的筆記。" })
        : list,
    compose,
  );
}

// ── 閱讀 ──
function renderNote(): void {
  const body = el("article", { className: "reader" });
  renderMarkdownTo(body, vault!.read(open!.docId));
  /**
   * wikilink 走事件委派:渲染出來的是 `<span class="wikilink" data-target>`(與桌面同一套
   * schema),不必為了可點而改渲染層。解不到目標就不動作——手機上不建檔,
   * 「點一下就生出一篇空筆記」在小螢幕上多半是誤觸而非本意。
   */
  body.onclick = (e) => {
    const target = (e.target as HTMLElement).closest("[data-target]")?.getAttribute("data-target");
    if (!target) return;
    const dest = vault!.resolve(target);
    if (!dest) return;
    open = dest;
    editing = false;
    render();
  };

  const links = vault!.backlinks(open!.rel);
  const backlinks = el("section", { className: "backlinks" });
  if (links.length > 0) {
    backlinks.append(el("h2", { textContent: `反向連結 ${String(links.length)}` }));
    for (const link of links) {
      const item = el(
        "button",
        {},
        el("span", { className: "name", textContent: displayName(link.rel) }),
        el("span", { className: "context", textContent: link.line }),
      );
      item.onclick = () => {
        open = { docId: link.docId, rel: link.rel };
        editing = false;
        render();
      };
      backlinks.append(item);
    }
  }

  const back = el("button", { className: "back", textContent: "‹ 筆記" });
  back.onclick = () => {
    open = undefined;
    render();
  };
  const edit = el("button", { className: "edit", textContent: "編輯" });
  edit.onclick = () => {
    editing = true;
    render();
  };

  app().replaceChildren(
    el("header", { className: "bar" }, back, el("h1", { textContent: displayName(open!.rel) }), edit),
    body,
    backlinks,
  );
}

// ── 編輯(純文字;WYSIWYG 留給桌面)──
function renderEditor(): void {
  const area = el("textarea", { className: "editor", value: vault!.read(open!.docId) });
  const done = el("button", { className: "edit", textContent: "完成" });
  done.onclick = () => {
    vault!.write(open!.docId, area.value);
    editing = false;
    render();
  };
  const back = el("button", { className: "back", textContent: "‹ 取消" });
  back.onclick = () => {
    editing = false;
    render();
  };

  app().replaceChildren(el("header", { className: "bar" }, back, el("h1", { textContent: displayName(open!.rel) }), done), area);
  area.focus();
}

/**
 * 開發用的自動連線:`?dev=1&url=…&vault=…&token=…&pass=…`。
 *
 * **只在 localhost 生效**。模擬器上的 Safari 沒有程式化輸入表單的辦法,而「連上真伺服器 →
 * 解密 → 列出筆記」這條路必須在真的 WebView 裡走過一次才算數。密語出現在網址列是為了
 * 這個目的、也僅限於此:主機名一旦不是本機就整段忽略,不會有人不小心把密語貼給遠端。
 */
function devAutoConnect(): VaultSettings | undefined {
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!isLocal) return undefined;
  const params = new URLSearchParams(location.search);
  if (params.get("dev") !== "1") return undefined;
  const settings = {
    url: params.get("url") ?? "",
    vaultId: params.get("vault") ?? "",
    token: params.get("token") ?? "",
    passphrase: params.get("pass") ?? "",
  };
  return settings.url && settings.vaultId && settings.passphrase ? settings : undefined;
}

async function main(): Promise<void> {
  const saved = await storage.readSetting(SETTINGS_KEY);
  renderSetup();

  const dev = devAutoConnect();
  if (dev) {
    await connect(dev).catch((err: unknown) => renderSetup(`連線失敗:${String(err)}`));
    return;
  }

  if (!saved) return;
  // 連線資訊帶回來,密語仍要現場輸入(它是主金鑰的來源,不落盤)
  try {
    const rest = JSON.parse(saved) as Omit<VaultSettings, "passphrase">;
    const inputs = document.querySelectorAll<HTMLInputElement>(".setup input");
    if (inputs[0]) inputs[0].value = rest.url;
    if (inputs[1]) inputs[1].value = rest.vaultId;
    if (inputs[2]) inputs[2].value = rest.token;
    inputs[3]?.focus();
  } catch {
    // 設定壞掉:當成第一次開啟
  }
}

void main();
