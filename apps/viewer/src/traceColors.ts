import type { ChartTheme } from "@codesweep-ai/ui";
import type { EventKind } from "./types";

// A type, not a runtime array. The list was previously a `const` tuple that
// existed only to derive this union with `typeof ...[number]`: nothing read it
// at run time, so it shipped in the bundle for nothing. The two maps below are
// keyed by it, so a missing or misspelled key is still a compile error.
export type TraceColorKey = "user" | "assistant" | "tool" | "thinking" | "system";

/** Kind colors are chosen explicitly per theme, not dealt from the palette in
 * alphabetical key order (which had put assistant-blue next to user-violet — the single
 * most important distinction in a trace, measured at normal-vision dE 6.3 — and tool
 * next to the error red).
 *
 * Both sets pass all six checks of the categorical-palette validator at the app's
 * surfaces, all-pairs (light: worst CVD dE 10.9, normal 18.1; dark: 9.2 / 18.7). The
 * blue step differs per theme because blue-violet is inseparable on the light surface
 * and sky-emerald on the dark one — dark is selected, never an automatic flip.
 *
 * `system` (and meta/turn_end, which map to it) is deliberately NOT a categorical hue:
 * plumbing recedes to muted ink so the four content kinds carry the signal. Error stays
 * the reserved status red, distinct from all five. */
const LIGHT: Record<TraceColorKey, string> = {
  user: "#0ea5e9",       // sky
  assistant: "#10b981",  // emerald
  tool: "#8b5cf6",       // violet
  thinking: "#ca8a04",   // yellow-600 — pulled off orange so it clears the error red
  system: "",            // filled from theme.muted
};
const DARK: Record<TraceColorKey, string> = {
  user: "#3b82f6",       // blue
  assistant: "#047857",  // emerald (dark step)
  tool: "#6d28d9",       // violet (dark step)
  thinking: "#b45309",   // amber-700 — dark-theme counterpart, clear of the error red
  system: "",
};

/** Dark surfaces are near-black; the app's light surface is near-white. */
function isDarkSurface(theme: ChartTheme): boolean {
  // No literal colour needed: an unreadable/absent theme.bg simply means "not dark",
  // which is the safe default (light steps stay legible on an unknown surface).
  const hex = (theme.bg || "").replace("#", "");
  if (hex.length < 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

export function traceSeriesColors(theme: ChartTheme): Record<TraceColorKey, string> {
  const base = isDarkSurface(theme) ? DARK : LIGHT;
  return { ...base, system: theme.muted };
}

export function traceColorKey(kind: EventKind): TraceColorKey {
  if (kind === "tool_call" || kind === "tool_result") return "tool";
  if (kind === "meta" || kind === "turn_end") return "system";
  return kind;
}
