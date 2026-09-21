import { describe, expect, it } from "vitest";
import { costLabel, ownCost, rollupCost, traceCostLabel } from "../cost";
import type { LoadedTrace, TraceCost } from "../types";

const totals = (cost?: TraceCost) => ({ events: 1, toolCalls: 0, toolErrors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost });
const trace = (id: string, cost?: TraceCost, parent: string | null = null): LoadedTrace => ({ id, path: id, summary: { schemaVersion: 3, meta: { source: "t", sessionId: id, parentSessionId: parent }, totals: totals(cost), parse: { adapter: "t", adapterVersion: "1", skippedByType: [], unrecognized: 0, warnings: [] }, chunkSize: 1000, chunkCount: 1, strip: [] } });

describe("cost display (§9)", () => {
  it("labels an estimate, a reported figure and an unknown one apart", () => {
    expect(costLabel({ usd: 0.0142, estimated: true })).toBe("~$0.0142 est.");
    expect(costLabel({ usd: 0.0142, estimated: false })).toBe("$0.0142");
    expect(costLabel({ usd: 0.0142, estimated: false, incomplete: true })).toBe("≥$0.0142");
    expect(costLabel(null)).toBe("");
  });
  it("shows the reported figure, never the estimate, when the trajectory has one", () => {
    expect(ownCost(totals({ reported: [{ usd: 2, covers: "trajectory" }], estimated: { usd: 9 } }))).toEqual({ usd: 2, estimated: false });
    expect(ownCost(totals({ reportedByEvents: { usd: 3, events: 4, of: 4 }, estimated: { usd: 9 } }))).toEqual({ usd: 3, estimated: false });
    expect(ownCost(totals({ estimated: { usd: 9 } }))).toEqual({ usd: 9, estimated: true });
    expect(ownCost(totals({}))).toBeNull();
  });
  it("never shows a sum over some events as a total", () => {
    expect(ownCost(totals({ reportedByEvents: { usd: 3, events: 2, of: 4 }, estimated: { usd: 9 } }))).toEqual({ usd: 9, estimated: true });
    expect(ownCost(totals({ reportedByEvents: { usd: 3, events: 2, of: 4 } }))).toBeNull();
  });
  it("shows a figure covering the tree beside the trajectory's own", () => {
    expect(traceCostLabel(totals({ reported: [{ usd: 10, covers: "tree" }], estimated: { usd: 4 } }))).toBe("~$4.0000 est. · $10.0000 incl. sub-agents");
  });
  it("counts a tree once when its root reports for the whole tree", () => {
    const root = trace("root", { reported: [{ usd: 10, covers: "tree" }], estimated: { usd: 4 } });
    const child = trace("child", { estimated: { usd: 3 } }, "root");
    const grandchild = trace("grandchild", {}, "child");
    expect(rollupCost([child, root, grandchild])).toMatchObject({ usd: 10, estimated: false, priced: 1, unpriced: 0 });
  });
  it("adds members by their own figures when no figure covers the tree", () => {
    const root = trace("root", { reported: [{ usd: 2, covers: "trajectory" }] });
    const child = trace("child", { estimated: { usd: 3 } }, "root");
    const orphan = trace("orphan", {}, "gone");
    expect(rollupCost([root, child, orphan])).toMatchObject({ usd: 5, estimated: true, priced: 2, unpriced: 1 });
  });
});
