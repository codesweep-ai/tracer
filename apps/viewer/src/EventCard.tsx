import { Card, HighlightText, StatusBadge } from "@codesweep-ai/ui";
import { CodeBlock } from "@codesweep-ai/ui/code";
import json from "highlight.js/lib/languages/json";
import { duration, eventLabel } from "./format";
import { hasTrace, linkTo } from "./routes";
import type { TraceEvent } from "./types";

// CodeBlock registers no grammars by default; without `languages` the tool
// input renders escaped and uncoloured, which looks like a styling bug.
const stringify = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
export function EventCard({ event, query }: { event: TraceEvent; query?: string }) {
  const errored = event.result?.isError === true;
  const redactedThinking = event.kind === "thinking" && !event.text;
  if (redactedThinking) return <article id={`ev-${event.i}`} data-card-index={event.i} data-compact="true" className="event-card event-card-compact"><Card variant="tight"><div className="event-card-head"><span className="text-label-upper">#{event.i} · thinking</span><span className="muted">thinking (redacted at source)</span>{event.tokens && <span className="muted">Tokens · reasoning {event.tokens.reasoning ?? 0}</span>}</div></Card></article>;
  return <article id={`ev-${event.i}`} data-card-index={event.i} className="event-card">
    <Card variant={errored ? "danger" : "tight"} header={<span className="event-card-title"><span className="text-label-upper">#{event.i} · {eventLabel(event.kind)}</span>{errored && <StatusBadge label="error" status="error" />}</span>}>
      <div className="event-card-body">
        {event.text && <p className="event-text"><HighlightText text={event.text} query={query} /></p>}
        {event.tool && <details open><summary className="tool-summary"><HighlightText text={event.tool.name} query={query} /> input</summary><CodeBlock code={stringify(event.tool.input ?? event.tool.command ?? "")} language="json" languages={{ json }} /></details>}
        {event.result && <details open={errored}><summary className="tool-summary">Tool output · {duration(event.result.durationMs)}</summary><pre className="tool-output">{event.result.text}</pre></details>}
        {event.tokens && <p className="muted caption">Tokens · in {event.tokens.input ?? 0} · out {event.tokens.output ?? 0} · cache {event.tokens.cacheRead ?? 0} · reasoning {event.tokens.reasoning ?? 0}</p>}
        {event.durationMs != null && <p className="muted">Duration · {duration(event.durationMs)}</p>}
        {/* A child link is only offered when the child is actually here. The
            id is the parent's claim about a separate trajectory, and linking
            to one that was never exported — or whose reference is broken —
            produced a live-looking link to "Trajectory … was not found", or a
            404 in split mode. The spawn is still reported, because it happened. */}
        {event.subtask && event.childSessionId && (hasTrace(event.childSessionId)
          ? <a className="child-link" href={linkTo(event.childSessionId)}>Open child trajectory →</a>
          : <span className="child-link child-link-absent" data-child-absent="">Spawned a child trajectory · not in this export</span>)}
      </div>
    </Card>
  </article>;
}
