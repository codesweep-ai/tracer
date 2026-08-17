#!/usr/bin/env node
/**
 * fixtures/synthetic/generate.mjs — deterministic 50k-event synthetic fixture generator.
 *
 * Emits a Claude-Code-format JSONL session tree (root session + sub-agent sidechain
 * files + .meta.json sidecars — the on-disk layout described in fixtures/README.md)
 * sized to a fixed budget of *planned normalized events* (default 50,000 across the
 * tree). It is the scale vehicle: it flows through the real claude-code adapter like
 * any captured session.
 *
 * Determinism (hard requirement — performance tests must be stable):
 *   - all randomness comes from one seeded mulberry32 PRNG (no Math.random);
 *   - all timestamps derive from a fixed base time (BASE_MS below), never Date.now();
 *   - UUIDs, message IDs, tool-use IDs, signatures are PRNG-derived;
 *   - object keys are inserted in a fixed order so JSON.stringify output is stable.
 * Same seed + same args => byte-identical output. The summary line printed at the end
 * includes a SHA-256 over all written bytes; run twice and compare to verify.
 *
 * Event accounting (what counts toward the budget, mirroring the adapter's mapping):
 *   user text record -> 1 user event; assistant thinking block -> 1 thinking event;
 *   assistant text block -> 1 assistant event; assistant tool_use block -> 1 tool_call
 *   event; tool_result record -> 0 (paired onto its call); system/turn_duration record
 *   -> 1 turn_end event; head sidecar records (mode/permission-mode) -> 0 (skipped).
 *
 * Usage:
 *   node fixtures/synthetic/generate.mjs [--seed N] [--events N] [--children N] [--out DIR]
 * Defaults: --seed 20260801 --events 50000 --children 6 --out fixtures/synthetic/claude-50k
 *
 * The multi-MB raw output is gitignored (fixtures/synthetic/.gitignore); regenerate in
 * build/test steps. Only this generator (and its default seed) is committed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    seed: 20260801,
    events: 50000,
    children: 6,
    out: join(__dirname, "claude-50k"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--seed") args.seed = Number(next());
    else if (a === "--events") args.events = Number(next());
    else if (a === "--children") args.children = Number(next());
    else if (a === "--out") args.out = resolve(next());
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node generate.mjs [--seed N] [--events N] [--children N] [--out DIR]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  for (const k of ["seed", "events", "children"]) {
    if (!Number.isInteger(args[k]) || args[k] < 0) {
      console.error(`--${k} must be a non-negative integer, got ${args[k]}`);
      process.exit(2);
    }
  }
  if (args.events < args.children * 10) {
    console.error("--events too small for the requested tree");
    process.exit(2);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — the ONLY randomness source in this file.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(1); // placeholder, rebound in main()
let rand = rnd;
function randint(lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(rand() * 16)];
  return s;
}
function uuid() {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
}
function msgId() {
  return `msg_${hex(20)}`;
}
function toolUseId() {
  return `toolu_01${hex(20)}`;
}
function b64(bytes) {
  let s = "";
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < bytes; i++) s += alpha[Math.floor(rand() * 64)];
  return s + "==";
}

// ---------------------------------------------------------------------------
// Fixed base time — never Date.now().
// ---------------------------------------------------------------------------
const BASE_MS = Date.UTC(2026, 7, 1, 9, 0, 0, 0); // 2026-08-01T09:00:00.000Z

// ---------------------------------------------------------------------------
// Deterministic text generation
// ---------------------------------------------------------------------------
const WORDS = (
  "index render chunk summary strip lane event token cache shard adapter schema parse " +
  "record session trajectory viewer server browser canvas scroll window virtual filter " +
  "theme palette tooltip legend badge cost model prompt tool result error warning drift " +
  "version fixture corpus provenance sanitize nested spawn child parent root tree walker " +
  "join key envelope payload reasoning thinking assistant user system boundary tick hash " +
  "seed deterministic random jitter byte size budget paint frame lazy fetch deep link " +
  "normalize validate conform contract workspace package build smoke gate verify report"
).split(" ");
const VERBS = ["processes", "renders", "validates", "fetches", "normalizes", "caches", "streams", "pairs", "dedupes", "walks", "spawns", "joins", "shards", "serves"];
const OBJECTS = ["the chunk range", "event strip", "summary document", "parse report", "tool result", "sidechain file", "token usage", "lane rollup", "turn boundary", "link hint", "schema draft", "fixture corpus"];
const LEVELS = ["INFO", "INFO", "INFO", "DEBUG", "WARN"];

function sentence() {
  const n = randint(6, 13);
  const words = [];
  for (let i = 0; i < n; i++) words.push(pick(WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  if (rand() < 0.35) words.splice(randint(1, n - 2), 0, pick(VERBS));
  return words.join(" ") + pick([".", ".", ".", "?"]);
}
function paragraph() {
  const n = randint(1, 3);
  return Array.from({ length: n }, sentence).join(" ");
}
function thinkingText() {
  return `Let me think about how to ${pick(VERBS)} ${pick(OBJECTS)}. ${sentence()} ${sentence()}`;
}
function userPrompt(k) {
  return `Step ${k}: please ${pick(VERBS)} ${pick(OBJECTS)}, then ${pick(VERBS)} ${pick(OBJECTS)}. ${sentence()}`;
}
function assistantText() {
  return `I'll ${pick(VERBS)} ${pick(OBJECTS)} first. ${paragraph()}`;
}
/** Deterministic large tool output: build-log style lines until ~targetBytes. */
function largeOutput(targetBytes) {
  const lines = [];
  let bytes = 0;
  const total = randint(400, 900);
  let i = 0;
  while (bytes < targetBytes) {
    i = (i + 1) % total;
    const ts = new Date(BASE_MS + randint(0, 3600_000)).toISOString();
    lines.push(
      `[${ts}] [worker-${randint(0, 7)}] ${pick(LEVELS)} processed shard ${i}/${total} ` +
        `(${(rand() * 40 + 2).toFixed(1)} MB/s, eta ${randint(0, 4)}:${String(randint(0, 59)).padStart(2, "0")}) ` +
        `checksum=${hex(8)} ${pick(WORDS)}_${pick(WORDS)}.log`
    );
    bytes += lines[lines.length - 1].length + 1;
  }
  return lines.join("\n");
}
function mediumOutput() {
  const n = randint(15, 60);
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      `-rw-r--r-- 1 user user ${randint(400, 98000)} Aug  1 ${String(randint(0, 23)).padStart(2, "0")}:${String(randint(0, 59)).padStart(2, "0")} ${pick(WORDS)}_${pick(WORDS)}.${pick(["ts", "json", "md", "mjs"])}`
    );
  }
  return lines.join("\n");
}
function smallOutput() {
  return pick([
    "(Bash completed with no output)",
    sentence(),
    `${randint(2, 40)} files matched.`,
    `ok`,
    paragraph(),
  ]);
}
const ERROR_OUTPUTS = [
  "cat: /nope/missing.txt: No such file or directory",
  "Error: ENOENT: no such file or directory, open '/home/user/synth-project/dist/out.json'",
  "npm error code ELIFECYCLE\nnpm error errno 1",
  "SyntaxError: Unexpected token '}', <anonymous>:14:2",
  "grep: unrecognized option '--frobnicate'",
];

