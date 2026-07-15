// P0-3:Electron 骨架自測 — main process 單一寫入者 + 雙視窗 IPC + fsWatch 吸收 + 鏡像迴圈防護
import { app, BrowserWindow, ipcMain } from "electron";
import * as Y from "yjs";
import diff from "fast-diff";
import chokidar from "chokidar";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.join(__dirname, "..", "tmp-vault");
const NOTE = path.join(VAULT, "note.md");

// ── 單一寫入者:main process 持有唯一的 Y.Doc ──
const ydoc = new Y.Doc();
const ytext = ydoc.getText("md");
let lastMirrored = ""; // 迴圈防護:記住自己寫出去的內容

mkdirSync(VAULT, { recursive: true });
writeFileSync(NOTE, "# 測試筆記\n\n初始內容。\n");
ytext.insert(0, readFileSync(NOTE, "utf8"));
lastMirrored = ytext.toString();

const windows = [];
let mirrorWrites = 0;
let absorbed = 0;
let loopBlocked = 0;

// 鏡像:CRDT 變更 → 原子寫回 .md(tmp+rename)
let mirrorTimer = null;
ydoc.on("update", (_u, origin) => {
  for (const w of windows) w.webContents.send("doc", ytext.toString()); // 廣播給所有視窗
  if (origin === "external-file") return; // 外部吸收造成的變更不需要再寫回
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(async () => {
    const content = ytext.toString();
    lastMirrored = content;
    const tmp = NOTE + ".tmp";
    await writeFile(tmp, content);
    await rename(tmp, NOTE);
    mirrorWrites++;
  }, 80);
});

// fsWatch:外部修改 → fast-diff → 吸收進 CRDT
chokidar.watch(NOTE, { ignoreInitial: true }).on("change", () => {
  const onDisk = readFileSync(NOTE, "utf8");
  if (onDisk === lastMirrored) { loopBlocked++; return; } // 迴圈防護:是自己寫的,忽略
  let pos = 0;
  ydoc.transact(() => {
    for (const [kind, text] of diff(ytext.toString(), onDisk)) {
      if (kind === 0) pos += text.length;
      else if (kind === -1) ytext.delete(pos, text.length);
      else { ytext.insert(pos, text); pos += text.length; }
    }
  }, "external-file");
  lastMirrored = onDisk;
  absorbed++;
});

// IPC:視窗是「編輯請求者」,不是持有者
ipcMain.on("edit", (_e, { insert, at }) => {
  ydoc.transact(() => ytext.insert(at ?? ytext.length, insert), "renderer");
});
ipcMain.handle("read", () => ytext.toString());

app.whenReady().then(async () => {
  for (let i = 0; i < 2; i++) {
    const w = new BrowserWindow({
      width: 480, height: 320, x: 60 + i * 500, y: 60,
      title: `Stele P0-3 視窗 ${i + 1}`,
      webPreferences: { preload: path.join(__dirname, "preload.cjs") },
    });
    await w.loadFile(path.join(__dirname, "index.html"));
    windows.push(w);
  }

  // ── 自測腳本 ──
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  windows[0].webContents.send("do-edit", { insert: "【視窗1打的字】", at: null }); // 視窗1 經 IPC 編輯
  await sleep(400);
  writeFileSync(NOTE, readFileSync(NOTE, "utf8").replace("初始內容。", "初始內容被外部程式改掉。")); // 模擬外部編輯器
  await sleep(900); // 等 fsWatch + 鏡像 debounce

  const finalDoc = ytext.toString();
  const onDisk = readFileSync(NOTE, "utf8");
  const w1 = await windows[0].webContents.executeJavaScript("document.getElementById('content').textContent");
  const w2 = await windows[1].webContents.executeJavaScript("document.getElementById('content').textContent");

  const results = {
    "視窗1的IPC編輯進入CRDT": finalDoc.includes("【視窗1打的字】"),
    "外部修改被吸收": finalDoc.includes("初始內容被外部程式改掉"),
    "磁碟鏡像與CRDT一致": onDisk === finalDoc,
    "兩個視窗即時同步一致": w1 === finalDoc && w2 === finalDoc,
    "鏡像寫回未造成吸收迴圈": loopBlocked >= 1 && absorbed === 1,
    統計: { 鏡像寫回次數: mirrorWrites, 吸收次數: absorbed, 迴圈防護攔截: loopBlocked },
  };
  console.log("P0-3-RESULTS " + JSON.stringify(results));
  const pass = Object.entries(results).filter(([k]) => k !== "統計").every(([, v]) => v === true);
  console.log(pass ? "P0-3 ✅ 全數通過" : "P0-3 ❌ 有項目失敗");
  app.exit(pass ? 0 : 1);
});
