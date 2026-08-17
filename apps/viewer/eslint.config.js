import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import codesweep from "@codesweep-ai/eslint-plugin";

const designRules = Object.fromEntries(Object.keys(codesweep.rules).map((name) => [`@codesweep-ai/${name}`, "error"]));

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  files: ["src/**/*.{ts,tsx}"],
  plugins: { react, "react-hooks": reactHooks, "@codesweep-ai": codesweep },
  settings: { react: { version: "18.3" } },
  rules: { ...designRules, "@codesweep-ai/no-unknown-token": ["error", { tokenSource: "../../vendor/codesweep-ui/src/styles/tokens.css" }], "react/no-danger": "error", ...reactHooks.configs.recommended.rules },
}, {
  // Plain-JS test files (assemble.test.mjs) run in vitest's jsdom environment;
  // `document`/`window` exist there and TS scoping rules do not apply.
  files: ["src/**/*.test.mjs"],
  languageOptions: { globals: { document: "readonly", window: "readonly", location: "readonly", history: "readonly" } },
}, {
  // Build/gate scripts and the vite configs run under Node — and parity.mjs
  // additionally contains page.evaluate() bodies, whose browser globals eslint
  // sees as ordinary references. Without this block these files were simply not
  // linted: `eslint src` never reached them.
  files: ["scripts/**/*.mjs", "*.config.ts", "*.config.js"],
  languageOptions: { globals: { ...globals.node, ...globals.browser } },
});
