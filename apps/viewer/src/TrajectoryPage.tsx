import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SearchInput, StatusBadge } from "@codesweep-ai/ui";
import { loadChunk, scanChunkText } from "./data";
import { indexLink } from "./routes";
import { compact, duration, money } from "./format";
import { EventCard } from "./EventCard";
import { StripCanvas } from "./StripCanvas";
import { KindLegend } from "./KindLegend";
import type { EventKind, LoadedTrace, TraceChunk } from "./types";

const OVERSCAN = 3;
const EVENT_KINDS: EventKind[] = ["user", "assistant", "thinking", "tool_call", "tool_result", "system", "meta", "turn_end"];
function eventRowHeight(): number { const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--event-row-height")); return Number.isFinite(value) ? value : 224; }
function hashEventIndex(max: number): number | undefined { const match = location.hash.match(/^#ev-(\d+)$/); if (!match) return undefined; return Math.min(Number(match[1]), Math.max(0, max - 1)); }
function positionAtOffset(offsets: number[], offset: number): number {
  let low = 0; let high = Math.max(0, offsets.length - 2);
  while (low < high) { const middle = Math.ceil((low + high) / 2); if ((offsets[middle] ?? 0) <= offset) low = middle; else high = middle - 1; }
  return low;
}
function MeasuredEventCard({ event, onHeight }: { event: Parameters<typeof EventCard>[0]["event"]; onHeight: (eventIndex: number, height: number) => void }) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = row.current; if (!element) return;
    const measure = () => onHeight(event.i, element.getBoundingClientRect().height);
    measure(); if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [event.i, onHeight]);
  return <div ref={row}><EventCard event={event} /></div>;
}

export function TrajectoryPage({ trace }: { trace: LoadedTrace }) {
  const rowHeight = eventRowHeight(); const viewport = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(() => hashEventIndex(trace.summary.strip.length) ?? 0);
  // keep navigation intent pending until the viewport reports that target.
  // Scroll events from a previous jump may arrive before the nav effect; ignoring any
  // other spied index prevents those stale echoes from cancelling the newer intent.
  // A sequenced request also reasserts the target over a spy update queued beforehand.
  const pendingNavTarget = useRef<number | null>(selected);
  const navSequence = useRef(0); const [navRequest, setNavRequest] = useState({ index: selected, sequence: 0 });
  const [scrollTop, setScrollTop] = useState(selected * rowHeight); const [loadedChunks, setLoadedChunks] = useState(new Map<number, TraceChunk>());
  const [viewportHeight, setViewportHeight] = useState(0); const [measuredHeights, setMeasuredHeights] = useState(new Map<number, number>());
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(EVENT_KINDS)); const [query, setQuery] = useState(""); const [activeQuery, setActiveQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false); // a second filter dimension, ANDed with kinds + text const [query, setQuery] = useState(""); const [activeQuery, setActiveQuery] = useState("");
  const [matches, setMatches] = useState<Set<number>>(new Set()); const [scanned, setScanned] = useState(0); const [searching, setSearching] = useState(false);
  const hiddenKinds = useMemo(() => new Set(EVENT_KINDS.filter((kind) => !kinds.has(kind))), [kinds]);
  const displayed = useMemo(() => trace.summary.strip.filter((entry) => !hiddenKinds.has(entry.kind) && (!errorsOnly || entry.error) && (!activeQuery || matches.has(entry.i))).map((entry) => entry.i), [activeQuery, errorsOnly, hiddenKinds, matches, trace.summary.strip]);
  const offsets = useMemo(() => { const next = new Array<number>(displayed.length + 1); next[0] = 0; for (let position = 0; position < displayed.length; position++) next[position + 1] = next[position]! + (measuredHeights.get(displayed[position]!) ?? rowHeight); return next; }, [displayed, measuredHeights, rowHeight]);
  const visible = useMemo(() => { if (!displayed.length) return { start: 0, end: 0 }; const first = positionAtOffset(offsets, scrollTop); const last = positionAtOffset(offsets, scrollTop + (viewportHeight || rowHeight * 12)); return { start: Math.max(0, first - OVERSCAN), end: Math.min(displayed.length, last + OVERSCAN + 1) }; }, [displayed.length, offsets, rowHeight, scrollTop, viewportHeight]);
  // Errors-only reuses the strip's existing dimming channel: non-matching cells ghost out
  // so the ✕ marks stand alone. With a text query too, the intersection is what is lit.
  const stripMatches = useMemo(() => {
    if (!errorsOnly) return matches;
    const errored = new Set(trace.summary.strip.filter((entry) => entry.error).map((entry) => entry.i));
    return activeQuery ? new Set([...errored].filter((i) => matches.has(i))) : errored;
  }, [activeQuery, errorsOnly, matches, trace.summary.strip]);
  const recordHeight = useCallback((eventIndex: number, height: number) => { setMeasuredHeights((current) => { if (Math.abs((current.get(eventIndex) ?? 0) - height) < 0.5) return current; return new Map(current).set(eventIndex, height); }); }, []);

  const selectEvent = useCallback((index: number) => {
    pendingNavTarget.current = index;
    setNavRequest({ index, sequence: ++navSequence.current });
  }, []);

  useEffect(() => { const onHashChange = () => { const index = hashEventIndex(trace.summary.strip.length); if (index == null) return; pendingNavTarget.current = index; setNavRequest({ index, sequence: ++navSequence.current }); const chunk = Math.floor(index / trace.summary.chunkSize); void loadChunk(trace.path, chunk).then((data) => setLoadedChunks((current) => new Map(current).set(chunk, data))); }; window.addEventListener("hashchange", onHashChange); return () => window.removeEventListener("hashchange", onHashChange); }, [trace.path, trace.summary.chunkSize, trace.summary.strip.length]);
  useEffect(() => { const chunks = new Set<number>(); for (let position = visible.start; position < visible.end; position++) { const eventIndex = displayed[position]; if (eventIndex != null) chunks.add(Math.floor(eventIndex / trace.summary.chunkSize)); } chunks.forEach((chunk) => { void loadChunk(trace.path, chunk).then((data) => setLoadedChunks((current) => new Map(current).set(chunk, data))); }); }, [displayed, trace.path, trace.summary.chunkSize, visible.end, visible.start]);
  useEffect(() => { const target = navRequest.index; if (pendingNavTarget.current !== target) return; setSelected(target); const position = displayed.indexOf(target); const element = viewport.current; if (position >= 0 && element) { const targetTop = offsets[position] ?? 0; if (Math.abs(element.scrollTop - targetTop) < 1) pendingNavTarget.current = null; else element.scrollTo({ top: targetTop, behavior: "auto" }); } history.replaceState(null, "", `#ev-${target}`); }, [displayed, navRequest, offsets]);
  useEffect(() => { if (pendingNavTarget.current == null) history.replaceState(null, "", `#ev-${selected}`); }, [selected]);
  useEffect(() => { if (displayed.length && !displayed.includes(selected)) { pendingNavTarget.current = null; setSelected(displayed[0]!); } }, [displayed, selected]);
  useLayoutEffect(() => { const element = viewport.current; if (!element) return; const measure = () => setViewportHeight(element.clientHeight); measure(); if (typeof ResizeObserver === "undefined") return; const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect(); }, []);
  useEffect(() => {
    let cancelled = false; const needle = activeQuery.trim().toLocaleLowerCase();
    if (!needle) { setMatches(new Set()); setScanned(0); setSearching(false); return () => { cancelled = true; }; }
    setMatches(new Set(trace.summary.strip.filter((entry) => entry.label?.toLocaleLowerCase().includes(needle)).map((entry) => entry.i))); setScanned(0); setSearching(true);
    void (async () => { for (let chunk = 0; chunk < trace.summary.chunkCount; chunk++) { const found = await scanChunkText(trace.path, chunk, needle); if (cancelled) return; setMatches((current) => new Set([...current, ...found])); setScanned(chunk + 1); } if (!cancelled) setSearching(false); })();
    return () => { cancelled = true; };
  }, [activeQuery, trace.path, trace.summary.chunkCount, trace.summary.strip]);

  // money() is empty for an unpriced lane; its separator must go with it.
  const costLabel = money(trace.summary.totals.cost, trace.summary.totals.costEstimated);
  return <section data-testid="trajectory-page" className="h-full min-h-0 flex flex-col gap-[var(--space-3)]">
    <div className="flex items-start justify-between gap-[var(--space-3)]"><div><a href={indexLink()} className="[color:var(--color-link)]">← All trajectories</a><h1 className="[font-size:var(--font-size-page-title)] [font-weight:var(--font-weight-bold)]">{trace.summary.meta.title ?? (trace.summary.meta.autoTitle ? <span className="italic" title="Derived from the session's first user message">{trace.summary.meta.autoTitle}</span> : trace.id)}</h1><p className="[color:var(--muted)] [font-size:var(--font-size-caption)]">{trace.summary.meta.model ?? "Unknown model"} · {compact(trace.summary.totals.input + trace.summary.totals.output)} tokens · {duration(trace.summary.meta.durationMs)}{costLabel && <> · {costLabel}</>}{(trace.summary.meta.title ?? trace.summary.meta.autoTitle) && <> · <span className="font-mono">{trace.id}</span></>}</p></div>{trace.summary.parse.unrecognized > 0 && <StatusBadge label={`${trace.summary.parse.unrecognized} unrecognized`} status="warning" />}</div>
    <div aria-label="Trajectory filters" className="flex items-start gap-[var(--space-3)] flex-wrap">
      <SearchInput value={query} onChange={setQuery} onSearch={(value) => setActiveQuery(value.trim())} minChars={1} placeholder="Filter event text or tool names" noResults={Boolean(activeQuery) && !searching && matches.size === 0} className="min-w-[var(--input-min-width)]" />
      <KindLegend kinds={kinds} onKindsChange={setKinds} errorsOnly={errorsOnly} onErrorsOnlyChange={setErrorsOnly} allKinds={EVENT_KINDS} />
      {activeQuery && <span role="status" className="py-[var(--space-2)] [font-size:var(--font-size-caption)] [color:var(--muted)]">{matches.size} matches{searching ? ` · scanning ${scanned}/${trace.summary.chunkCount}` : ""}</span>}
    </div>
    <StripCanvas events={trace.summary.strip} selected={selected} onSelect={selectEvent} label={`${trace.id} event strip`} hiddenKinds={hiddenKinds} matches={stripMatches} textFiltering={Boolean(activeQuery) || errorsOnly} />
    <div ref={viewport} data-testid="virtual-event-list" className="flex-1 min-h-0 overflow-y-auto" onScroll={(event) => { const top = event.currentTarget.scrollTop; setScrollTop(top); const index = displayed[positionAtOffset(offsets, top)]; const pending = pendingNavTarget.current; if (pending != null) { if (index === pending) pendingNavTarget.current = null; return; } if (index != null && index !== selected) setSelected(index); }}>
      {!displayed.length && <p role="status" data-testid="empty-filter" className="[color:var(--muted)] py-[var(--space-4)]">{kinds.size === 0 ? "No event kinds selected — pick one above, or choose all." : errorsOnly ? "No errored events in this trajectory." : "No events match this filter."}</p>}
      <div className="relative" style={{ height: offsets[offsets.length - 1] ?? 0 }}>
        <div className="absolute inset-x-0" style={{ top: offsets[visible.start] ?? 0 }}>{displayed.slice(visible.start, visible.end).map((i) => { const event = loadedChunks.get(Math.floor(i / trace.summary.chunkSize))?.events[i % trace.summary.chunkSize]; return event ? <MeasuredEventCard key={i} event={event} onHeight={recordHeight} /> : /* App-local layout token defined in styles.css. */ <div key={i} className="h-[var(--event-row-height)] animate-pulse rounded-[var(--radius-md)] bg-[var(--color-bg-muted)]" aria-label={`Loading event ${i}`} />; })}</div>
      </div>
    </div>
  </section>;
}
