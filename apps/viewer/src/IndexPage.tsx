import { useEffect, useRef, useState } from "react";
import { Card, Legend, StatusBadge } from "@codesweep-ai/ui";
import { compact, duration, money } from "./format";
import { linkTo } from "./routes";
import { EventStrip, LEGEND_CHIPS, RedactedKey, STRIP_CELL_WIDTH, stripAxisPadding } from "./EventStrip";
import type { LinkHint, LoadedTrace } from "./types";
import { ErrorSwatch } from "./ErrorSwatch";
import { TRACE_PALETTE, traceColorKey } from "./palette";


function ForkConnector({ parentId, spawnIndex, childLane }: { parentId: string; spawnIndex: number; childLane: React.RefObject<HTMLDivElement | null> }) {
  const [anchor, setAnchor] = useState<{ left: number; top: number; height: number; x: number; visible: boolean }>();
  useEffect(() => {
    const parent = [...document.querySelectorAll<HTMLElement>('[data-trace-id]')].find((element) => element.dataset.traceId === parentId); const child = childLane.current; if (!parent || !child) return;
    // the strip wrapper carries the cell-width contract; EventLanes' scroller
    // (its documented hook) is the horizontal scroll owner inside it. The
    // offset is the axis's boundary padding: ink sits data-cell-offset px
    // right of the axis origin.
    const strip = parent.querySelector('[data-testid="strip"]');
    const scroller = parent.querySelector('[data-event-lanes-scroller]');
    if (!(strip instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
    const update = () => { const cellWidth = Number((strip as HTMLElement).dataset.cellWidth) || STRIP_CELL_WIDTH; const cellOffset = Number((strip as HTMLElement).dataset.cellOffset) || stripAxisPadding(cellWidth); const logicalX = cellOffset + spawnIndex * cellWidth + cellWidth / 2; const localX = logicalX - scroller.scrollLeft; const edge = cellWidth / 2; const clampedX = Math.max(edge, Math.min(scroller.clientWidth - edge, localX)); const stripRect = scroller.getBoundingClientRect(); const childRect = child.getBoundingClientRect(); const markerY = stripRect.top + stripRect.height / 2; setAnchor({ left: stripRect.left + clampedX - childRect.left, top: markerY - childRect.top, height: Math.max(0, childRect.top - markerY), x: stripRect.left + clampedX, visible: localX >= edge && localX <= scroller.clientWidth - edge }); };
    update(); scroller.addEventListener("scroll", update); window.addEventListener("resize", update); void document.fonts?.ready.then(update); if (typeof ResizeObserver === "undefined") return () => { scroller.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
    // The anchor reads the CHILD's top, which moves when the PARENT lane's card
    // finishes laying out (its strip's height is content-driven under
    // EventLanes). A position change fires no ResizeObserver on the child, so
    // watch the parent's size as well — otherwise the measurement races the
    // parent's settle and lands on either of two heights (the parity coin flip).
    const observer = new ResizeObserver(update); observer.observe(scroller); observer.observe(child); observer.observe(parent); return () => { observer.disconnect(); scroller.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [childLane, parentId, spawnIndex]);
  if (!anchor) return null;
  if (!anchor.visible) return <span data-testid="offscreen-fork-connector" data-spawn-index={spawnIndex} data-spawn-visible="false" role="img" aria-label="Proven parent-child connector (spawn outside visible strip)" className="fork-connector fork-connector-offscreen border-solid" />;
  return <span data-testid="fork-connector" data-spawn-index={spawnIndex} data-spawn-x={anchor.x} data-spawn-visible={anchor.visible} role="img" aria-label="Proven parent-child connector" className="fork-connector fork-connector-vertical border-solid" style={{ left: anchor.left, top: anchor.top, height: anchor.height }}><span className="fork-connector-horizontal border-solid" style={{ width: Math.max(0, anchor.left) }} /></span>;
}

function Lane({ trace, depth, hinted, parentId, spawnIndex }: { trace: LoadedTrace; depth: number; hinted: boolean; parentId?: string; spawnIndex?: number }) {
  const { meta, totals, parse, strip } = trace.summary;
  const lane = useRef<HTMLDivElement | null>(null);
  return <div ref={lane} data-testid="lane" data-trace-id={trace.id} data-parent-trace-id={parentId} data-spawn-index={spawnIndex} className="lane" style={{ marginLeft: `calc(${depth} * var(--trajectory-depth-indent))` }}>
    {parentId && spawnIndex != null ? <ForkConnector parentId={parentId} spawnIndex={spawnIndex} childLane={lane} /> : depth > 0 && <span role="img" aria-label="Proven parent-child connector" className="fork-connector fork-connector-depth border-solid" />}
    {hinted && <span role="img" aria-label="Dashed link hint" className="link-hint border-dashed" />}
    <Card variant="tight">
      <div className="lane-grid">
        <div className="lane-meta"><a href={linkTo(trace.id)} className="lane-title">{meta.title ?? meta.label ?? (meta.autoTitle ? <span className="auto-title" title="Derived from the session's first user message">{meta.autoTitle}</span> : trace.id)}</a><p className="lane-meta-line">{meta.model ?? "Unknown model"} · {compact(totals.input + totals.output)} tokens · {duration(meta.durationMs)} {money(totals.cost, totals.costEstimated)}</p>{(meta.title ?? meta.label ?? meta.autoTitle) && <p className="lane-meta-line lane-id" title={trace.id}>{trace.id}</p>}<div className="lane-badges">{totals.toolErrors > 0 && <StatusBadge label={`${totals.toolErrors} error`} status="error" />}{parse.unrecognized > 0 && <StatusBadge label={`${parse.unrecognized} unrecognized`} status="warning" />}</div></div>
        <EventStrip events={strip} label={trace.id} laneLabel="" onSelect={(i) => { location.href = linkTo(trace.id, i); }} />
      </div>
    </Card>
  </div>;
}
export function IndexPage({ traces, links }: { traces: LoadedTrace[]; links: LinkHint[] }) {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const byParent = new Map<string | null, LoadedTrace[]>(); traces.forEach((trace) => { const key = trace.summary.meta.parentSessionId ?? null; byParent.set(key, [...(byParent.get(key) ?? []), trace]); });
  const ordered: Array<{ trace: LoadedTrace; depth: number }> = []; const seen = new Set<string>();
  const visit = (trace: LoadedTrace, depth: number) => { if (seen.has(trace.id)) return; seen.add(trace.id); ordered.push({ trace, depth }); (byParent.get(trace.id) ?? []).forEach((child) => visit(child, depth + 1)); };
  (byParent.get(null) ?? traces).forEach((trace) => visit(trace, 0)); traces.forEach((trace) => visit(trace, 0));
  // the rollup sums only the lanes that HAVE a cost, so it must say when
  // lanes are excluded — a plausible total that silently omits a lane presents an
  // unknowable quantity as a known one.
  const totals = traces.reduce((sum, t) => { const cost = t.summary.totals.cost; return { events: sum.events + t.summary.totals.events, tokens: sum.tokens + t.summary.totals.input + t.summary.totals.output, cost: sum.cost + (cost ?? 0), hasCost: sum.hasCost || cost != null, unpriced: sum.unpriced + (cost == null ? 1 : 0), costEstimated: sum.costEstimated || (cost != null && Boolean(t.summary.totals.costEstimated)) }; }, { events: 0, tokens: 0, cost: 0, hasCost: false, unpriced: 0, costEstimated: false });
  return <section data-testid="index-page" className="index-page">
    <div><h1 className="page-title">Trajectory overview</h1><p className="rollup">{traces.length} lane{traces.length === 1 ? "" : "s"} · {compact(totals.events)} events · {compact(totals.tokens)} tokens{totals.hasCost ? ` · ${money(totals.cost, totals.costEstimated)}${totals.unpriced > 0 ? ` · ${totals.unpriced} lane${totals.unpriced === 1 ? "" : "s"} unpriced` : ""}` : ""}</p></div>
    <Legend aria-label="Event legend" className="index-legend" items={LEGEND_CHIPS.map((chip) => ({ id: chip.label, label: chip.label, color: TRACE_PALETTE[traceColorKey(chip.kinds[0]!)], shape: "square" as const }))} extras={<><span data-testid="index-legend-extra" className="legend-extra"><ErrorSwatch />error</span><span data-testid="index-legend-extra" className="legend-extra"><RedactedKey /></span><span data-testid="index-legend-extra">┄ link hint</span></>} />
    <div className="lane-list">{ordered.map(({ trace, depth }) => { const parentId = trace.summary.meta.parentSessionId ?? undefined; const spawnIndex = parentId ? byId.get(parentId)?.summary.strip.find((event) => event.subtask && event.childSessionId === trace.id)?.i : undefined; return <Lane key={trace.id} trace={trace} depth={depth} hinted={links.some((link) => link.toSessionId === trace.id)} parentId={parentId} spawnIndex={spawnIndex} />; })}</div>
  </section>;
}
