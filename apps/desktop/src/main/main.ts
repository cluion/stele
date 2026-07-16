import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { VaultSession, type SessionCallbacks } from "./vault-session.ts";
import { loadSettings, saveSettings } from "./settings.ts";

const SMOKE = process.argv.includes("--smoke");
const FIXTURES_VAULT = path.resolve(__dirname, "..", "..", "..", "prototypes", "mirror", "fixtures", "vault");

let session: VaultSession | undefined;
const windows = new Set<BrowserWindow>();

const callbacks: SessionCallbacks = {
  broadcastDoc(rel, update) {
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send("doc:update", rel, update);
    }
  },
  notifyIndexUpdated() {
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send("index:updated");
    }
  },
};

function requireSession(): VaultSession {
  if (!session) throw new Error("尚未開啟 vault");
  return session;
}

/** 換 vault:先建新 session 再拆舊的,新目錄無效時拋錯、原狀不動 */
async function switchVault(dir: string): Promise<{ vault: string; files: string[] }> {
  const next = new VaultSession(dir, callbacks);
  const prev = session;
  session = next;
  if (prev) await prev.destroy();
  if (!SMOKE) {
    try {
      saveSettings({ lastVault: next.root });
    } catch (err) {
      console.error("設定寫入失敗:", err);
    }
  }
  return next.list();
}

/** 啟動時的 vault 決定順序:smoke 固定 fixtures → STELE_VAULT(開發 override)→ 上次開啟 → 無(歡迎畫面) */
function initialVaultDir(): string | undefined {
  if (SMOKE) return FIXTURES_VAULT;
  const env = process.env["STELE_VAULT"];
  if (env) return path.resolve(env);
  const { lastVault } = loadSettings();
  if (lastVault && existsSync(lastVault) && statSync(lastVault).isDirectory()) return lastVault;
  return undefined;
}

ipcMain.handle("vault:list", () => session?.list() ?? null);

ipcMain.handle("vault:backlinks", (_e, rel: unknown) => {
  if (typeof rel !== "string") throw new Error("非法參數");
  return requireSession().backlinks(rel);
});

ipcMain.handle("vault:graph", () => requireSession().graph());

ipcMain.handle("vault:daily", () => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return requireSession().daily(date);
});

ipcMain.handle("doc:open", (_e, rel: unknown) => requireSession().openDoc(rel));

ipcMain.handle("vault:create", (_e, rel: unknown) => requireSession().create(rel));

ipcMain.on("doc:push", (_e, rel: string, update: Uint8Array) => {
  session?.pushUpdate(rel, update);
});

ipcMain.handle("vault:choose", async (e) => {
  const opts = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const dir = result.filePaths[0];
  if (result.canceled || dir === undefined) return null;
  return switchVault(dir);
});

