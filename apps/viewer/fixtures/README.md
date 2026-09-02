# Viewer fixtures — the behavioural oracle

`apps/viewer/scripts/parity.mjs` proves the two export transports render identically.
Nothing proved the viewer *behaves* the same after a component migration: the
strip moving to a design-system component, the legend to another, the tooltip,
the loading rows, search highlighting, Tailwind going away. Pixels are allowed
to change across that work (the parity gate is re-baselined at the accepted
commit); behaviour, accessibility, keyboard reach, search responsiveness and
page size are not. This suite is what holds them.

It renders three fixture sessions (one large multi-chunk capture, one Codex
multi-agent run, one sub-agent run with real parent/child lanes) with
`bin/cs-tracer`, opens the pages in Chromium, measures, and compares with
`expectations.json`.

## Run

```
make build                                  # bin/cs-tracer, used to render the fixtures
npm run fixtures --workspace apps/viewer    # from the repo root
make fixtures                               # the same, after a build
```

Flags (after `--` with npm: `npm run fixtures -w apps/viewer -- --strict`):

| flag | what |
|---|---|
| `--strict` | an unmet `must-change` target fails the run |
| `--update` | rewrite the recorded `value` of every check from this run (see *Changing an expectation*) |
| `--fixture <key>` | only that fixture (`large-session`, `codex-multi-agent-run`, `subagent-run`); repeatable |
| `--only TF-01,TF-11` | only those checks |
| `--report <file>` | dump the measured values and the table as JSON |
| `--keep-pages <dir>` | render into `<dir>` and leave the pages there |

