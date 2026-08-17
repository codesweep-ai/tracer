export type EventKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system" | "meta" | "turn_end";
export interface TokenUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
export interface TraceMeta { source: string; sessionId: string; parentSessionId: string | null; agentId?: string | null; label?: string; title?: string; autoTitle?: string; model?: string | null; cliVersion?: string | null; cwd?: string; startedAt?: string; endedAt?: string; durationMs?: number | null; cost?: number | null }
export interface TraceTotals { events: number; toolCalls: number; toolErrors: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; cost?: number | null; costEstimated?: boolean }
export interface StripEvent { i: number; kind: EventKind; error: boolean; ts?: string; label?: string; size?: number; turnEnd?: boolean; subtask?: boolean; childSessionId?: string; redacted?: boolean }
export interface LinkHint { fromSessionId: string; toSessionId: string; kind: string; label?: string; evidence?: string }
/** Records that produced no event, counted per source record type and sorted by
 * type. Replaces a bare `skipped` count, which could not distinguish correctly
 * ignored bookkeeping from silently lost data. */
export interface SkippedType { type: string; count: number }
export interface ParseReport { adapter: string; adapterVersion: string; cliVersionRange?: string; skippedByType: SkippedType[]; unrecognized: number; warnings: Array<{ message: string; rawType?: string; count?: number }> }
export interface TraceSummary { schemaVersion: number; meta: TraceMeta; totals: TraceTotals; parse: ParseReport; links?: LinkHint[]; chunkSize: number; chunkCount: number; strip: StripEvent[] }
export interface TraceIndex { schemaVersion: number; generatedAt: string; trajectories: Array<{ id: string; path: string }>; links?: LinkHint[] }
export interface TraceEvent { i: number; kind: EventKind; ts?: string; text?: string; durationMs?: number; tokens?: TokenUsage; subtask?: boolean; childSessionId?: string; tool?: { name: string; callId?: string; input?: unknown; command?: string }; result?: { text?: string; isError?: boolean; ts?: string; durationMs?: number } }
export interface TraceChunk { chunk: number; events: TraceEvent[] }
export interface LoadedTrace { id: string; path: string; summary: TraceSummary }
