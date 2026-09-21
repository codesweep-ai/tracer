import type { LoadedTrace, TraceTotals } from "./types";

/** One figure to show, and whether it is tracer's estimate rather than the CLI's own. */
export interface ShownCost { usd: number; estimated: boolean; incomplete?: boolean }

/** The figure a trajectory shows for itself (§9): a reported figure covering it
 * alone, else a per-event sum covering every event, else tracer's estimate. A
 * sum over some events is not a total, so it is never shown as one. */
export function ownCost(totals: TraceTotals): ShownCost | null {
  const cost = totals.cost; if (!cost) return null;
  const mine = cost.reported?.find((figure) => figure.covers === "trajectory");
  if (mine) return { usd: mine.usd, estimated: false, incomplete: mine.incomplete };
  const byEvents = cost.reportedByEvents;
  if (byEvents && byEvents.events === byEvents.of) return { usd: byEvents.usd, estimated: false };
  if (cost.estimated) return { usd: cost.estimated.usd, estimated: true };
  return null;
}

/** A reported figure covering this trajectory and its sub-agents together (R72). */
export function treeCost(totals: TraceTotals): ShownCost | null {
  const tree = totals.cost?.reported?.find((figure) => figure.covers === "tree");
  return tree ? { usd: tree.usd, estimated: false, incomplete: tree.incomplete } : null;
}

export const costLabel = (cost: ShownCost | null) => cost == null ? "" : cost.estimated ? `~$${cost.usd.toFixed(4)} est.` : `${cost.incomplete ? "≥" : ""}$${cost.usd.toFixed(4)}`;

/** The label beside a trajectory: its own figure, then any figure covering its tree. */
export function traceCostLabel(totals: TraceTotals) {
  const tree = treeCost(totals);
  return [costLabel(ownCost(totals)), tree ? `${costLabel(tree)} incl. sub-agents` : ""].filter(Boolean).join(" · ");
}

/** A total that counts each tree once (§9). A trajectory whose figure covers its
 * tree stands for every trajectory under it; otherwise it adds its own figure and
 * each child is taken the same way. `unpriced` counts trajectories with no figure
 * at all, which R51 requires the total to admit to. */
export function rollupCost(traces: LoadedTrace[]) {
  const ids = new Set(traces.map((trace) => trace.id));
  const children = new Map<string, LoadedTrace[]>();
  traces.forEach((trace) => { const parent = trace.summary.meta.parentSessionId; if (parent && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), trace]); });
  const sum = { usd: 0, estimated: false, incomplete: false, priced: 0, unpriced: 0 };
  const seen = new Set<string>();
  const visit = (trace: LoadedTrace) => {
    if (seen.has(trace.id)) return; seen.add(trace.id);
    const tree = treeCost(trace.summary.totals);
    const shown = tree ?? ownCost(trace.summary.totals);
    if (shown) { sum.usd += shown.usd; sum.priced++; sum.estimated ||= shown.estimated; sum.incomplete ||= Boolean(shown.incomplete); } else sum.unpriced++;
    if (tree) { markCovered(trace); return; }
    (children.get(trace.id) ?? []).forEach(visit);
  };
  const markCovered = (trace: LoadedTrace) => (children.get(trace.id) ?? []).forEach((child) => { seen.add(child.id); markCovered(child); });
  traces.filter((trace) => { const parent = trace.summary.meta.parentSessionId; return !parent || !ids.has(parent); }).forEach(visit);
  traces.forEach(visit);
  return sum;
}
