import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChartTheme } from "@codesweep-ai/ui";
import type { EventKind, StripEvent } from "./types";
import { eventLabel } from "./format";
import { traceColorKey, traceSeriesColors } from "./traceColors";

const CELL_WIDTH = 10;

/** the ✕ that marks an errored event, drawn over its kind colour. A surface
 * casing under the stroke keeps it legible on every fill (amber included). */
export function drawErrorMark(ctx: CanvasRenderingContext2D, x: number, y: number, side: number, surface: string, errorColor: string): void {
  if (side < 5) return; // below this the glyph is mush; the overview band carries errors instead
  const inset = Math.max(1, side * 0.17);
  const x0 = x + inset, y0 = y + inset, x1 = x + side - inset, y1 = y + side - inset;
  const stroke = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1, y0); ctx.lineTo(x0, y1); ctx.stroke(); };
  const previousCap = ctx.lineCap, previousWidth = ctx.lineWidth, previousStroke = ctx.strokeStyle;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.5, side * 0.38); ctx.strokeStyle = surface; stroke();
  ctx.lineWidth = Math.max(1.5, side * 0.22); ctx.strokeStyle = errorColor; stroke();
  ctx.lineCap = previousCap; ctx.lineWidth = previousWidth; ctx.strokeStyle = previousStroke;
}

const DRAW_OVERSCAN = 8;
const OVERVIEW_BUCKET_WIDTH = 3;

function StripOverview({ events, scroller, viewportWidth, scrollLeft, contentWidth }: { events: StripEvent[]; scroller: React.RefObject<HTMLDivElement | null>; viewportWidth: number; scrollLeft: number; contentWidth: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const theme = useChartTheme();
  // Three CSS pixels per bucket keeps phase/error changes legible without painting
  // one cell per event; aggregation below remains one pass over the summary strip.
  const buckets = Math.max(1, Math.floor(viewportWidth / OVERVIEW_BUCKET_WIDTH));
  const overview = useMemo(() => {
    const values = Array.from({ length: buckets }, () => ({ errors: 0, total: 0, counts: new Map<EventKind, number>() }));
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const bucket = values[Math.min(buckets - 1, Math.floor(index * buckets / events.length))];
      bucket.total++;
      if (event.error) bucket.errors++;
      bucket.counts.set(event.kind, (bucket.counts.get(event.kind) ?? 0) + 1);
    }
    return values.map((bucket) => {
      let kind: EventKind | undefined; let count = -1;
      for (const [candidate, candidateCount] of bucket.counts) if (candidateCount > count) { kind = candidate; count = candidateCount; }
      return { errorShare: bucket.total ? bucket.errors / bucket.total : 0, kind };
    });
  }, [buckets, events]);
  useEffect(() => {
    const node = canvas.current; if (!node) return;
    const rect = node.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio)); const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    if (node.width !== pixelWidth) node.width = pixelWidth; if (node.height !== pixelHeight) node.height = pixelHeight;
    const ctx = node.getContext("2d"); if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    const colors = traceSeriesColors(theme); const bucketWidth = rect.width / buckets;
    for (let index = 0; index < overview.length; index++) {
      const bucket = overview[index];
      ctx.fillStyle = bucket.kind ? colors[traceColorKey(bucket.kind)] ?? theme.muted : theme.muted;
      ctx.fillRect(index * bucketWidth, 0, Math.ceil(bucketWidth), rect.height);
      // Errors are a separate top-edge channel: never hidden, but never replacing the
      // kind shape. Height conveys prevalence; one CSS pixel keeps single errors visible.
      if (bucket.errorShare > 0) {
        const stripeHeight = Math.max(1, rect.height * bucket.errorShare);
        ctx.fillStyle = theme.error;
        ctx.fillRect(index * bucketWidth, 0, Math.ceil(bucketWidth), stripeHeight);
        // A bg casing separates neighboring pink/red tokens in dark themes, where
        // their luminance is otherwise nearly identical (the halo precedent).
        if (stripeHeight < rect.height) {
          ctx.fillStyle = theme.bg;
          ctx.fillRect(index * bucketWidth, stripeHeight, Math.ceil(bucketWidth), 1);
        }
      }
    }
  }, [buckets, overview, theme]);
  const windowStart = Math.max(0, Math.min(1, scrollLeft / contentWidth));
  const windowEnd = Math.max(windowStart, Math.min(1, (scrollLeft + viewportWidth) / contentWidth));
  const moveWindow = (clientX: number) => {
    const node = scroller.current; const rect = canvas.current?.getBoundingClientRect(); if (!node || !rect) return;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, fraction * node.scrollWidth - node.clientWidth / 2));
  };
  return <div data-testid="strip-overview" data-buckets={buckets} data-events={events.length} className="relative mb-[var(--space-1)] h-[var(--space-3)] w-full cursor-crosshair overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-bg-muted)] touch-none" onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); moveWindow(event.clientX); }} onPointerMove={(event) => { if (dragging.current) moveWindow(event.clientX); }} onPointerUp={(event) => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} onClick={(event) => moveWindow(event.clientX)}>
    <canvas ref={canvas} aria-hidden="true" className="block h-full w-full" />
    <span data-testid="strip-overview-window" data-window-start={windowStart} data-window-end={windowEnd} className="pointer-events-none absolute inset-y-0 border border-[var(--color-link)] bg-[var(--color-brand-accent-bg-strong)] opacity-60" style={{ left: `${windowStart * 100}%`, width: `${(windowEnd - windowStart) * 100}%` }} />
  </div>;
}