// ---------------------------------------------------------------------------
// Tool call shapes
// ---------------------------------------------------------------------------
const TOOL_SPECS = [
  { name: "Bash", weight: 38, input: () => ({ command: `${pick(["ls -la", "cat", "rg", "npm run", "node", "git status --", "wc -l"])} ${pick(WORDS)}_${pick(WORDS)}.${pick(["ts", "json", "log", "md"])}` }) },
  { name: "Read", weight: 20, input: () => ({ file_path: `/home/user/synth-project/src/${pick(WORDS)}-${pick(WORDS)}.ts` }) },
  { name: "Edit", weight: 12, input: () => ({ file_path: `/home/user/synth-project/src/${pick(WORDS)}.ts`, old_string: sentence(), new_string: sentence() }) },
  { name: "Write", weight: 8, input: () => ({ file_path: `/home/user/synth-project/docs/${pick(WORDS)}.md`, content: paragraph() }) },
  { name: "Grep", weight: 10, input: () => ({ pattern: `${pick(WORDS)}|${pick(WORDS)}`, path: "src" }) },
  { name: "Glob", weight: 6, input: () => ({ pattern: `**/*.${pick(["ts", "json", "md"])}` }) },
  { name: "WebFetch", weight: 6, input: () => ({ url: `https://example.com/${pick(WORDS)}/${pick(WORDS)}`, prompt: sentence() }) },
];
function pickToolSpec() {
  const total = TOOL_SPECS.reduce((s, t) => s + t.weight, 0);
  let x = rand() * total;
  for (const t of TOOL_SPECS) {
    x -= t.weight;
    if (x <= 0) return t;
  }
  return TOOL_SPECS[0];
}

