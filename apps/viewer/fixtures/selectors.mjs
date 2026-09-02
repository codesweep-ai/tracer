// selectors.mjs — the ONE place the fixture suite touches the viewer's DOM.
//
// When a component moves (strip → EventLanes, legend → Legend, tooltip →
// ChartTooltip, …) the DOM changes and these selectors change with it. The
// expectation VALUES in expectations.json do not: they describe behaviour,
// not markup. A selector that no longer matches anything shows up as a null
// or a count of 0 in the measured value, which is a `keep` mismatch — fix the
// selector, not the expectation.
//
// Every entry is a CSS selector unless the name says otherwise (…Attr = an
// attribute name read off the matched element; THEME = storage contract).

export const S = {
  // ---- pages ---------------------------------------------------------------
  indexPage: '[data-testid="index-page"]',
  tracePage: '[data-testid="trajectory-page"]',
  pageTitle: "main h1",
  themeAttr: "data-theme", // attribute on <html> that carries the resolved theme

  // ---- index page ------------------------------------------------------------
  lane: '[data-testid="lane"]',
  laneIdAttr: "data-trace-id",
  laneParentAttr: "data-parent-trace-id",
  laneSpawnAttr: "data-spawn-index",
  laneLink: "a[href]", // within a lane: the title link to the trace page
  statusBadge: '[data-component="StatusBadge"]', // within a lane
  spawnMarker: '[data-testid="spawn-marker"]', // within a lane's strip
  forkConnector: '[data-testid="fork-connector"], [data-testid="offscreen-fork-connector"]',
  indexLegend: '[data-testid="index-page"] [data-component="Legend"]', // Legend's documented root hook
  indexLegendItem: "[data-legend-label]", // within indexLegend: one per swatch/label pair; Legend's documented label hook (paired with the swatch by item id)
  indexLegendExtra: '[data-testid="index-legend-extra"]', // the extras are tracer's own content passed to Legend's slot, so they carry tracer's own hook
  rollup: '[data-testid="index-page"] h1 + p', // "N lanes · N events · N tokens …"

  // ---- the strip (index lanes and the trace page) ------------------------------
  strip: '[data-testid="strip"]', // tracer's wrapper around EventLanes (carries the cell-width contract)
  stripCellWidthAttr: "data-cell-width", // on `strip`: CSS px per event; the click check relies on it
  stripCellOffsetAttr: "data-cell-offset", // on `strip`: axis boundary padding; ink starts this far right of the axis origin (EventLanes' selection-halo overhang reservation)
  stripImage: "[data-event-lanes-scroller]", // the focusable, labelled surface ("<id> event strip: N events"); EventLanes' documented scroller hook, the horizontal scroll owner
  stripCanvas: "[data-event-lanes-canvas]", // EventLanes' documented main drawing surface
  stripTooltip: '[data-component="ChartTooltip"]', // EventLanes' tooltip shell, by its documented root hook

  // ---- trace page: filters ------------------------------------------------------
  searchInput: "[data-search-input]", // SearchInput's documented fill/focus surface
  searchButton: "[data-search-submit]", // SearchInput's documented submit hook
  searchStatus: "[data-search-status]", // the "N matches[ · scanning k/n]" live region, by SearchInput's documented hook
  kindChip: "button:has([data-legend-label])", // Legend's chips, anchored on its documented label hook (extras carry no label hook, so errors-only is excluded without a :not)
  errorsOnly: '[data-testid="errors-only"]',
  filterAll: '[data-testid="filter-all"]',
  filterNone: '[data-testid="filter-none"]',
  backLink: '[data-testid="trajectory-page"] a[href]', // "← All trajectories" (first link on the page)
  navIndexLink: "[data-header-nav-link]", // the "Trajectories" nav item, by AppShell's documented header nav-link hook

  // ---- trace page: event list ------------------------------------------------------
  virtualList: '[data-testid="virtual-event-list"]',
  // Cards carry data-card-index: EventLanes' census options also carry
  // data-event-index, so the strip's attribute can no longer name a card.
  eventCard: "[data-card-index]",
  eventIndexAttr: "data-card-index",
  loadingRow: '[aria-label^="Loading event"]', // a row whose chunk has not arrived yet
  emptyFilter: '[data-testid="empty-filter"]',
  childLink: 'a[href*="trace"]', // within an event card: "Open child trajectory →"
  highlight: "[data-highlight-match]", // what HighlightText wraps a search hit in, by its documented match hook

  // ---- chrome -----------------------------------------------------------------------
  themeToggle: '[data-component="ThemeToggle"]',
};

// The theme contract the chrome's ThemeToggle implements (from @codesweep-ai/ui):
// mode is stored under THEME.storageKey as "light" | "dark" | "system"; the
// resolved theme is stamped on <html data-theme>. Cycle order: system → light → dark.
export const THEME = { storageKey: "cs-theme", attr: "data-theme" };

// The data blocks the export assembler embeds (SPEC.md §5). Read by Node from
// the rendered file to derive data-side expectations (event counts per kind,
// error counts) that the DOM is then held to.
export const DATA_BLOCK = { index: "index", summary: (id) => `s-${id}`, mode: "mode" };
