import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";

/**
 * 行動端的儲存層——**唯一碰原生 API 的地方**。
 *
 * 這道介面存在的理由很具體:原生檔案系統目前還沒真正驗過(spike 跑的是 Capacitor 的
 * web fallback,見 plan/p4-4-mobile.md)。把儲存收斂成一個介面,等真機驗出行為差異時
 * 只要改這一個檔,而不是把 app 全境的 `Filesystem.readFile` 一個個找出來。
 *
 * 兩種資料分開放:
 * - **筆記是明文 `.md`**,落在 Documents 底下,與桌面的 vault 資料夾一致。使用者要能用
 *   Files app 把自己的東西拿出去——那正是選 Capacitor 而非 PWA 的理由。裝置層的保護交給
 *   iOS 全機加密,不自己再包一層(自己加密會讓「拿得出來」失效)。
 * - **CRDT 狀態是二進位**,放在隱藏的 `.stele/`,與筆記同一套規則:刪掉它不影響 vault,
 *   下次連線重新拉。
 */

export interface VaultStorage {
  listNotes(): Promise<string[]>;
  readNote(rel: string): Promise<string | null>;
  writeNote(rel: string, text: string): Promise<void>;
  deleteNote(rel: string): Promise<void>;
  /** CRDT 狀態;key 是 docId */
  readState(key: string): Promise<Uint8Array | null>;
  writeState(key: string, bytes: Uint8Array): Promise<void>;
  /** 小設定(伺服器位址、vault id、裝置 id);不放機密 */
  readSetting(key: string): Promise<string | null>;
  writeSetting(key: string, value: string): Promise<void>;
}

/** vault 在裝置上的根目錄名;使用者在 Files app 裡看到的就是它 */
const ROOT = "Stele";
const STATE_DIR = `${ROOT}/.stele`;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  // 一次一段,避免大狀態把 apply 的參數表撐爆
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/** docId 會組進檔名,格式必驗——它來自伺服器,是不受信輸入 */
const VALID_DOC_ID = /^[0-9a-zA-Z-]{1,64}$/;

/**
 * 相對路徑的合法性:與桌面 `resolveNewFile` 同一套規則。路徑來自同步下來的 meta,
 * 不受信;`..` 一旦放行,遠端就能把檔案寫到 app 沙盒的任何角落。
 */
function assertRel(rel: string): void {
  if (
    rel.length === 0 ||
    rel.startsWith("/") ||
    !(rel.endsWith(".md") || rel.endsWith(".canvas")) ||
    rel.split("/").some((seg) => seg.trim() === "" || seg === "." || seg === "..")
  ) {
    throw new Error(`非法路徑:${rel}`);
  }
}

export class CapacitorStorage implements VaultStorage {
  async listNotes(): Promise<string[]> {
    return (await this.walk(ROOT)).sort();
  }

  /** 遞迴列出筆記;隱藏目錄(`.stele`)不是使用者的筆記,一律跳過 */
  private async walk(dir: string, prefix = ""): Promise<string[]> {
    let entries: Array<{ name: string; type: string }>;
    try {
      entries = (await Filesystem.readdir({ path: dir, directory: Directory.Documents })).files;
    } catch {
      return []; // 目錄還不存在:第一次啟動
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.type === "directory") out.push(...(await this.walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`)));
      else if (entry.name.endsWith(".md") || entry.name.endsWith(".canvas")) out.push(prefix + entry.name);
    }
    return out;
  }

  async readNote(rel: string): Promise<string | null> {
    assertRel(rel);
    try {
      const res = await Filesystem.readFile({ path: `${ROOT}/${rel}`, directory: Directory.Documents, encoding: Encoding.UTF8 });
      return typeof res.data === "string" ? res.data : null;
    } catch {
      return null;
    }
  }

  async writeNote(rel: string, text: string): Promise<void> {
    assertRel(rel);
    const path = `${ROOT}/${rel}`;
    const dir = path.slice(0, path.lastIndexOf("/"));
    await Filesystem.mkdir({ path: dir, directory: Directory.Documents, recursive: true }).catch(() => undefined);
    await Filesystem.writeFile({ path, directory: Directory.Documents, data: text, encoding: Encoding.UTF8 });
  }

  async deleteNote(rel: string): Promise<void> {
    assertRel(rel);
    await Filesystem.deleteFile({ path: `${ROOT}/${rel}`, directory: Directory.Documents }).catch(() => undefined);
  }

  async readState(key: string): Promise<Uint8Array | null> {
    if (!VALID_DOC_ID.test(key)) throw new Error(`非法 doc id:${key}`);
    try {
      const res = await Filesystem.readFile({ path: `${STATE_DIR}/${key}.ybin`, directory: Directory.Documents });
      return typeof res.data === "string" ? base64ToBytes(res.data) : null;
    } catch {
      return null;
    }
  }

  async writeState(key: string, bytes: Uint8Array): Promise<void> {
    if (!VALID_DOC_ID.test(key)) throw new Error(`非法 doc id:${key}`);
    await Filesystem.mkdir({ path: STATE_DIR, directory: Directory.Documents, recursive: true }).catch(() => undefined);
    await Filesystem.writeFile({ path: `${STATE_DIR}/${key}.ybin`, directory: Directory.Documents, data: bytesToBase64(bytes) });
  }

  async readSetting(key: string): Promise<string | null> {
    return (await Preferences.get({ key })).value;
  }

  async writeSetting(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  }
}