// ---------------------------------------------------------------------------
// Session builder — emits Claude-Code JSONL records, counting planned events.
// ---------------------------------------------------------------------------
const VERSION = "2.1.220";
const CWD = "/home/user/synth-project";

class SessionBuilder {
  /**
   * @param {object} o
   * @param {string[]} o.lines  output line sink
   * @param {string} o.sessionId  root session uuid (shared by sidechains)
   * @param {string|null} o.agentId  set for sub-agent sidechain files
   * @param {number} o.budget  planned normalized events to emit
   * @param {number} o.clock  mutable start time (ms)
   * @param {Map<string,object>} [o.pendingSpawns]  root only: child agentId -> spawn meta
   * @param {number[]} [o.spawnThresholds]  root only: event counts at which to spawn
   */
  constructor(o) {
    this.lines = o.lines;
    this.sessionId = o.sessionId;
    this.agentId = o.agentId ?? null;
    this.sidechain = o.agentId != null;
    this.budget = o.budget;
    this.clock = o.clock;
    this.pendingSpawns = o.pendingSpawns ?? null;
    this.spawnThresholds = o.spawnThresholds ?? null;
    this.used = 0; // planned normalized events emitted
    this.toolCalls = 0; // raw tool_use count (for large/error scheduling)
    this.parentUuid = null;
    this.promptCounter = 0;
    this.largeOutputs = 0;
  }

  tick(lo, hi) {
    this.clock += randint(lo, hi);
    return new Date(this.clock).toISOString();
  }

  envelope(type) {
    const e = {
      parentUuid: this.parentUuid,
      isSidechain: this.sidechain,
    };
    const u = uuid();
    e.type = type;
    e.uuid = u;
    e.timestamp = new Date(this.clock).toISOString();
    if (this.agentId) e.agentId = this.agentId;
    e.userType = "external";
    e.entrypoint = "cli";
    e.cwd = CWD;
    e.sessionId = this.sessionId;
    e.version = VERSION;
    e.gitBranch = "main";
    this.parentUuid = u;
    return e;
  }

  push(rec) {
    this.lines.push(JSON.stringify(rec));
  }

  /** Head sidecars (skipped by the adapter; 0 events). */
  head() {
    this.clock += randint(1, 40);
    this.push({ type: "mode", mode: "normal", sessionId: this.sessionId });
    this.push({ type: "permission-mode", permissionMode: "default", sessionId: this.sessionId });
  }

  /** user text record -> 1 user event. */
  userText(text) {
    this.clock += randint(400, 4000);
    const rec = this.envelope("user");
    rec.promptId = uuid();
    rec.message = { role: "user", content: text };
    this.push(rec);
    this.used += 1;
  }

  /**
   * Assistant API message: one JSONL record per content block, all sharing
   * message.id/requestId and repeating the same usage object — the trap that forces
   * token dedupe by message.id.
   * parts: array of {type:"thinking"|"text"|"tool_use", ...}. Returns tool_use parts.
   */
  assistantMessage(parts) {
    this.clock += randint(300, 2500);
    const id = msgId();
    const requestId = `req_${hex(16)}`;
    const usage = {
      input_tokens: randint(2, 60),
      cache_creation_input_tokens: randint(0, 9000),
      cache_read_input_tokens: randint(12000, 46000),
      output_tokens: randint(80, 1400),
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
    };
    const stop = parts.some((p) => p.type === "tool_use") ? "tool_use" : "end_turn";
    const toolUses = [];
    for (const part of parts) {
      const rec = this.envelope("assistant");
      rec.requestId = requestId;
      const content = [];
      if (part.type === "thinking") {
        content.push({ type: "thinking", thinking: part.thinking, signature: b64(randint(180, 320)) });
        this.used += 1;
      } else if (part.type === "text") {
        content.push({ type: "text", text: part.text });
        this.used += 1;
      } else {
        content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
        this.used += 1;
        this.toolCalls += 1;
        part.ordinal = this.toolCalls; // this call's own 1-based index in the file
        part.assistantUuid = rec.uuid;
        toolUses.push(part);
      }
      rec.message = {
        model: "claude-fable-5",
        id,
        type: "message",
        role: "assistant",
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage,
      };
      this.push(rec);
    }
    return toolUses;
  }

