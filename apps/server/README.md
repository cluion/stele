# @stele/server — 自架同步伺服器

blind relay:只存加密 blob、配序號、廣播,看不到任何筆記內容與檔名。

## 一行起服

```bash
docker build -f apps/server/Dockerfile -t stele-server .
docker run -d -p 4800:4800 -v stele-data:/data -e STELE_TOKEN=請換成至少16字元的祕密 stele-server
```

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `STELE_TOKEN` | 是 | — | 存取權杖,至少 16 字元;client 連線時出示 |
| `PORT` | 否 | `4800` | WebSocket 監聽 port |
| `STELE_DATA` | 否 | `data/stele.db` | SQLite 資料庫路徑(Docker 內為 `/data/stele.db`) |

## 開發

```bash
STELE_TOKEN=本機開發用的假token pnpm --filter @stele/server start
pnpm --filter @stele/server test
```
