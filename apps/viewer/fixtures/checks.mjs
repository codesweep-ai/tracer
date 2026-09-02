// checks.mjs — what the suite measures. Each scenario opens pages and returns
// `[id, variant, value]` triples; run.mjs merges variants (fixture, or
// fixture/theme) into one value per check id and compares it with
// expectations.json. The meta below (status/target/note) is only used when an
// id has no entry yet (`--update` on a fresh file); expectations.json is the
// authority once it exists.
import { statSync } from "node:fs";
import { AXE_PATH, openPage, press, settle, sleep, withTimeout, ledger } from "./lib.mjs";
import { S, THEME } from "./selectors.mjs";

export const THEMES = ["dark", "light"];

/** The legend's vocabulary: which strip kinds each chip governs (KindLegend.tsx). */
const CHIP_KINDS = { user: ["user"], assistant: ["assistant"], tool: ["tool_call", "tool_result"], thinking: ["thinking"], system: ["system"], meta: ["meta"], "turn end": ["turn_end"] };

export const CHECKS = [
  // A. structure
  { id: "TF-01", name: "index.lanes", status: "keep", note: "lane count, labels, nesting by parent session (index, both fixtures × themes)" },
  { id: "TF-02", name: "index.laneEvents", status: "keep", note: "per-lane event count from the strip's accessible label; spawn markers, connectors, badges per lane" },
  { id: "TF-03", name: "index.legend", status: "keep", note: "legend entries on the index, in order" },
  { id: "TF-04", name: "index.rollup", status: "keep", note: "the rollup line under the index title" },
  { id: "TF-05", name: "theme.attr", status: "keep", note: "<html data-theme> under each seeded theme, index and trace page" },
  { id: "TF-06", name: "trace.stripEvents", status: "keep", note: "event count in the trace strip's accessible label" },
  { id: "TF-07", name: "trace.kindChips", status: "keep", note: "the 7 kind chips (label, pressed) with the event count each governs, errors-only / all / none state at load" },
  { id: "TF-08", name: "trace.firstLast", status: "keep", note: "first/last event ids in the strip data, the first card rendered at load, the hash at load" },
  { id: "TF-09", name: "trace.cardsAtLoad", status: "keep", note: "cards in the DOM at load, 1280×900 (virtualized: a handful, not the event count)" },
  { id: "TF-10", name: "trace.searchPresent", status: "keep", note: "search input + button present" },
  // B. interaction end states
  { id: "TF-11", name: "search.tool", status: "keep", note: "fill \"tool\", settle past the debounce, Enter → status text and the ids of the first 5 matches" },
  { id: "TF-12", name: "filter.chipTool", status: "keep", note: "tool chip off → data count, first 5 displayed, last card after scrolling to the end; chip back on restores" },
  { id: "TF-13", name: "filter.noneAll", status: "keep", note: "none → empty-state text; all → first cards restored, chips all on" },
  { id: "TF-14", name: "filter.errorsOnly", status: "keep", note: "errors-only → data count, first 5 displayed, last after scrolling to the end, empty-state text when the trace has none" },
  { id: "TF-15", name: "strip.click", status: "keep", note: "click cell 10 of the strip (x = data-cell-offset + 10.5 × data-cell-width): trace page hash; index lane → navigates to ?trace=…#ev-10" },
  { id: "TF-16", name: "nav.hash", status: "keep", note: "location.hash = #ev-N → card N rendered, no loading rows, hash kept" },
  { id: "TF-17", name: "modes.links", status: "keep", note: "single vs split transport: lane href, back link, nav link, trace page mounts in split" },
  { id: "TF-18", name: "theme.toggle", status: "keep", note: "ThemeToggle: system(dark) → light, persisted across reload, → dark" },
  // C. search responsiveness (TR-22)
  { id: "TF-19", name: "search.responsive", status: "must-change", target: { responsive: true }, note: "type \"to\" fast, Enter inside the debounce, large-session: the page must answer an evaluate within 2 s (today the renderer wedges)" },
  // D. accessibility
  { id: "TF-20", name: "a11y.axe", status: "must-change", target: { "*.seriousOrCritical": 0 }, note: "axe-core violations by rule id per page × theme (nodes, impact); target: no serious/critical nodes on any page" },
  // E. keyboard
  { id: "TF-21", name: "keys.tabStops", status: "keep", note: "Tab stops on the trace page from the top of the document up to the strip (first 20 at most)" },
  { id: "TF-22", name: "keys.stripReachable", status: "keep", note: "the strip is in the Tab order" },
  { id: "TF-23", name: "keys.stripArrows", status: "must-change", target: { "*.selectionChanges": true }, note: "focus the strip, ArrowRight then Enter: the selection (location.hash) must move (today it does not)" },
  { id: "TF-24", name: "keys.listFocusable", status: "must-change", target: { "*.focusable": true }, note: "the virtual event list carries an explicit tabindex ≥ 0 (today none; Chromium reaches it only as a keyboard-scrollable region)" },
  { id: "TF-25", name: "keys.selectWithoutMouse", status: "must-change", target: { "*.selectable": true }, note: "Tab to the strip, ArrowRight ×3, Enter — or Tab to the list, ArrowDown, Enter — must select an event other than #0" },
  // F. size
  { id: "TF-26", name: "size.page", status: "must-change", target: { "large-session.bytes": "<=1130000", "codex-multi-agent-run.bytes": "<=380000", "subagent-run.bytes": "<=375000" }, note: "single-file page bytes with the CSS / JS split; budget per page, at (just above) today's size — the CSS is expected to shrink when Tailwind goes" },
  { id: "TF-27", name: "size.data", status: "keep", note: "embedded data bytes and block count — the transport payload must not change" },
  { id: "TF-28", name: "size.tailwind", status: "must-change", target: { "*.total": 0 }, note: "Tailwind bytes in the page CSS: the preflight segment plus tracer's utility rules (non-`.cs-` class rules with --tw- vars, escaped selectors, or sitting after the preflight); ui's own --tw- vars are not counted" },
  // G. hygiene
  { id: "TF-29", name: "net.external", status: "keep", note: "requests to anything but file:/data:/blob: over every page the suite opened" },
  { id: "TF-30", name: "errors.page", status: "keep", note: "pageerror + console.error over every page the suite opened" },
  // HighlightText adoption (TR-30)
  // Target asserts per fixture rather than "*.marks": TF-11 freezes "0 matches"
  // for codex-multi-agent-run on this query, and with no matches there are no
  // rendered cards and nothing to wrap — a highlight requirement there would
  // assert behaviour the product must never have. (tracer-03)
  { id: "TF-31", name: "search.highlight", status: "must-change", target: { "large-session.marks": ">=1", "subagent-run.marks": ">=1" }, note: "after search \"tool\", rendered cards wrap hits in <mark> (HighlightText); today none" },
  // the selected card must end up on screen
  { id: "TF-32", name: "nav.targetInView", status: "must-change", target: { "*.hashNav.inView": true, "*.hashNav.hashKept": true, "*.stripClick.inView": true, "*.stripClick.hashKept": true }, note: "after a deep link (#ev-N) or a strip click the selected card intersects the list viewport and the hash still names it; today the scroll lands near the card, row measurement shifts the offsets, and the scrollspy re-selects whatever is on top" },
  // F. invariants — relationships, not values. Every defect the 2026-08-24 tier-4
  //    walk-through found lived in a relationship between two things that were
  //    each individually correct, which is why value-at-one-state rows missed
  //    them all. These record the VIOLATIONS, so the expected value is [].
  { id: "TF-33", name: "invariant.stripMatchesData", status: "keep", note: "for each kind chip selected alone: the strip's rendered data-event-count must equal the count of that kind in the source strip data. Catches a strip that filters on anything other than the event's own kind" },
  { id: "TF-34", name: "invariant.canvasPinned", status: "keep", note: "the strip canvas must stay pinned to its scrollport at 0%, 50% and 100% horizontal scroll. The paint already subtracts scrollLeft, so a canvas that scrolls away offsets everything twice and the drawn region collapses" },
];

