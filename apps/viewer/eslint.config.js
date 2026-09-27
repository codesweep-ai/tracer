import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  files: ["src/**/*.{ts,tsx}"],
  plugins: { "react-hooks": reactHooks },
  rules: {
    "no-restricted-syntax": ["error", "JSXAttribute[name.name='dangerouslySetInnerHTML']"],
    ...reactHooks.configs.recommended.rules,
    "react-hooks/refs": "off",
    "react-hooks/set-state-in-effect": "off",
  },
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
  files: ["scripts/**/*.mjs", "fixtures/**/*.mjs", "*.config.ts", "*.config.js"],
  languageOptions: { globals: { ...globals.node, ...globals.browser } },
});
