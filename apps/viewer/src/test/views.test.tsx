import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexPage } from "../IndexPage";
import { TrajectoryPage } from "../TrajectoryPage";
import { EventCard } from "../EventCard";
import type { LoadedTrace, TraceChunk, TraceEvent, TraceSummary } from "../types";
import { traceSeriesColors } from "../traceColors";
import type { ChartTheme } from "@codesweep-ai/ui";

/** a guard so a future palette edit cannot silently re-crowd the kind colours.
 * OKLab distance x100, same space the palette validator uses. */
function oklabDistance(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = [0, 2, 4].map((i) => { const v = parseInt(hex.slice(1 + i, 3 + i), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s2, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s2, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s2];
  };
  const [l1, a1, b1] = lab(a); const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

/* eslint-disable @codesweep-ai/no-hardcoded-colors -- this guard exists to assert exact
   colour VALUES; tokens would defeat the test. Values mirror the real theme tokens. */
const themeFor = (bg: string, error: string, muted = "#6b7280"): ChartTheme => ({ bg, card: bg, border: "#888", gridLine: "#888", fg: "#000", muted, axisLabel: "#888", accent: "#000", accentSoft: "#000", success: "#0a0", warning: "#fa0", error, categorical: [], categoricalLight: [], categoricalMid: [], categoricalDark: [] } as unknown as ChartTheme);

const summary: TraceSummary = { schemaVersion: 2, meta: { source: "claude-code", sessionId: "demo", parentSessionId: null, title: "Demo", model: "test", durationMs: 1000 }, totals: { events: 2, toolCalls: 0, toolErrors: 0, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, parse: { adapter: "demo", adapterVersion: "1", skippedByType: [], unrecognized: 0, warnings: [] }, links: [], chunkSize: 1000, chunkCount: 1, strip: [{ i: 0, kind: "user", error: false }, { i: 1, kind: "assistant", error: false }] };
const trace: LoadedTrace = { id: "demo", path: "demo", summary };
/** Inject a DOM data block exactly as the export assembler writes it: JSON with
 * every "<" escaped as < so a "</script>" in trace text cannot terminate the
 * block. */
function block(id: string, value: unknown) { const node = document.createElement("script"); node.type = "application/json"; node.id = id; node.textContent = JSON.stringify(value).replaceAll("<", "\\u003c"); document.body.append(node); }
beforeEach(() => { location.hash = ""; history.replaceState(null, "", "/"); document.querySelectorAll('script[type="application/json"]').forEach((node) => node.remove()); block("c-demo-000", { chunk: 0, events: [{ i: 0, kind: "user", text: "hello" }, { i: 1, kind: "assistant", text: "world" }] } satisfies TraceChunk); });
afterEach(cleanup);
describe("kind colours", () => {
  it("keeps every rendered kind colour perceptually apart, in both themes", () => {
    // real app tokens per theme (light/dark surfaces and muted ink)
      for (const [bg, error, muted] of [["#f3f4f6", "#dc2626", "#6b7280"], ["#0b0f14", "#f87171", "#9aa4af"]] as const) {
      const colors = traceSeriesColors(themeFor(bg, error, muted));
      const marks = { ...colors, error };
      const entries = Object.entries(marks);
      for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        const [nameA, colorA] = entries[i]!; const [nameB, colorB] = entries[j]!;
        expect(oklabDistance(colorA, colorB), `${nameA} vs ${nameB} on ${bg}`).toBeGreaterThanOrEqual(15);
      }
    }
  });
  it("assigns kinds explicitly rather than by palette order", () => {
    const light = traceSeriesColors(themeFor("#f3f4f6", "#dc2626", "#6b7280"));
    const dark = traceSeriesColors(themeFor("#0b0f14", "#f87171", "#9aa4af"));
    expect(light.user).not.toEqual(light.assistant);
    expect(light.user).not.toEqual(dark.user); // dark is selected, not an automatic flip
    expect(light.system).toEqual("#6b7280"); expect(dark.system).toEqual("#9aa4af"); // plumbing recedes to muted ink, not a hue
  });
});

describe("P0 views", () => {
  it("nests children when a root omits parentSessionId", () => { const rootMeta: Partial<typeof summary.meta> = { ...summary.meta }; delete rootMeta.parentSessionId; const rootWithoutParent: LoadedTrace = { ...trace, summary: { ...summary, meta: rootMeta as typeof summary.meta } }; const children: LoadedTrace[] = ["child-a", "child-b"].map((id) => ({ id, path: id, summary: { ...summary, meta: { ...summary.meta, sessionId: id, parentSessionId: "demo", title: id } } })); render(<IndexPage traces={[...children, rootWithoutParent]} links={[]} />); const lanes = screen.getAllByTestId("lane"); expect(lanes[0]?.style.marginLeft).toMatch(/^calc\(0 \*/); expect(lanes[1]?.style.marginLeft).toMatch(/^calc\(1 \*/); expect(lanes[2]?.style.marginLeft).toMatch(/^calc\(1 \*/); expect(screen.getAllByLabelText("Proven parent-child connector")).toHaveLength(2); });
  it("renders proven and hinted connectors distinctly", () => { const child: LoadedTrace = { id: "child", path: "child", summary: { ...summary, meta: { ...summary.meta, sessionId: "child", parentSessionId: "demo", title: "Child" } } }; render(<IndexPage traces={[trace, child]} links={[{ fromSessionId: "demo", toSessionId: "child", kind: "campaign" }]} />); expect(screen.getByTestId("index-page")).toBeInTheDocument(); expect(screen.getAllByTestId("lane")).toHaveLength(2); expect(screen.getByLabelText("Proven parent-child connector")).toHaveClass("border-solid"); expect(screen.getByLabelText("Dashed link hint")).toHaveClass("border-dashed"); expect(screen.getAllByTestId("strip")).toHaveLength(2); });
  it("marks the rollup estimated exactly when a known component is estimated", () => {
    const costTrace = (id: string, cost?: number, costEstimated?: boolean): LoadedTrace => ({ id, path: id, summary: { ...summary, meta: { ...summary.meta, sessionId: id, title: id }, totals: { ...summary.totals, cost, costEstimated } } });
    const real = costTrace("real", 10, false); const estimated = costTrace("estimated", 5, true); const unpriced = costTrace("unpriced");
    const { rerender } = render(<IndexPage traces={[real, estimated, unpriced]} links={[]} />);
    const rollup = () => screen.getByRole("heading", { name: "Trajectory overview" }).nextElementSibling;
    expect(rollup()).toHaveTextContent("~$15.0000 est.");
    expect(rollup()).toHaveTextContent("1 lane unpriced"); // the excluded lane is disclosed
    rerender(<IndexPage traces={[real, unpriced]} links={[]} />);
    expect(rollup()).toHaveTextContent("$10.0000"); expect(rollup()).not.toHaveTextContent("~$10.0000"); expect(rollup()).not.toHaveTextContent("est.");
    expect(rollup()).toHaveTextContent("1 lane unpriced");
    rerender(<IndexPage traces={[real, estimated]} links={[]} />);
    expect(rollup()).toHaveTextContent("~$15.0000 est."); expect(rollup()).not.toHaveTextContent("unpriced");
    rerender(<IndexPage traces={[unpriced, { ...unpriced, id: "unpriced-2", path: "unpriced-2" }]} links={[]} />);
    expect(rollup()).not.toHaveTextContent("$"); expect(rollup()).not.toHaveTextContent("unpriced");
  });
  it("drops the cost separator with the cost on the trajectory meta line", () => {
    // the shared summary has no cost; the separator must leave with money()'s
    // empty string instead of printing "… 1.0 s · · demo".
    const { rerender } = render(<TrajectoryPage trace={trace} />);
    const metaLine = () => screen.getByRole("heading", { name: "Demo" }).parentElement?.querySelector("p")?.textContent ?? "";
    expect(metaLine()).not.toMatch(/·\s*·/);
    expect(metaLine()).not.toContain("$");
    const priced: LoadedTrace = { ...trace, summary: { ...summary, totals: { ...summary.totals, cost: 2.3456, costEstimated: true } } };
    rerender(<TrajectoryPage trace={priced} />);
    expect(metaLine()).toContain("· ~$2.3456 est.");
    expect(metaLine()).not.toMatch(/·\s*·/);
  });
  it("renders filters and reacts to an in-page hash jump", async () => { const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo); render(<TrajectoryPage trace={trace} />); expect(screen.getByTestId("trajectory-page")).toBeInTheDocument(); expect(screen.getByLabelText("Trajectory filters")).toBeInTheDocument(); expect(screen.getByPlaceholderText("Filter event text or tool names")).toBeInTheDocument(); location.hash = "#ev-1"; window.dispatchEvent(new HashChangeEvent("hashchange")); await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 224, behavior: "auto" })); await waitFor(() => expect(screen.getByText("world")).toBeInTheDocument()); });
  it("does not let a settling scroll cancel a pending hash navigation", async () => {
    const longSummary: TraceSummary = { ...summary, totals: { ...summary.totals, events: 6 }, strip: Array.from({ length: 6 }, (_, i) => ({ i, kind: i % 2 ? "assistant" as const : "user" as const, error: false })) };
    render(<TrajectoryPage trace={{ ...trace, summary: longSummary }} />);
    const viewport = screen.getByTestId("virtual-event-list"); const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo); scrollTo.mockClear();
    Object.defineProperty(viewport, "scrollTop", { value: 224, writable: true });
    await act(async () => {
      history.replaceState(null, "", "#ev-5");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 5 * 224, behavior: "auto" });
    expect(location.hash).toBe("#ev-5");
  });
  it("labels empty thinking as a compact source-redaction marker without changing non-empty thinking", () => { const empty: TraceEvent = { i: 3, kind: "thinking", text: "", tokens: { reasoning: 12 } }; const { rerender } = render(<EventCard event={empty} />); expect(screen.getByText("thinking (redacted at source)")).toBeInTheDocument(); expect(screen.getByText("thinking (redacted at source)").closest("article")).toHaveAttribute("data-compact", "true"); const nonEmpty: TraceEvent = { i: 4, kind: "thinking", text: "Visible reasoning" }; rerender(<EventCard event={nonEmpty} />); expect(screen.getByText("Visible reasoning")).toBeInTheDocument(); expect(screen.queryByText("thinking (redacted at source)")).not.toBeInTheDocument(); expect(screen.getByText("Visible reasoning").closest("article")).not.toHaveAttribute("data-compact", "true"); });
});

