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
- 日石英 / 夜燭石 雙主題,原生設計非反轉
- 多裝置端對端加密同步、自架伺服器一行 `docker run`
- 內建 i18n(zh-TW / en)

## 安裝

### macOS(Homebrew)

```bash
brew install --cask cluion/tap/stele
```

Stele 未經簽章,第一次開啟請**右鍵點 Stele.app → 開啟**以通過 Gatekeeper(只需一次)。想省下這步,改用 `brew install --cask --no-quarantine cluion/tap/stele` 安裝。

### 其他平台

到[最新發佈](https://github.com/cluion/stele/releases/latest)下載 `.dmg`(macOS)、`.AppImage` 或 `.deb`(Linux)。

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
| `apps/server` | 自架同步伺服器(blind relay) |

## 授權

MIT — 見 [LICENSE](LICENSE)。
