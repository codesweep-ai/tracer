// lib.mjs — rendering, browser plumbing and small utilities shared by the
// fixture suite. Nothing here knows what a check expects; see checks.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S, THEME, DATA_BLOCK } from "./selectors.mjs";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const viewerRoot = path.resolve(here, "..");
export const tracerRoot = path.resolve(viewerRoot, "../..");

// The same viewport as scripts/parity.mjs, so "cards rendered at load" means
// the same thing in both gates.
export const VIEWPORT = { width: 1280, height: 900 };

const require = createRequire(import.meta.url);
export const AXE_PATH = require.resolve("axe-core/axe.min.js");

export function browserExecutable() {
  const fromEnv = process.env.TRACER_FIXTURES_BROWSER || process.env.CS_TRACER_CHROMIUM || process.env.CHROME_BIN;
  if (fromEnv) return fromEnv;
  if (existsSync("/usr/bin/chromium-browser")) return "/usr/bin/chromium-browser";
  return undefined; // a Playwright-managed Chromium, if one is installed
}

export function binaryPath() {
  return process.env.TRACER_FIXTURES_BIN || path.join(tracerRoot, "bin", "cs-tracer");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Read one embedded `<script type="application/json" id=…>` block out of a rendered page. */
export function readBlock(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<script type="application/json" id="${escaped}">([\\s\\S]*?)</script>`));
  if (!match) throw new Error(`no data block #${id} in the rendered page`);
  return JSON.parse(match[1]);
}

/**
 * Render every fixture with the tracer binary, both transports, into `workDir`.
 * Fills in on each fixture: single/split paths and URLs, the parsed index and
 * summaries, the root trace id and its trace-page URLs.
 */
export function renderFixtures(fixtures, workDir) {
  const binary = binaryPath();
  if (!existsSync(binary)) throw new Error(`no tracer binary at ${binary} — run \`make build\`, or set TRACER_FIXTURES_BIN`);
  for (const fixture of fixtures) {
    const source = path.join(tracerRoot, "fixtures", fixture.source);
    if (!existsSync(source)) throw new Error(`no such fixture: ${source}`);
    const single = path.join(workDir, `${fixture.key}.html`);
    const split = path.join(workDir, `${fixture.key}-split`);
    execFileSync(binary, [source, "--single", "-o", single], { stdio: "pipe" });
    execFileSync(binary, [source, "--split", "-o", split], { stdio: "pipe" });
    const html = readFileSync(single, "utf8");
    const index = readBlock(html, DATA_BLOCK.index);
    const summaries = Object.fromEntries(index.trajectories.map((t) => [t.id, readBlock(html, DATA_BLOCK.summary(t.id))]));
    // The index page lists root lanes first, in index order; the first of
    // those is the trace page the suite exercises.
    const ids = index.trajectories.map((t) => t.id);
    const rootId = ids.find((id) => summaries[id].meta.parentSessionId == null) ?? ids[0];
    const traceFiles = readdirSync(path.join(split, "traces")).filter((f) => f.endsWith(".html"));
    const safeId = (id) => id.replace(/[^A-Za-z0-9._-]/g, "-") || "trajectory";
    const rootFile = traceFiles.find((f) => f === `${safeId(rootId)}.html`) ?? traceFiles[0];
    Object.assign(fixture, {
      binary, single, split, html, index, summaries, rootId,
      singleUrl: `file://${single}`,
      traceUrl: `file://${single}?trace=${encodeURIComponent(rootId)}`,
      splitIndexUrl: `file://${path.join(split, "index.html")}`,
      splitTraceUrl: `file://${path.join(split, "traces", rootFile)}`,
    });
  }
}

// Every page the suite opens reports into this ledger, so "no external
// requests" and "zero page errors" are judged over the whole run.
export const ledger = { pages: 0, errors: [], external: [] };

export async function settle(page, { tracePage }) {
  await page.waitForSelector(tracePage ? S.tracePage : S.indexPage);
  if (tracePage) await page.waitForFunction((selector) => !document.querySelector(selector), S.loadingRow);
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(150);
}

/**
 * A fresh context per page: nothing leaks between checks. `theme` pre-seeds the
 * ThemeToggle's storage (null = leave the page to its own default), and
 * `colorScheme` is what "system" resolves to.
 */
export async function openPage(browser, url, { theme = "dark", tracePage = false, colorScheme, record = true } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: colorScheme ?? theme ?? "dark" });
  context.setDefaultTimeout(15000);
  if (theme) await context.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }, [THEME.storageKey, theme]);
  // In-page readers, built from the selector map once so every evaluate below
  // reads the DOM the same way.
  await context.addInitScript((sel) => {
    const helpers = {
      cards: () => [...document.querySelectorAll(sel.eventCard)].map((node) => Number(node.getAttribute(sel.eventIndexAttr))).sort((a, b) => a - b),
      inView: (i) => {
        const card = document.querySelector(`[${sel.eventIndexAttr}="${i}"]`); const list = document.querySelector(sel.virtualList);
        if (!card || !list) return false;
        const a = card.getBoundingClientRect(), b = list.getBoundingClientRect();
        return a.bottom > b.top && a.top < b.bottom;
      },
      status: () => [...document.querySelectorAll(sel.searchStatus)].map((node) => node.textContent.trim()).find((text) => /\d+ matches/.test(text)) ?? null,
      empty: () => document.querySelector(sel.emptyFilter)?.textContent.trim() ?? null,
      loading: () => document.querySelectorAll(sel.loadingRow).length,
      theme: () => document.documentElement.getAttribute(sel.themeAttr),
      focused: () => {
        const el = document.activeElement;
        if (!el || el === document.body) return { desc: "body", strip: false, list: false };
        const tag = el.tagName.toLowerCase(); const role = el.getAttribute("role");
        const name = el.getAttribute("aria-label") || (tag === "input" ? el.getAttribute("placeholder") : "") || el.textContent.trim().replace(/\s+/g, " ").slice(0, 32);
        return { desc: `${tag}${role ? `[${role}]` : ""}:${name}`, strip: el.matches(sel.stripImage), list: el.matches(sel.virtualList) || Boolean(el.closest(sel.virtualList)) };
      },
    };
    Object.defineProperty(window, "__tf", { value: helpers });
  }, S);
  const page = await context.newPage();
  const log = { url, errors: [], external: [] };
  page.on("pageerror", (error) => log.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") log.errors.push(`console.error: ${message.text()}`); });
  page.on("request", (request) => { const target = request.url(); if (!/^(file|data|blob|about):/.test(target)) log.external.push(target); });
  if (record) { ledger.pages++; ledger.errors.push(log.errors); ledger.external.push(log.external); }
  await page.goto(url, { waitUntil: "load" });
  await settle(page, { tracePage });
  const close = () => withTimeout(context.close(), 5000, "context.close").catch(() => {});
  return { context, page, log, close };
}