  /** tool_result pseudo-user record -> 0 events (paired onto its call). */
  toolResult(part, { text, isError, extra }) {
    this.clock += randint(120, 3000);
    const rec = this.envelope("user");
    rec.promptId = uuid();
    rec.message = {
      role: "user",
      content: [{ tool_use_id: part.id, type: "tool_result", content: text, is_error: isError }],
    };
    rec.toolUseResult = {
      stdout: isError ? "" : text.slice(0, 200),
      stderr: isError ? text : "",
      interrupted: false,
      isImage: false,
      ...(extra ?? {}),
    };
    rec.sourceToolAssistantUUID = part.assistantUuid ?? this.parentUuid;
    this.push(rec);
  }

  /** system/turn_duration record -> 1 turn_end event. */
  turnEnd(messageCount) {
    this.clock += randint(100, 800);
    const rec = this.envelope("system");
    rec.subtype = "turn_duration";
    rec.durationMs = randint(4000, 120000);
    rec.messageCount = messageCount;
    rec.isMeta = false;
    this.push(rec);
    this.used += 1;
  }

  /** Decide the output body for one tool call (schedules large/medium/error deterministically). */
  resultFor(spec, ordinal) {
    const n = ordinal; // this call's own 1-based index — not the shared counter
    if (n % 1307 === 0) {
      this.largeOutputs += 1;
      return { text: largeOutput(randint(60_000, 140_000)), isError: false };
    }
    if (n % 23 === 0) return { text: pick(ERROR_OUTPUTS), isError: true };
    if (n % 89 === 0) return { text: mediumOutput(), isError: false };
    if (spec.name === "Read") return { text: mediumOutput(), isError: false };
    return { text: smallOutput(), isError: false };
  }

  /**
   * One work message: optional thinking + text + 1..3 tool calls (+ their results).
   * Root builder may substitute a Task spawn for one tool call when the next spawn
   * threshold has been crossed.
   */
  workMessage() {
    const parts = [];
    if (rand() < 0.7) parts.push({ type: "thinking", thinking: thinkingText() });
    parts.push({ type: "text", text: assistantText() });
    const nTools = randint(1, 3);
    for (let i = 0; i < nTools; i++) {
      const spec = pickToolSpec();
      parts.push({ type: "tool_use", id: toolUseId(), name: spec.name, input: spec.input() });
    }
    // Root only: promote one tool_use to a Task spawn when a threshold is crossed.
    if (this.pendingSpawns && this.spawnThresholds.length && this.used >= this.spawnThresholds[0]) {
      this.spawnThresholds.shift();
      const [agentId, meta] = this.pendingSpawns.entries().next().value;
      this.pendingSpawns.delete(agentId);
      const victim = parts.find((p) => p.type === "tool_use");
      victim.name = "Task";
      victim.input = { description: meta.description, prompt: meta.prompt, subagent_type: "general-purpose" };
      victim.spawnAgentId = agentId;
      meta.toolUseId = victim.id; // recorded into the child's .meta.json sidecar
    }
    const toolUses = this.assistantMessage(parts);
    for (const part of toolUses) {
      if (part.spawnAgentId) {
        const meta = part.spawnMeta ?? {};
        this.toolResult(part, {
          text: `Child agent completed: ${part.input.description}`,
          isError: false,
          extra: { status: "completed", agentId: part.spawnAgentId, prompt: part.input.prompt },
        });
      } else {
        const r = this.resultFor({ name: part.name }, part.ordinal);
        this.toolResult(part, r);
      }
    }
  }

  /** Emit one full turn. */
  turn() {
    this.promptCounter += 1;
    this.userText(userPrompt(this.promptCounter));
    let msgs = 1;
    const nWork = randint(1, 2);
    for (let i = 0; i < nWork; i++) {
      this.workMessage();
      msgs += 1;
    }
    // closing text message
    const closing = [];
    if (rand() < 0.2) closing.push({ type: "thinking", thinking: thinkingText() });
    closing.push({ type: "text", text: paragraph() });
    this.assistantMessage(closing);
    msgs += 1;
    this.turnEnd(msgs);
  }