The browser comes from `$TRACER_FIXTURES_BROWSER`, then `$CS_TRACER_CHROMIUM`
(the parity gate's variable), then `$CHROME_BIN`, then `/usr/bin/chromium-browser`.
The binary comes from `$TRACER_FIXTURES_BIN`, else `bin/cs-tracer`. Chromium
runs without its sandbox, as parity does. The whole run takes under a minute.

The suite is deliberately not part of `make check`: `check` stays the
contract every commit meets, and this suite carries `must-change` targets that
are *meant* to be unmet until the migration lands.

## Files

| file | role |
|---|---|
| `run.mjs` | the runner: render, measure, compare, print, exit code |
| `checks.mjs` | the check ids and what each measures |
| `selectors.mjs` | the ONE place the suite touches the DOM |
| `lib.mjs` | rendering, browser plumbing, comparison helpers |
| `expectations.json` | one entry per check: `{id, name, status, target?, note, value}` |

## The two statuses

**`keep`** — the measured value must equal the recorded one, deep-equal, or
the run fails. These are the behaviours the migration must preserve: lane
structure, per-lane event counts, legend entries, chip counts, search results,
filter end states, routing in both transports, theme persistence, tab order up
to the strip, the embedded data bytes, zero external requests, zero page errors.

**`must-change`** — the recorded value is today's baseline and `target` says
where it has to go. The runner reports `pending` / `met` (and `moved` when the
value differs from the baseline without meeting the target). Only `--strict`
turns `pending` into a failure. A target is a literal, or `"<=N"` / `">=N"` on
a number; a path starting with `*.` quantifies over every variant (fixture, or
fixture/theme/page) and is met only when all of them meet it.

## Selectors move, values do not

When the DOM changes under a component swap, **edit `selectors.mjs`**. A
selector that stops matching surfaces as a `null` or a `0` in a measured value,
which is a `keep` mismatch — the fix is the selector. The expectation values are
behaviour; the only honest way to change one is a deliberate product change,
re-measured with `--update`, with the commit saying why the behaviour changed.
`--update` refreshes `value` only; `status`, `target` and `note` are kept.

Two selector-adjacent contracts the checks lean on: the strip exposes its CSS
pixels-per-event as `data-cell-width` (the click check computes x from it), and
the strip's accessible name ends in `N events`. If a replacement component
exposes these differently, map them in `selectors.mjs`.

## What is measured (TF-01 … TF-32)

Structure is read on every fixture × both themes (values keyed
`<fixture>/<theme>`); interactions and keyboard on the dark theme (keyed
`<fixture>`). Viewport 1280×900, the parity gate's.

| id | check | what |
|---|---|---|
| TF-01 | `index.lanes` | lane count, titles, parent id and depth per lane |
| TF-02 | `index.laneEvents` | event count per lane from the strip's label; spawn markers, fork connectors, badges |
| TF-03 | `index.legend` | legend entries in order |
| TF-04 | `index.rollup` | the rollup line text |
| TF-05 | `theme.attr` | `<html data-theme>` under each seeded theme |
| TF-06 | `trace.stripEvents` | event count in the trace strip's label; strip focusable |
| TF-07 | `trace.kindChips` | the 7 chips, pressed state, and the event count each governs (from the summary data) |
| TF-08 | `trace.firstLast` | first/last event ids, first card at load, hash at load |
| TF-09 | `trace.cardsAtLoad` | cards in the DOM at load (virtualized) |
| TF-10 | `trace.searchPresent` | search input and button |
| TF-11 | `search.tool` | fill "tool", settle past the debounce, Enter → status text, first 5 match ids |
| TF-12 | `filter.chipTool` | tool chip off/on: data count, first 5 displayed, last after scroll-to-end |
| TF-13 | `filter.noneAll` | none → empty-state text; all → restored |
| TF-14 | `filter.errorsOnly` | errors-only: data count, first 5, last, empty text |
| TF-15 | `strip.click` | click cell 10: the selection written to the hash; index lane → `?trace=…#ev-10` |
| TF-16 | `nav.hash` | `#ev-N` deep link → card N rendered, no loading rows |
| TF-17 | `modes.links` | single vs split: lane href, back link, nav link, trace mounts |
| TF-18 | `theme.toggle` | system(dark) → light → persisted → dark |
| TF-19 | `search.responsive` | **must-change**: type "to" fast + Enter inside the debounce; page answers within 2 s (TR-22) |
| TF-20 | `a11y.axe` | **must-change**: axe violations per page × theme; target no serious/critical nodes |
| TF-21 | `keys.tabStops` | Tab stops up to the strip |
| TF-22 | `keys.stripReachable` | the strip is a Tab stop |
| TF-23 | `keys.stripArrows` | **must-change**: ArrowRight/Enter on the strip moves the selection |
| TF-24 | `keys.listFocusable` | **must-change**: the event list has an explicit `tabindex` |
| TF-25 | `keys.selectWithoutMouse` | **must-change**: an event selectable by keyboard alone |
| TF-26 | `size.page` | **must-change**: page bytes (with CSS/JS split) within budget |
| TF-27 | `size.data` | embedded data bytes and block count |
| TF-28 | `size.tailwind` | **must-change**: Tailwind bytes in the CSS → 0 |
| TF-29 | `net.external` | requests beyond file:/data:/blob: over the run |
| TF-30 | `errors.page` | page errors + console errors over the run |
| TF-31 | `search.highlight` | **must-change**: search hits wrapped in `<mark>` |
| TF-32 | `nav.targetInView` | **must-change**: after a deep link or strip click the selected card is on screen and the hash still names it |

Notes on the measurements:

- *Counts* in TF-07, TF-12 and TF-14 come from the page's own summary data
  block (`#s-<id>`), not the DOM: the DOM is then held to showing the right
  first and last events for that count. The virtualizer renders a handful of
  cards, so "first 5 displayed" scrolls until it has seen five.
- TF-19 runs in its own browser process with hard timeouts; today the renderer
  wedges and the suite reports that without hanging.
- TF-28 counts the preflight segment plus tracer's own utility rules. The ui
  package's CSS also carries `--tw-` variables (it was built with Tailwind);
  those are ui's bytes and are excluded by their `.cs-` selectors.
- TF-32's baseline can differ between runs: where the scroll lands relative to
  the target card depends on row measurement timing. That instability is the
  finding; the target is stability.
- `must-change` baselines are informational. `keep` values were run three
  times before being recorded and did not move.

## Changing an expectation

1. Selector drift → `selectors.mjs`.
2. A deliberate behaviour change → `node fixtures/run.mjs --update`, review the
   diff of `expectations.json` (pretty-printed, one field per line, so the diff
   shows exactly which values moved), and say in the commit which behaviour
   changed and why.
3. A `must-change` target met → leave the entry; the table shows `met`. Once the
   migration is accepted, the maintainer may flip those entries to `keep` with
   `--update` so the new behaviour is held too.

`npx eslint fixtures` lints the suite (the viewer's eslint config knows this
directory); it is not part of `npm run lint`.