/** Press a key on the page without letting a wedged renderer wedge the suite. */
export const press = (page, key, ms = 5000) => withTimeout(page.keyboard.press(key), ms, `press ${key}`);

// ---- value comparison ---------------------------------------------------------
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (typeof a === "object") {
    const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
    return deepEqual(keys, other) && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

/** The paths at which two values differ, for a readable mismatch report. */
export function diffPaths(expected, actual, prefix = "", out = []) {
  if (deepEqual(expected, actual)) return out;
  const isObject = (v) => v && typeof v === "object";
  if (isObject(expected) && isObject(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) diffPaths(expected[key], actual[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  out.push({ path: prefix || "(root)", expected, actual });
  return out;
}

export function getPath(value, dotted) {
  return dotted.split(".").reduce((node, key) => (node == null ? undefined : node[key]), value);
}

/** A target is a literal, or "<=N" / ">=N" / "<N" / ">N" on a number. */
export function meetsTarget(measured, target) {
  if (typeof target === "string") {
    const match = target.match(/^(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/);
    if (match) {
      if (typeof measured !== "number") return false;
      const bound = Number(match[2]);
      return { "<=": measured <= bound, ">=": measured >= bound, "<": measured < bound, ">": measured > bound }[match[1]];
    }
  }
  return deepEqual(measured, target);
}

export const compactJson = (value, max = 88) => {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
