// The design-system version the viewer was built against, for the provenance
// footer (__UI_VERSION__). One helper shared by the three vite configs, which
// used to each carry a pasted copy of this lookup. The workspace hoists
// node_modules to the repository root, so look upward from apps/viewer.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function uiVersion() {
  for (const dir of [viewerRoot, path.join(viewerRoot, ".."), path.join(viewerRoot, "..", "..")]) {
    try { return JSON.parse(readFileSync(path.join(dir, "node_modules/@codesweep-ai/ui/package.json"), "utf8")).version; } catch { /* keep looking */ }
  }
  return "unknown";
}
