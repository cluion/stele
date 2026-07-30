import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * 秘密的保管層——與 `VaultStorage` 分開的第二道介面,分開的理由是**威脅模型不同**。
 *
 * `VaultStorage` 存的是筆記與 CRDT 狀態:明文落在 Documents 底下是刻意的,使用者要能用
 * Files app 把自己的東西拿出去。這裡存的是成員身分種子,規則正好相反——它必須進 Keychain,
 * 不進備份、不進 iCloud、使用者也不該看得到。兩者混在同一個介面遲早會有人把種子寫進
 * 那個「使用者拿得出去」的資料夾。
 *
 * `@capacitor/preferences` 不能用:它在 iOS 走的是 UserDefaults,那是一個未加密的 plist,
 * 會進裝置備份。對一把能冒充此成員於所有已加入 vault 的長期金鑰,那不是保管,是放在桌上。
 *
 * 原生實作是我們自己的 `ios/App/App/KeychainPlugin.swift`。
 */

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** 原生外掛的介面;與 KeychainPlugin.swift 的三個方法一一對應 */
interface KeychainApi {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const Keychain = registerPlugin<KeychainApi>("SteleKeychain");

class KeychainSecrets implements SecretStore {
  async get(key: string): Promise<string | null> {
    return (await Keychain.get({ key })).value;
  }
  set(key: string, value: string): Promise<void> {
    return Keychain.set({ key, value });
  }
  remove(key: string): Promise<void> {
    return Keychain.remove({ key });
  }
}

/**
 * 開發用的退回實作:**localStorage,毫無保護**。
 *
 * 存在的理由與 `devAutoConnect` 同一個——模擬器的 Safari 裡沒有 Keychain,而團隊 vault 的
 * 加入流程必須在真的 WebView 之外也能手動走一遍。因此它只在 localhost 生效,其他任何主機
 * 一律當場拋。桌面的身分保管在 keychain 不可用時會安靜地退回明文(Linux 無 keyring 是真實
 * 使用情境),這裡不行:行動端沒有「Keychain 不可用」的正當情境,安靜退回只會變成正式版
 * 把種子寫進 localStorage 而沒有人發現。
 */
class InsecureDevSecrets implements SecretStore {
  private readonly prefix = "stele-dev-secret:";

  private assertLocal(): void {
    const host = location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new Error("此裝置沒有安全的秘密保管(非原生環境),拒絕存取身分種子");
    }
  }
  get(key: string): Promise<string | null> {
    this.assertLocal();
    return Promise.resolve(localStorage.getItem(this.prefix + key));
  }
  set(key: string, value: string): Promise<void> {
    this.assertLocal();
    localStorage.setItem(this.prefix + key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.assertLocal();
    localStorage.removeItem(this.prefix + key);
    return Promise.resolve();
  }
}

/** 原生環境走 Keychain,其餘走開發用退回(且只在 localhost 動得了) */
export const createSecretStore = (): SecretStore =>
  Capacitor.isNativePlatform() ? new KeychainSecrets() : new InsecureDevSecrets();
