import type { CSSProperties } from "react";
import { TRACE_EVENT_PALETTE } from "./palette";
import type { EventKind } from "./types";

/** An event's mark as the strip draws it, for the title of its card: the kind's
 *  colour, hollow when redacted at source, the error colour when it failed
 *  (R47). A
 *  reader scrolling the details list matches a card to its mark by sight rather
 *  than by reading every title (TRC-020). The colour comes from the same token
 *  table the strip paints with, so the two cannot drift apart. */
export function CellMark({ kind, error = false, redacted = false }: { kind: EventKind; error?: boolean; redacted?: boolean }) {
  const style = { "--cell-mark-color": `var(${error ? "--color-error" : TRACE_EVENT_PALETTE[kind]})` } as CSSProperties;
  return <span data-testid="cell-mark" data-kind={kind} data-error={error || undefined} data-redacted={redacted || undefined} aria-hidden="true" className={redacted ? "cell-mark cell-mark-hollow" : "cell-mark"} style={style} />;
}
