#!/usr/bin/env node
/**
 * scrub-fixtures.mjs — remove host-identifying data from fixture sessions.
 *
 * Fixtures are captured from real CLI sessions, so they carry host paths,
 * usernames, e-mail addresses and session UUIDs. This rewrites all of that, and
 * redacts conversation prose, so the corpus can be published.
 *
 * HAZARD PRESERVATION — the important part.
 *
 * Some fixtures exist precisely to pin byte-level hazards that live INSIDE
 * prose: raw U+2028/U+2029 (legal in JSON, must not be escaped), a literal
 * backslash-u003c sequence (which a naive un-escaper corrupts), a raw
 * "</script>" (which would terminate an export data block), and emoji. Blindly
 * replacing prose would delete the very thing under test and leave a green gate
 * that proves nothing.
 *
 * So redaction is hazard-preserving and GENERIC: every hazard sequence found in
 * a string is carried into its replacement, in order. No fixture is special-cased
 * by name — add a new hazard fixture and it is protected automatically.
 *
 * SCRUB ONLY THE FIXTURE YOU ADDED — pass --dir.
 *
 * Replacement text is derived from a seeded PRNG keyed by the string being
 * replaced, so the same INPUT always gives the same output. But the output is not
 * a fixed point: a scrubbed uuid is still uuid-shaped, so a second pass matches it
 * again and maps it to something new. Rerunning over the whole corpus therefore
 * rewrites every fixture with fresh identifiers and fresh prose, and every golden
 * regenerates — burying the one fixture you actually changed in 36 files of noise.
 *
 * Usage:
 *   node scripts/scrub-fixtures.mjs --dir fixtures/claude/v2.1/<name> [--dry-run]
 *
 * AFTER RUNNING THIS the goldens are stale. Regenerate them:
 *   scripts/gen-goldens.sh
 */
