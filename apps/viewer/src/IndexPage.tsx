import { useEffect, useRef, useState } from "react";
import { Card, StatusBadge, useChartTheme } from "@codesweep-ai/ui";
import { compact, duration, money } from "./format";
import { linkTo } from "./routes";
import { StripCanvas } from "./StripCanvas";
import type { LinkHint, LoadedTrace } from "./types";
import { ErrorSwatch } from "./KindLegend";
import { traceSeriesColors } from "./traceColors";

function ForkConnector({ parentId, spawnIndex, childLane }: { parentId: string; spawnIndex: number; childLane: React.RefObject<HTMLDivElement | null> }) {
  const [anchor, setAnchor] = useState<{ left: number; top: number; height: number; x: number; visible: boolean }>();
  useEffect(() => {
    const parent = [...document.querySelectorAll<HTMLElement>('[data-trace-id]')].find((element) => element.dataset.traceId === parentId); const child = childLane.current; if (!parent || !child) return; const strip = parent.querySelector('[data-testid="strip"]');
    if (!(strip instanceof HTMLElement)) return;
    const update = () => { const cellWidth = Number(strip.dataset.cellWidth) || 4; const logicalX = spawnIndex * cellWidth + cellWidth / 2; const localX = logicalX - strip.scrollLeft; const edge = cellWidth / 2; const clampedX = Math.max(edge, Math.min(strip.clientWidth - edge, localX)); const stripRect = strip.getBoundingClientRect(); const childRect = child.getBoundingClientRect(); const marker = [...parent.querySelectorAll<HTMLElement>('[data-testid="spawn-marker"]')].find((element) => Number(element.dataset.spawnIndex) === spawnIndex); const markerRect = marker?.getBoundingClientRect(); const markerY = markerRect ? markerRect.top + markerRect.height / 2 : stripRect.top + stripRect.height / 2; setAnchor({ left: stripRect.left + clampedX - childRect.left, top: markerY - childRect.top, height: Math.max(0, childRect.top - markerY), x: stripRect.left + clampedX, visible: localX >= edge && localX <= strip.clientWidth - edge }); };
    update(); strip.addEventListener("scroll", update); window.addEventListener("resize", update); if (typeof ResizeObserver === "undefined") return () => { strip.removeEventListener("scroll", update); window.removeEventListener("resize", update); }; const observer = new ResizeObserver(update); observer.observe(strip); observer.observe(child); return () => { observer.disconnect(); strip.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [childLane, parentId, spawnIndex]);
  if (!anchor) return null;
  // eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css.
  if (!anchor.visible) return <span data-testid="offscreen-fork-connector" data-spawn-index={spawnIndex} data-spawn-visible="false" aria-label="Proven parent-child connector (spawn outside visible strip)" className="pointer-events-none absolute right-full top-[var(--space-5)] w-[var(--trajectory-depth-indent)] h-[var(--space-5)] border-l border-b border-solid border-[var(--color-brand)] rounded-bl-[var(--radius-sm)]" />;
  return <span data-testid="fork-connector" data-spawn-index={spawnIndex} data-spawn-x={anchor.x} data-spawn-visible={anchor.visible} aria-label="Proven parent-child connector" className="pointer-events-none absolute z-[var(--z-sticky)] border-l-2 border-solid border-[var(--color-brand)]" style={{ left: anchor.left, top: anchor.top, height: anchor.height }}><span className="absolute right-0 bottom-0 border-b-2 border-solid border-[var(--color-brand)]" style={{ width: Math.max(0, anchor.left) }} /></span>;
}

function Lane({ trace, depth, hinted, parentId, spawnIndex }: { trace: LoadedTrace; depth: number; hinted: boolean; parentId?: string; spawnIndex?: number }) {
  const { meta, totals, parse, strip } = trace.summary;
  const lane = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css.
  return <div ref={lane} data-testid="lane" data-trace-id={trace.id} data-parent-trace-id={parentId} data-spawn-index={spawnIndex} className="relative" style={{ marginLeft: `calc(${depth} * var(--trajectory-depth-indent))` }}>
    {/* eslint-disable-next-line @codesweep-ai/no-unknown-token -- App-local semantic layout token defined in styles.css. */}
    {parentId && spawnIndex != null ? <ForkConnector parentId={parentId} spawnIndex={spawnIndex} childLane={lane} /> : depth > 0 && <span aria-label="Proven parent-child connector" className="absolute right-full top-[var(--space-5)] w-[var(--trajectory-depth-indent)] h-[var(--space-5)] border-l border-b border-solid border-[var(--color-brand)] rounded-bl-[var(--radius-sm)]" />}
    {hinted && <span aria-label="Dashed link hint" className="absolute -left-[var(--space-4)] top-0 bottom-0 border-l border-dashed border-[var(--muted)]" />}
    <Card variant="tight">
      <div className="grid grid-cols-[minmax(12rem,20rem)_1fr] max-md:grid-cols-1 gap-[var(--space-4)] items-center">
        <div className="min-w-0"><a href={linkTo(trace.id)} className="[color:var(--fg)] [font-weight:var(--font-weight-semibold)] no-underline hover:[color:var(--color-link)] truncate block">{meta.title ?? meta.label ?? (meta.autoTitle ? <span className="italic" title="Derived from the session's first user message">{meta.autoTitle}</span> : trace.id)}</a><p className="[font-size:var(--font-size-caption)] [color:var(--muted)] truncate">{meta.model ?? "Unknown model"} · {compact(totals.input + totals.output)} tokens · {duration(meta.durationMs)} {money(totals.cost, totals.costEstimated)}</p>{(meta.title ?? meta.label ?? meta.autoTitle) && <p className="[font-size:var(--font-size-caption)] [color:var(--muted)] font-mono truncate" title={trace.id}>{trace.id}</p>}<div className="flex gap-[var(--space-2)] mt-[var(--space-2)]">{totals.toolErrors > 0 && <StatusBadge label={`✕ ${totals.toolErrors} error`} status="error" />}{parse.unrecognized > 0 && <StatusBadge label={`${parse.unrecognized} unrecognized`} status="warning" />}</div></div>
        <StripCanvas events={strip} label={trace.id} onSelect={(i) => { location.href = linkTo(trace.id, i); }} />
      </div>
    </Card>
  </div>;
}
export function IndexPage({ traces, links }: { traces: LoadedTrace[]; links: LinkHint[] }) {
  const theme = useChartTheme(); const colors = traceSeriesColors(theme);
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const byParent = new Map<string | null, LoadedTrace[]>(); traces.forEach((trace) => { const key = trace.summary.meta.parentSessionId ?? null; byParent.set(key, [...(byParent.get(key) ?? []), trace]); });
  const ordered: Array<{ trace: LoadedTrace; depth: number }> = []; const seen = new Set<string>();
  const visit = (trace: LoadedTrace, depth: number) => { if (seen.has(trace.id)) return; seen.add(trace.id); ordered.push({ trace, depth }); (byParent.get(trace.id) ?? []).forEach((child) => visit(child, depth + 1)); };
  (byParent.get(null) ?? traces).forEach((trace) => visit(trace, 0)); traces.forEach((trace) => visit(trace, 0));
  // the rollup sums only the lanes that HAVE a cost, so it must say when
  // lanes are excluded — a plausible total that silently omits a lane presents an
  // unknowable quantity as a known one.
  const totals = traces.reduce((sum, t) => { const cost = t.summary.totals.cost; return { events: sum.events + t.summary.totals.events, tokens: sum.tokens + t.summary.totals.input + t.summary.totals.output, cost: sum.cost + (cost ?? 0), hasCost: sum.hasCost || cost != null, unpriced: sum.unpriced + (cost == null ? 1 : 0), costEstimated: sum.costEstimated || (cost != null && Boolean(t.summary.totals.costEstimated)) }; }, { events: 0, tokens: 0, cost: 0, hasCost: false, unpriced: 0, costEstimated: false });
  return <section data-testid="index-page" className="flex flex-col gap-[var(--space-4)]">
    <div><h1 className="[font-size:var(--font-size-page-title)] [font-weight:var(--font-weight-bold)]">Trajectory overview</h1><p className="[color:var(--muted)]">{traces.length} lanes · {compact(totals.events)} events · {compact(totals.tokens)} tokens{totals.hasCost ? ` · ${money(totals.cost, totals.costEstimated)}${totals.unpriced > 0 ? ` · ${totals.unpriced} lane${totals.unpriced === 1 ? "" : "s"} unpriced` : ""}` : ""}</p></div>
    <div aria-label="Event legend" className="flex flex-wrap items-center gap-[var(--space-3)] [font-size:var(--font-size-caption)]">{([{ label: "user", color: colors.user }, { label: "assistant", color: colors.assistant }, { label: "tool", color: colors.tool }, { label: "thinking", color: colors.thinking }, { label: "system", color: colors.system }]).map((item) => <span key={item.label} className="inline-flex items-center gap-[var(--space-1)]"><span aria-hidden="true" className="w-[var(--space-3)] h-[var(--space-3)] rounded-[var(--radius-sm)]" style={{ backgroundColor: item.color }} />{item.label}</span>)}<span className="inline-flex items-center gap-[var(--space-1)]"><ErrorSwatch />error</span><span>┄ link hint</span></div>
    <div className="flex flex-col gap-[var(--space-3)]">{ordered.map(({ trace, depth }) => { const parentId = trace.summary.meta.parentSessionId ?? undefined; const spawnIndex = parentId ? byId.get(parentId)?.summary.strip.find((event) => event.subtask && event.childSessionId === trace.id)?.i : undefined; return <Lane key={trace.id} trace={trace} depth={depth} hinted={links.some((link) => link.toSessionId === trace.id)} parentId={parentId} spawnIndex={spawnIndex} />; })}</div>
  </section>;
}
