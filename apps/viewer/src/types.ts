export type EventKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system" | "meta" | "turn_end";
export interface TokenUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
export interface TraceMeta { source: string; sessionId: string; parentSessionId: string | null; agentId?: string | null; label?: string; title?: string; autoTitle?: string; model?: string | null; cliVersion?: string | null; cwd?: string; startedAt?: string; endedAt?: string; durationMs?: number | null }
/** A cost the CLI itself stated for a span of work: this trajectory alone, or it
 * and its sub-agents (§9). */
export interface ReportedCost { usd: number; covers: "trajectory" | "tree"; byModel?: Array<{ model: string; usd: number }>; incomplete?: true }
/** Every cost figure for a trajectory, kept apart by where it came from. */
export interface TraceCost { reported?: ReportedCost[]; reportedByEvents?: { usd: number; events: number; of: number }; estimated?: { usd: number } }
export interface TraceTotals { events: number; toolCalls: number; toolErrors: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; cost?: TraceCost }
export interface StripEvent { i: number; kind: EventKind; error: boolean; ts?: string; label?: string; size?: number; turnEnd?: boolean; subtask?: boolean; childSessionId?: string; redacted?: boolean }
export interface LinkHint { fromSessionId: string; toSessionId: string; kind: string; label?: string; evidence?: string }
/** Records that produced no event, counted per source record type and sorted by
 * type. Replaces a bare `skipped` count, which could not distinguish correctly
 * ignored bookkeeping from silently lost data. */
export interface SkippedType { type: string; count: number }
/** `unrecognized` counts valid records whose type no adapter knows — the adapter
 * is behind its CLI. `unreadable` counts lines that were not JSON at all — the
 * file is damaged. They call for opposite responses, so they are reported and
 * badged apart (R56). Optional: exports written before R56 omit it. */
export interface ParseReport { adapter: string; adapterVersion: string; cliVersionRange?: string; skippedByType: SkippedType[]; unrecognized: number; unreadable?: number; warnings: Array<{ message: string; rawType?: string; count?: number }> }
export interface TraceSummary { schemaVersion: number; meta: TraceMeta; totals: TraceTotals; parse: ParseReport; links?: LinkHint[]; chunkSize: number; chunkCount: number; strip: StripEvent[] }
export interface TraceIndex { schemaVersion: number; generatedAt: string; trajectories: Array<{ id: string; path: string }>; links?: LinkHint[] }
export interface TraceEvent { i: number; kind: EventKind; ts?: string; text?: string; durationMs?: number; isError?: boolean; tokens?: TokenUsage; reportedCostUSD?: number; subtask?: boolean; childSessionId?: string; tool?: { name: string; callId?: string; input?: unknown; command?: string }; result?: { text?: string; isError?: boolean; ts?: string; durationMs?: number } }
export interface TraceChunk { chunk: number; events: TraceEvent[] }
export interface LoadedTrace { id: string; path: string; summary: TraceSummary }
