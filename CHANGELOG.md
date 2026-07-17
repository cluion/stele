# Changelog

本專案的所有重要變更都記錄於此。格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/),版本遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

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

[0.2.0]: https://github.com/cluion/stele/releases/tag/v0.2.0
[0.1.0]: https://github.com/cluion/stele/releases/tag/v0.1.0
