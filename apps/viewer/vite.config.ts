import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { block, injectBlocks } from "./scripts/assemble.mjs";
import { uiVersion } from "./scripts/uiVersion.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const reactDir = path.dirname(require.resolve("react/package.json"));
const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));

// Dev-only: the export transport reads DOM data blocks, not fetch(), so the
// demo trace-cache under public/ is injected into index.html as blocks when
// serving. The export builds (vite.single/split.config.ts) do NOT do this —
// their shells must stay data-free for the export assembler.
function demoDataBlocks(): Plugin {
  const cache = path.join(root, "public", "trace-cache");
  const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(cache, ...parts), "utf8")) as { trajectories?: Array<{ id: string; path: string }> };
  const index = read("index.json");
  const blocks = [block("mode", { mode: "single" }), block("index", index)];
  for (const { id, path: dir } of index.trajectories ?? []) {
    blocks.push(block(`s-${id}`, read(dir, "summary.json")));
    const summary = read(dir, "summary.json") as { chunkCount?: number };
    for (let n = 0; n < (summary.chunkCount ?? 0); n++) blocks.push(block(`c-${id}-${String(n).padStart(3, "0")}`, read(dir, "chunks", `${String(n).padStart(3, "0")}.json`)));
  }
  return { name: "demo-data-blocks", apply: "serve", transformIndexHtml: (html) => injectBlocks(html, blocks) };
}



export default defineConfig({
  define: { __UI_VERSION__: JSON.stringify(uiVersion()) },
  plugins: [react(), demoDataBlocks()],
  resolve: { alias: { react: reactDir, "react-dom": reactDomDir }, dedupe: ["react", "react-dom"] },
});
