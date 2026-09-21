import { useEffect, useMemo, useRef } from "react";
import { EventLanes } from "@codesweep-ai/ui";
import type { EventLaneEvent } from "@codesweep-ai/ui";
import { duration, eventLabel } from "./format";
import { TRACE_EVENT_PALETTE } from "./palette";
import type { EventKind, StripEvent } from "./types";

/** Cell pitch, exposed as data-cell-width on the wrapper because the fixture
 *  suite and the fork connectors compute coordinates from it. At 13 the mark is
 *  12 pixels, the width a bar is drawn at. */
export const STRIP_CELL_WIDTH = 13;

/** A work bar reaches the top of its row at this duration, and anything longer
 *  carries the notch. One named value, so the scale changes in one place. */
export const WORK_CEILING_MS = 2 * 60_000;

/** A wait bar reaches the bottom of its row at this duration. */
export const IDLE_CEILING_MS = 60 * 60_000;

/** Duration to bar length on a log scale: a two-second step and a two-minute
 *  one both stay readable in a 40-pixel row. */
function logFraction(ms: number, ceiling: number): number {
  return Math.log2(1 + Math.min(ms, ceiling) / 1000) / Math.log2(1 + ceiling / 1000);
}

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

/** The time part of a cell's tooltip. A turn end reports its wait (R68). A
 *  model step reports its model time (R70): the round trip from the end of the
 *  previous work to the end of this step. Where the CLI recorded when the model
 *  began (R79), the round trip splits into the wait and the generation. A tool
 *  call's time includes running it. */
export function timingLabel(event: StripEvent): string {
  if (event.kind === "turn_end") {
    if (event.idleMs == null) return "";
    return ` · waited ${duration(event.idleMs)}${event.idleMs > IDLE_CEILING_MS ? ` (bar stops at ${duration(IDLE_CEILING_MS)})` : ""}`;
  }
  if (event.workMs == null) return "";
  const clipped = event.workMs > WORK_CEILING_MS ? `, bar stops at ${duration(WORK_CEILING_MS)}` : "";
  const name = event.kind === "tool_call" ? "took" : "model time";
  const split = event.activeMs == null ? "" : `waited ${duration(event.workMs - event.activeMs)}, ${event.kind === "thinking" ? "thought" : "wrote"} ${duration(event.activeMs)}`;
  const detail = [split, clipped.slice(2)].filter(Boolean).join(", ");
  return ` · ${name} ${duration(event.workMs)}${detail ? ` (${detail})` : ""}`;
}
const WAIT_LANE_ID = "wait";

/**
 * Scroll `scroller` so cell `index` sits in the middle of it.
 *
 * Geometry comes off the strip wrapper's own data attributes, the same contract
 * the fork connectors and the fixture suite read, so the three cannot disagree
 * about where a cell is. Clamped at both ends: a cell with too few events after
 * it stops at the end of the strip rather than centring into blank space, which
 * is the "where there is room" half of R62.
 *
 * Instant, never smooth: the parity gate compares an interaction end state
 * between two transports, and an animation makes that a race.
 */
export function centerCell(strip: HTMLElement, scroller: HTMLElement, index: number): void {
  const cellWidth = Number(strip.dataset.cellWidth) || STRIP_CELL_WIDTH;
  const cellOffset = Number(strip.dataset.cellOffset) || stripAxisPadding(cellWidth);
  const middle = cellOffset + index * cellWidth + cellWidth / 2 - scroller.clientWidth / 2;
  const furthest = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  scroller.scrollLeft = Math.max(0, Math.min(furthest, middle));
}

/** A request to bring one cell into view, CENTRED. The sequence makes a repeat
 *  request for the same index a fresh one. */
export interface StripFocus { index: number; sequence: number }

/**
 * tracer's strip on ui's EventLanes (TR-20/24): i is already the global index;
 * redacted → hollow, a turn end → a bar in the wait row, error → the error cross overlay, a spawn →
 * a marker. Search/chip dimming maps to `emphasis`; kind filters to
 * `hiddenKinds`. The tooltip body keeps tracer's wording inside EventLanes'
 * ChartTooltip shell (TR-28).
 *
 * The visually-hidden spawn-marker spans are tracer's own machine-readable
 * census: EventLanes paints and announces markers but exposes no per-marker
 * DOM, and the index page's fork connectors (which stay tracer's) plus the
 * fixture suite count them. They carry no paint of their own.
 */
