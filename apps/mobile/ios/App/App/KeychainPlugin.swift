import Foundation
import Capacitor
import Security

/**
 * Keychain 存取——**本專案唯一自寫的原生程式碼**。
 *
 * 為什麼不用現成外掛:這裡保管的是成員身分種子,是整個系統裡洩漏代價最高的一個秘密
 * (可冒充此成員於所有已加入的 vault,並解開所有曾以他的 pubWrap 包裝的空間金鑰)。
 * 它經手的每一行程式碼都該是我們讀過的。而 Keychain 的四個操作總共不到一百行,
 * 換來的是把一個帶原生碼的第三方套件放進這條路徑上——這筆交易不划算。
 *
 * 兩個決定寫死在這裡,不開放給 JS 調:
 *
 * - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
 *   `ThisDeviceOnly` = **不進裝置備份**。備份會跟著 iTunes/iCloud 備份檔搬到別的地方,
 *   而身分種子的威脅模型裡「備份檔外流」與「裝置遺失」同等重要。
 *   `AfterFirstUnlock`(而非 `WhenUnlocked`)是為了同步:app 在背景被喚醒時螢幕可能是鎖的,
 *   要求解鎖狀態會讓背景同步在鎖屏時全部失敗。
 * - `kSecAttrSynchronizable = false`
 *   **絕不進 iCloud Keychain**。同步過去等於把種子交給 Apple 的伺服器保管,
 *   而這個產品的第一句話是「你的資料在你手上」。
 *
 * JS 端見 `src/secrets.ts`。
 */
@objc(SteleKeychain)
public class KeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SteleKeychain"
    public let jsName = "SteleKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    /** 所有項目共用的服務名;與 bundle id 同名,和別的 app 的 keychain 項目天然分開 */
    private static let service = "com.cluion.stele.mobile"

    /** 一把 key 的查詢基底。account = 呼叫端給的 key */
    private func query(_ account: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: KeychainPlugin.service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    /** 取 key;不存在回 null(而非錯誤)——「還沒有身分」是正常狀態,不是故障 */
    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("缺少 key")
            return
        }
        var query = self.query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            // 讀失敗一律當錯誤往上拋:靜默回 null 會讓上層以為「還沒有身分」而生一個新的,
            // 那等於無聲換掉使用者的身分,所有已加入的團隊都要重新核准
            call.reject("Keychain 讀取失敗(OSStatus \(status))")
            return
        }
        call.resolve(["value": value])
    }

    /** 寫 key;已存在就更新。先試 update、失敗才 add,避免先刪後加中間斷電留下空窗 */
    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("缺少 key")
            return
        }
        guard let value = call.getString("value"), let data = value.data(using: .utf8) else {
            call.reject("缺少 value")
            return
        }

        let update: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query(key) as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }
        guard updateStatus == errSecItemNotFound else {
            call.reject("Keychain 更新失敗(OSStatus \(updateStatus))")
            return
        }

        var insert = query(key)
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            call.reject("Keychain 寫入失敗(OSStatus \(addStatus))")
            return
        }
        call.resolve()
    }

    /** 刪 key;本來就不存在也算成功(冪等) */
    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("缺少 key")
            return
        }
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Keychain 刪除失敗(OSStatus \(status))")
            return
        }
        call.resolve()
    }
}
