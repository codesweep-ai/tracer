#!/usr/bin/env node
/**
 * run.mjs — the viewer's behavioural oracle.
 *
 * Renders the fixture sessions with bin/cs-tracer, opens the pages in a
 * Chromium and measures behaviour: structure, interaction end states, search
 * responsiveness, accessibility, keyboard reach, page size, hygiene. Every
 * measurement is compared with expectations.json:
 *
 *   status "keep"        — the measured value must equal the recorded one; any
 *                          difference fails the run.
 *   status "must-change" — the recorded value is today's baseline and `target`
 *                          names where it has to go; progress is reported, and
 *                          only `--strict` turns an unmet target into a failure.
 *
 * usage:
 *   node fixtures/run.mjs [--strict] [--update] [--fixture <key>]... [--only TF-xx,...]
 *                         [--report <file>] [--keep-pages <dir>]
 *                         [--approve <dispatch-id> --reason "<why>"]
 *
 * --update rewrites expectations.json from what was measured, under the
 * frozen-value contract: changing a keep row's value or a must-change row's
 * target needs --approve and --reason together (recorded on the row as an
 * `approval` block); a row the run could not measure is carried forward
 * verbatim; a new row is never gated — it is disclosed with an `origin`
 * (the --approve id, else the member name, and the reason).
 *
 * Browser: $TRACER_FIXTURES_BROWSER, else $CS_TRACER_CHROMIUM, else $CHROME_BIN,
 * else /usr/bin/chromium-browser. Binary: $TRACER_FIXTURES_BIN, else bin/cs-tracer.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { CHECKS, THEMES, structure, interaction, modes, keyboard, searchFreeze, hygiene } from "./checks.mjs";
import { browserExecutable, compactJson, deepEqual, diffPaths, getPath, here, meetsTarget, renderFixtures } from "./lib.mjs";

// `jump` is the event the hash-navigation check deep-links to: in a later
// chunk for the multi-chunk session, past the first screen for the others.
const FIXTURES = [
  { key: "large-session", source: "claude/v2.1/large-session", jump: 1050 },
  { key: "codex-multi-agent-run", source: "codex/v0.146/multi-agent-run", jump: 20 },
  { key: "subagent-run", source: "claude/v2.1/subagent-run", jump: 20 },
];
const EXPECTATIONS = path.join(here, "expectations.json");

// ---- arguments ---------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
const strict = flag("--strict"), update = flag("--update");
// --approve/--reason travel together or not at all: the id names the dispatch
// the operator is working under, the reason is a sentence of prose. One
// without the other is an error, before anything is measured or written.
const approveId = values("--approve")[0];
const approveReason = values("--reason")[0];
if ((approveId === undefined) !== (approveReason === undefined)) {
  console.error("--approve and --reason must be given together or not at all");
  process.exit(2);
}
const only = new Set(values("--only").flatMap((v) => v.split(",")).filter(Boolean));
const fixtureKeys = values("--fixture");
const reportPath = values("--report")[0];
const keepPages = values("--keep-pages")[0];
const fixtures = FIXTURES.filter((f) => !fixtureKeys.length || fixtureKeys.includes(f.key));
if (!fixtures.length) { console.error(`no such fixture; known: ${FIXTURES.map((f) => f.key).join(", ")}`); process.exit(2); }
const wanted = (id) => !only.size || only.has(id);

// ---- measure -----------------------------------------------------------------
const measured = {}; // id -> value (variants merged into an object keyed by variant)
const errors = []; // scenario failures, reported and fatal
const record = (triples) => { for (const [id, variant, value] of triples) { if (variant == null) measured[id] = value; else (measured[id] ??= {})[variant] = value; } };
const guard = async (label, fn) => { try { record(await fn()); } catch (error) { errors.push(`${label}: ${error.message}`); } };

const work = keepPages ? (mkdirSync(keepPages, { recursive: true }), path.resolve(keepPages)) : await mkdtemp(path.join(os.tmpdir(), "cs-tracer-fixtures-"));
const executablePath = browserExecutable();
const launch = () => chromium.launch({ executablePath, chromiumSandbox: false });

try {
  renderFixtures(fixtures, work);
  console.error(`fixtures: ${fixtures.map((f) => `${f.key} (${f.index.trajectories.length} traces, root ${f.rootId.slice(0, 8)}…)`).join(", ")}`);
  const browser = await launch();
  console.error(`chromium: ${browser.version()}${executablePath ? ` at ${executablePath}` : " (playwright managed)"}`);
  try {
    for (const fixture of fixtures) {
      for (const theme of THEMES) await guard(`${fixture.key}/${theme} structure`, () => structure(browser, fixture, theme));
      await guard(`${fixture.key} interaction`, () => interaction(browser, fixture));
      await guard(`${fixture.key} modes`, () => modes(browser, fixture));
      await guard(`${fixture.key} keyboard`, () => keyboard(browser, fixture));
      console.error(`measured ${fixture.key}`);
    }
  } finally {
    await browser.close();
  }
  const large = fixtures.find((f) => f.key === "large-session");
  if (large && wanted("TF-19")) await guard("search freeze", () => searchFreeze(launch, large));
  record(hygiene());
} finally {
  if (!keepPages) await rm(work, { recursive: true, force: true });
}

// ---- compare -----------------------------------------------------------------
const stored = existsSync(EXPECTATIONS) ? JSON.parse(readFileSync(EXPECTATIONS, "utf8")) : [];
const byId = new Map(stored.map((entry) => [entry.id, entry]));
const rows = []; const failures = [];
for (const check of CHECKS) {
  if (!wanted(check.id)) continue;
  const entry = byId.get(check.id) ?? { id: check.id, status: check.status, ...(check.target ? { target: check.target } : {}), note: check.note, value: undefined };
  const value = measured[check.id];
  const row = { id: check.id, name: check.name, status: entry.status, target: entry.target, result: "", detail: "" };
  if (value === undefined) {
    row.result = "missing"; row.detail = "not measured";
    failures.push(`${check.id} ${check.name}: not measured`);
  } else if (entry.value === undefined) {
    row.result = update ? "recorded" : "new"; row.detail = compactJson(value);
    if (!update) failures.push(`${check.id} ${check.name}: no recorded expectation (run with --update)`);
  } else if (entry.status === "keep") {
    const same = deepEqual(entry.value, value);
    row.result = same ? "ok" : "MISMATCH"; row.detail = compactJson(value);
    if (!same) {
      const diffs = diffPaths(entry.value, value);
      failures.push(`${check.id} ${check.name}: ${diffs.length} difference(s)\n${diffs.slice(0, 12).map((d) => `      ${d.path}: expected ${compactJson(d.expected, 60)} got ${compactJson(d.actual, 60)}`).join("\n")}${diffs.length > 12 ? `\n      … ${diffs.length - 12} more` : ""}`);
    }
  } else {
    const targets = Object.entries(entry.target ?? {});
    // "*.path" quantifies over the variants (fixture, fixture/theme/page …):
    // met only when every one of them meets the target.
    const progress = targets.map(([dotted, target]) => {
      if (!dotted.startsWith("*.")) return { dotted, target, now: getPath(value, dotted), met: meetsTarget(getPath(value, dotted), target) };
      const rest = dotted.slice(2);
      const each = Object.values(value ?? {}).map((variant) => getPath(variant, rest));
      return { dotted, target, now: each, met: each.length > 0 && each.every((now) => meetsTarget(now, target)) };
    });
    const met = progress.length > 0 && progress.every((p) => p.met);
    const moved = !deepEqual(entry.value, value);
    row.result = met ? "met" : "pending"; if (moved && !met) row.result = "moved";
    row.detail = progress.map((p) => `${p.dotted}=${compactJson(p.now, 24)}→${compactJson(p.target, 16)}`).join(" ");
    if (strict && !met) failures.push(`${check.id} ${check.name}: target not met (${row.detail})`);
  }
  rows.push(row);
}

// ---- report ------------------------------------------------------------------
const pad = (text, width) => String(text).padEnd(width);
console.log(`\n${pad("id", 6)} ${pad("status", 12)} ${pad("result", 9)} ${pad("check", 24)} value → target`);
for (const row of rows) console.log(`${pad(row.id, 6)} ${pad(row.status, 12)} ${pad(row.result, 9)} ${pad(row.name, 24)} ${row.detail}`);
const counts = rows.reduce((acc, row) => { acc[row.result] = (acc[row.result] ?? 0) + 1; return acc; }, {});
console.log(`\n${rows.length} checks: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}${strict ? " (strict)" : ""}`);

if (reportPath) { writeFileSync(reportPath, JSON.stringify({ measured, rows, errors }, null, 1)); console.error(`report: ${reportPath}`); }
if (update) {
  // The frozen-value contract. The gate compares what this run would WRITE
  // against what the FILE holds: a keep row's value changing, or a
  // must-change row's target changing (the runner's declared target differs
  // from the file's), needs --approve/--reason; the approved row carries its
  // own permission slip. A row the run produced no value for is carried
  // forward verbatim — value, target, approval and all — never rebuilt; one
  // that can neither be measured nor carried forward is an error. A new row
  // is not an approved write, but it is disclosed with an origin.
  const gated = [];   // changes that need --approve/--reason
  const created = []; // rows with no prior entry
  const lost = [];    // rows the run can neither measure nor carry forward
  const next = [];
  for (const check of CHECKS) {
    const prior = byId.get(check.id);
    const measuredValue = wanted(check.id) ? measured[check.id] : undefined;
    if (measuredValue === undefined) {
      if (prior) next.push(prior); // carried forward verbatim
      else lost.push(check.id);
      continue;
    }
    if (!prior) {
      // A new row is never gated and never refused for being new. Its origin
      // names the dispatch via --approve when supplied, else the member name
      // (never a placeholder); the reason is --reason when supplied, else one
      // sentence from the check's own note.
      created.push(check.id);
      next.push({ id: check.id, name: check.name, status: check.status, ...(check.target ? { target: check.target } : {}), note: check.note, value: measuredValue, origin: { id: approveId ?? "tracer", reason: approveReason ?? `Recorded by the write path; the check's intent: ${check.note}` } });
      continue;
    }
    const targetChange = check.target !== undefined && !deepEqual(prior.target, check.target);
    const valueChange = prior.status === "keep" && !deepEqual(prior.value, measuredValue);
    const row = { id: prior.id, name: check.name, status: prior.status, ...(check.target || prior.target ? { target: check.target ?? prior.target } : {}), note: prior.note, value: measuredValue };
    if (prior.approval) row.approval = prior.approval;
    if (targetChange || valueChange) {
      const change = { id: check.id, name: check.name, kind: targetChange ? "must-change target" : "keep value", previous: targetChange ? prior.target : prior.value, measured: targetChange ? check.target : measuredValue };
      if (approveId) row.approval = { id: approveId, reason: approveReason, previous: change.previous, measured: change.measured };
      else gated.push(change);
    }
    next.push(row);
  }
  // Refusal is loud and total — and only ever about gated changes or rows
  // that can be neither measured nor carried forward: nothing at all is
  // written, every offending row is named, and the command that would
  // authorise the write is printed. New rows are disclosed, never refused.
  if (lost.length || gated.length) {
    if (lost.length) console.error(`\nrefusing to write: ${lost.length} row(s) could be neither measured nor carried forward: ${lost.join(", ")}`);
    if (gated.length) {
      console.error(`\nrefusing to write: ${gated.length} gated change(s) need --approve/--reason:`);
      for (const g of gated) console.error(`  ${g.id} ${g.name}: ${g.kind} ${compactJson(g.previous, 60)} -> ${compactJson(g.measured, 60)}`);
    }
    console.error(`\nto authorise: node fixtures/run.mjs ${args.join(" ")} --approve <dispatch-id> --reason "<why this change is correct>"`);
    process.exit(1);
  }
  writeFileSync(EXPECTATIONS, `${JSON.stringify(next, null, 1)}\n`);
  console.error(`wrote ${EXPECTATIONS}`);
  for (const id of created) {
    const row = next.find((r) => r.id === id);
    console.error(`new row: ${id} (origin: ${row?.origin?.id})`);
  }
}

if (errors.length) { console.error("\nscenario errors:"); for (const e of errors) console.error(`  ${e}`); }
if (failures.length) { console.error("\nfixtures FAILED:"); for (const f of failures) console.error(`  ${f}`); }
if (errors.length || failures.length) process.exit(1);
console.log("fixtures: PASS");
