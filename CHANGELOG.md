# Changelog

本專案的所有重要變更都記錄於此。格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/),版本遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [0.4.0] - 2026-07-18

桌面安裝檔與自動發版:一鍵下載的 dmg / AppImage / deb,推 tag 即自動打包並發佈。

### 新增

- **桌面安裝檔打包**:`apps/desktop` 接上 electron-builder,產出 macOS dmg(x64 + arm64 雙架構)、Linux AppImage 與 deb,附石碑應用圖示。產物走 esbuild 全 bundle,asar 只收 `dist/` 不含 node_modules,dmg 檔名帶架構後綴避免雙架構互相覆蓋。
- **CI 自動發版**(新 `.github/workflows/release.yml`):push `v*` tag 觸發,`build` job 在 macOS 與 Linux runner 並行打包三平台安裝檔,`release` job 收齊產物後從 `CHANGELOG.md` 抽出對應版本節當 release notes,`gh release create` 一次帶齊安裝檔直接發佈;發佈前斷言 tag 版本與 `package.json` 一致,擋下忘記升版號的誤發。`workflow_dispatch` 另備只建置不發佈的 dry-run。

### 品質

- 發版流程全自動化,原本手動的跨平台打包與建 Release 交由 CI 完成;Linux 產物改由 Linux runner 實際打包,不再是 mac 上跨建。發版流程文件(`plan/RELEASE.md`)同步更新。

## [0.3.0] - 2026-07-17

分享連結:把單一筆記唯讀分享到瀏覽器,伺服器仍全盲。

### 新增

- **唯讀分享連結**:右鍵任一筆記即可建立分享連結,對方用瀏覽器就能開,免安裝、免帳號。桌面對話框含複製連結與撤銷清單。
- **網頁檢視器**(新 `apps/viewer`):與桌面同一套 editor-core schema 唯讀渲染,連結、表格、callout 呈現一致。伺服器同埠掛靜態頁,`shareId` 只在前端解析。
- **端對端加密延伸到分享**:每則分享匯出「單一 doc 金鑰」(HKDF 單向,vault 主金鑰不外洩),金鑰只走 URL fragment(`#` 之後)不進伺服器;伺服器新增 shares 表管理作用域與撤銷,唯讀連線鎖定單一 doc 且拒所有寫入型訊息。

### 修正

- **撤銷即時生效**:撤銷分享會當場切斷既有連線,撤銷後的內容一個字都拿不到(原本只擋新連線,已連上的可續讀);且撤銷嚴格綁 vault,猜中他人 `shareId` 也踢不掉對方連線。
- **連結 href 淨化**:編輯器與檢視器只放行 `http`/`https`/`mailto` 與相對連結,`javascript:`/`data:` 等一律剝除(貼上 HTML 會繞過 markdown-it 的內建過濾,渲染器主世界有 IPC 面,不能只靠上游解析器設定)。
- **檢視器安全標頭**:分享頁補上 CSP(`default-src 'none'`、腳本只信同源、`frame-ancestors 'none'`)、`nosniff`、`no-referrer`;`frame-ancestors` 下在 HTTP header,`<meta>` 版另備為自架保底。

### 品質

- 分享全鏈測試:金鑰匯出/單 doc 解密、協議往返、伺服器作用域與權限、撤銷即時與跨 vault 隔離、桌面「建立→列出→撤銷」真實往返(驗證 fragment 金鑰可還原且不落伺服器)、檢視器連結解析。
- 桌面 smoke 增至 17 項,新增分享對話框開啟/建立/關閉全鏈。

## [0.2.0] - 2026-07-17

即時多人協作:加密的在場指示與遠端游標。

### 新增

- **即時協作 awareness**:多人開同一 vault 時,即時顯示誰在看哪篇筆記(彩色頭像,顏色由裝置穩定衍生)。
- **遠端游標**:兩種編輯器模式都渲染協作者游標——源碼模式為字元級精確 caret 與選取範圍(Y.Text relative position,並發編輯下不漂移);所見即所得模式為塊級段落標記與名字標籤。
- **端對端加密**:awareness 與游標資料以同一把 doc 金鑰加密,伺服器為 blind relay,看不到誰在哪、也不落盤(ephemeral)。

### 修正

- 本地游標回報加上節流(~90ms),打字期間不再每按鍵一次加密廣播。
- 協作熱路徑改用編輯器增量維護的區塊映射,不再每次按鍵/在場更新整份重新解析 Markdown。
- 同步引擎:awareness 對非法 docId 拒絕(防資源耗盡)、切 vault 重置在場、stop 後不復活實例。

## [0.1.0] - 2026-07-17

首個公開版本:本地優先單機 MVP + 端對端加密同步 + 自架伺服器。

### 新增

- **編輯器核心**:ProseMirror 真 WYSIWYG + CodeMirror 6 源碼模式,塊級重序列化保位元組穩定;不支援語法走 opaque 原文節點。
- **Wikilink 生態**:`[[ ]]` 自動完成、點擊導航、就地建檔、改名連動全庫改寫。
- **雙鏈**:反向連結面板、自寫力導向關聯圖。
- **每日筆記**:`{{date}}` 模板、`.stele/config.json` 可自訂。
- **搜尋與切換**:CJK bigram 全文搜尋、快速切換器。
- **設計系統**:日石英 / 夜燭石 雙主題(原生設計,非反轉)。
- **CRDT 狀態持久化**:`.stele/` 保存二進位狀態,開檔吸收外部差異,歷史跨啟動延續。
- **端對端加密同步**:passphrase → scrypt → 主金鑰,per-doc HKDF 子金鑰 + AES-256-GCM;伺服器只見密文。
- **自架同步伺服器**:Node + ws + better-sqlite3 的 blind relay,單 Docker 一行起服;雙路徑同步(快照 + 增量)、離線佇列、路徑 LWW。
- **i18n**:zh-TW / en,CI 缺譯檢查。

### 品質

- 209 個單元/整合測試,含 8 輪固定 seed 多裝置混沌測試(隨機編輯/刪除/斷線/中殺,零資料遺失為底線)。
- 16 項 smoke 測試涵蓋桌面全鏈。
- CI:lint、typecheck、test、授權政策檢查、smoke。

[0.4.0]: https://github.com/cluion/stele/releases/tag/v0.4.0
[0.3.0]: https://github.com/cluion/stele/releases/tag/v0.3.0
[0.2.0]: https://github.com/cluion/stele/releases/tag/v0.2.0
[0.1.0]: https://github.com/cluion/stele/releases/tag/v0.1.0
