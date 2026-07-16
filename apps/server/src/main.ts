import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { SyncStore } from "./store.ts";
import { startServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(path.dirname(config.dbFile), { recursive: true });
  const store = new SyncStore(config.dbFile);
  const server = await startServer({ port: config.port, token: config.token, store });
  console.log(`Stele 同步伺服器啟動,port ${server.port},資料庫 ${config.dbFile}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.close().then(() => {
        store.close();
        process.exit(0);
      });
    });
  }
}

main().catch((err: unknown) => {
  console.error("啟動失敗:", err);
  process.exit(1);
});
