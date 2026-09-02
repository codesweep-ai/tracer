import { useMemo } from "react";
import { EventLanes } from "@codesweep-ai/ui";
import type { EventLaneEvent } from "@codesweep-ai/ui";
import { eventLabel } from "./format";
import { TRACE_EVENT_PALETTE } from "./palette";
import type { EventKind, StripEvent } from "./types";

/** Cell pitch the strip has always used; exposed as data-cell-width on the
 *  wrapper because the fixture suite computes click coordinates from it. */
export const STRIP_CELL_WIDTH = 10;

/** EventLanes reserves equal boundary padding on the axis so the selection
 *  halo's overhang paints whole at both edges (EventLanes.md §Data model); all
 *  ink sits this far right of the axis origin. ui does not re-export
 *  axisPaddingFor, so the formula is mirrored here — the fixture suite's click
 *  check (TF-15) is the tripwire if the ink ever moves again. Fork connectors
 *  and the suite both read the result off the wrapper (data-cell-offset). */
export function stripAxisPadding(cellWidth: number): number {
  const markSize = Math.max(5, Math.min(14, cellWidth - 1));
  return Math.max(0, (markSize + 7) / 2 + 3 - cellWidth / 2 + 1);
}

const LANE_ID = "events";

/**
 * tracer's strip on ui's EventLanes (TR-20/24): i is already the global index;
 * redacted → hollow, turnEnd → tick, error → the error cross overlay, a spawn →
 * a marker. Search/chip dimming maps to `emphasis`; kind filters to
 * `hiddenKinds`. The tooltip body keeps tracer's wording inside EventLanes'
 * ChartTooltip shell (TR-28).
 *
 * The visually-hidden spawn-marker spans are tracer's own machine-readable
 * census: EventLanes paints and announces markers but exposes no per-marker
 * DOM, and the index page's fork connectors (which stay tracer's) plus the
 * fixture suite count them. They carry no paint of their own.
 */
export function EventStrip({ events, selected, onSelect, label, laneLabel, hiddenKinds, matches, textFiltering = false }: {
  events: readonly StripEvent[];
  selected?: number;
  onSelect?: (i: number) => void;
  /** Base of the accessible name: announced as "<label>: <N> events". */
  label: string;
  /** The gutter lane label. tracer's strips are single-lane and the page already
   *  names the trace, so callers pass "" — the gutter itself is collapsed in
   *  styles.css via EventLanes' own theming variable. */
  laneLabel: string;
  hiddenKinds?: ReadonlySet<EventKind>;
  matches?: ReadonlySet<number>;
  textFiltering?: boolean;
}) {
  const laneEvents = useMemo<readonly EventLaneEvent<EventKind>[]>(() => events.map((event) => ({
    i: event.i,
    lane: LANE_ID,
    kind: event.kind,
    shape: event.redacted ? "hollow" : "square",
    label: event.label ? `${eventLabel(event.kind)} — ${event.label}` : eventLabel(event.kind),
    at: event.ts ?? "",
    error: event.error || undefined,
    tick: event.turnEnd || undefined,
    marker: event.subtask && event.childSessionId ? "spawn" : undefined,
  })), [events]);
  const byIndex = useMemo(() => new Map(events.map((event) => [event.i, event])), [events]);
  // EventLanes reseeds/reclamps when lanes/events identity changes — a fresh
  // array per render would reset the active descendant mid-keyboard-walk.
  const lanes = useMemo(() => [{ id: LANE_ID, label: laneLabel, className: "event-strip-lane-label" }], [laneLabel]);
  // Passed straight through: `hiddenKinds` is already keyed by EventKind, which
  // is what TRACE_EVENT_PALETTE and the lane events are keyed by. Projecting it
  // through the many-to-one colour map here is what erased system/meta/turn_end.
  const hidden = hiddenKinds;
  const spawns = useMemo(() => events.filter((event) => event.subtask && event.childSessionId), [events]);
  return <div data-testid="strip" data-cell-width={STRIP_CELL_WIDTH} data-cell-offset={stripAxisPadding(STRIP_CELL_WIDTH)} className="event-strip">
    <EventLanes
      lanes={lanes}
      events={laneEvents}
      palette={TRACE_EVENT_PALETTE}
      selected={selected ?? null}
      hiddenKinds={hidden}
      emphasis={textFiltering ? matches : undefined}
      cellWidth={STRIP_CELL_WIDTH}
      overview="auto"
      aria-label={`${label}: ${events.length} events`}
      onSelect={onSelect ? (event) => onSelect(event.i) : undefined}
      renderTooltip={(laneEvent) => {
        const event = byIndex.get(laneEvent.i);
        if (!event) return null;
        return <>#{event.i} · {event.error ? "✕ error · " : ""}{eventLabel(event.kind)}{event.redacted ? " · redacted at source" : event.label ? ` · ${event.label}` : ""}</>;
      }}
    />
    {spawns.map((event) => <span key={`${event.i}:${event.childSessionId}`} data-testid="spawn-marker" data-spawn-index={event.i} data-spawn-x={event.i * STRIP_CELL_WIDTH + STRIP_CELL_WIDTH / 2} data-child-session-id={event.childSessionId} aria-hidden="true" className="spawn-marker-census" />)}
  </div>;
}

/**
 * Legend granularity, shared by both pages so they cannot drift: "tool" covers
 * call+result (identical colour, nobody filters them apart), and meta and turn
 * end honestly share the system colour the strip draws them with.
 *
 * The index page listed only the first five while its strips drew all seven.
 */
export const LEGEND_CHIPS: Array<{ label: string; kinds: EventKind[] }> = [
  { label: "user", kinds: ["user"] },
  { label: "assistant", kinds: ["assistant"] },
  { label: "tool", kinds: ["tool_call", "tool_result"] },
  { label: "thinking", kinds: ["thinking"] },
  { label: "system", kinds: ["system"] },
  { label: "meta", kinds: ["meta"] },
  { label: "turn end", kinds: ["turn_end"] },
];

/**
 * The key for the hollow mark. Redaction is an overlay flag, not a kind, so it
 * cannot be a chip — and it is not filterable, only explainable. Both pages
 * draw hollow marks, so both pages carry it.
 */
export function RedactedKey() {
  return <span data-testid="redacted-key" className="redacted-key">
    <span aria-hidden="true" className="redacted-key-swatch" />
    redacted at source
  </span>;
}
