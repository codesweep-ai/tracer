import { useEffect, useRef } from "react";
import { useChartTheme } from "@codesweep-ai/ui";
import { drawErrorMark } from "./StripCanvas";
import { traceColorKey, traceSeriesColors } from "./traceColors";
import type { EventKind } from "./types";

/** Legend-granularity chips: "tool" covers call+result (identical colour, nobody filters
 * them apart); meta and turn end honestly share the system colour the strip draws them
 * with. */
const LEGEND_CHIPS: Array<{ label: string; kinds: EventKind[] }> = [
  { label: "user", kinds: ["user"] },
  { label: "assistant", kinds: ["assistant"] },
  { label: "tool", kinds: ["tool_call", "tool_result"] },
  { label: "thinking", kinds: ["thinking"] },
  { label: "system", kinds: ["system"] },
  { label: "meta", kinds: ["meta"] },
  { label: "turn end", kinds: ["turn_end"] },
];

/** the error entry must depict the TREATMENT the strip draws (a ✕ over a cell),
 * not a colour — errors are no longer a fill. The cell under the glyph is the strip's own
 * track colour, standing in for "any kind". */
export function ErrorSwatch({ size = 12 }: { size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useChartTheme();
  useEffect(() => {
    const node = canvas.current; if (!node) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = size * ratio; node.height = size * ratio;
    const ctx = node.getContext("2d"); if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = theme.gridLine || theme.muted; ctx.globalAlpha = 0.35; ctx.fillRect(0, 0, size, size); ctx.globalAlpha = 1;
    drawErrorMark(ctx, 0, 0, size, theme.bg, theme.error);
  }, [size, theme]);
  return <canvas ref={canvas} aria-hidden="true" className="rounded-[var(--radius-sm)] align-[-2px]" style={{ width: size, height: size }} />;
}

export function KindLegend({ kinds, onKindsChange, errorsOnly, onErrorsOnlyChange, allKinds }: {
  kinds: Set<string>;
  onKindsChange: (next: Set<string>) => void;
  errorsOnly: boolean;
  onErrorsOnlyChange: (next: boolean) => void;
  allKinds: EventKind[];
}) {
  const theme = useChartTheme(); const colors = traceSeriesColors(theme);
  const filtering = kinds.size < allKinds.length || errorsOnly;
  return <div role="group" aria-label="Event legend" className="flex flex-wrap items-center gap-[var(--space-3)] py-[var(--space-2)] [font-size:var(--font-size-caption)]">
    {LEGEND_CHIPS.map((chip) => {
      const on = chip.kinds.every((kind) => kinds.has(kind));
      const color = colors[traceColorKey(chip.kinds[0]!)] ?? theme.muted;
      return <button key={chip.label} type="button" aria-pressed={on} title={on ? `Hide ${chip.label} events` : `Show ${chip.label} events`} onClick={() => { const next = new Set(kinds); chip.kinds.forEach((kind) => { if (on) next.delete(kind); else next.add(kind); }); onKindsChange(next); }} className="inline-flex items-center gap-[var(--space-1)] cursor-pointer bg-transparent border-0 p-0 [font-size:var(--font-size-caption)] hover:underline" style={{ color: on ? "var(--fg)" : "var(--muted)" }}>
        <span aria-hidden="true" className="w-[var(--space-3)] h-[var(--space-3)] rounded-[var(--radius-sm)] box-border" style={on ? { backgroundColor: color } : { border: `1.5px solid ${color}` }} />{chip.label}
      </button>;
    })}
    <span aria-hidden="true" className="[color:var(--border)]">|</span>
    {/* errors are an overlay flag, not a kind — this restricts rather than hides,
        so it gets its own affordance and composes (AND) with the chips and text search. */}
    <button type="button" data-testid="errors-only" aria-pressed={errorsOnly} title={errorsOnly ? "Show all events again" : "Show only events that errored"} onClick={() => onErrorsOnlyChange(!errorsOnly)} className="inline-flex items-center gap-[var(--space-1)] cursor-pointer border-0 [font-size:var(--font-size-caption)] hover:underline rounded-[var(--radius-sm)] px-[var(--space-1)] py-[var(--space-0-5)]" style={errorsOnly ? { background: "var(--color-error-bg)", color: "var(--color-error)" } : { background: "transparent", color: "var(--fg)" }}>
      <ErrorSwatch />{errorsOnly ? "errors only" : "error"}
    </button>
    <span className="inline-flex items-center gap-[var(--space-2)] [color:var(--muted)]">
      <button type="button" data-testid="filter-all" onClick={() => { onKindsChange(new Set(allKinds)); onErrorsOnlyChange(false); }} disabled={!filtering} className="cursor-pointer bg-transparent border-0 p-0 [font-size:var(--font-size-caption)] hover:underline disabled:opacity-40 disabled:cursor-default" style={{ color: filtering ? "var(--color-link)" : undefined }}>all</button>
      ·
      <button type="button" data-testid="filter-none" onClick={() => onKindsChange(new Set())} disabled={kinds.size === 0} className="cursor-pointer bg-transparent border-0 p-0 [font-size:var(--font-size-caption)] hover:underline disabled:opacity-40 disabled:cursor-default" style={{ color: kinds.size ? "var(--color-link)" : undefined }}>none</button>
    </span>
  </div>;
}
