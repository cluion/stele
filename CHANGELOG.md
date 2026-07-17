# Changelog

本專案的所有重要變更都記錄於此。格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/),版本遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

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

[0.1.0]: https://github.com/cluion/stele/releases/tag/v0.1.0
