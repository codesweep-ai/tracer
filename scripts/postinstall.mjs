// Makes `npm ci && npm run build && npm test` work from a fresh clone, by installing
// the dependencies of the sub-project a root `npm ci` does NOT cover:
//
//  1. fixtures/test/  — the schema-conformance harness run by `npm test` (ajv also
//     hoists to the root, but installing here is explicit and future-proof).
//
// The design system needs no install step here: @codesweep-ai/ui is an ordinary
// registry dependency, pinned to one exact version, and the workspace install
// covers it.
//
// Idempotent + best-effort: a missing/absent target is warned and skipped (exit 0), never
// fatal — a normalizer-only checkout that never builds the viewer still installs cleanly.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Install deps in `dir` iff it exists and has no node_modules yet. */
function ensureInstalled(dir, label, { required }) {
  if (!existsSync(dir)) {
    console.warn(`[postinstall] ${label} not found at ${dir} — skipping.${required ? " The viewer build needs it." : ""}`);
    return;
  }
  if (existsSync(path.join(dir, "node_modules"))) return; // already installed
  const hasLock = existsSync(path.join(dir, "package-lock.json"));
  console.log(`[postinstall] installing ${label} deps in ${dir} (${hasLock ? "npm ci" : "npm install"})…`);
  const res = spawnSync("npm", [hasLock ? "ci" : "install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", env: process.env });
  if (res.status !== 0) console.warn(`[postinstall] ${label} install exited ${res.status}.`);
}

ensureInstalled(path.join(repoRoot, "fixtures", "test"), "fixtures test harness", { required: false });
process.exit(0);
