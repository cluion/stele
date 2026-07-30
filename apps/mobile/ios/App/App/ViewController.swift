import UIKit
import Capacitor

/**
 * Capacitor 的橋接 view controller,只為了一件事而存在:**註冊我們自己的 Keychain 外掛**。
 *
 * Capacitor 8 的外掛註冊表來自 `cap sync` 產生的 `capacitor.config.json` 的 `packageClassList`,
 * 那份清單只收 npm 外掛套件——app target 裡的類別不會被自動發現。想放一個自寫的原生外掛,
 * 就得在這裡明說。少了這一段,JS 端呼叫會安靜地落到 web fallback,而那正是我們最不想要的結果。
 */
class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(KeychainPlugin())
    }
}