export function StripCanvas({ events, selected, onSelect, label, hiddenKinds, matches, textFiltering = false }: { events: StripEvent[]; selected?: number; onSelect?: (i: number) => void; label: string; hiddenKinds?: ReadonlySet<EventKind>; matches?: ReadonlySet<number>; textFiltering?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null); const overlay = useRef<HTMLCanvasElement>(null);
  const theme = useChartTheme(); const [hovered, setHovered] = useState<{ event: StripEvent; x: number; top: number }>(); const [viewportWidth, setViewportWidth] = useState(0); const [scrollLeft, setScrollLeft] = useState(0);
  const cellWidth = CELL_WIDTH;
  const contentWidth = Math.max(viewportWidth, events.length * cellWidth);
  const visibleStart = Math.max(0, Math.floor(scrollLeft / cellWidth) - DRAW_OVERSCAN);
  const visibleEnd = Math.min(events.length, Math.ceil((scrollLeft + viewportWidth) / cellWidth) + DRAW_OVERSCAN);

  useLayoutEffect(() => {
    const node = scroller.current; if (!node) return;
    const measure = () => setViewportWidth(node.clientWidth); measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = canvas.current; if (!node || !viewportWidth) return;
    const rect = node.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio)); const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    if (node.width !== pixelWidth) node.width = pixelWidth; if (node.height !== pixelHeight) node.height = pixelHeight;
    const ctx = node.getContext("2d"); if (!ctx) return; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    const colors = traceSeriesColors(theme);
    for (let index = visibleStart; index < visibleEnd; index++) {
      const event = events[index]; if (!event || hiddenKinds?.has(event.kind)) continue;
      const x = event.i * cellWidth - scrollLeft; const key = traceColorKey(event.kind);
      const matched = matches?.has(event.i) ?? false; ctx.globalAlpha = textFiltering && !matched ? 0.18 : 1;
      ctx.fillStyle = colors[key] ?? theme.muted;
      if (event.turnEnd) ctx.fillRect(Math.max(0, x - 0.5), 1, 1, rect.height - 2);
      else {
        const side = Math.max(1, Math.min(cellWidth - 1, rect.height - 8)); const y = (rect.height - side) / 2;
        ctx.fillRect(x, y, side, side);
        if (event.redacted) ctx.clearRect(x + 1, y + 1, Math.max(1, side - 2), Math.max(1, side - 2));
        // an error is a SHAPE over its kind colour, not a replacement colour —
        // so an errored tool call still reads as a tool call, and the mark survives any
        // fill (surface casing under the stroke, same trick as the selection ring).
        if (event.error) drawErrorMark(ctx, x, y, side, theme.bg, theme.error);
      }
    }
    ctx.globalAlpha = 1;
  }, [cellWidth, events, hiddenKinds, matches, scrollLeft, textFiltering, theme, viewportWidth, visibleEnd, visibleStart]);
  useEffect(() => {
    const node = overlay.current; if (!node || !viewportWidth) return;
    const rect = node.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; const pixelWidth = Math.max(1, Math.round(rect.width * ratio)); const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    if (node.width !== pixelWidth) node.width = pixelWidth; if (node.height !== pixelHeight) node.height = pixelHeight;
    const ctx = node.getContext("2d"); if (!ctx) return; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height); ctx.lineWidth = 2;
    if (matches) { ctx.strokeStyle = theme.accent; for (let index = visibleStart; index < visibleEnd; index++) { const event = events[index]; if (event && matches.has(event.i)) ctx.strokeRect(event.i * cellWidth - scrollLeft, 1, Math.max(2, cellWidth), rect.height - 2); } }
    if (selected != null && selected >= visibleStart && selected < visibleEnd) {
      // Two-tone halo: an fg-only ring vanishes against similar-luminance cell colors
      // (dark theme lightens the palette toward fg). The bg casing guarantees contrast.
      const x = selected * cellWidth - scrollLeft; const w = Math.max(2, cellWidth);
      ctx.lineWidth = 4; ctx.strokeStyle = theme.bg; ctx.strokeRect(x, 2, w, rect.height - 4);
      ctx.lineWidth = 2; ctx.strokeStyle = theme.fg; ctx.strokeRect(x, 2, w, rect.height - 4);
    }
  }, [cellWidth, events, matches, scrollLeft, selected, theme.accent, theme.bg, theme.fg, viewportWidth, visibleEnd, visibleStart]);
  // keep the selected cell visible — on long scrollable lanes the strip is a
  // live minimap, so when selection moves (click, deep link, or scrollspy) the window
  // follows. Only fires on selection change; manual strip scrolling is never overridden.
  useEffect(() => {
    const node = scroller.current; if (!node || selected == null || !viewportWidth) return;
    const x = selected * cellWidth;
    if (x < node.scrollLeft + cellWidth || x + cellWidth > node.scrollLeft + viewportWidth - cellWidth) node.scrollTo({ left: Math.max(0, x - viewportWidth / 2) });
  }, [cellWidth, selected, viewportWidth]);
  const locate = (clientX: number) => { const rect = overlay.current?.getBoundingClientRect(); if (!rect || !events.length) return; const index = Math.floor((clientX - rect.left + scrollLeft) / cellWidth); const event = index >= 0 && index < events.length ? events[index] : undefined; return event && !hiddenKinds?.has(event.kind) ? event : undefined; };
  const overflowing = viewportWidth > 0 && events.length * cellWidth > viewportWidth;
  return <div className="w-full min-w-0">
    {overflowing && <StripOverview events={events} scroller={scroller} viewportWidth={viewportWidth} scrollLeft={scrollLeft} contentWidth={contentWidth} />}
    <div ref={scroller} data-testid="strip" data-cell-width={cellWidth} className="relative w-full overflow-x-auto" onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}>
    {/* eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css. */}
    <div className="relative h-[var(--strip-height)] rounded-[var(--radius-sm)] bg-[var(--color-bg-muted)]" style={{ width: contentWidth }}>
      {/* eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css. */}
      <canvas ref={canvas} aria-hidden="true" className="sticky left-0 top-0 block h-[var(--strip-height)]" style={{ width: viewportWidth }} />
      {/* eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css. */}
      <canvas ref={overlay} role="img" aria-label={`${label}: ${events.length} events`} tabIndex={onSelect ? 0 : -1} className="sticky left-0 top-0 -mt-[var(--strip-height)] block h-[var(--strip-height)] cursor-crosshair" style={{ width: viewportWidth }} onMouseMove={(event) => { const found = locate(event.clientX); const rect = scroller.current?.getBoundingClientRect(); setHovered(found && rect ? { event: found, x: event.clientX, top: rect.top } : undefined); }} onMouseLeave={() => setHovered(undefined)} onClick={(event) => { const found = locate(event.clientX); if (found) onSelect?.(found.i); }} />
      {/* eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css. */}
      {events.filter((event) => event.subtask && event.childSessionId).map((event) => <span key={`${event.i}:${event.childSessionId}`} data-testid="spawn-marker" data-spawn-index={event.i} data-spawn-x={event.i * cellWidth + cellWidth / 2} data-child-session-id={event.childSessionId} aria-label={`Spawn ${event.childSessionId} at event ${event.i}`} className="pointer-events-none absolute top-[var(--space-0-5)] h-[calc(var(--strip-height)-2*var(--space-0-5))] border-2 border-[var(--color-brand)] rounded-[var(--radius-sm)]" style={{ left: event.i * cellWidth, width: Math.max(2, cellWidth - 1) }} />)}
    </div>
    {hovered && <div role="tooltip" className="pointer-events-none fixed z-[var(--z-sticky)] -translate-x-1/2 -translate-y-full whitespace-nowrap px-[var(--space-2)] py-[var(--space-1)] rounded-[var(--radius-sm)] bg-[var(--card)] border border-[var(--border)] [box-shadow:var(--shadow-md)] [font-size:var(--font-size-caption)]" style={{ left: hovered.x, top: hovered.top - 4 }}>#{hovered.event.i} · {hovered.event.error ? "✕ error · " : ""}{eventLabel(hovered.event.kind)}{hovered.event.redacted ? " · redacted at source" : hovered.event.label ? ` · ${hovered.event.label}` : ""}</div>}
    </div>
  </div>;
}
