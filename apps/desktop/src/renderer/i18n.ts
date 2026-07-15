import i18next from "i18next";
import { initReactI18next } from "react-i18next";

export const resources = {
  "zh-TW": {
    translation: {
      "sidebar.empty": "這個 vault 沒有筆記",
      "editor.pickNote": "選一篇筆記開始",
      "editor.loading": "載入中…",
      "backlinks.title": "反向連結",
      "backlinks.empty": "還沒有筆記連到這裡",
      "switcher.placeholder": "搜尋筆記…",
      "switcher.create": "建立筆記「{{name}}」",
      "switcher.empty": "沒有符合的筆記",
      "switcher.createFailed": "建立筆記失敗",
    },
  },
  en: {
    translation: {
      "sidebar.empty": "No notes in this vault",
      "editor.pickNote": "Pick a note to start",
      "editor.loading": "Loading…",
      "backlinks.title": "Backlinks",
      "backlinks.empty": "No notes link here yet",
      "switcher.placeholder": "Search notes…",
      "switcher.create": "Create note “{{name}}”",
      "switcher.empty": "No matching notes",
      "switcher.createFailed": "Failed to create note",
    },
  },
} as const;

void i18next.use(initReactI18next).init({
  resources,
  lng: navigator.language.startsWith("zh") ? "zh-TW" : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18next;
