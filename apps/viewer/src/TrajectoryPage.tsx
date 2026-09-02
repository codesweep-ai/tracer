import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Legend, SearchInput, Skeleton, StatusBadge } from "@codesweep-ai/ui";
import { loadChunk, scanChunkText } from "./data";
import { indexLink } from "./routes";
import { compact, duration, money } from "./format";
import { EventCard } from "./EventCard";
import { EventStrip, LEGEND_CHIPS, RedactedKey } from "./EventStrip";
import { ErrorSwatch } from "./ErrorSwatch";
import { TRACE_PALETTE, traceColorKey } from "./palette";
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
/** The nav intent is discharged only when the target CARD verifiably intersects
 * the list viewport — estimated offsets can name the right index while the card
 * itself is still off-screen (row measurement shifts them), which is exactly the
 * TF-32 failure: the spy used to take over from that premature landing. */
function cardInView(list: HTMLElement, i: number): boolean {
  const card = list.querySelector(`[data-card-index="${i}"]`);
  if (!card) return false;
  const cardRect = card.getBoundingClientRect(); const listRect = list.getBoundingClientRect();
  return cardRect.bottom > listRect.top && cardRect.top < listRect.bottom;
}
function MeasuredEventCard({ event, query, onHeight }: { event: Parameters<typeof EventCard>[0]["event"]; query?: string; onHeight: (eventIndex: number, height: number) => void }) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = row.current; if (!element) return;
    const measure = () => onHeight(event.i, element.getBoundingClientRect().height);
    measure(); if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [event.i, onHeight]);
  return <div ref={row}><EventCard event={event} query={query} /></div>;
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
  // Every position the nav effect has scrolled the list to. A scroll event
  // landing on one of them is the ECHO of our own scrollTo, not user input —
  // and scroll events carry no causality, so the echo can arrive after the
  // intent it served has discharged, by which time row measurement has shifted
  // the offsets under that fixed position and the resolver names a neighbour.
  // Read as a user scroll, the echo re-selects the neighbour and the hash
  // flips: the index-lane navigation coin flip (TF-32). So an echo may
  // discharge a pending intent but never selects. Positions are kept for the
  // life of the page: a user scroll landing on one to the pixel loses a single
  // spy update and the next event in the stream corrects it.
  const programmaticTops = useRef<number[]>([]);
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

  // Memoized so SearchInput's debounce effect (which depends on onSearch identity)
  // is not re-armed on every render of this page (TR-22).
  const onSearch = useCallback((value: string) => setActiveQuery(value.trim()), []);

  const selectEvent = useCallback((index: number) => {
    pendingNavTarget.current = index;
    setNavRequest({ index, sequence: ++navSequence.current });
  }, []);

  useEffect(() => { const onHashChange = () => { const index = hashEventIndex(trace.summary.strip.length); if (index == null) return; pendingNavTarget.current = index; setNavRequest({ index, sequence: ++navSequence.current }); const chunk = Math.floor(index / trace.summary.chunkSize); void loadChunk(trace.path, chunk).then((data) => setLoadedChunks((current) => current.get(chunk) === data ? current : new Map(current).set(chunk, data))); }; window.addEventListener("hashchange", onHashChange); return () => window.removeEventListener("hashchange", onHashChange); }, [trace.path, trace.summary.chunkSize, trace.summary.strip.length]);
  // Never dispatch for a chunk already loaded: the cached loadChunk promise
  // resolves on a microtask, and an unconditional setLoadedChunks per effect
  // run is a self-sustaining render loop when the search commit lands inside
  // the Enter keydown's synchronous flush (TR-22's freeze). The ref keeps the
  // check honest without making loadedChunks an effect dependency.
  const loadedChunksRef = useRef(loadedChunks); loadedChunksRef.current = loadedChunks;
  useEffect(() => { const chunks = new Set<number>(); for (let position = visible.start; position < visible.end; position++) { const eventIndex = displayed[position]; if (eventIndex != null) chunks.add(Math.floor(eventIndex / trace.summary.chunkSize)); } chunks.forEach((chunk) => { if (loadedChunksRef.current.has(chunk)) return; void loadChunk(trace.path, chunk).then((data) => setLoadedChunks((current) => current.get(chunk) === data ? current : new Map(current).set(chunk, data))); }); }, [displayed, trace.path, trace.summary.chunkSize, visible.end, visible.start]);
  useEffect(() => { const target = navRequest.index; if (pendingNavTarget.current !== target) return; setSelected(target); const position = displayed.indexOf(target); const element = viewport.current; if (position >= 0 && element) { const atScrollEnd = element.scrollTop >= element.scrollHeight - element.clientHeight - 1; if (cardInView(element, target) && (atScrollEnd || displayed[positionAtOffset(offsets, element.scrollTop)] === target)) pendingNavTarget.current = null; else { const top = offsets[position] ?? 0; programmaticTops.current.push(top); element.scrollTo({ top, behavior: "auto" }); } } history.replaceState(null, "", `#ev-${target}`); }, [displayed, navRequest, offsets]);
  useEffect(() => { if (pendingNavTarget.current == null) history.replaceState(null, "", `#ev-${selected}`); }, [selected]);
  // A filter change is a navigation intent, resolved ONCE, when the displayed set is
  // final. A text scan lands progressively (matches grow per chunk — instantly when
  // the chunks are cached), and a shrinking list makes the browser clamp scrollTop,
  // which it dispatches as a scroll event after paint: if the scrollspy read that
  // clamp as user input before the correction landed, the end state depended on
  // event timing and the two transports could diverge (the parity interaction
  // flake). So the layout phase of a filter commit raises correctOnLand — muting
  // the spy — and the correction itself (re-assert the selected card, else select
  // the first survivor) runs once the final, non-empty set is in hand.
  const prevFilter = useRef({ activeQuery: "", errorsOnly: false, kinds });
  const correctOnLand = useRef(false);
  useLayoutEffect(() => {
    const prev = prevFilter.current; prevFilter.current = { activeQuery, errorsOnly, kinds };
    if (prev.activeQuery !== activeQuery || prev.errorsOnly !== errorsOnly || prev.kinds !== kinds) correctOnLand.current = true;
    const pendingUnreachable = pendingNavTarget.current != null && !displayed.includes(pendingNavTarget.current);
    if (!correctOnLand.current && !pendingUnreachable) return;
    if (!displayed.length || searching) return;
    correctOnLand.current = false;
    selectEvent(displayed.includes(selected) ? selected : displayed[0]!);
  }, [displayed, selected, activeQuery, errorsOnly, kinds, searching, selectEvent]);
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
  const filtering = kinds.size < EVENT_KINDS.length || errorsOnly;
  return <section data-testid="trajectory-page" className="trace-page">
    <div className="trace-header"><div><a href={indexLink()} className="back-link">← All trajectories</a><h1 className="trace-title">{trace.summary.meta.title ?? (trace.summary.meta.autoTitle ? <span className="auto-title" title="Derived from the session's first user message">{trace.summary.meta.autoTitle}</span> : trace.id)}</h1><p className="trace-meta">{trace.summary.meta.model ?? "Unknown model"} · {compact(trace.summary.totals.input + trace.summary.totals.output)} tokens · {duration(trace.summary.meta.durationMs)}{costLabel && <> · {costLabel}</>}{(trace.summary.meta.title ?? trace.summary.meta.autoTitle) && <> · <span className="trace-id">{trace.id}</span></>}</p></div>{trace.summary.parse.unrecognized > 0 && <StatusBadge label={`${trace.summary.parse.unrecognized} unrecognized`} status="warning" />}</div>
    <div aria-label="Trajectory filters" className="filters-row">
      <SearchInput value={query} onChange={setQuery} onSearch={onSearch} minChars={1} placeholder="Filter event text or tool names" noResults={Boolean(activeQuery) && !searching && matches.size === 0} status={activeQuery ? `${matches.size} matches${searching ? ` · scanning ${scanned}/${trace.summary.chunkCount}` : ""}` : undefined} className="trace-search" />
      <Legend
        role="group"
        aria-label="Event legend"
        className="kind-legend"
        items={LEGEND_CHIPS.map((chip) => ({ id: chip.label, label: chip.label, color: TRACE_PALETTE[traceColorKey(chip.kinds[0]!)], shape: "square" as const }))}
        selected={new Set(LEGEND_CHIPS.filter((chip) => chip.kinds.every((kind) => kinds.has(kind))).map((chip) => chip.label))}
        onChange={(next) => { const nextKinds = new Set<EventKind>(); for (const chip of LEGEND_CHIPS) if (next.has(chip.label)) chip.kinds.forEach((kind) => nextKinds.add(kind)); setKinds(nextKinds); }}
        extras={<>
          <span aria-hidden="true" className="legend-sep">|</span>
          <RedactedKey />
          <span aria-hidden="true" className="legend-sep">|</span>
          {/* errors are an overlay flag, not a kind — this restricts rather than hides,
              so it gets its own affordance and composes (AND) with the chips and text search. */}
          <button type="button" data-testid="errors-only" aria-pressed={errorsOnly} title={errorsOnly ? "Show all events again" : "Show only events that errored"} onClick={() => setErrorsOnly(!errorsOnly)} className={errorsOnly ? "errors-only errors-only-on" : "errors-only"}><ErrorSwatch />{errorsOnly ? "errors only" : "error"}</button>
          <span className="filter-reset">
            <button type="button" data-testid="filter-all" onClick={() => { setKinds(new Set(EVENT_KINDS)); setErrorsOnly(false); }} disabled={!filtering} className="filter-reset-button">all</button>
            ·
            <button type="button" data-testid="filter-none" onClick={() => setKinds(new Set())} disabled={kinds.size === 0} className="filter-reset-button">none</button>
          </span>
        </>}
      />
    </div>
    <EventStrip events={trace.summary.strip} selected={selected} onSelect={selectEvent} label={`${trace.id} event strip`} laneLabel="" hiddenKinds={hiddenKinds} matches={stripMatches} textFiltering={Boolean(activeQuery) || errorsOnly} />
    <div ref={viewport} data-testid="virtual-event-list" tabIndex={0} role="region" aria-label="Events" className="virtual-list" onScroll={(event) => { const top = event.currentTarget.scrollTop; setScrollTop(top); const index = displayed[positionAtOffset(offsets, top)]; const pending = pendingNavTarget.current; if (pending != null) { if (index === pending && cardInView(event.currentTarget, pending)) pendingNavTarget.current = null; return; } if (programmaticTops.current.some((requested) => Math.abs(requested - top) < 1)) return; if (correctOnLand.current) return; if (index != null && index !== selected) setSelected(index); }}>
      {!displayed.length && <p role="status" data-testid="empty-filter" className="empty-filter">{kinds.size === 0 ? "No event kinds selected — pick one above, or choose all." : errorsOnly ? "No errored events in this trajectory." : "No events match this filter."}</p>}
      <div className="virtual-list-inner" style={{ height: offsets[offsets.length - 1] ?? 0 }}>
        <div className="virtual-list-window" style={{ top: offsets[visible.start] ?? 0 }}>{displayed.slice(visible.start, visible.end).map((i) => { const event = loadedChunks.get(Math.floor(i / trace.summary.chunkSize))?.events[i % trace.summary.chunkSize]; return event ? <MeasuredEventCard key={i} event={event} query={activeQuery} onHeight={recordHeight} /> : /* App-local layout token defined in styles.css. */ <div key={i} aria-label={`Loading event ${i}`}><Skeleton variant="rect" height="var(--event-row-height)" /></div>; })}</div>
      </div>
    </div>
  </section>;
}
