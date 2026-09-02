import type { EventToken } from "@codesweep-ai/ui";
import type { EventKind } from "./types";

// A type, not a runtime array. The list was previously a `const` tuple that
// existed only to derive this union with `typeof ...[number]`: nothing read it
// at run time, so it shipped in the bundle for nothing. The maps below are
// keyed by it, so a missing or misspelled key is still a compile error.
export type TraceColorKey = "user" | "assistant" | "tool" | "thinking" | "system" | "meta";

export function traceColorKey(kind: EventKind): TraceColorKey {
  if (kind === "tool_call" || kind === "tool_result") return "tool";
  if (kind === "turn_end") return "system";
  if (kind === "meta") return "meta";
  return kind;
}

/** Kind colours as design-system TOKEN NAMES (TR-15/16), resolved with var()
 *  by EventLanes and Legend at paint time — no resolved-hex table lives in
 *  tracer anymore (traceColors.ts is gone). The categorical palette is ui's
 *  accessibility-reviewed set; system and meta are deliberately not categorical
 *  hues: plumbing recedes to neutral ink so the four content kinds carry the
 *  signal. They recede to DIFFERENT steps, because meta recurs at volume — 101
 *  of 1,366 marks on large-session against 8 system — and one shared step made
 *  a legend that lists them separately promise a distinction the colour did not
 *  deliver. turn_end keeps system's ink on purpose: every turn_end draws a
 *  trailing tick (shard.go sets turnEnd exactly when kind is turn_end, so it is
 *  1:1 by construction, verified across all four multi-agent fixtures), and a
 *  mark identified by shape does not also need a colour of its own.
 *  Error stays the reserved status red. */
export const TRACE_PALETTE: Record<TraceColorKey, EventToken> = {
  user: "--color-cat-9",       // sky
  assistant: "--color-cat-7",  // emerald
  tool: "--color-cat-5",       // violet
  thinking: "--color-cat-3",   // amber
  system: "--muted",
  meta: "--color-structural",
};

/** The palette EventLanes is given, keyed by the FINE-GRAINED `EventKind`.
 *
 *  EventLanes' `kind` is both the paint key and the filter key (`hiddenKinds`
 *  is a set of it). Handing it the coarse colour key made those two meanings
 *  the same thing, so hiding any one of `system` / `meta` / `turn_end` — which
 *  share a colour — hid all three from the strip while the details list stayed
 *  correct. Colours are still collapsed here, deliberately and visibly; the
 *  *identity* stays fine-grained so filtering is sound.
 *
 *  Record<EventKind, …> makes a missing or misspelled kind a compile error, and
 *  every value is read from TRACE_PALETTE so there is one source of colour. */
export const TRACE_EVENT_PALETTE: Record<EventKind, EventToken> = {
  user: TRACE_PALETTE.user,
  assistant: TRACE_PALETTE.assistant,
  thinking: TRACE_PALETTE.thinking,
  tool_call: TRACE_PALETTE.tool,
  tool_result: TRACE_PALETTE.tool,
  system: TRACE_PALETTE.system,
  meta: TRACE_PALETTE.meta,
  turn_end: TRACE_PALETTE.system,
};
