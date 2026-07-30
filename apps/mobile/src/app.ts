import { renderMarkdownTo, rankFiles } from "@stele/editor-core";
import type { SyncStatus } from "@stele/sync";
import { CapacitorStorage } from "./storage.ts";
import { MobileVault, isTeamSettings, type VaultSettings } from "./vault.ts";
import { createSecretStore } from "./secrets.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { recordFromInvite, openTeamVault, type TeamRecord } from "./join.ts";

/**
 * 行動端 UI。首版就兩件事:**翻一下**與**馬上記一筆**——那是手機真正會被拿來做的兩件事。
 * WYSIWYG 留在桌面:行動輸入法與 ProseMirror 的手感是另一場獨立的仗,不在首版扛。
 *
 * 純 DOM 不引入框架:畫面只有三個(清單、閱讀、編輯),為此帶進 React 只會讓包更大、
 * 冷啟更慢,而冷啟速度正是手機上最有感的東西。
 */

const SETTINGS_KEY = "vault-settings";
const TEAM_KEY = "team-record";
const DEVICE_KEY = "device-id";

const storage = new CapacitorStorage();
const secrets = createSecretStore();
let vault: MobileVault | undefined;
let status: SyncStatus = "connecting";
let query = "";
let open: { docId: string; rel: string } | undefined;
let editing = false;
/** 團隊 vault 才有:目前這台裝置的連線紀錄(信任錨可能被組織委任鏈換掉,一變就存回去) */
let team: TeamRecord | undefined;
/** 唯讀成員(viewer):不給新建與編輯的入口。真正的柵欄在伺服器與收件端,這裡只是不騙人 */
let readOnly = false;
/** 已送出加入申請、等 owner 核准 */
let awaitingApproval = false;

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
  if (awaitingApproval) return renderAwaiting();
  if (!vault) return renderSetup();
  if (open && editing) return renderEditor();
  if (open) return renderNote();
  renderList();
}

// ── 設定:連上一個既有的 vault ──
/** 兩種入口:個人 vault 用密語,團隊 vault 用邀請碼。手機上不建新 vault */
let setupMode: "personal" | "team" = "personal";

function renderSetup(message?: string): void {
  const tab = (mode: typeof setupMode, label: string): HTMLButtonElement => {
    const b = el("button", { className: `tab${setupMode === mode ? " on" : ""}`, textContent: label });
    b.onclick = () => {
      setupMode = mode;
      renderSetup();
    };
    return b;
  };

  const hint =
    setupMode === "personal"
      ? "手機是既有知識庫的第二個端點:連上你已經在用的 vault,內容會解密後存成這台裝置上的 Markdown 檔。"
      : "貼上團隊擁有者給你的邀請碼。這台裝置會用自己的身分金鑰申請加入,等擁有者核准後才拿得到團隊金鑰。";

  const fields: HTMLElement[] = [];
  const submit = el("button", { className: "primary", textContent: setupMode === "personal" ? "連線" : "加入團隊" });

  if (setupMode === "personal") {
    const url = el("input", { type: "url", placeholder: "wss://sync.example.com", autocapitalize: "off" });
    const vaultId = el("input", { type: "text", placeholder: "vault id", autocapitalize: "off" });
    const token = el("input", { type: "password", placeholder: "伺服器 token" });
    const passphrase = el("input", { type: "password", placeholder: "vault 密語" });
    fields.push(url, vaultId, token, passphrase);
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
  } else {
    const invite = el("textarea", { className: "invite", placeholder: "貼上邀請碼", autocapitalize: "off", rows: 4 });
    fields.push(invite);
    submit.onclick = () => {
      submit.disabled = true;
      submit.textContent = "加入中…";
      void joinTeam(invite.value).catch((err: unknown) => renderSetup(`加入失敗:${String(err)}`));
    };
  }

  app().replaceChildren(
    el("header", { className: "bar" }, el("h1", { textContent: "Stele" })),
    el("nav", { className: "tabs" }, tab("personal", "個人 vault"), tab("team", "團隊")),
    el(
      "section",
      { className: "setup" },
      el("p", { className: "hint", textContent: hint }),
      ...fields,
      submit,
      ...(message ? [el("p", { className: "error", textContent: message })] : []),
    ),
  );
}

/** 等核准:pending 是加入流程的一站,不是失敗——畫面要說得出「現在卡在誰身上」 */
function renderAwaiting(message?: string): void {
  const retry = el("button", { className: "primary", textContent: "再試一次" });
  retry.onclick = () => {
    if (!team) return;
    retry.disabled = true;
    retry.textContent = "確認中…";
    void resumeTeam(team).catch((err: unknown) => renderAwaiting(`確認失敗:${String(err)}`));
  };
  const back = el("button", { textContent: "改用其他 vault" });
  back.onclick = () => {
    awaitingApproval = false;
    void storage.writeSetting(TEAM_KEY, "");
    team = undefined;
    render();
  };
  app().replaceChildren(
    el("header", { className: "bar" }, el("h1", { textContent: "等待核准" })),
    el(
      "section",
      { className: "setup" },
      el("p", {
        className: "hint",
        textContent: "已送出加入申請。團隊擁有者核准後,這台裝置才拿得到團隊金鑰——在那之前看不到任何內容。",
      }),
      retry,
      back,
      ...(message ? [el("p", { className: "error", textContent: message })] : []),
    ),
  );
}

