import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { createRequire } from "node:module";
import { uiVersion } from "./scripts/uiVersion.mjs";

// build:single — the --single export shell (SPEC.md §5): JS and CSS inlined into
// ONE index.html, no src= on the script tag, no crossorigin, no absolute paths,
// no dynamic import(. Emitted inside the Go module tree so //go:embed can reach
// it. The export assembler injects the data blocks into this shell.
const require = createRequire(import.meta.url);
const reactDir = path.dirname(require.resolve("react/package.json"));
const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  define: { __UI_VERSION__: JSON.stringify(uiVersion()) },
  // public/ holds dev-only demo data (and a stale trace-cache); it must NOT be
  // copied alongside the "single" file.
  publicDir: false,
  plugins: [
    react(),
    viteSingleFile({ removeViteModuleLoader: true }),
    // vite-plugin-singlefile inlines everything but leaves the crossorigin
    // attribute on the inline script/style tags; CORS mode is meaningless and
    // forbidden on an inline tag, and the build assertion checks it.
    { name: "strip-crossorigin", enforce: "post", transformIndexHtml(html) { return html.replace(/\s+crossorigin/g, ""); } },
  ],
  resolve: { alias: { react: reactDir, "react-dom": reactDomDir }, dedupe: ["react", "react-dom"] },
  build: {
    outDir: "../../internal/cli/viewer/single",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // nothing spills out as a sibling asset (logo.png inlines as a data URI)
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