const countWhere = (strip, predicate) => strip.filter(predicate).length;
const kindsOf = (chipLabel) => new Set(CHIP_KINDS[chipLabel] ?? []);

async function axe(page) {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    const out = { seriousOrCritical: 0 };
    for (const violation of result.violations) {
      out[violation.id] = { impact: violation.impact, nodes: violation.nodes.length };
      if (violation.impact === "serious" || violation.impact === "critical") out.seriousOrCritical += violation.nodes.length;
    }
    return out;
  });
}

async function scrollListToEnd(page) {
  let last = -1;
  for (let i = 0; i < 8; i++) {
    await page.evaluate((selector) => { const list = document.querySelector(selector); if (list) list.scrollTop = list.scrollHeight; }, S.virtualList);
    await settle(page, { tracePage: true });
    const top = await page.evaluate((selector) => document.querySelector(selector)?.scrollTop ?? 0, S.virtualList);
    if (top === last) break;
    last = top;
  }
  return page.evaluate(() => window.__tf.cards());
}

/**
 * The first `limit` events the list displays, independent of how many cards
 * the virtualizer happens to render at this viewport: start at the top and
 * scroll down until that many distinct ids have been seen (or the list ends).
 */
async function firstDisplayed(page, limit) {
  const seen = new Set();
  await page.evaluate((selector) => { const list = document.querySelector(selector); if (list) list.scrollTop = 0; }, S.virtualList);
  for (let i = 0; i < 12; i++) {
    await settle(page, { tracePage: true });
    for (const id of await page.evaluate(() => window.__tf.cards())) seen.add(id);
    const atEnd = await page.evaluate((selector) => { const list = document.querySelector(selector); if (!list) return true; const before = list.scrollTop; list.scrollTop = before + list.clientHeight / 2; return list.scrollTop === before; }, S.virtualList);
    if (seen.size >= limit || atEnd) break;
  }
  return [...seen].sort((a, b) => a - b).slice(0, limit);
}