  /** Fill the exact remaining budget with a trimmed final turn. */
  fillRemainder() {
    let rem = this.budget - this.used;
    if (rem <= 0) return;
    if (rem === 1) {
      this.userText(userPrompt(this.promptCounter + 1));
      return;
    }
    this.promptCounter += 1;
    this.userText(userPrompt(this.promptCounter));
    rem -= 1;
    // rem-1 assistant text events, then a turn_end (kept text-only for exactness)
    while (rem > 1) {
      this.assistantMessage([{ type: "text", text: paragraph() }]);
      rem -= 1;
    }
    this.turnEnd(2);
  }

  build() {
    this.head();
    // A turn emits 5..14 planned events; stop early enough that no turn can overshoot.
    while (this.budget - this.used >= 14) this.turn();
    this.fillRemainder();
    if (this.used !== this.budget) {
      throw new Error(`event budget miss: used ${this.used}, budget ${this.budget}`);
    }
    return this.clock;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  rand = mulberry32(args.seed);

  const rootSessionId = uuid();
  const childBudget = Math.floor(args.events * 0.08); // 8% of tree per child
  const rootBudget = args.events - childBudget * args.children;

  // Pre-mint child identities + spawn prompts (deterministic).
  const spawnDefs = new Map(); // agentId -> {description, prompt}
  for (let i = 0; i < args.children; i++) {
    const agentId = hex(16);
    spawnDefs.set(agentId, {
      description: `${pick(VERBS)} ${pick(OBJECTS)} (synthetic worker ${i + 1})`,
      prompt: `You are synthetic sub-agent ${i + 1}. In ${CWD}, ${pick(VERBS)} ${pick(OBJECTS)} and report back. ${sentence()}`,
    });
  }
  // Root spawn thresholds: evenly spaced across the root budget.
  const spawnThresholds = [...spawnDefs.keys()].map((_, i) =>
    Math.floor(rootBudget * ((i + 1) / (args.children + 1)))
  );

  const written = []; // {path, bytes, lines, events, agentId?}

  // Root session file.
  const rootLines = [];
  const root = new SessionBuilder({
    lines: rootLines,
    sessionId: rootSessionId,
    agentId: null,
    budget: rootBudget,
    clock: BASE_MS,
    pendingSpawns: new Map(spawnDefs), // copy: root build consumes it
    spawnThresholds,
  });
  root.build();
  if (root.pendingSpawns.size !== 0) throw new Error("unspawned children remain");
  const rootPath = join(args.out, `${rootSessionId}.jsonl`);
  written.push({ path: rootPath, text: rootLines.join("\n") + "\n", events: root.used });

  // Child sidechain files + .meta.json sidecars.
  const builders = [root];
  let clock = BASE_MS + 30_000;
  for (const [agentId, def] of spawnDefs) {
    const childLines = [];
    const child = new SessionBuilder({
      lines: childLines,
      sessionId: rootSessionId,
      agentId,
      budget: childBudget,
      clock,
      pendingSpawns: null,
      spawnThresholds: null,
    });
    clock = child.build() + randint(5_000, 60_000);
    builders.push(child);
    const dir = join(args.out, rootSessionId, "subagents");
    written.push({ path: join(dir, `agent-${agentId}.jsonl`), text: childLines.join("\n") + "\n", events: child.used, agentId });
    written.push({
      path: join(dir, `agent-${agentId}.meta.json`),
      text:
        JSON.stringify({
          agentType: "general-purpose",
          description: def.description,
          toolUseId: def.toolUseId,
          spawnDepth: 1,
        }) + "\n",
      events: 0,
    });
  }

  // Write everything; hash over concatenated bytes in path order for determinism check.
  const hash = createHash("sha256");
  let totalBytes = 0;
  let totalEvents = 0;
  written.sort((a, b) => a.path.localeCompare(b.path));
  for (const w of written) {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.text);
    hash.update(w.text);
    totalBytes += Buffer.byteLength(w.text);
    totalEvents += w.events;
  }

  console.log(`synthetic fixture written to ${args.out}`);
  console.log(`  seed=${args.seed} children=${args.children} files=${written.length}`);
  for (const w of written) {
    const rel = w.path.replace(args.out + "/", "");
    console.log(`  ${rel}  ${Buffer.byteLength(w.text)} bytes${w.events ? `  ~${w.events} planned events` : ""}`);
  }
  console.log(`  TOTAL raw bytes: ${totalBytes} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`  TOTAL planned normalized events across tree: ${totalEvents}`);
  console.log(`  large tool outputs (>=60KB): ${builders.reduce((s, b) => s + b.largeOutputs, 0)}`);
  console.log(`  sha256(all bytes, path order): ${hash.digest("hex")}`);
}

main();
