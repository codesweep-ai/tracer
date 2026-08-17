import { Card, CodeBlock, StatusBadge } from "@codesweep-ai/ui";
import { duration, eventLabel } from "./format";
import { linkTo } from "./routes";
import type { TraceEvent } from "./types";

const stringify = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
export function EventCard({ event }: { event: TraceEvent }) {
  const errored = event.result?.isError === true;
  const redactedThinking = event.kind === "thinking" && !event.text;
  if (redactedThinking) return <article id={`ev-${event.i}`} data-event-index={event.i} data-compact="true" className="pb-[var(--space-1)] scroll-mt-[var(--space-4)]"><Card variant="tight"><div className="flex items-center flex-wrap gap-x-[var(--space-3)] gap-y-[var(--space-1)] [font-size:var(--font-size-caption)]"><span className="text-label-upper">#{event.i} · thinking</span><span className="[color:var(--muted)]">thinking (redacted at source)</span>{event.tokens && <span className="[color:var(--muted)]">Tokens · reasoning {event.tokens.reasoning ?? 0}</span>}</div></Card></article>;
  return <article id={`ev-${event.i}`} data-event-index={event.i} className="pb-[var(--space-3)] scroll-mt-[var(--space-4)]">
    <Card variant={errored ? "danger" : "tight"} header={<span className="flex items-center gap-[var(--space-2)]"><span className="text-label-upper">#{event.i} · {eventLabel(event.kind)}</span>{errored && <StatusBadge label="✕ error" status="error" />}</span>}>
      <div className="flex flex-col gap-[var(--space-2)] [font-size:var(--font-size-body)] min-w-0">
        {event.text && <p className="whitespace-pre-wrap break-words">{event.text}</p>}
        {event.tool && <details open><summary className="cursor-pointer [font-weight:var(--font-weight-semibold)]">{event.tool.name} input</summary><CodeBlock code={stringify(event.tool.input ?? event.tool.command ?? "")} language="json" /></details>}
        {event.result && <details open={errored}><summary className="cursor-pointer [font-weight:var(--font-weight-semibold)]">Tool output · {duration(event.result.durationMs)}</summary><pre className="mt-[var(--space-2)] max-w-full overflow-x-auto whitespace-pre-wrap font-mono [font-size:var(--font-size-code)]">{event.result.text}</pre></details>}
        {event.tokens && <p className="[color:var(--muted)] [font-size:var(--font-size-caption)]">Tokens · in {event.tokens.input ?? 0} · out {event.tokens.output ?? 0} · cache {event.tokens.cacheRead ?? 0} · reasoning {event.tokens.reasoning ?? 0}</p>}
        {event.durationMs != null && <p className="[color:var(--muted)]">Duration · {duration(event.durationMs)}</p>}
        {event.subtask && event.childSessionId && <a className="[color:var(--color-link)] underline" href={linkTo(event.childSessionId)}>Open child trajectory →</a>}
      </div>
    </Card>
  </article>;
}
