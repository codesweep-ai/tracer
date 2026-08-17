import type { LoadedTrace } from "./types";

// Mode-aware routing for the two export artifacts (SPEC.md §5). One bundle
// serves both modes; the export assembler injects
//   <script type="application/json" id="mode">{"mode":"single"|"split"}</script>
// and linkTo() resolves at runtime. The URL scheme is unchanged: single mode
// keeps `?trace=<id>#ev-<n>`; split mode lets the filename do the job of
// `?trace=` (`traces/<safeId>.html#ev-<n>`), with `../index.html` breadcrumbs.

export type ViewerMode = "single" | "split";

type RouteIndexEntry = { id?: string; path?: string; safeId?: string };

/** The injected `#mode` data block, defaulting to "single" when absent (dev server, tests). */
export function mode(): ViewerMode {
  const block = document.getElementById("mode");
  if (!block) return "single";
  try {
    return (JSON.parse(block.textContent ?? "") as { mode?: string }).mode === "split" ? "split" : "single";
  } catch {
    return "single"; // a corrupt mode block must not break routing; loadIndex reports data errors
  }
}

/** True on split-mode trace pages (`traces/<safeId>.html`), false on both index pages. */
export function inTracePage(): boolean {
  return /(?:^|\/)traces\/[^/]+\.html$/.test(location.pathname);
}

/** Entries of the `#index` block — full ({id, path}) on index pages, reduced ({id, safeId, title}) on trace pages. */
function indexEntries(): RouteIndexEntry[] | undefined {
  const block = document.getElementById("index");
  if (!block) return undefined;
  try {
    const trajectories = (JSON.parse(block.textContent ?? "") as { trajectories?: RouteIndexEntry[] }).trajectories;
    return Array.isArray(trajectories) ? trajectories : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The filename a trace page lives at in split mode. Prefers the exporter's own
 * mapping (reduced index `safeId`, or full index `path`, which the exporter
 * already fills with safeId) so collision disambiguation is honoured; falls back
 * to the safeId transform itself (`[^A-Za-z0-9._-]` → `-`).
 */
export function traceFilename(traceId: string): string {
  const entry = indexEntries()?.find((candidate) => candidate.id === traceId);
  const base = entry?.safeId ?? entry?.path ?? traceId.replace(/[^A-Za-z0-9._-]/g, "-") ?? "";
  return `${encodeURIComponent(base || "trajectory")}.html`;
}

/** Where a link to `traceId` (optionally deep-linked to `#ev-<n>`) points from the current page. */
export function linkTo(traceId: string, eventIndex?: number): string {
  const hash = eventIndex == null ? "" : `#ev-${eventIndex}`;
  if (mode() === "single") return `?trace=${encodeURIComponent(traceId)}${hash}`;
  const filename = `${traceFilename(traceId)}${hash}`;
  return inTracePage() ? filename : `traces/${filename}`;
}

/** Target of the "← All trajectories" breadcrumb and the header nav item. */
export function indexLink(): string {
  if (mode() === "split") return inTracePage() ? "../index.html" : "index.html";
  return "?"; // query-only relative URL: same file, trace param and hash dropped; works under file://
}

/**
 * The route read (replaces App.tsx's bare URLSearchParams). Single mode is
 * unchanged: `?trace=<id>`. Split mode has no query param — the filename does
 * the job — and a trace page carries exactly one summary block (its own), so
 * data.loadIndex surfaces exactly one trace; use it only then, so a one-trace
 * corpus still shows the IndexPage at the root.
 */
export function currentTraceId(traces: LoadedTrace[]): string | null {
  const requested = new URLSearchParams(location.search).get("trace");
  if (requested) return requested;
  if (mode() === "split" && inTracePage() && traces.length === 1) return traces[0]!.id;
  return null;
}