/**
 * Wait until the list has stopped scrolling and the hash has stopped moving:
 * after a jump, row measurement can shift the offsets a few frames later and
 * the scrollspy follows. Three quiet polls 100 ms apart, or 3 s.
 */
async function stable(page) {
  let last = null, quiet = 0;
  for (let i = 0; i < 30 && quiet < 3; i++) {
    await page.waitForTimeout(100);
    const now = await page.evaluate((selector) => `${location.hash}@${document.querySelector(selector)?.scrollTop ?? 0}`, S.virtualList);
    quiet = now === last ? quiet + 1 : 0; last = now;
  }
  await settle(page, { tracePage: true });
}

const traceState = (page) => page.evaluate((sel) => ({
  cards: window.__tf.cards(),
  hash: location.hash,
  empty: window.__tf.empty(),
  loading: window.__tf.loading(),
  chipsOn: [...document.querySelectorAll(sel.kindChip)].filter((b) => b.getAttribute("aria-pressed") === "true").length,
  allDisabled: document.querySelector(sel.filterAll)?.disabled ?? null,
  noneDisabled: document.querySelector(sel.filterNone)?.disabled ?? null,
}), S);

// ---------------------------------------------------------------------------
// A + D: structure and axe, read-only, per fixture × theme
// ---------------------------------------------------------------------------
export async function structure(browser, fixture, theme) {
  const variant = `${fixture.key}/${theme}`;
  const out = [];
  const strip = fixture.summaries[fixture.rootId].strip;

  const idx = await openPage(browser, fixture.singleUrl, { theme });
  const index = await idx.page.evaluate((sel) => {
    const lanes = [...document.querySelectorAll(sel.lane)].map((lane) => {
      const link = lane.querySelector(sel.laneLink); const image = lane.querySelector(sel.stripImage);
      return {
        id: lane.getAttribute(sel.laneIdAttr), parent: lane.getAttribute(sel.laneParentAttr), spawnIndex: lane.getAttribute(sel.laneSpawnAttr),
        label: link?.textContent.trim() ?? null, href: link?.getAttribute("href") ?? null,
        events: Number(/(\d+) events/.exec(image?.getAttribute("aria-label") ?? "")?.[1] ?? -1),
        badges: lane.querySelectorAll(sel.statusBadge).length, spawnMarkers: lane.querySelectorAll(sel.spawnMarker).length, connector: Boolean(lane.querySelector(sel.forkConnector)),
      };
    });
    const legend = document.querySelector(sel.indexLegend);
    return {
      lanes,
      legend: legend ? [...legend.querySelectorAll(sel.indexLegendItem), ...document.querySelectorAll(sel.indexLegendExtra)].map((node) => node.textContent.trim()) : null,
      rollup: document.querySelector(sel.rollup)?.textContent.trim() ?? null,
      title: document.querySelector(sel.pageTitle)?.textContent.trim() ?? null,
      theme: window.__tf.theme(),
    };
  }, S);
  const depthOf = (lane) => { let depth = 0; let cursor = lane; const seen = new Set(); while (cursor?.parent && !seen.has(cursor.id)) { seen.add(cursor.id); cursor = index.lanes.find((l) => l.id === cursor.parent); if (cursor) depth++; } return depth; };
  out.push(["TF-01", variant, { title: index.title, count: index.lanes.length, lanes: index.lanes.map((lane) => ({ id: lane.id, label: lane.label, parent: lane.parent, depth: depthOf(lane), spawnIndex: lane.spawnIndex == null ? null : Number(lane.spawnIndex) })) }]);
  out.push(["TF-02", variant, { events: Object.fromEntries(index.lanes.map((l) => [l.id, l.events])), spawnMarkers: Object.fromEntries(index.lanes.map((l) => [l.id, l.spawnMarkers])), connectors: Object.fromEntries(index.lanes.map((l) => [l.id, l.connector])), badges: Object.fromEntries(index.lanes.map((l) => [l.id, l.badges])) }]);
  out.push(["TF-03", variant, index.legend]);
  out.push(["TF-04", variant, index.rollup]);
  const indexAxe = await axe(idx.page);
  await idx.close();

  const tr = await openPage(browser, fixture.traceUrl, { theme, tracePage: true });
  const trace = await tr.page.evaluate((sel) => {
    const image = document.querySelector(sel.stripImage);
    const input = document.querySelector(sel.searchInput);
    const errorsOnly = document.querySelector(sel.errorsOnly);
    return {
      theme: window.__tf.theme(),
      stripLabel: image?.getAttribute("aria-label") ?? null,
      stripEvents: Number(/(\d+) events/.exec(image?.getAttribute("aria-label") ?? "")?.[1] ?? -1),
      stripFocusable: image ? image.tabIndex >= 0 : false,
      chips: [...document.querySelectorAll(sel.kindChip)].map((b) => ({ label: b.textContent.trim(), on: b.getAttribute("aria-pressed") === "true" })),
      errorsOnly: errorsOnly ? { label: errorsOnly.textContent.trim(), on: errorsOnly.getAttribute("aria-pressed") === "true" } : null,
      allDisabled: document.querySelector(sel.filterAll)?.disabled ?? null,
      noneDisabled: document.querySelector(sel.filterNone)?.disabled ?? null,
      cards: window.__tf.cards(),
      loading: window.__tf.loading(),
      hash: location.hash,
      search: { present: Boolean(input), placeholder: input?.getAttribute("placeholder") ?? null, button: document.querySelector(sel.searchButton)?.textContent.trim() || null },
    };
  }, S);
  out.push(["TF-05", variant, { index: index.theme, trace: trace.theme }]);
  out.push(["TF-06", variant, { events: trace.stripEvents, focusable: trace.stripFocusable }]);
  out.push(["TF-07", variant, {
    chips: trace.chips.map((chip) => ({ ...chip, count: countWhere(strip, (e) => kindsOf(chip.label).has(e.kind)) })),
    errorsOnly: trace.errorsOnly, allDisabled: trace.allDisabled, noneDisabled: trace.noneDisabled,
  }]);
  out.push(["TF-08", variant, { first: strip[0]?.i ?? null, last: strip[strip.length - 1]?.i ?? null, firstCardAtLoad: trace.cards[0] ?? null, hashAtLoad: trace.hash }]);
  out.push(["TF-09", variant, { cards: trace.cards.length, loading: trace.loading }]);
  out.push(["TF-10", variant, trace.search]);
  // F. sizes — read off the DOM, before axe is injected (the raw file cannot be
  // split by regex: the JS bundle carries "<style" and "<script" inside
  // highlight.js patterns).
  if (theme === THEMES[0]) {
    const composition = await tr.page.evaluate(() => {
      const size = (text) => new TextEncoder().encode(text).length;
      const styles = [...document.querySelectorAll("style")];
      const scripts = [...document.querySelectorAll("script")];
      const isData = (s) => /json/.test(s.type);
      return { css: styles.map((s) => s.textContent).join(""), cssBytes: styles.reduce((sum, s) => sum + size(s.textContent), 0), js: scripts.filter((s) => !isData(s)).reduce((sum, s) => sum + size(s.textContent), 0), data: scripts.filter(isData).reduce((sum, s) => sum + size(s.textContent), 0), blocks: scripts.filter(isData).length };
    });
    out.push(["TF-26", fixture.key, { bytes: statSync(fixture.single).size, css: composition.cssBytes, js: composition.js }]);
    out.push(["TF-27", fixture.key, { data: composition.data, blocks: composition.blocks }]);
    out.push(["TF-28", fixture.key, tailwindBytes(composition.css)]);
  }
  const traceAxe = await axe(tr.page);
  await tr.close();
  out.push(["TF-20", `${variant}/index`, indexAxe]);
  out.push(["TF-20", `${variant}/trace`, traceAxe]);
  return out;
}

