/** 啟動設定全部來自環境變數,缺必要值就快速失敗 */
export interface ServerConfig {
  port: number;
  token: string;
  dbFile: string;
}

const MIN_TOKEN_LENGTH = 16;

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const token = env["STELE_TOKEN"];
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`STELE_TOKEN 未設定或太短,至少 ${MIN_TOKEN_LENGTH} 字元`);
  }
  const port = Number(env["PORT"] ?? "4800");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`非法 PORT:${env["PORT"]}`);
  }
  return { port, token, dbFile: env["STELE_DATA"] ?? "data/stele.db" };
}
