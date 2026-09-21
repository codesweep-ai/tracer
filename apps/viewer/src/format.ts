import type { TraceTime } from "./types";
export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
export const duration = (ms?: number | null) => ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
/** Working time first, then how long the trajectory was open (R77). Elapsed time
 * alone read as how long a session took, and one left open over a weekend read
 * as 211 hours of work. */
export const timeLabel = (time?: TraceTime) => time == null ? "—" : [`${duration(time.workMs)} working`, time.elapsedMs == null ? "" : `${duration(time.elapsedMs)} open`].filter(Boolean).join(" · ");
export const eventLabel = (kind: string) => kind.replace("_", " ");