// ---------------------------------------------------------------------------
// B: interaction end states, per fixture (dark), one fresh page per interaction
// ---------------------------------------------------------------------------
export async function interaction(browser, fixture) {
  const variant = fixture.key;
  const out = [];
  const strip = fixture.summaries[fixture.rootId].strip;
  const openTrace = () => openPage(browser, fixture.traceUrl, { theme: "dark", tracePage: true });
  const inView = { hashNav: null, stripClick: null }; // TF-32, filled by TF-16 and TF-15

  // TF-11 / TF-31 — search "tool": fill, let the debounce fire, then Enter.
  {
    const { page, close } = await openTrace();
    await page.fill(S.searchInput, "tool");
    await page.waitForTimeout(800);
    await press(page, "Enter").catch(() => {});
    await page.waitForFunction(() => { const text = window.__tf.status(); return text && !/scanning/.test(text); }, null, { timeout: 20000 });
    await settle(page, { tracePage: true });
    const state = await traceState(page);
    const status = await page.evaluate(() => window.__tf.status());
    const marks = await page.evaluate((sel) => document.querySelectorAll(`${sel.eventCard} ${sel.highlight}`).length, S);
    const first = await firstDisplayed(page, 5);
    out.push(["TF-11", variant, { status, first, empty: state.empty }]);
    out.push(["TF-31", variant, { marks, renderedCards: state.cards.length }]);
    await close();
  }

  // TF-12 — the tool chip off, then on again.
  {
    const { page, close } = await openTrace();
    const chip = page.locator(S.kindChip, { hasText: /^tool$/ }).first();
    await chip.click(); await settle(page, { tracePage: true });
    const off = await traceState(page);
    const pressed = await chip.getAttribute("aria-pressed");
    const first = await firstDisplayed(page, 5);
    const tail = await scrollListToEnd(page);
    await chip.click(); await settle(page, { tracePage: true });
    const on = await traceState(page);
    const toolKinds = kindsOf("tool");
    out.push(["TF-12", variant, {
      off: { pressed, dataCount: countWhere(strip, (e) => !toolKinds.has(e.kind)), first, lastAfterScrollToEnd: tail[tail.length - 1] ?? null, empty: off.empty, allDisabled: off.allDisabled },
      on: { pressed: await chip.getAttribute("aria-pressed"), chipsOn: on.chipsOn, allDisabled: on.allDisabled },
    }]);
    await close();
  }

  // TF-13 — none, then all.
  {
    const { page, close } = await openTrace();
    const before = await traceState(page);
    await page.click(S.filterNone); await settle(page, { tracePage: true });
    const none = await traceState(page);
    await page.click(S.filterAll); await settle(page, { tracePage: true });
    const all = await traceState(page);
    out.push(["TF-13", variant, {
      none: { empty: none.empty, rendered: none.cards.length, chipsOn: none.chipsOn, noneDisabled: none.noneDisabled, allDisabled: none.allDisabled },
      all: { first: all.cards.slice(0, 5), restored: JSON.stringify(all.cards.slice(0, 5)) === JSON.stringify(before.cards.slice(0, 5)), chipsOn: all.chipsOn, allDisabled: all.allDisabled, empty: all.empty },
    }]);
    await close();
  }

  // TF-14 — errors only.
  {
    const { page, close } = await openTrace();
    await page.click(S.errorsOnly); await settle(page, { tracePage: true });
    const state = await traceState(page);
    const button = await page.evaluate((sel) => { const b = document.querySelector(sel.errorsOnly); return { label: b?.textContent.trim() ?? null, on: b?.getAttribute("aria-pressed") === "true" }; }, S);
    const first = state.cards.length ? await firstDisplayed(page, 5) : [];
    const tail = state.cards.length ? await scrollListToEnd(page) : [];
    out.push(["TF-14", variant, { ...button, dataCount: countWhere(strip, (e) => e.error), first, lastAfterScrollToEnd: tail[tail.length - 1] ?? null, empty: state.empty, allDisabled: state.allDisabled }]);
    await close();
  }

  // TF-15 — click the strip at cell 10, on the trace page and on the index lane.
  {
    const cell = 10;
    const { page, close } = await openTrace();
    const width = Number(await page.getAttribute(S.strip, S.stripCellWidthAttr)) || 10;
    const offset = Number(await page.getAttribute(S.strip, S.stripCellOffsetAttr)) || 0; // ink starts `offset` px right of the axis origin (halo padding)
    const box = await page.locator(S.stripImage).first().boundingBox();
    const hashBefore = await page.evaluate(() => location.hash);
    await page.mouse.click(box.x + offset + width * cell + width / 2, box.y + box.height / 2);
    // The selection is written to the hash before the list scrolls; read it
    // then, since today's scrollspy may re-select once the scroll lands (TF-32).
    const selectedHash = await page.waitForFunction((before) => location.hash !== before ? location.hash : null, hashBefore, { timeout: 3000 }).then((handle) => handle.jsonValue()).catch(() => hashBefore);
    await stable(page);
    const trace = await page.evaluate((i) => ({ hash: location.hash, cardInView: window.__tf.inView(i), cardPresent: Boolean(document.querySelector(`[data-event-index="${i}"]`)) }), cell);
    await close();

    const idx = await openPage(browser, fixture.singleUrl, { theme: "dark" });
    const lane = idx.page.locator(S.lane).first();
    const laneWidth = Number(await lane.locator(S.strip).getAttribute(S.stripCellWidthAttr)) || 10;
    const laneOffset = Number(await lane.locator(S.strip).getAttribute(S.stripCellOffsetAttr)) || 0;
    const laneBox = await lane.locator(S.stripImage).boundingBox();
    const navigated = idx.page.waitForURL((url) => /#ev-\d+$/.test(url.href), { timeout: 5000 }).then(() => idx.page.url()).catch(() => null);
    await idx.page.mouse.click(laneBox.x + laneOffset + laneWidth * cell + laneWidth / 2, laneBox.y + laneBox.height / 2);
    const target = await navigated; // the lane's own navigation, before the trace page re-selects
    await idx.page.waitForSelector(S.tracePage); await settle(idx.page, { tracePage: true }); await stable(idx.page);
    const index = await idx.page.evaluate((i) => ({ hash: location.hash, cardInView: window.__tf.inView(i) }), cell);
    await idx.close();
    const suffix = target ? target.slice(target.indexOf("?")) : null;
    out.push(["TF-15", variant, { cellWidth: width, trace: { selectedHash, cardPresent: trace.cardPresent }, index: { urlSuffix: suffix } }]);
    inView.stripClick = { inView: trace.cardInView && index.cardInView, hashKept: trace.hash === `#ev-${cell}` && index.hash === `#ev-${cell}` };
  }

  // TF-16 — hash navigation to an event in a later chunk.
  {
    const target = fixture.jump;
    const { page, close } = await openTrace();
    await page.evaluate((i) => { location.hash = `#ev-${i}`; }, target);
    await page.waitForSelector(`[${S.eventIndexAttr}="${target}"]`);
    await settle(page, { tracePage: true }); await stable(page);
    const state = await page.evaluate((i) => ({ hash: location.hash, cardPresent: Boolean(document.querySelector(`[data-event-index="${i}"]`)), cardInView: window.__tf.inView(i), loading: window.__tf.loading() }), target);
    out.push(["TF-16", variant, { target, cardPresent: state.cardPresent, loading: state.loading }]);
    inView.hashNav = { inView: state.cardInView, hashKept: state.hash === `#ev-${target}` };
    await close();
  }
  out.push(["TF-32", variant, inView]);

  // TF-18 — theme toggle and persistence, from a page with no stored preference.
  {
    const { page, close } = await openPage(browser, fixture.singleUrl, { theme: null, colorScheme: "dark" });
    const initial = await page.evaluate(() => window.__tf.theme());
    await page.click(S.themeToggle); await page.waitForTimeout(100);
    const afterToggle = await page.evaluate(() => window.__tf.theme());
    const stored = await page.evaluate((key) => localStorage.getItem(key), THEME.storageKey);
    await page.reload({ waitUntil: "load" }); await settle(page, { tracePage: false });
    const afterReload = await page.evaluate(() => window.__tf.theme());
    await page.click(S.themeToggle); await page.waitForTimeout(100);
    const afterSecondToggle = await page.evaluate(() => window.__tf.theme());
    const storedAfterSecond = await page.evaluate((key) => localStorage.getItem(key), THEME.storageKey);
    out.push(["TF-18", variant, { initial, afterToggle, stored, afterReload, afterSecondToggle, storedAfterSecond }]);
    await close();
  }

  // TF-33 — rendered strip vs the source data, one chip at a time.
  {
    const { page, close } = await openTrace();
    const mismatches = [];
    for (const label of Object.keys(CHIP_KINDS)) {
      await page.click(S.filterNone);
      await settle(page, { tracePage: true });
      await page.locator(S.kindChip, { hasText: new RegExp(`^${label}$`) }).first().click();
      await settle(page, { tracePage: true });
      const rendered = Number(await page.getAttribute(S.stripImage, "data-event-count"));
      const kinds = kindsOf(label);
      const expected = countWhere(strip, (event) => kinds.has(event.kind));
      if (rendered !== expected) mismatches.push({ chip: label, rendered, expected });
    }
    out.push(["TF-33", variant, mismatches]);
    await close();
  }

  // TF-34 — the strip canvas stays pinned while scrolling.
  {
    const { page, close } = await openTrace();
    const drift = await page.evaluate(async (sel) => {
      const scroller = document.querySelector(sel.stripImage);
      const canvas = scroller?.querySelector(sel.stripCanvas);
      if (!scroller || !canvas) return [{ at: "setup", problem: "no strip canvas" }];
      if (scroller.scrollWidth <= scroller.clientWidth + 5) return [];
      const bad = [];
      for (const fraction of [0, 0.5, 1]) {
        scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) * fraction);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const offset = Math.round(canvas.getBoundingClientRect().left - scroller.getBoundingClientRect().left);
        if (Math.abs(offset) > 3) bad.push({ at: fraction, offset });
      }
      return bad;
    }, S);
    out.push(["TF-34", variant, drift]);
    await close();
  }

  return out;
}

