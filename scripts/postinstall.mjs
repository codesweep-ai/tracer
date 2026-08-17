// Makes `npm ci && npm run build && npm test` work from a fresh clone, by installing
// the dependencies of the two sub-projects a root `npm ci` does NOT cover:
//
//  1. vendor/codesweep-ui — the design-system subset, consumed by apps/viewer as a
//     `file:` dep. npm *links* a directory `file:` dep but does NOT install the linked
//     package's own deps, and the subset ships raw TS importing react/lucide/clsx, so
//     `npm run build` (which type-checks and bundles that source) needs it installed.
//  2. fixtures/test/  — the schema-conformance harness run by `npm test` (ajv also
//     hoists to the root, but installing here is explicit and future-proof).
//
// Idempotent + best-effort: a missing/absent target is warned and skipped (exit 0), never
// fatal — a normalizer-only checkout that never builds the viewer still installs cleanly.
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
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

/** a root `npm ci` hoists apps/viewer's `file:../../vendor/codesweep-ui` deps to
 * node_modules/@codesweep-ai/ but writes each symlink target relative to the WORKSPACE
 * dir, so the hoisted links dangle (one level short of the real target).
 * Vite/Vitest resolve the package by path and never consult the link; `npm run lint`
 * does, and dies with ERR_MODULE_NOT_FOUND. Repair any dangling @codesweep-ai/* link
 * whose real target exists (idempotent; correct links are left untouched).
 * the removal must be `unlinkSync`, not `rmSync` — on Node >= 22 `rmSync`
 * resolves a DANGLING symlink to ENOENT and returns success WITHOUT unlinking it, so
 * the following `symlinkSync` died with EEXIST and took `npm ci` down with it. */
function repairScopedLinks() {
  const vendor = path.join(repoRoot, "vendor");
  const links = {
    ui: path.join(vendor, "codesweep-ui"),
    "eslint-plugin": path.join(vendor, "codesweep-eslint-plugin"),
  };
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(repoRoot, "node_modules", "@codesweep-ai", name);
    let dangling;
    try { dangling = lstatSync(link).isSymbolicLink() && !existsSync(link); } catch { continue; }
    if (!dangling) continue;
    if (!existsSync(target)) { console.warn(`[postinstall] ${link} dangles and ${target} is absent — skipping.`); continue; }
    unlinkSync(link);
    symlinkSync(path.relative(path.dirname(link), target), link);
    console.log(`[postinstall] repaired dangling @codesweep-ai/${name} symlink -> ${target}.`);
  }
}

ensureInstalled(path.join(repoRoot, "vendor", "codesweep-ui"), "design system (@codesweep-ai/ui)", { required: true });
ensureInstalled(path.join(repoRoot, "fixtures", "test"), "fixtures test harness", { required: false });
repairScopedLinks();
process.exit(0);
