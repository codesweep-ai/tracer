import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexPage } from "../IndexPage";
import { TrajectoryPage } from "../TrajectoryPage";
import { EventCard } from "../EventCard";
import type { EventKind, LoadedTrace, TraceChunk, TraceEvent, TraceSummary } from "../types";
import { TRACE_PALETTE, traceColorKey } from "../palette";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

/* The kind colours are ui's categorical TOKEN palette now (traceColors.ts is
   gone): the values live in ui's tokens.css, so the guard resolves them from
   the installed package and asserts the property the review actually requires
   (TR-15/16): every kind fill clears 3:1 non-text contrast against the surfaces
   the strip renders on, in both themes — and no two kinds collapse to one hue. */
const tokensCss = readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve("@codesweep-ai/ui/package.json")), "dist/styles/tokens.css"), "utf8");
function tokenValue(name: string, theme: "dark" | "light"): string {
  const block = theme === "light" ? tokensCss.split(':root[data-theme="light"]')[1]! : tokensCss.split(':root[data-theme="light"]')[0]!;
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!match) throw new Error(`token ${name} not found for theme ${theme}`);
  return match[1]!;
}
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => { const f = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; const [r, g, bl] = [0, 2, 4].map((i) => f(parseInt(hex.slice(1 + i, 3 + i), 16) / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const summary: TraceSummary = { schemaVersion: 2, meta: { source: "claude-code", sessionId: "demo", parentSessionId: null, title: "Demo", model: "test", durationMs: 1000 }, totals: { events: 2, toolCalls: 0, toolErrors: 0, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, parse: { adapter: "demo", adapterVersion: "1", skippedByType: [], unrecognized: 0, warnings: [] }, links: [], chunkSize: 1000, chunkCount: 1, strip: [{ i: 0, kind: "user", error: false }, { i: 1, kind: "assistant", error: false }] };
const trace: LoadedTrace = { id: "demo", path: "demo", summary };
/** Inject a DOM data block exactly as the export assembler writes it: JSON with
 * every "<" escaped as < so a "</script>" in trace text cannot terminate the
 * block. */
function block(id: string, value: unknown) { const node = document.createElement("script"); node.type = "application/json"; node.id = id; node.textContent = JSON.stringify(value).replaceAll("<", "\\u003c"); document.body.append(node); }
/** A Legend chip's clickable button, found by the documented label hook. */
const chipButton = (name: string) => document.querySelector(`[data-legend-label="${name}"]`)?.closest("button");
beforeEach(() => { location.hash = ""; history.replaceState(null, "", "/"); document.querySelectorAll('script[type="application/json"]').forEach((node) => node.remove()); block("c-demo-000", { chunk: 0, events: [{ i: 0, kind: "user", text: "hello" }, { i: 1, kind: "assistant", text: "world" }] } satisfies TraceChunk); });
afterEach(cleanup);
describe("kind colours (token palette)", () => {
  it("keeps every kind fill at or above 3:1 against the strip's surfaces, in both themes (TR-15/16)", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const surface of ["--bg", "--card"] as const) {
        for (const [key, token] of Object.entries(TRACE_PALETTE)) {
          expect(contrastRatio(tokenValue(token, theme), tokenValue(surface, theme)), `${key} (${token}) vs ${surface} ${theme}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
  it("assigns kinds explicitly and never collapses two kinds to one hue", () => {
    expect(Object.keys(TRACE_PALETTE).sort()).toEqual(["assistant", "meta", "system", "thinking", "tool", "user"]);
    for (const theme of ["dark", "light"] as const) {
      const values = Object.values(TRACE_PALETTE).map((token) => tokenValue(token, theme));
      expect(new Set(values).size).toBe(values.length);
    }
    expect(traceColorKey("tool_call")).toBe("tool"); expect(traceColorKey("tool_result")).toBe("tool");
    // turn_end shares system's ink on purpose: it is identified by its trailing
    // tick, so it does not need a hue. meta does not share it — it recurs at
    // volume, and the legend lists and filters the two separately.
    expect(traceColorKey("turn_end")).toBe("system");
    expect(traceColorKey("meta")).toBe("meta");
    expect(TRACE_PALETTE.system).toBe("--muted"); // plumbing recedes to neutral ink, not a hue
    expect(TRACE_PALETTE.meta).toBe("--color-structural");
    for (const theme of ["dark", "light"] as const) {
      // the whole point of the second step: it must not read as --muted
      expect(tokenValue("--color-structural", theme)).not.toBe(tokenValue("--muted", theme));
    }
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
  it("renders filters and reacts to an in-page hash jump", async () => { const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo); render(<TrajectoryPage trace={trace} />); expect(screen.getByTestId("trajectory-page")).toBeInTheDocument(); expect(screen.getByLabelText("Trajectory filters")).toBeInTheDocument(); expect(document.querySelector("[data-search-input]")).toBeInTheDocument(); location.hash = "#ev-1"; window.dispatchEvent(new HashChangeEvent("hashchange")); await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 224, behavior: "auto" })); await waitFor(() => expect(screen.getByText("world")).toBeInTheDocument()); });
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
    act(() => { chipButton("tool")?.click(); });   // AND: no errored tools left (Legend's documented label hook is the chip's handle)
    await waitFor(() => expect(screen.getByTestId("empty-filter")).toBeInTheDocument());
  });

  it("says so honestly when a clean trajectory has no errors", async () => {
    render(<TrajectoryPage trace={trace} />);
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    act(() => { screen.getByTestId("errors-only").click(); });
    await waitFor(() => expect(screen.getByTestId("empty-filter")).toHaveTextContent("No errored events"));
  });
});

describe("kind filtering is independent of kind colour (T4-01 regression)", () => {
  /* `system`, `meta` and `turn_end` deliberately share one colour token, and the
     legend exposes them as three separate chips. EventLanes' `kind` is BOTH the
     paint key and the filter key, so passing it the coarse colour key made any
     partial selection among the three erase all three from the strip while the
     details list stayed correct — silent data loss, with data-event-count="0"
     and an "aria-disabled" listbox agreeing with it. One event per kind here, so
     a correct build reports exactly 1. */
  const stripKinds: EventKind[] = ["user", "tool_call", "thinking", "system", "meta", "turn_end"];
  const filterTrace: LoadedTrace = { id: "demo", path: "demo", summary: {
    ...summary,
    totals: { ...summary.totals, events: stripKinds.length },
    strip: stripKinds.map((kind, i) => ({ i, kind, error: false })),
  } };
  // These tests drive selection, and TrajectoryPage writes `#ev-N` into history
  // on every selection change. Left behind, that hash perturbs any test that
  // navigates by hash afterwards, so put the URL back.
  afterEach(() => { history.replaceState(null, "", "/"); location.hash = ""; });
  const eventCount = () => document.querySelector('[data-testid="strip"] [data-event-lanes-scroller]')?.getAttribute("data-event-count");
  const selectOnly = (...chips: string[]) => {
    fireEvent.click(screen.getByTestId("filter-none"));
    for (const chip of chips) fireEvent.click(chipButton(chip)!);
  };

  it.each([["meta"], ["turn end"], ["system"], ["user"], ["tool"]])(
    "selecting only %s keeps that kind visible in the strip", (chip) => {
      render(<TrajectoryPage trace={filterTrace} />);
      selectOnly(chip);
      expect(eventCount()).toBe("1");
    });

  it("keeps colour-siblings independent when selected in combination", () => {
    render(<TrajectoryPage trace={filterTrace} />);
    selectOnly("meta", "turn end");
    expect(eventCount()).toBe("2");
    selectOnly("system", "meta", "turn end");
    expect(eventCount()).toBe("3");
    selectOnly("user", "meta");
    expect(eventCount()).toBe("2");
  });

  it("still hides what was actually deselected", () => {
    render(<TrajectoryPage trace={filterTrace} />);
    selectOnly();
    expect(eventCount()).toBe("0");
  });
});
