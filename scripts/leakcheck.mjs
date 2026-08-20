#!/usr/bin/env node
/**
 * leakcheck.mjs — refuse to commit host-identifying data.
 *
 * Fixtures are captured from real sessions, the goldens are derived from them,
 * and issue records quote commits, paths and findings. All of it is checked in.
 * A scrub pass needed SIX iterations to get clean, and each round only became
 * visible after the previous one was fixed — that is the shape of thing that
 * must be a gate rather than a habit.
 *
 * WHY THERE IS NO LIST OF FORBIDDEN WORDS.
 *
 * The obvious implementation is a committed denylist of private terms. That file
 * would itself be a disclosure — it publishes exactly what you consider private,
 * and it is the first thing a curious reader opens. It also rots: every new
 * project name has to be remembered.
 *
 * So these patterns catch the CLASS, not the instance. A username is "the
 * segment after /home/ that is not a placeholder", never a specific name. That
 * covers anyone's machine, needs no maintenance, and naturally permits the
 * legitimate appearances a name-based list would keep tripping over —
 * `codesweep` is in the Go module path on nearly every file.
 *
 * The invoking user's own name is added at RUNTIME from the environment, so it
 * is checked without ever being written down.
 *
 * Usage: node scripts/leakcheck.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// Generated pages embed their whole payload on one line; report a bounded
// excerpt rather than dumping it.
const excerpt = (line, index) => {
  const start = Math.max(0, index - 40);
  return (start > 0 ? "…" : "") + line.slice(start, index + 60).replace(/\s+/g, " ") + "…";
};

// Logins that are a placeholder or the account an image ships under, rather
// than a person. Kept in step with oss.homeAllow in .cs-lint.yaml, which
// allows the same four for the same reason. CI is why the set has to be
// more than "user": a GitHub-hosted runner logs in as `runner`, so the runtime
// pattern below turned every ordinary use of that word — "what a runner cannot
// do", node_modules/@vitest/runner — into a leak, and the gate failed on a
// clean tree. Every name here is one this check stops catching, so add a
// placeholder or a shipped account, and never a name that is somebody's.
const PLACEHOLDERS = ["user", "you", "name", "runner"];
const NOT_A_PERSON = `(?!(?:${PLACEHOLDERS.join("|")})\\b)`;

const PATTERNS = [
  // A home directory belonging to someone.
  { re: new RegExp(`(?:^|[^A-Za-z0-9_])/?home/${NOT_A_PERSON}([A-Za-z0-9_.-]+)`, "g"), what: "a home directory naming a user" },
  { re: new RegExp(`/Users/${NOT_A_PERSON}([A-Za-z0-9_.-]+)`, "g"), what: "a macOS home directory naming a user" },
  // Real e-mail addresses. example.com/example.org are the documentation domains.
  { re: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, what: "an e-mail address" },
  // Absolute paths into per-user state, which leak a username even when the
  // /home/ prefix has been rewritten (this is how a browser path reached a
  // committed manifest).
  { re: new RegExp(`/(?:home|Users)/${NOT_A_PERSON}[A-Za-z0-9_.-]+/\\.(cache|claude|config|local|ssh)\\b`, "g"), what: "an absolute path into per-user state" },
];

// The invoking user, from the environment — never committed to this file.
for (const name of [process.env.USER, process.env.LOGNAME]) {
  if (name && name.length > 2 && !PLACEHOLDERS.includes(name.toLowerCase())) {
    PATTERNS.push({
      re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
      what: "the invoking user's name",
    });
  }
}

// Optional, gitignored: project names no pattern can infer. Absent by default —
// added only when a real term needs it, so the list never lands in the repo.
try {
  for (const term of readFileSync(`${ROOT}/.leakterms`, "utf8").split("\n")) {
    const t = term.trim();
    if (t && !t.startsWith("#")) {
      PATTERNS.push({ re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), what: "a term from .leakterms" });
    }
  }
} catch { /* absent is the normal case */ }

// Every TRACKED file: leaks have appeared in fixtures, in goldens derived from
// them, in a committed parity manifest, in docs, and in a script with a
// hard-coded path. Narrowing the scope is how the second round survived the first.
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((f) => !f.startsWith("node_modules/"));

// This file necessarily contains the patterns it searches for.
const SELF = "scripts/leakcheck.mjs";

// Binary files cannot be scanned, so "not inspected" must never be reported as
// "clean" — a committed vim swap file smuggled a username past this check
// exactly that way. Anything binary must be an expected asset type; anything
// else fails, because it is unreviewable by definition.
const BINARY_ALLOWED = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$/i;
const uninspectable = [];

for (const file of files) {
  if (file === SELF) continue;
  // Extension decides FIRST. Skipping on "contains a NUL byte" looked sensible
  // and was wrong: ledger.html embeds one, so the generated page carrying every
  // issue's text — a prime leak surface — was being skipped as though binary.
  // Known asset types are skipped by name; everything else is scanned as text,
  // stray bytes and all, because the patterns match regardless.
  if (BINARY_ALLOWED.test(file)) continue;
  let text;
  try {
    if (statSync(`${ROOT}/${file}`).size > 40 * 1024 * 1024) continue;
    text = readFileSync(`${ROOT}/${file}`, "utf8");
  } catch {
    uninspectable.push(file);
    continue;
  }

  for (const { re, what } of PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    const lineStart = before.lastIndexOf("\n") + 1;
    problems.push(`${file}:${line}: ${what} — ${excerpt(text.slice(lineStart, lineStart + 4000), m.index - lineStart)}`);
    break; // one report per file is enough to act on
  }
}

for (const file of uninspectable) {
  problems.push(`${file}: unreadable as text, so its contents cannot be checked — remove it, or add its extension to BINARY_ALLOWED if it is a legitimate asset`);
}

if (problems.length) {
  console.error("leakcheck FAILED — host-identifying data in tracked files:");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nFixtures: re-run scripts/scrub-fixtures.mjs, then regenerate goldens.");
  console.error("Anything else: remove it, or add a term to .leakterms (gitignored) if it is a false positive.");
  process.exit(1);
}
console.log(`leakcheck: ${files.length} tracked files carry no home paths, e-mail addresses or user names`);