app.whenReady().then(async () => {
  const dir = initialVaultDir();
  if (dir) {
    try {
      await switchVault(dir);
    } catch (err) {
      console.error(`開啟 vault 失敗 ${dir}:`, err); // 退到歡迎畫面,不擋啟動
    }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Stele",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));

  if (SMOKE) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await sleep(1800);
    const mounted = await win.webContents.executeJavaScript(
      `!!document.querySelector("#editor .ProseMirror") && document.querySelector("#editor .ProseMirror").textContent.length > 0`,
    );

    // 模擬真實鍵盤輸入 → 驗證鏡像寫回磁碟,結束後還原 fixture
    const firstFile = path.join(FIXTURES_VAULT, requireSession().list().files[0]!);
    const originalBytes = readFileSync(firstFile, "utf8");
    await win.webContents.executeJavaScript(`document.querySelector("#editor .ProseMirror").focus()`);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ω" });
    await sleep(150);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await sleep(150);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ψ" });
    let mirrored = false;
    for (let waited = 0; waited < 5000 && !mirrored; waited += 200) {
      await sleep(200);
      // Enter 切段:兩字被空行隔開;第二塊可能帶區塊前綴(如標題的「# 」)
      mirrored = /Ω\n\n[^\n]{0,3}Ψ/.test(readFileSync(firstFile, "utf8"));
    }
    await writeFile(firstFile, originalBytes);
    await sleep(300);

    // 反向連結面板:立項.md 被日記 2026-07-15 連到
    let backlinked = false;
    for (let waited = 0; waited < 5000 && !backlinked; waited += 200) {
      await sleep(200);
      backlinked = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".backlinks .file")].some((el) => el.textContent.includes("2026-07-15"))`,
      );
    }

    // 點擊 wikilink → 建立不存在的筆記並跳轉,驗證後清理
    const clickInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(".wikilink");
        if (!el) return { ok: false, editor: document.querySelector("#editor")?.innerHTML?.slice(0, 400) ?? "no-editor" };
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, opts));
        return { ok: true };
      })()`,
    )) as { ok: boolean; editor?: string };
    if (!clickInfo.ok) console.log("SMOKE DEBUG 找不到 .wikilink:", clickInfo.editor);
    let navigated = false;
    for (let waited = 0; waited < 5000 && !navigated; waited += 200) {
      await sleep(200);
      navigated = await win.webContents.executeJavaScript(
        `document.querySelector("#editor .ProseMirror h1")?.textContent === "Obsidian"`,
      );
    }
    const created = path.join(FIXTURES_VAULT, "Obsidian.md");
    const createdOk = existsSync(created);
    if (createdOk) rmSync(created);

    // 快速切換器:Cmd+P → 打「靈感」→ Enter,應切換到 靈感箱.md
    const typeInSwitcher = (text: string) => `(() => {
      const input = document.querySelector(".switcher input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`;
    const pressInSwitcher = (key: string) => `(() => {
      const input = document.querySelector(".switcher input");
      if (!input) return false;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;
    })()`;
    const openSwitcher = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, cancelable: true }))`;
    const activeSidebarText = `document.querySelector(".sidebar button.active")?.textContent ?? ""`;

    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    const switcherTyped = (await win.webContents.executeJavaScript(typeInSwitcher("靈感"))) as boolean;
    await sleep(200);
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    let switched = false;
    for (let waited = 0; waited < 5000 && !switched; waited += 200) {
      await sleep(200);
      switched = ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "靈感箱";
    }

    // 快速切換器建檔:查詢無符合 → 末項「建立筆記」→ Enter 建檔並開啟
    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("煙霧測試新檔"));
    await sleep(200);
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    const smokeNote = path.join(FIXTURES_VAULT, "煙霧測試新檔.md");
    let switcherCreated = false;
    for (let waited = 0; waited < 5000 && !switcherCreated; waited += 200) {
      await sleep(200);
      switcherCreated =
        existsSync(smokeNote) &&
        ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === "煙霧測試新檔";
    }
    if (existsSync(smokeNote)) rmSync(smokeNote);

    // 源碼模式:切到 靈感箱 → Cmd+E 掛 CodeMirror → 打字鏡像到磁碟 → Cmd+E 切回 WYSIWYG
    await win.webContents.executeJavaScript(openSwitcher);
    await sleep(200);
    await win.webContents.executeJavaScript(typeInSwitcher("靈感"));
    await sleep(200);
    await win.webContents.executeJavaScript(pressInSwitcher("Enter"));
    await sleep(400);
    const toggleMode = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, cancelable: true }))`;
    await win.webContents.executeJavaScript(toggleMode);
    let cmMounted = false;
    for (let waited = 0; waited < 5000 && !cmMounted; waited += 200) {
      await sleep(200);
      cmMounted = await win.webContents.executeJavaScript(
        `!!document.querySelector("#editor .cm-editor") && document.querySelector("#editor .cm-content").textContent.length > 0`,
      );
    }
    const inspFile = path.join(FIXTURES_VAULT, "靈感箱.md");
    const inspBytes = readFileSync(inspFile, "utf8");
    await win.webContents.executeJavaScript(`document.querySelector("#editor .cm-content").focus()`);
    win.webContents.sendInputEvent({ type: "char", keyCode: "Ψ" });
    let cmMirrored = false;
    for (let waited = 0; waited < 5000 && !cmMirrored; waited += 200) {
      await sleep(200);
      cmMirrored = readFileSync(inspFile, "utf8").includes("Ψ");
    }
    await writeFile(inspFile, inspBytes);
    await sleep(300);
    await win.webContents.executeJavaScript(toggleMode);
    let pmBack = false;
    for (let waited = 0; waited < 5000 && !pmBack; waited += 200) {
      await sleep(200);
      pmBack = await win.webContents.executeJavaScript(`!!document.querySelector("#editor .ProseMirror")`);
    }
    const sourceMode = cmMounted && cmMirrored && pmBack;

    // 關聯圖:Cmd+G 開啟 → canvas 掛載且節點數=筆記數 → Esc 關閉回編輯器
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", metaKey: true, cancelable: true }))`,
    );
    let graphShown = false;
    const expectedNodes = requireSession().list().files.length;
    for (let waited = 0; waited < 5000 && !graphShown; waited += 200) {
      await sleep(200);
      graphShown = await win.webContents.executeJavaScript(
        `!!document.querySelector(".graph canvas") && document.querySelector(".graph")?.dataset.nodeCount === "${expectedNodes}"`,
      );
    }
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))`,
    );
    await sleep(300);
    const graphClosed = await win.webContents.executeJavaScript(
      `!document.querySelector(".graph") && !!document.querySelector("#editor")`,
    );
    const graphOk = graphShown && graphClosed;

    // 每日筆記:Cmd+D → 建立並開啟今天的日記,驗證後清理
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, cancelable: true }))`,
    );
    const dailyFile = path.join(FIXTURES_VAULT, "日記", `${todayStr}.md`);
    let dailyOk = false;
    for (let waited = 0; waited < 5000 && !dailyOk; waited += 200) {
      await sleep(200);
      dailyOk =
        existsSync(dailyFile) &&
        readFileSync(dailyFile, "utf8").startsWith(`# ${todayStr}`) &&
        ((await win.webContents.executeJavaScript(activeSidebarText)) as string) === `日記/${todayStr}`;
    }
    if (existsSync(dailyFile)) rmSync(dailyFile);

    // 換 vault:切到臨時 vault 驗證索引與反向連結,再切回 fixtures 確認 session 生滅正常
    const tmpVault = path.join(app.getPath("temp"), "stele-smoke-vault");
    rmSync(tmpVault, { recursive: true, force: true });
    mkdirSync(path.join(tmpVault, "子夾"), { recursive: true });
    writeFileSync(path.join(tmpVault, "唯一.md"), "# 唯一\n");
    writeFileSync(path.join(tmpVault, "子夾", "來源.md"), "連到 [[唯一]]\n");
    let vaultSwitched = false;
    try {
      const tmpList = await switchVault(tmpVault);
      const tmpBacklinks = requireSession().backlinks("唯一.md");
      const backList = await switchVault(FIXTURES_VAULT);
      vaultSwitched =
        tmpList.files.join(",") === "唯一.md,子夾/來源.md" &&
        tmpBacklinks.length === 1 &&
        tmpBacklinks[0]!.file === "子夾/來源.md" &&
        backList.files.length >= 3 &&
        requireSession().backlinks("專案/Stele/立項.md").length >= 1;
    } catch (err) {
      console.error("SMOKE 換 vault 失敗:", err);
    }
    rmSync(tmpVault, { recursive: true, force: true });

    console.log(mounted ? "SMOKE ✅ 編輯器掛載且有內容" : "SMOKE ❌ 編輯器未就緒");
    console.log(mirrored ? "SMOKE ✅ 鍵盤輸入與 Enter 切段已鏡像到磁碟" : "SMOKE ❌ 輸入未寫回磁碟");
    console.log(navigated && createdOk ? "SMOKE ✅ 點擊 wikilink 建檔並跳轉" : "SMOKE ❌ wikilink 導航失敗");
    console.log(backlinked ? "SMOKE ✅ 反向連結面板顯示來源" : "SMOKE ❌ 反向連結未顯示");
    console.log(switcherTyped && switched ? "SMOKE ✅ Cmd+P 模糊搜尋切換筆記" : "SMOKE ❌ 快速切換器切換失敗");
    console.log(switcherCreated ? "SMOKE ✅ 快速切換器建檔並開啟" : "SMOKE ❌ 快速切換器建檔失敗");
    console.log(sourceMode ? "SMOKE ✅ 源碼模式編輯與雙向切換" : "SMOKE ❌ 源碼模式失敗");
    console.log(graphOk ? "SMOKE ✅ 關聯圖開啟節點數正確且可關閉" : "SMOKE ❌ 關聯圖失敗");
    console.log(dailyOk ? "SMOKE ✅ Cmd+D 建立並開啟每日筆記" : "SMOKE ❌ 每日筆記失敗");
    console.log(vaultSwitched ? "SMOKE ✅ 換 vault session 生滅正常" : "SMOKE ❌ 換 vault 失敗");
    app.exit(
      mounted && mirrored && navigated && createdOk && backlinked && switcherTyped && switched && switcherCreated && sourceMode && graphOk && dailyOk && vaultSwitched
        ? 0
        : 1,
    );
  }
});

// 退出前 flush 所有未落盤的鏡像;destroy 完成後才真正退出
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !session) return;
  e.preventDefault();
  quitting = true;
  const closing = session;
  session = undefined;
  void closing
    .destroy()
    .catch((err: unknown) => console.error("退出前 flush 失敗:", err))
    .finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());