describe("kind filters", () => {
  const errored: LoadedTrace = { id: "err", path: "err", summary: { ...summary, totals: { ...summary.totals, events: 3, toolErrors: 1 }, strip: [{ i: 0, kind: "user", error: false }, { i: 1, kind: "tool_call", error: true }, { i: 2, kind: "assistant", error: false }] } };
  beforeEach(() => { block("c-err-000", { chunk: 0, events: [{ i: 0, kind: "user", text: "hello" }, { i: 1, kind: "tool_call", text: "boom", result: { isError: true, text: "failed" } }, { i: 2, kind: "assistant", text: "world" }] } satisfies TraceChunk); });

  it("none clears every card and says so; all restores", async () => {
    render(<TrajectoryPage trace={errored} />);
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    act(() => { screen.getByTestId("filter-none").click(); });
    await waitFor(() => expect(screen.getByTestId("empty-filter")).toHaveTextContent("No event kinds selected"));
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    act(() => { screen.getByTestId("filter-all").click(); });
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  });

  it("errors only restricts to errored events and composes with kind chips", async () => {
    render(<TrajectoryPage trace={errored} />);
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    act(() => { screen.getByTestId("errors-only").click(); });
    await waitFor(() => expect(screen.queryByText("hello")).not.toBeInTheDocument());
    expect(screen.getByTestId("errors-only")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("errors only")).toBeInTheDocument();
    act(() => { screen.getByTitle("Hide tool events").click(); });   // AND: no errored tools left
    await waitFor(() => expect(screen.getByTestId("empty-filter")).toBeInTheDocument());
  });

  it("says so honestly when a clean trajectory has no errors", async () => {
    render(<TrajectoryPage trace={trace} />);
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    act(() => { screen.getByTestId("errors-only").click(); });
    await waitFor(() => expect(screen.getByTestId("empty-filter")).toHaveTextContent("No errored events"));
  });
});