import { readdirSync, readFileSync, writeFileSync, statSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : null;

// Whole-corpus scrubbing is destructive in a way that is easy to do by accident
// and hard to notice: it succeeds, and the damage shows up as an enormous golden
// diff. So it must be asked for by name.
if (!only && !args.includes("--all")) {
  console.error("refusing to scrub the whole corpus without --all.\n");
  console.error("A scrubbed identifier is still identifier-shaped, so a second pass remaps it");
  console.error("again: every fixture gets fresh ids and prose, and every golden regenerates.");
  console.error("To scrub one fixture:  scripts/scrub-fixtures.mjs --dir fixtures/<cli>/<version>/<name>");
  process.exit(2);
}

const ROOTS = only ? [only] : ["fixtures/claude", "fixtures/codex", "fixtures/opencode"];

// --- hazards: sequences that must survive redaction -------------------------
const HAZARDS = [
  " ", " ",          // raw line/paragraph separators
  "\\u003c",                   // literal backslash-u003c in source text
  "</script>", "<script",      // block-terminating markup
];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

// --- deterministic PRNG ------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

const WORDS = ("the module handles input records and returns a normalized document parser reads each line " +
  "then writes output files while tests confirm expected values remain stable across runs when the build " +
  "completes successfully and the suite reports no failures for this change").split(" ");

function placeholder(source) {
  const rnd = mulberry32(seedOf(source));
  const wordCount = Math.max(3, Math.min(120, Math.round(source.split(/\s+/).length)));
  const out = [];
  for (let i = 0; i < wordCount; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  let text = out.join(" ");
  if (source.includes("\n")) text = text.replace(/ (\w+) /g, (m, w, i) => (i % 40 === 0 ? `\n${w} ` : m));
  return text;
}

// Replace prose, then re-inject every hazard sequence that was present.
function redactProse(s) {
  const present = HAZARDS.filter((h) => s.includes(h));
  const emoji = s.match(EMOJI) || [];
  let out = placeholder(s);
  for (const h of present) out += ` ${h}`;
  if (emoji.length) out += ` ${emoji.slice(0, 8).join("")}`;
  return out;
}

// --- identifier remapping ----------------------------------------------------
const idMap = new Map();
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SESID = /\bses_[0-9A-Za-z]{20,}\b/g;
const CSEID = /\bcse_[0-9A-Za-z]{20,}\b/g;
const HEXID = /\b[0-9a-f]{16,}\b/gi;

function mapId(orig, kind) {
  if (idMap.has(orig)) return idMap.get(orig);
  const rnd = mulberry32(seedOf(orig));
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
  let v;
  if (kind === "uuid") v = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
  else if (kind === "ses") v = `ses_${hex(26)}`;
  else if (kind === "cse") v = `cse_${hex(26)}`;
  else v = hex(orig.length);
  idMap.set(orig, v);
  return v;
}

// --- host-identifying data ---------------------------------------------------
// Extra names to scrub beyond the path patterns: the invoking user, plus
// anything passed as --also <name>. A bare username can appear outside any path
// (window titles, git author fields, prose), so pattern-matching paths alone is
// not sufficient — opencode stores "home/<user>/..." with NO leading slash,
// which is exactly how the first pass missed 35 occurrences.
const EXTRA_NAMES = [process.env.USER, process.env.LOGNAME]
  .concat(args.includes("--also") ? [args[args.indexOf("--also") + 1]] : [])
  .filter((n) => n && n.length > 2);

function scrubIdentity(s) {
  let out = s
    // with or without a leading slash
    .replace(/(^|[^A-Za-z0-9_])home\/[A-Za-z0-9_.-]+/g, "$1home/user")
    .replace(/(^|[^A-Za-z0-9_])Users\/[A-Za-z0-9_.-]+/g, "$1Users/user")
    // deployment roots leak internal PROJECT names even when no username is
    // present (/opt/<internal-product>), so genericise the first segment.
    .replace(/\/opt\/[A-Za-z0-9_.-]+/g, "/opt/app")
    .replace(/\/srv\/[A-Za-z0-9_.-]+/g, "/srv/app")
    .replace(/\/var\/www\/[A-Za-z0-9_.-]+/g, "/var/www/app")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com")
    .replace(/\bcodesweep-ai\b/g, "project")
    .replace(/\bcodesweep\b/gi, "project")
    .replace(/\bbox3\b/g, "host");
  for (const name of EXTRA_NAMES) {
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "user");
  }
  return out;
}

// Path SEGMENTS leak project names even after the username is gone:
// /home/<user>/<company>/<product>/... . Genericising only the user segment left
// 2,560 occurrences of private project names in `cwd`, `file_path`,
// `trackingPath` and `realParentDir`. Every segment is mapped deterministically,
// so directory structure and file extensions survive but names do not.
const segMap = new Map();
const SEG_WORDS = ["app", "core", "lib", "svc", "tools", "web", "api", "data", "docs", "src", "pkg", "mod"];
function mapSegment(seg) {
  if (/^(home|user|Users|opt|srv|var|www|tmp|etc|usr|bin|app|\.+)$/.test(seg)) return seg;
  if (segMap.has(seg)) return segMap.get(seg);
  const rnd = mulberry32(seedOf(seg));
  const ext = seg.match(/\.[A-Za-z0-9]{1,6}$/);
  const v = SEG_WORDS[Math.floor(rnd() * SEG_WORDS.length)] + "-" + Math.floor(rnd() * 90 + 10) + (ext ? ext[0] : "");
  segMap.set(seg, v);
  return v;
}
function scrubPaths(s) {
  return s.replace(/(^|[\s"'`(=:,])((?:~|\.{0,2})?\/[A-Za-z0-9_.\-/]+)/g, (m, pre, p) => {
    if (p.length < 3 || !p.includes("/")) return m;
    const lead = p.startsWith("/") ? "/" : p.startsWith("~/") ? "~/" : p.startsWith("./") ? "./" : p.startsWith("../") ? "../" : "";
    const parts = p.slice(lead.length).split("/").filter(Boolean);
    return pre + lead + parts.map(mapSegment).join("/");
  });
}

// RELATIVE paths with no leading marker — "acme-app/service/NOTES.md"
// — are missed by scrubPaths, which anchors on a leading / ~/ ./ or ../ . They
// show up as OBJECT KEYS (claude's trackedFileBackups is keyed by relative path),
// and object keys were only getting scrubIdentity, so private project names
// survived there after every other surface was clean.
function scrubKey(k) {
  const out = scrubIdentity(k);
  if (!out.includes("/") || /\s/.test(out)) return out;
  return out.split("/").map(mapSegment).join("/");
}

function scrubString(s, { prose }) {
  let out = scrubIdentity(s);
  out = scrubPaths(out);
  out = out.replace(UUID, (m) => mapId(m.toLowerCase(), "uuid"))
           .replace(SESID, (m) => mapId(m, "ses"))
           .replace(CSEID, (m) => mapId(m, "cse"))
           .replace(HEXID, (m) => mapId(m.toLowerCase(), "hex"));
  if (prose && out.trim().length > PROSE_MIN) out = redactProse(out);
  return out;
}

// FAIL SAFE: redact every long string EXCEPT keys known to be structural.
//
// This was originally an allowlist of keys believed to carry prose, and it
// leaked: `lastPrompt` was not on the list, so real prompt text — naming private
// projects — survived into committed fixtures. An allowlist of prose keys is a
// silent default for every key nobody thought of, and record formats grow.
//
// So the default is now "redact", and only keys that MUST keep their value are
// exempt: identifiers and types (behaviour depends on them), model names (cost
// depends on them), enums, and numbers/timestamps. Anything new a CLI adds is
// redacted until someone deliberately exempts it.
const STRUCTURAL_KEYS = new Set([
  "type", "role", "kind", "uuid", "id", "sessionId", "session_id", "parentUuid",
  "messageId", "promptId", "leafUuid", "snapshotMessageId", "toolUseID", "tool_use_id",
  "agentId", "bridgeSessionId", "childSessionId", "model", "version", "cliVersion",
  "mode", "permissionMode", "operation", "name", "timestamp", "ts", "cwd",
  "stop_reason", "stopReason", "status", "source", "adapter", "subtype", "level",
  // Pricing inputs. `speed` and `inferenceGeo` select the rate and the geo
  // multiplier, so redacting them silently zeroes `totals.cost`: a scrub run
  // turned speed "standard" into placeholder prose and the cost disappeared from
  // every golden, with only one unit test noticing.
  "speed", "inferenceGeo", "inference_geo", "provider", "service_tier", "serviceTier", "region",
]);

// Almost no floor: a leaked project name can be a single short word ("widget-name"
// is 11 chars), and a 30-char floor let those straight through. Structural keys are
// exempted by NAME, not by length.
const PROSE_MIN = 2;

function walk(node, key = null) {
  if (typeof node === "string") {
    const structural = key !== null && STRUCTURAL_KEYS.has(key);
    return scrubString(node, { prose: !structural });
  }
  if (Array.isArray(node)) return node.map((v) => walk(v, key));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[scrubKey(k)] = walk(v, k);
    return out;
  }
  return node;
}

// --- file processing ---------------------------------------------------------
function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

let changedFiles = 0, renamed = 0;
const targets = ROOTS.flatMap((r) => { try { return listFiles(r); } catch { return []; } });

for (const file of targets) {
  if (!/\.(jsonl|json)$/.test(file)) continue;
  const raw = readFileSync(file, "utf8");
  const isJsonl = file.endsWith(".jsonl");
  let out;
  if (isJsonl) {
    out = raw.split("\n").map((line) => {
      if (!line.trim()) return line;
      try { return JSON.stringify(walk(JSON.parse(line))); } catch { return scrubString(line, { prose: false }); }
    }).join("\n");
  } else {
    try { out = JSON.stringify(walk(JSON.parse(raw)), null, raw.includes("\n  ") ? 2 : 0); }
    catch { out = scrubString(raw, { prose: false }); }
    if (raw.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  }
  if (out !== raw) {
    changedFiles++;
    if (!dryRun) writeFileSync(file, out);
  }
}

// Rename files whose names embed a remapped identifier.
for (const file of targets) {
  const base = basename(file);
  let nb = base;
  for (const [orig, mapped] of idMap) if (nb.includes(orig)) nb = nb.split(orig).join(mapped);
  if (nb !== base) {
    renamed++;
    if (!dryRun) renameSync(file, join(dirname(file), nb));
  }
}

console.log(`${dryRun ? "[dry-run] " : ""}scrubbed ${changedFiles} file(s), renamed ${renamed}, remapped ${idMap.size} identifier(s)`);
console.log(dryRun ? "no files written" : "goldens are now STALE — regenerate: scripts/gen-goldens.sh");