// ── 團隊 vault:加入與復原 ──
async function joinTeam(inviteText: string): Promise<void> {
  const { record, invite } = recordFromInvite(inviteText.trim()); // 碼壞掉在這裡就拋
  await resumeTeam(record, invite.enrollToken);
}

/**
 * 用既有紀錄開團隊 vault:認證 → 拉自己的 root 信封 → 連線。首次加入才帶邀請碼。
 * 回來的紀錄可能已經不同(組織撤換 owner、政策收緊),一律存回去。
 */
async function resumeTeam(record: TeamRecord, enrollToken?: string): Promise<void> {
  const identity = await loadOrCreateIdentity(secrets);
  const res = await openTeamVault(record, identity, enrollToken !== undefined ? { enrollToken } : {});
  team = res.record;
  await storage.writeSetting(TEAM_KEY, JSON.stringify(res.record));
  if (res.status === "pending") {
    awaitingApproval = true;
    renderAwaiting();
    return;
  }
  awaitingApproval = false;
  readOnly = res.role === "viewer";
  await connect(res.settings);
}

/**
 * 金鑰輪換後續跑:owner 換掉團隊金鑰(多半是因為移除了某個成員)後,舊 root 解不開新內容,
 * 推送已自動暫停。重跑一次 bootstrap 取新 root 就能接回去——使用者不該為此重開 app。
 */
async function refreshTeamKeys(): Promise<void> {
  if (!team || !vault) return;
  const identity = await loadOrCreateIdentity(secrets);
  const res = await openTeamVault(team, identity);
  team = res.record;
  await storage.writeSetting(TEAM_KEY, JSON.stringify(res.record));
  if (res.status !== "ready") return; // 被移出團隊:等 onRevoked 收尾
  await vault.applyRotation(res.settings.root, res.settings.epoch, res.settings.spaceKeys, res.settings.restrictedSpaceIds);
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
      // 團隊金鑰輪換:背景取新 root 接回去,不打擾使用者
      onKeyRotated: () => void refreshTeamKeys().catch((err: unknown) => console.error("輪換後續跑失敗:", err)),
      onRevoked: () => {
        void teardown();
        renderSetup("你已不在這個團隊裡。已經同步下來的筆記留在這台裝置上,但不會再更新。");
      },
    },
    deviceId,
  );
  await next.start(settings);
  vault = next;
  if (isTeamSettings(settings)) {
    // 團隊 vault 的連線資訊已隨 TeamRecord 存好;root 不落盤,每次開 app 重新 bootstrap
    await storage.writeSetting(SETTINGS_KEY, "");
  } else {
    // 密語不落盤:它是主金鑰的來源,存起來等於把整個 vault 的鑰匙放在檔案系統裡。
    // 其餘連線資訊可以留,下次開啟只要再輸入密語。
    await storage.writeSetting(SETTINGS_KEY, JSON.stringify({ url: settings.url, vaultId: settings.vaultId, token: settings.token }));
  }
  render();
}

/** 收掉目前的 vault(被移出團隊時);本地筆記留著,那是使用者的東西 */
async function teardown(): Promise<void> {
  const current = vault;
  vault = undefined;
  team = undefined;
  open = undefined;
  editing = false;
  await storage.writeSetting(TEAM_KEY, "");
  await current?.stop();
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
  compose.onclick = () => {
    // 手機上「馬上記一筆」的路徑要短:問一個名字就直接進編輯,不再多一層表單
    const name = window.prompt("新筆記名稱");
    if (name === null || name.trim().length === 0) return;
    open = vault!.create(name.trim());
    editing = true;
    render();
  };

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
    // 唯讀成員不給新增入口:按了也只會被伺服器拒,不如一開始就別假裝可以
    ...(readOnly ? [] : [compose]),
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
    el("header", { className: "bar" }, back, el("h1", { textContent: displayName(open!.rel) }), ...(readOnly ? [] : [edit])),
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
  const savedTeam = await storage.readSetting(TEAM_KEY);
  renderSetup();

  const dev = devAutoConnect();
  if (dev) {
    await connect(dev).catch((err: unknown) => renderSetup(`連線失敗:${String(err)}`));
    return;
  }

  /**
   * 團隊 vault 自動接回去:不必問任何東西。憑據是 Keychain 裡那把身分金鑰,
   * 不是使用者記得住的字串——這正是團隊 vault 與個人 vault 在手機上最大的體感差別。
   */
  if (savedTeam) {
    setupMode = "team";
    try {
      await resumeTeam(JSON.parse(savedTeam) as TeamRecord);
      return;
    } catch (err) {
      renderSetup(`重新連上團隊失敗:${String(err)}`);
      return;
    }
  }

  if (!saved) return;
  // 連線資訊帶回來,密語仍要現場輸入(它是主金鑰的來源,不落盤)
  try {
    const rest = JSON.parse(saved) as { url: string; vaultId: string; token: string };
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