// ---------------------------------------------------------------------------
// TF-17 — the two transports route differently and only there
// ---------------------------------------------------------------------------
export async function modes(browser, fixture) {
  const read = async (url, tracePage) => {
    const { page, close } = await openPage(browser, url, { theme: "dark", tracePage });
    const state = await page.evaluate((sel) => ({
      laneHref: document.querySelector(`${sel.lane} ${sel.laneLink}`)?.getAttribute("href") ?? null,
      backHref: document.querySelector(sel.backLink)?.getAttribute("href") ?? null,
      navHref: document.querySelector(sel.navIndexLink)?.getAttribute("href") ?? null,
      stripEvents: Number(/(\d+) events/.exec(document.querySelector(sel.stripImage)?.getAttribute("aria-label") ?? "")?.[1] ?? -1),
      cards: window.__tf.cards().length,
    }), S);
    await close();
    return state;
  };
  const singleIndex = await read(fixture.singleUrl, false), singleTrace = await read(fixture.traceUrl, true);
  const splitIndex = await read(fixture.splitIndexUrl, false), splitTrace = await read(fixture.splitTraceUrl, true);
  return [["TF-17", fixture.key, {
    single: { laneHref: singleIndex.laneHref, navHrefOnIndex: singleIndex.navHref, backHref: singleTrace.backHref, navHrefOnTrace: singleTrace.navHref, stripEvents: singleTrace.stripEvents, cards: singleTrace.cards },
    split: { laneHref: splitIndex.laneHref, navHrefOnIndex: splitIndex.navHref, backHref: splitTrace.backHref, navHrefOnTrace: splitTrace.navHref, stripEvents: splitTrace.stripEvents, cards: splitTrace.cards },
  }]];
}

