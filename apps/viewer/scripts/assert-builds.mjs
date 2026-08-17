#!/usr/bin/env node
/**
 * assert-builds.mjs — build-time gate for the two export shells (SPEC.md §5).
 * These constraints fail SILENTLY at runtime (a
 * blocked module script under file:// is a blank page), so they are asserted on
 * the emitted bytes after every build rather than trusted to the config:
 *
 *   single/index.html — the ONLY file; JS+CSS inlined; no src= on the script
 *     tag, no crossorigin, no absolute src/href, no dynamic import(, no
 *     unresolved url( (the KaTeX fonts are orphaned — so any url( that
 *     is not a data: URI or a #fragment is a regression).
 *   split/{index.html, assets/app.js, assets/app.css} — exactly these three
 *     files; the script tag is a CLASSIC relative reference (no type="module",
 *     no crossorigin, no leading /); app.js has no import/export/import.meta
 *     left (IIFE), app.css has no unresolved url(.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outBase = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../internal/cli/viewer");
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// An unresolved CSS url(): anything that is not an inlined data: URI or an
// in-document #fragment reference.
const unresolvedUrl = (text) => /url\(\s*(?!["']?(?:data:|#))[^)]*\)/.test(text);
// import( that is a dynamic import, not the word inside a larger identifier.
const dynamicImport = (text) => /(?<![\w$.])import\s*\(/.test(text);

const singleDir = path.join(outBase, "single");
const singleFiles = (await readdir(singleDir, { recursive: true })).sort();
check(singleFiles.join("\n") === "index.html", `single build must emit exactly index.html, got:\n${singleFiles.join("\n")}`);
const single = await readFile(path.join(singleDir, "index.html"), "utf8");
check(!/<script[^>]+\bsrc=/.test(single), "single: <script src=> present — the shell must be fully inlined");
check(!/\bcrossorigin\b/.test(single), "single: crossorigin attribute present");
check(!/(?:src|href)=["']\//.test(single), "single: absolute src=/href= present");
check(!dynamicImport(single), "single: dynamic import( present");
check(!unresolvedUrl(single), "single: unresolved url( present (KaTeX font tripwire, SPEC.md)");
check(single.includes('<div id="root">'), "single: #root mount point missing");

const splitDir = path.join(outBase, "split");
const splitFiles = (await readdir(splitDir, { recursive: true })).filter((name) => !name.endsWith("assets")).sort();
for (const required of ["assets/app.css", "assets/app.js", "index.html"]) check(splitFiles.includes(required), `split: missing ${required}`);
check(splitFiles.length === 3, `split build must emit exactly index.html + assets/app.{js,css}, got:\n${splitFiles.join("\n")}`);
const splitHtml = await readFile(path.join(splitDir, "index.html"), "utf8");
const splitJs = await readFile(path.join(splitDir, "assets", "app.js"), "utf8");
const splitCss = await readFile(path.join(splitDir, "assets", "app.css"), "utf8");
check(/<script(?![^>]*\btype=)[^>]*\bsrc=["']\.\/assets\/app\.js["']/.test(splitHtml), "split: no classic <script src=\"./assets/app.js\"> tag");
check(/<script[^>]+\bdefer\b[^>]*\bsrc=["']\.\/assets\/app\.js["']/.test(splitHtml), "split: app.js script tag lost its defer — a classic head script runs before #root exists");
check(!/<script[^>]+\btype=["']module["']/.test(splitHtml), "split: type=\"module\" script present — blocked under file://");
check(!/\bcrossorigin\b/.test(splitHtml), "split: crossorigin attribute present");
check(!/(?:src|href)=["']\//.test(splitHtml), "split: absolute src=/href= present");
check(/<link[^>]+\bhref=["']\.\/assets\/app\.css["']/.test(splitHtml), "split: no <link href=\"./assets/app.css\"> tag");
check(!dynamicImport(splitJs), "split: dynamic import( present in app.js");
check(!/(?:^|[;\n])\s*import\s+(?![(])[\w*{]/.test(splitJs), "split: static import statement left in app.js (must be a classic script)");
check(!/(?:^|[;\n])\s*export\s+(?:default|\{|\*)/.test(splitJs), "split: export statement left in app.js (must be a classic script)");
check(!splitJs.includes("import.meta"), "split: import.meta left in app.js (undefined in a classic script)");
check(!unresolvedUrl(splitCss), "split: unresolved url( present in app.css");

if (failures.length) {
  console.error(`assert-builds FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`single: internal/cli/viewer/single/index.html — ${Buffer.byteLength(single)} bytes, JS+CSS inlined; assertions PASS`);
console.log(`split:  internal/cli/viewer/split/index.html + assets/app.js (${Buffer.byteLength(splitJs)} bytes) + assets/app.css (${Buffer.byteLength(splitCss)} bytes); assertions PASS`);
