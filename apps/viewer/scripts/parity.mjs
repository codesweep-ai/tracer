#!/usr/bin/env node
/**
 * parity.mjs — the viewer's gate: cs-tracer's two export transports must render
 * IDENTICALLY. This is a direct test of the thesis that only transport differs.
 *
 * Both sides are rendered FRESH, in ONE browser process. There are no committed
 * baselines: nothing to regenerate when content changes, and strict pixel
 * equality is valid precisely because both renders come from the same executable
 * in the same run rather than from a stored image made by some other Chromium.
 *
 * Strict on the PIXELS, which is not the same as strict on the PNG. The encoder
 * is free to compress the same image two ways, and does — see pngPixels below.
 *
 * PROVES: single-file and split produce the same DOM, the same pixels, and the
 * same interaction end-state. That covers data-block escaping, split asset
 * rewriting, route handling and chunk loading.
 *
 * DOES NOT PROVE the render is CORRECT — both transports could be wrong in the
 * same way. The file:// smoke test (React mounts, zero page errors) is the only
 * backstop against that.
 *
 * usage:
 *   node scripts/parity.mjs [--fixture <oracle-subdir>]...
 *
 * Browser: $CS_TRACER_CHROMIUM, else /usr/bin/chromium-browser when present.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracerRoot = path.resolve(viewerRoot, "../..");
const binary = path.join(tracerRoot, "bin", "cs-tracer");
const safeId = (id) => id.replace(/[^a-zA-Z0-9._-]/g, "-") || "trajectory";

const DEFAULT_FIXTURES = ["claude/v2.1/subagent-run", "claude/v2.1/multi-chunk", "claude/v2.1/hazard-text"];
const VIEWPORT = { width: 1280, height: 900 }; // byte-reproducible at dSF 1 + reducedMotion

const args = process.argv.slice(2);
const fixtureArgs = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--fixture") fixtureArgs.push(args[++i]);
const fixtureList = fixtureArgs.length ? fixtureArgs : DEFAULT_FIXTURES;

const fail = (message) => { console.error(`\nparity FAILED: ${message}`); process.exit(1); };
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// PNG decoding, because comparing ENCODED bytes does not compare pixels.
//
// Chromium's encoder does not always make the same deflate choices for the same
// image: two screenshots of a page that is identical to the pixel can differ in
// the length of the final IDAT, with no metadata chunk involved and no
// difference anywhere in the decoded image. That happened here — a 14-byte
// difference on one page, stable across runs, with a byte-identical DOM — and a
// gate that reads it as "the transports render differently" is reporting on the
// compressor.
//
// So the comparison decodes. Node's zlib does the inflate; unfiltering is the
// only other step, and it is short enough not to be worth a dependency for.
// ---------------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngPixels(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("not a PNG");
  let offset = 8;
  const idat = [];
  let header;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length; // length + type + data + crc
  }
  if (!header) throw new Error("PNG has no IHDR");
  // Screenshots are 8-bit, non-interlaced, RGB or RGBA. Anything else would
  // need more unfiltering cases than this gate has ever seen, so refuse rather
  // than compare something half-decoded.
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  if (header.depth !== 8 || header.interlace !== 0 || !channels) {
    throw new Error(`unsupported PNG: depth=${header.depth} colorType=${header.colorType} interlace=${header.interlace}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const out = Buffer.allocUnsafe(stride * header.height);
  let prior = Buffer.alloc(stride); // the row above row 0 is defined as zeroes
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;  // left
      const b = prior[x];                                // above
      const c = x >= channels ? prior[x - channels] : 0; // upper left
      let value;
      switch (filter) {
        case 0: value = line[x]; break;
        case 1: value = line[x] + a; break;
        case 2: value = line[x] + b; break;
        case 3: value = line[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      row[x] = value & 0xff;
    }
    prior = row;
  }
  return { pixels: out, ...header };
}

// ---------------------------------------------------------------------------
// DOM digest normalization. The two transports differ INTENTIONALLY in how they
// address a trace, and only there:
//   single — keeps ?trace=<id> in the query string
//   split  — the filename carries it: traces/<safeId>.html
// Canonicalising both to ROUTE: markers compares rendered CONTENT while letting
// the intended routing difference through. Routing correctness itself is
// asserted by the interaction tier (real clicks) and routes.test.ts.
// ---------------------------------------------------------------------------
function normalizeDom(html, { split }) {
  let out = html;
  if (split) {
    out = out
      .replace(/href="(?:\.\.\/)?index\.html"/g, 'href="ROUTE:index"')
      .replace(/href="traces\/([^"/]+)\.html#ev-(\d+)"/g, 'href="ROUTE:trace:$1:ev-$2"')
      .replace(/href="traces\/([^"/]+)\.html"/g, 'href="ROUTE:trace:$1"')
      .replace(/href="([^"/]+)\.html#ev-(\d+)"/g, 'href="ROUTE:trace:$1:ev-$2"')
      .replace(/href="([^"/]+)\.html"/g, 'href="ROUTE:trace:$1"');
  }
  return out
    .replaceAll('href="/"', 'href="ROUTE:index"')
    .replace(/href="\?"/g, 'href="ROUTE:index"')
    .replace(/href="\?trace=([^"&]+)#ev-(\d+)"/g, 'href="ROUTE:trace:$1:ev-$2"')
    .replace(/href="\?trace=([^"&]+)"/g, 'href="ROUTE:trace:$1"');
}

const chromiumExecutable = process.env.CS_TRACER_CHROMIUM || (existsSync("/usr/bin/chromium-browser") ? "/usr/bin/chromium-browser" : undefined);

async function newPage(browser, url) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  await page.goto(url, { waitUntil: "load" });
  return { context, page, errors };
}

async function settle(page, { tracePage }) {
  await page.waitForSelector(tracePage ? '[data-testid="trajectory-page"]' : '[data-testid="index-page"]');
  if (tracePage) await page.waitForFunction(() => !document.querySelector('[aria-label^="Loading event"]'));
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(150);
}

async function render(browser, url, { tracePage = false } = {}) {
  const { context, page, errors } = await newPage(browser, url);
  await settle(page, { tracePage });
  const dom = await page.evaluate(() => document.getElementById("root").innerHTML);
  const png = await page.screenshot({ fullPage: true });
  await context.close();
  return { dom, png, errors };
}

// ---------------------------------------------------------------------------
// Tier 3 — interaction parity: the same script of actions on both transports,
// expecting the same end state. The query must match events in BOTH chunks of
// the chunkCount:2 fixture so the progressive scan crosses the chunk boundary.
//
// End-state DOM comparison neutralises the virtual list's accumulated
// measurements: total-height and window-top depend on WHICH cards happened to be
// measured while chunks loaded, and that timing differs between transports. The
// semantic end state — hash, match count, the exact set of rendered cards and
// their contents — is compared in full. Initial-load layout numbers remain
// strictly compared by tiers 1 and 2.
// ---------------------------------------------------------------------------
const normalizeInteractionDom = (html, opts) =>
  normalizeDom(html, opts)
    .replace(/(<div class="relative" style=")height: [\d.]+px(;")/g, "$1height:H$2")
    .replace(/(<div class="absolute inset-x-0" style=")top: [\d.]+px(;")/g, "$1top:T$2");

async function interact(browser, url, { traceId, jumpEvent, query }) {
  const { context, page, errors } = await newPage(browser, url);
  await settle(page, { tracePage: false });
  await page.locator(`a[href*="${traceId}"]`).first().click();
  await page.waitForSelector('[data-testid="trajectory-page"]');
  await page.waitForFunction(() => !document.querySelector('[aria-label^="Loading event"]'));
  await page.evaluate((target) => { location.hash = `#ev-${target}`; }, jumpEvent);
  await page.waitForSelector(`[data-event-index="${jumpEvent}"]`);
  const hashAfterJump = await page.evaluate(() => location.hash);
  const box = page.getByPlaceholder("Filter event text or tool names");
  await box.fill(query);
  // NOT locator.press("Enter"): the debounced auto-search re-renders on fill, and
  // press() retries against one resolved handle forever if React replaces the
  // node mid-actionability. Dispatch on the live node instead.
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Filter event text or tool names"]');
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await page.waitForFunction(() => !document.querySelector('[aria-label^="Loading event"]'));
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    hash: location.hash,
    matchText: document.body.innerText.match(/\d+ matches?/)?.[0] ?? "",
    cards: [...document.querySelectorAll("[data-event-index]")].map((n) => Number(n.getAttribute("data-event-index"))).slice(0, 8),
    dom: document.getElementById("root").innerHTML,
  }));
  await context.close();
  return { ...state, hashAfterJump, errors };
}

// ---------------------------------------------------------------------------
if (!existsSync(binary)) fail(`no binary at ${binary} — run: make build`);

const work = await mkdtemp(path.join(os.tmpdir(), "cs-tracer-parity-"));
const browser = await chromium.launch({ executablePath: chromiumExecutable, chromiumSandbox: false });
console.log(`chromium: ${(await browser.version()) || "unknown"}${chromiumExecutable ? "" : " (playwright managed)"}`);

const report = [];
const failures = [];
let warmed = false;

try {
  for (const fixture of fixtureList) {
    const source = path.join(tracerRoot, "fixtures", fixture);
    if (!existsSync(source)) fail(`no such fixture: ${source}`);
    const links = existsSync(path.join(source, "links.json")) ? ["--links", path.join(source, "links.json")] : [];

    // Both transports, from the same input, with the same binary.
    const singleFile = path.join(work, `${safeId(fixture)}.html`);
    const splitDir = path.join(work, `${safeId(fixture)}-split`);
    execFileSync(binary, [source, "--single", "-o", singleFile, ...links], { stdio: "pipe" });
    execFileSync(binary, [source, "--split", "-o", splitDir, ...links], { stdio: "pipe" });

    // Trace ids come from the split output's own pages, so the gate needs no
    // knowledge of the normalizer's internals.
    const { readdirSync } = await import("node:fs");
    const traceFiles = readdirSync(path.join(splitDir, "traces")).filter((f) => f.endsWith(".html"));
    const targets = [{ name: "index", single: `file://${singleFile}`, split: `file://${path.join(splitDir, "index.html")}`, tracePage: false }];
    for (const f of traceFiles) {
      const id = f.replace(/\.html$/, "");
      targets.push({
        name: `trace-${id}`,
        single: `file://${singleFile}?trace=${encodeURIComponent(id)}`,
        split: `file://${path.join(splitDir, "traces", f)}`,
        tracePage: true,
      });
    }

    for (const t of targets) {
      // The FIRST page rendered in a fresh browser process rasterizes a handful
      // of glyph pixels differently from every page after it — measured here at
      // 96 pixels out of 1,152,000, spread over 39 rows of text and stable on
      // re-run. `document.fonts.ready` does not cover it.
      //
      // Each pair renders single first, so single alone paid that cost, and the
      // first target of the first fixture failed while every other page passed.
      // Throwing one render away puts both sides on the same footing, which is
      // the only way this compares the transports rather than the browser.
      if (!warmed) { await render(browser, t.single, { tracePage: t.tracePage }); warmed = true; }

      const a = await render(browser, t.single, { tracePage: t.tracePage });
      const b = await render(browser, t.split, { tracePage: t.tracePage });
      for (const [side, r] of [["single", a], ["split", b]]) {
        if (r.errors.length) failures.push(`${fixture}/${t.name}/${side}: ${r.errors.join(" | ")}`);
      }
      const da = normalizeDom(a.dom, { split: false });
      const db = normalizeDom(b.dom, { split: true });
      const domEqual = da === db;
      const pa = pngPixels(a.png), pb = pngPixels(b.png);
      const sizeEqual = pa.width === pb.width && pa.height === pb.height;
      const pixelEqual = sizeEqual && Buffer.compare(pa.pixels, pb.pixels) === 0;
      report.push(`${fixture}/${t.name}: DOM ${domEqual ? "MATCH" : "DIFF"} (sha ${sha(Buffer.from(da))} vs ${sha(Buffer.from(db))}, ${Buffer.byteLength(da)} vs ${Buffer.byteLength(db)} chars) · pixels ${pixelEqual ? "MATCH" : "DIFF"} (${pa.width}x${pa.height} vs ${pb.width}x${pb.height}, sha ${sha(pa.pixels)} vs ${sha(pb.pixels)})`);
      if (!domEqual) failures.push(`${fixture}/${t.name}: single and split DOM differ`);
      if (!pixelEqual) failures.push(`${fixture}/${t.name}: single and split pixels differ`);
    }

    // Tier 3 runs only on the fixture that crosses a chunk boundary.
    if (fixture.endsWith("multi-chunk") && traceFiles.length) {
      const boundary = traceFiles.map((f) => f.replace(/\.html$/, "")).sort((x, y) => y.length - x.length)[0];
      const states = {};
      for (const [side, url] of [["single", `file://${singleFile}`], ["split", `file://${path.join(splitDir, "index.html")}`]]) {
        const got = await interact(browser, url, { traceId: boundary, jumpEvent: 1050, query: "turn" });
        states[side] = got;
        report.push(`${fixture}/interaction/${side}: jump hash=${got.hashAfterJump} · end hash=${got.hash} · "${got.matchText}" · cards [${got.cards.join(",")}]`);
        if (got.errors.length) failures.push(`${fixture}/interaction/${side}: ${got.errors.join(" | ")}`);
      }
      const s = states.single, p = states.split;
      if (s && p) {
        if (s.hashAfterJump !== p.hashAfterJump) failures.push(`${fixture}/interaction: jump hash "${p.hashAfterJump}" != single "${s.hashAfterJump}"`);
        if (s.hash !== p.hash) failures.push(`${fixture}/interaction: end hash "${p.hash}" != single "${s.hash}"`);
        if (s.matchText !== p.matchText) failures.push(`${fixture}/interaction: match text "${p.matchText}" != single "${s.matchText}"`);
        if (s.cards.join(",") !== p.cards.join(",")) failures.push(`${fixture}/interaction: rendered cards [${p.cards}] != single [${s.cards}]`);
        if (normalizeInteractionDom(s.dom, { split: false }) !== normalizeInteractionDom(p.dom, { split: true })) failures.push(`${fixture}/interaction: end-state DOM differs between transports`);
      }
    }
  }
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}

console.log("\n--- parity report ---");
for (const line of report) console.log(line);
if (failures.length) {
  console.error("\nparity FAILED:");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log("\nparity: PASS");
