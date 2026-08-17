#!/usr/bin/env node
/**
 * schema-conformance.mjs — every document tracer produces must validate against
 * schema/trajectory.v1.json.
 *
 * PART 1: the published sample under schema/example/ validates against the
 *         sharded-layout $defs — index, summary, chunk.
 * PART 2: round-trip — each sample trajectory's summary metadata plus its
 *         concatenated chunk events (in index order) reconstructs a document
 *         valid against the TOP-LEVEL schema. Sharded and whole forms must
 *         describe the same thing.
 * PART 3: every committed oracle document validates.
 * PART 4: output produced by the CURRENT build validates. Parts 3 and 4 differ
 *         on purpose — see the note above checkRuntime.
 *
 * Deps: ajv, scoped to fixtures/test (`cd fixtures/test && npm install`).
 * Exit: 1 on any validation failure, 0 otherwise.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SCHEMA_PATH = join(ROOT, "schema/trajectory.v1.json");
const EXAMPLE_DIR = join(ROOT, "schema/example");
const FIXTURES_DIR = join(ROOT, "fixtures");

let failures = 0;
let skips = 0;
function fail(msg) {
  failures++;
  console.log(`  FAIL ${msg}`);
}
function pass(msg) {
  console.log(`  PASS ${msg}`);
}
function skip(msg) {
  skips++;
  console.log(`  SKIP ${msg}`);
}

async function loadAjv() {
  try {
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    return new Ajv2020({ allErrors: true, strict: false });
  } catch {
    console.error("ajv not installed for fixtures/test — run: cd fixtures/test && npm install");
    process.exit(2);
  }
}

function fmtErrs(validate) {
  return (validate.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// PART 1 + 2: published sharded sample
// ---------------------------------------------------------------------------
function checkExample(ajv, schema) {
  console.log("PART 1: published sample validates against sharded-layout $defs");
  const vIndex = ajv.getSchema(schema.$id + "#/$defs/index");
  const vSummary = ajv.getSchema(schema.$id + "#/$defs/summary");
  const vChunk = ajv.getSchema(schema.$id + "#/$defs/chunk");
  const vDoc = ajv.getSchema(schema.$id);

  const index = JSON.parse(readFileSync(join(EXAMPLE_DIR, "index.json"), "utf8"));
  if (!vIndex(index)) return fail(`example/index.json: ${fmtErrs(vIndex)}`);
  pass("example/index.json vs $defs/index");

  for (const t of index.trajectories) {
    const dir = join(EXAMPLE_DIR, t.path);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    if (!vSummary(summary)) {
      fail(`example/${t.path}/summary.json: ${fmtErrs(vSummary)}`);
      continue;
    }
    pass(`example/${t.path}/summary.json vs $defs/summary`);

    const chunks = readdirSync(join(dir, "chunks"))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const events = [];
    for (const cf of chunks) {
      const chunk = JSON.parse(readFileSync(join(dir, "chunks", cf), "utf8"));
      if (!vChunk(chunk)) {
        fail(`example/${t.path}/chunks/${cf}: ${fmtErrs(vChunk)}`);
        continue;
      }
      events.push(...chunk.events);
    }
    pass(`example/${t.path}/chunks (${chunks.length}) vs $defs/chunk`);

    // PART 2: round-trip — summary metadata + concatenated events == top-level doc
    events.sort((a, b) => a.i - b.i);
    const doc = {
      schemaVersion: summary.schemaVersion,
      meta: summary.meta,
      totals: summary.totals,
      events,
      parse: summary.parse,
      ...(summary.links ? { links: summary.links } : {}),
    };
    if (!vDoc(doc)) fail(`example/${t.path} round-trip document: ${fmtErrs(vDoc)}`);
    else pass(`example/${t.path} round-trip document vs top-level schema`);
  }
}

// ---------------------------------------------------------------------------
// PART 3: every committed oracle document
//
// The corpus's normalized output is committed under oracle/, so this validates
// those bytes directly rather than re-normalizing — the exact bytes the gates
// diff against.
// ---------------------------------------------------------------------------
function checkOracle(ajv, schema) {
  console.log("PART 3: every committed oracle document validates against the schema");
  const oracleDir = join(ROOT, "oracle");
  if (!existsSync(oracleDir)) { skip("oracle/ not present"); return; }
  const summaryV = ajv.getSchema(schema.$id + "#/$defs/summary");
  const chunkV = ajv.getSchema(schema.$id + "#/$defs/chunk");
  const indexV = ajv.getSchema(schema.$id + "#/$defs/index");
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json")) continue;
      const doc = JSON.parse(readFileSync(p, "utf8"));
      const rel = p.slice(oracleDir.length + 1);
      if (e.name === "summary.json") {
        if (summaryV(doc)) { n++; } else { fail(`${rel} vs $defs/summary: ${ajv.errorsText(summaryV.errors)}`); }
      } else if (dir.endsWith("chunks")) {
        if (chunkV(doc)) { n++; } else { fail(`${rel} vs $defs/chunk: ${ajv.errorsText(chunkV.errors)}`); }
      } else if (e.name === "index.json") {
        // index.json carries the --links merge; without this it was never validated
        if (indexV(doc)) { n++; } else { fail(`${rel} vs $defs/index: ${ajv.errorsText(indexV.errors)}`); }
      }
    }
  };
  walk(oracleDir);
  // A validator that passes because it found nothing is worse than no validator.
  if (n === 0) { fail("oracle/ contained no validatable documents — gate would pass vacuously"); return; }
  console.log(`  PASS ${n} oracle documents validate`);
}

// ---------------------------------------------------------------------------
// PART 4: validate what the TOOL PRODUCES RIGHT NOW, not what is committed.
//
// PART 3 validates oracle/, which is generated BY cs-tracer — so a broken golden
// validates happily against a schema it was shaped by. This normalizes fixtures
// fresh with the current binary and validates that output instead. It is the one
// check here that a golden regeneration cannot satisfy, which matters because the
// goldens are produced by the tool they describe.
// ---------------------------------------------------------------------------
function checkRuntime(ajv, schema) {
  console.log("PART 4: freshly produced output validates against the schema");
  const bin = join(ROOT, "bin", "cs-tracer");
  if (!existsSync(bin)) { skip("no bin/cs-tracer — run: make build"); return; }
  const summaryV = ajv.getSchema(schema.$id + "#/$defs/summary");
  const chunkV = ajv.getSchema(schema.$id + "#/$defs/chunk");
  const indexV = ajv.getSchema(schema.$id + "#/$defs/index");
  const tmp = mkdtempSync(join(tmpdir(), "cs-tracer-schema-"));
  let n = 0;
  try {
    for (const fixture of ["claude/v2.1/simple", "claude/v2.1/large-session", "codex/v0.146/tool-heavy", "opencode/v1.18/tool-heavy"]) {
      const src = join(ROOT, "fixtures", fixture);
      if (!existsSync(src)) continue;
      const out = join(tmp, fixture.replace(/\//g, "_"));
      execFileSync(bin, ["normalize", src, "--out", out], { stdio: "pipe" });
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!entry.name.endsWith(".json")) continue;
          const doc = JSON.parse(readFileSync(full, "utf8"));
          const validator = entry.name === "index.json" ? indexV : entry.name === "summary.json" ? summaryV : chunkV;
          if (!validator(doc)) fail(`${fixture}/${entry.name}: ${ajv.errorsText(validator.errors)}`);
          else n++;
        }
      };
      walk(out);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  pass(`${n} freshly produced documents validate`);
}

// ---------------------------------------------------------------------------
async function main() {
  const ajv = await loadAjv();
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  ajv.addSchema(schema);
  checkExample(ajv, schema);
  checkOracle(ajv, schema);
  checkRuntime(ajv, schema);
  console.log(`\nschema-conformance: ${failures} failed, ${skips} skipped`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
