import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// build:split — the --split export shell (SPEC.md §5): a shared
// assets/app.js + assets/app.css referenced RELATIVELY, written once per output
// directory instead of inlining ~320 kB into every trace page. The script tag
// must be CLASSIC, not type="module": a fetched module script is CORS-restricted
// and blocked under file://, while a relative classic <script src> loads fine.
// The bundle is therefore built as an IIFE with no import/export/import.meta.
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const reactDir = path.dirname(require.resolve("react/package.json"));
const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  base: "./", // index.html references ./assets/app.js; the exporter rewrites to ../assets/ for traces/*.html
  publicDir: false,
  plugins: [
    react(),
    {
      name: "classic-relative-shell",
      enforce: "post",
      transformIndexHtml(html) {
        // Module scripts are deferred by default; classic scripts are NOT. The
        // tag must gain `defer` when losing type="module", or app.js executes
        // before <body> is parsed and createRoot finds no #root.
        return html
          .replace(/\s+crossorigin/g, "")
          .replace('<script type="module"', "<script defer");
      },
    },
  ],
  resolve: { alias: { "@codesweep-ai/ui": path.resolve(root, "../../vendor/codesweep-ui/src"), react: reactDir, "react-dom": reactDomDir }, dedupe: ["react", "react-dom"] },
  build: {
    outDir: "../../internal/cli/viewer/split",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // logo.png inlines into app.js as a data URI
    cssCodeSplit: false, // one shared app.css, not per-chunk fragments
    rollupOptions: {
      output: {
        format: "iife", // classic script: no import/export statements, loadable from file://
        inlineDynamicImports: true, // one chunk; no dynamic import( to fail under file://
        entryFileNames: "assets/app.js", // stable names — the exporter and §3.3 reference them
        assetFileNames: (assetInfo) => (assetInfo.names?.some((name) => name.endsWith(".css")) ? "assets/app.css" : "assets/[name][extname]"),
      },
    },
  },
});
