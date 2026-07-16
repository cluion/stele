import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "prototypes/**", "**/*.mjs", "**/*.cjs"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      // Y.Text 有自訂 toString,規則從型別宣告看不出來
      "@typescript-eslint/no-base-to-string": ["error", { ignoredTypeNames: ["Text", "YText", "Error"] }],
    },
  },
  {
    // 伺服器入口:啟動訊息走 stdout 是常規
    files: ["apps/server/src/main.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // main.ts 一半是 smoke 測試工具:console.log 是輸出機制、executeJavaScript 天生回傳 any
    files: ["apps/desktop/src/main/main.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.tsx", "apps/desktop/src/renderer/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["**/test/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