export function EventStrip({ events, selected, onSelect, label, laneLabel, hiddenKinds, matches, textFiltering = false, focus }: {
  events: readonly StripEvent[];
  selected?: number;
  onSelect?: (i: number) => void;
  /** Centre this cell when it changes. Only navigation sets it — a click or a
   *  scrollspy update must not yank the strip out from under the reader. */
  focus?: StripFocus;
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
  // Work and waiting on separate rows (R77): a step's bar rises by the time it
  // took (R70), and a turn end hangs in the row below by the wait after it (R68).
  const laneEvents = useMemo<readonly EventLaneEvent<EventKind>[]>(() => events.map((event) => ({
    i: event.i,
    lane: event.kind === "turn_end" ? WAIT_LANE_ID : LANE_ID,
    ...(event.kind === "turn_end"
      ? { magnitude: logFraction(event.idleMs ?? 0, IDLE_CEILING_MS), clipped: (event.idleMs ?? 0) > IDLE_CEILING_MS || undefined }
      : event.workMs != null
        ? { magnitude: logFraction(event.workMs, WORK_CEILING_MS), clipped: event.workMs > WORK_CEILING_MS || undefined }
        : {}),
    kind: event.kind,
    shape: event.redacted ? "hollow" : "square",
    label: event.label ? `${eventLabel(event.kind)} — ${event.label}` : eventLabel(event.kind),
    at: event.ts ?? "",
    error: event.error || undefined,
    marker: event.subtask && event.childSessionId ? "spawn" : undefined,
  })), [events]);
  const byIndex = useMemo(() => new Map(events.map((event) => [event.i, event])), [events]);
  // EventLanes reseeds/reclamps when lanes/events identity changes — a fresh
  // array per render would reset the active descendant mid-keyboard-walk.
  const lanes = useMemo(() => [
    { id: LANE_ID, label: laneLabel, className: "event-strip-lane-label", height: 40, bars: "up" as const },
    // Left out of the overview: its sparse bars squeezed the work row there
    // into a line.
    { id: WAIT_LANE_ID, label: "", className: "event-strip-lane-label", height: 16, bars: "down" as const, barFloor: 2, overview: false },
  ], [laneLabel]);
  // Passed straight through: `hiddenKinds` is already keyed by EventKind, which
  // is what TRACE_EVENT_PALETTE and the lane events are keyed by. Projecting it
  // through the many-to-one colour map here is what erased system/meta/turn_end.
  const hidden = hiddenKinds;
  const spawns = useMemo(() => events.filter((event) => event.subtask && event.childSessionId), [events]);
  const root = useRef<HTMLDivElement>(null);
  // Centre the focused cell (R62). EventLanes scrolls the selection into view
  // MINIMALLY: a cell to the right lands flush against the right edge, so a
  // reader arriving at a fork point sees everything before it and nothing
  // after — the least useful place to land. This runs after that, because a
  // child's effects flush before its parent's, and overrides it.
  useEffect(() => {
    if (!focus) return;
    const element = root.current;
    const scroller = element?.querySelector<HTMLElement>("[data-event-lanes-scroller]");
    if (!element || !scroller) return;
    const apply = () => {
      // Zero while the strip is still laying out; centring against it would
      // land at 0. Retried below rather than guessed at.
      if (!scroller.clientWidth) return false;
      centerCell(element, scroller, focus.index);
      return true;
    };
    if (apply() || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (apply()) observer.disconnect(); });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [focus]);
  return <div ref={root} data-testid="strip" data-cell-width={STRIP_CELL_WIDTH} data-cell-offset={stripAxisPadding(STRIP_CELL_WIDTH)} className="event-strip">
    <EventLanes
      lanes={lanes}
      events={laneEvents}
      palette={TRACE_EVENT_PALETTE}
      selected={selected ?? null}
      hiddenKinds={hidden}
      emphasis={textFiltering ? matches : undefined}
      cellWidth={STRIP_CELL_WIDTH}
      overview="auto"
      overviewHeight={14}
      scrollbar="overview"
      aria-label={`${label}: ${events.length} events`}
      onSelect={onSelect ? (event) => onSelect(event.i) : undefined}
      renderTooltip={(laneEvent) => {
        const event = byIndex.get(laneEvent.i);
        if (!event) return null;
        return <>#{event.i} · {event.error ? "✕ error · " : ""}{eventLabel(event.kind)}{event.redacted ? " · redacted at source" : event.label ? ` · ${event.label}` : ""}{timingLabel(event)}</>;
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