// ---------------------------------------------------------------------------
// E: keyboard reach, per fixture (dark)
// ---------------------------------------------------------------------------
export async function keyboard(browser, fixture) {
  const variant = fixture.key;
  const out = [];
  const openTrace = () => openPage(browser, fixture.traceUrl, { theme: "dark", tracePage: true });

  // TF-21 / TF-22 / TF-24 — the Tab walk up to the strip, then one more stop.
  {
    const { page, close } = await openTrace();
    await page.evaluate(() => document.activeElement?.blur());
    const stops = []; let stripStop = null;
    for (let i = 1; i <= 20; i++) {
      await press(page, "Tab");
      const focused = await page.evaluate(() => window.__tf.focused());
      stops.push(focused.desc);
      if (focused.strip) { stripStop = i; break; }
    }
    let reachedList = false;
    if (stripStop != null) { await press(page, "Tab"); reachedList = (await page.evaluate(() => window.__tf.focused())).list; }
    const list = await page.evaluate((sel) => { const node = document.querySelector(sel.virtualList); return node ? { tabindex: node.getAttribute("tabindex"), role: node.getAttribute("role"), ariaLabel: node.getAttribute("aria-label"), focusable: node.tabIndex >= 0 && node.hasAttribute("tabindex") } : null; }, S);
    out.push(["TF-21", variant, stops]);
    out.push(["TF-22", variant, { reachable: stripStop != null, stop: stripStop }]);
    out.push(["TF-24", variant, { ...list, reachedByTab: reachedList }]);
    await close();
  }

  // TF-23 — arrows on the focused strip.
  {
    const { page, close } = await openTrace();
    await page.locator(S.stripImage).first().focus();
    const before = await page.evaluate(() => location.hash);
    await press(page, "ArrowRight"); await page.waitForTimeout(200);
    const afterArrowRight = await page.evaluate(() => location.hash);
    await press(page, "Enter"); await page.waitForTimeout(200);
    const afterEnter = await page.evaluate(() => location.hash);
    out.push(["TF-23", variant, { before, afterArrowRight, afterEnter, selectionChanges: afterArrowRight !== before || afterEnter !== before }]);
    await close();
  }

  // TF-25 — select an event with the keyboard alone, by either route.
  {
    const { page, close } = await openTrace();
    const start = await page.evaluate(() => location.hash);
    await page.evaluate(() => document.activeElement?.blur());
    let onStrip = false;
    for (let i = 0; i < 25 && !onStrip; i++) { await press(page, "Tab"); onStrip = (await page.evaluate(() => window.__tf.focused())).strip; }
    for (let i = 0; i < 3; i++) await press(page, "ArrowRight");
    await press(page, "Enter"); await page.waitForTimeout(300);
    const afterStripKeys = await page.evaluate(() => location.hash);
    await press(page, "Tab");
    const onList = (await page.evaluate(() => window.__tf.focused())).list;
    await press(page, "ArrowDown"); await press(page, "Enter"); await page.waitForTimeout(300);
    const afterListKeys = await page.evaluate(() => location.hash);
    // Scrolling the list with ArrowDown moves the scrollspy, and Enter on a
    // card's own <summary>/<a> toggles or navigates — neither is a selection.
    // The list route counts only when the focused element IS a card (or a
    // row/option inside the list) and the hash names that card.
    const listFocus = await page.evaluate((sel) => {
      const el = document.activeElement; const card = el?.closest(sel.eventCard);
      if (!card) return { cardFocused: false, hashNamesFocusedCard: false };
      const own = el === card || ["option", "row", "listitem", "treeitem"].includes(el.getAttribute("role") ?? "");
      return { cardFocused: own, hashNamesFocusedCard: location.hash === `#${card.id}` };
    }, S);
    const cardPresent = (hash) => page.evaluate((h) => Boolean(document.getElementById(h.slice(1))), hash);
    const viaStrip = afterStripKeys !== start && await cardPresent(afterStripKeys);
    const viaList = listFocus.cardFocused && listFocus.hashNamesFocusedCard && afterListKeys !== start;
    out.push(["TF-25", variant, { start, reachedStrip: onStrip, afterStripKeys, reachedList: onList, afterListKeys, ...listFocus, selectable: viaStrip || viaList }]);
    await close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// C: TF-19 — the search freeze (TR-22). Runs in its OWN browser process so a
// wedged renderer can be killed without touching the rest of the run.
// ---------------------------------------------------------------------------
export async function searchFreeze(launch, fixture) {
  const browser = await launch();
  const probes = [];
  let status = null;
  let enterResolved = false;
  try {
    const { page } = await openPage(browser, fixture.traceUrl, { theme: "dark", tracePage: true });
    await page.focus(S.searchInput);
    await withTimeout(page.keyboard.type("to"), 5000, "type").catch(() => {});
    const enter = press(page, "Enter", 6000).then(() => { enterResolved = true; }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      try {
        status = await withTimeout(page.evaluate(() => window.__tf.status()), 2000, "evaluate");
        probes.push(true);
      } catch {
        probes.push(false); // no answer inside 2 s
      }
      await sleep(500);
    }
    await withTimeout(enter, 1000, "enter").catch(() => {});
  } finally {
    await withTimeout(browser.close(), 8000, "browser.close").catch(() => { try { browser.process()?.kill("SIGKILL"); } catch { /* already gone */ } });
  }
  const responsive = probes.length > 0 && probes.every(Boolean);
  return [["TF-19", null, { responsive, enterResolved, probesAnswered: probes, status }]];
}

// ---------------------------------------------------------------------------
// F: Tailwind bytes in a stylesheet (the composition itself is read in
// `structure`, off the DOM)
// ---------------------------------------------------------------------------
const bytes = (text) => Buffer.byteLength(text, "utf8");

/** Top-level CSS blocks (an @media block counts as one). Braces inside strings
 * are not a thing in this bundle, so plain brace counting is enough. */
function cssBlocks(css) {
  const blocks = []; let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { blocks.push({ start, end: i + 1, text: css.slice(start, i + 1) }); start = i + 1; }
  }
  return blocks;
}

const PREFLIGHT_START = "*,:before,:after{--tw-";
const PREFLIGHT_END = "[hidden]:where(:not([hidden=until-found])){display:none}";

/**
 * Bytes of Tailwind in a stylesheet: the preflight segment (from its first rule
 * to its last), plus tracer's utility rules — class rules that are not ui
 * component rules (`.cs-…`) and either read a --tw- variable, carry an escaped
 * utility selector (`\[`, `\:`, …), or sit after the preflight, where Tailwind
 * emits them. ui's own CSS also carries --tw- variables (it was built with
 * Tailwind); those are ui's bytes and are not counted here.
 */
export function tailwindBytes(css) {
  const preflightStart = css.indexOf(PREFLIGHT_START);
  const endIndex = css.indexOf(PREFLIGHT_END);
  const preflightEnd = endIndex >= 0 ? endIndex + PREFLIGHT_END.length : -1;
  const escaped = /\\[^\w\s]/;
  let preflight = 0, utilities = 0;
  for (const block of cssBlocks(css)) {
    const selector = block.text.slice(0, block.text.indexOf("{"));
    if (preflightStart >= 0 && preflightEnd > preflightStart && block.start >= preflightStart && block.end <= preflightEnd) { preflight += bytes(block.text); continue; }
    if (block.text.includes(".cs-")) continue;
    const utility = selector.startsWith("@")
      ? escaped.test(block.text)
      : selector.startsWith(".") && (block.text.includes("--tw-") || escaped.test(selector) || (preflightEnd > 0 && block.start >= preflightEnd));
    if (utility) utilities += bytes(block.text);
  }
  return { preflight, utilities, total: preflight + utilities, twVarRefs: css.split("--tw-").length - 1 };
}

// ---------------------------------------------------------------------------
// G: over every page the run opened
// ---------------------------------------------------------------------------
export function hygiene() {
  const external = ledger.external.flat();
  const errors = ledger.errors.flat();
  return [
    ["TF-29", null, { external: external.length, sample: external.slice(0, 5) }],
    ["TF-30", null, { errors: errors.length, sample: errors.slice(0, 5) }],
  ];
}
