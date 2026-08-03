# Stele

> 本地優先的知識庫,如碑刻般長存。

[![CI](https://github.com/cluion/stele/actions/workflows/ci.yml/badge.svg)](https://github.com/cluion/stele/actions/workflows/ci.yml)
[![授權: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)

[English](README.md) · **繁體中文**

Stele(石碑)是一套本地優先、可端對端加密同步、可自架的知識管理工具。你的筆記永遠是磁碟上一份人類可讀、可帶走、git 友善的純 Markdown;同時擁有 CRDT 帶來的離線完美合併與多裝置同步。

## 核心理念

- **本地優先**:磁碟上永遠有完整的純 Markdown,刪掉同步狀態、關掉伺服器,你的資料仍然完整。
- **CRDT 為真相、Markdown 為鏡像**:Y.Text 持有原始 Markdown 為真相,`.md` 檔是位元組級的鏡像;外部編輯(其他編輯器、git、腳本)會被吸收回 CRDT。
- **端對端加密同步**:自架同步伺服器只是加密 blob 的轉信站(blind relay),看不到你的筆記內容與檔名。
- **開源 MIT**:所有執行期依賴皆為 MIT(或相容的寬鬆授權,逐一列管)。

## 功能

- 真 WYSIWYG 編輯(ProseMirror)+ 源碼模式(CodeMirror 6),Cmd/Ctrl+E 切換
- Wikilink `[[ ]]`:自動完成、點擊導航、就地建檔、改名連動全庫改寫
- 反向連結面板、關聯圖(graph view)
- 每日筆記 + 模板、CJK 全文搜尋、快速切換(Cmd/Ctrl+P)
- **查詢視圖**:用 ` ```stele-query ` 區塊把筆記當資料庫查,依標籤、資料夾與 frontmatter 欄位組出清單或表格
- **白板**:無限畫布上擺文字、筆記、連結與群組並連線;存成開放格式 [JSON Canvas](https://jsoncanvas.org) `.canvas`,與 Obsidian 互通
- **版本回溯(時光機)**:自動留存歷史版本,逐字比對後還原;版本是純 Markdown 檔,用檔案總管也翻得動
- 日石英 / 夜燭石 雙主題,原生設計非反轉
- 多裝置端對端加密同步、自架伺服器一行 `docker run`
- **團隊 vault**:邀請碼加人、擁有者核准、金鑰逐成員信封包裝、寫入帶作者簽章——伺服器看到的始終只有密文
- **iOS app**:在手機上讀、搜尋、記一筆(見下)
- 內建 i18n(zh-TW / en)

## 安裝

### macOS(Homebrew)

```bash
brew install --cask cluion/tap/stele
```

Stele 未經簽章,第一次開啟請**右鍵點 Stele.app → 開啟**以通過 Gatekeeper(只需一次)。想省下這步,改用 `brew install --cask --no-quarantine cluion/tap/stele` 安裝。

### 其他平台

到[最新發佈](https://github.com/cluion/stele/releases/latest)下載 `.dmg`(macOS)、`.AppImage` 或 `.deb`(Linux)。

### iOS

iOS app **還沒有 App Store 或 TestFlight 管道**——那需要 Apple Developer 帳號、憑證與審查,尚未著手。目前請自行建置:

```bash
pnpm --filter @stele/mobile sync   # 建置 web 層並同步 Xcode 專案
pnpm --filter @stele/mobile ios    # 在模擬器或實機上執行
```

需要 Xcode。手機的定位是**既有知識庫的第二個端點**:連上一個已經在用的 vault——個人 vault 用密語,團隊 vault 用邀請碼——筆記會以明文 `.md` 落在裝置上,和桌面的 vault 資料夾一致。它做的是讀、搜尋、wikilink 導航、反向連結,以及記一筆。WYSIWYG 編輯、白板編輯與管理面板留在桌面。

## 開發與執行

需要 Node ≥ 24 與 pnpm。

```bash
pnpm install
pnpm --filter @stele/desktop start   # 啟動桌面 app
pnpm check                            # lint + typecheck + test + 授權檢查
```

## 自架同步伺服器

```bash
docker build -f apps/server/Dockerfile -t stele-server .
docker run -d -p 4800:4800 -v stele-data:/data -e STELE_TOKEN=請換成至少16字元的祕密 stele-server
```

在 vault 的 `.stele/sync.json` 填入 `url`、`token`、`passphrase` 即啟用加密同步。詳見 [apps/server/README.md](apps/server/README.md)。

## 架構

單一 TypeScript monorepo(pnpm workspace):

| 套件 | 職責 |
|---|---|
| `packages/editor-core` | 區塊映射引擎、SteleBinding、wikilink |
| `packages/sync` | 同步協議、SyncClient、E2EE 加密層 |
| `packages/ui` | 設計系統與 tokens |
| `apps/desktop` | Electron 桌面 app |
| `apps/mobile` | iOS app(Capacitor 原生殼) |
| `apps/server` | 自架同步伺服器(blind relay) |

## 授權

MIT — 見 [LICENSE](LICENSE)。
