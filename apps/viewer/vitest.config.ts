import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const reactDir = path.dirname(require.resolve("react/package.json"));
const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));
export default defineConfig({ resolve: { alias: { "@codesweep-ai/ui": path.resolve(root, "../../ui/codesweep-ui/src"), react: reactDir, "react-dom": reactDomDir }, dedupe: ["react", "react-dom"] }, test: { environment: "jsdom", setupFiles: "./src/test/setup.ts", css: true } });
