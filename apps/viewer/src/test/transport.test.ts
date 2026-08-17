import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceChunk, TraceSummary } from "../types";

/** Inject a DOM data block exactly as the export assembler writes it. */
function block(id: string, value: unknown) {
  const node = document.createElement("script");
  node.type = "application/json";
  node.id = id;
  node.textContent = JSON.stringify(value).replaceAll("<", "\\u003c");
  document.body.append(node);
}
const summaryFor = (id: string, chunkCount = 1): TraceSummary => ({ schemaVersion: 2, meta: { source: "claude-code", sessionId: id, parentSessionId: null }, totals: { events: 1, toolCalls: 0, toolErrors: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, parse: { adapter: "demo", adapterVersion: "1", skippedByType: [], unrecognized: 0, warnings: [] }, chunkSize: 1000, chunkCount, strip: [{ i: 0, kind: "user", error: false }] });

beforeEach(() => {
  document.querySelectorAll('script[type="application/json"]').forEach((node) => node.remove());
  history.replaceState(null, "", "/index.html");
  vi.resetModules(); // data.ts caches the index and chunks per module instance
});

describe("DOM data-block transport", () => {
  it("loads the index, summaries and chunks without fetch, at chunk granularity", async () => {
    const fetchSpy = vi.fn(); globalThis.fetch = fetchSpy;
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "a", path: "a" }, { id: "b", path: "b" }] });
    block("s-a", { ...summaryFor("a", 2), meta: { ...summaryFor("a").meta, title: "Alpha" } });
    block("s-b", summaryFor("b"));
    block("c-a-000", { chunk: 0, events: [{ i: 0, kind: "user", text: "first" }] });
    block("c-a-001", { chunk: 1, events: [{ i: 1000, kind: "assistant", text: "second chunk" }] });
    const { loadIndex, loadChunk } = await import("../data");
    const { index, traces } = await loadIndex();
    expect(traces.map((trace) => trace.id)).toEqual(["a", "b"]);
    expect(traces[0]?.summary.meta.title).toBe("Alpha");
    expect(index.trajectories).toHaveLength(2);
    // chunk granularity: chunk 1 parses without touching chunk 0's block again
    expect((await loadChunk("a", 1)).events[0]?.text).toBe("second chunk");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("round-trips hazardous text: </script>, U+2028/29, astral pairs, RTL override, literal \\u003c", async () => {
    // mirrors fixtures/claude/v2.1/hazard-text — including a LITERAL \<
    // sequence in the source text, which naive un-escaping would corrupt.
    const hazard = "close </script> here; line-sep\u2028 para-sep\u2029; astral \uD83D\uDE00; rtl \u202E; literal-lt \\u003c and <b>";
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "haz", path: "haz" }] });
    block("s-haz", summaryFor("haz"));
    block("c-haz-000", { chunk: 0, events: [{ i: 0, kind: "user", text: hazard }] });
    const { loadChunk } = await import("../data");
    expect((await loadChunk("haz", 0)).events[0]?.text).toBe(hazard);
  });

  it("resolves chunks by trace id even when the index path diverges (safeId)", async () => {
    // safeId maps every char outside [A-Za-z0-9._-] to "-"; blocks stay id-keyed.
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "a/b:c", path: "a-b-c" }] });
    block("s-a/b:c", summaryFor("a/b:c"));
    block("c-a/b:c-000", { chunk: 0, events: [{ i: 0, kind: "user", text: "found" }] });
    const { loadIndex, loadChunk } = await import("../data");
    const { traces } = await loadIndex();
    expect(traces[0]?.path).toBe("a-b-c");
    expect((await loadChunk(traces[0]!.path, 0)).events[0]?.text).toBe("found");
  });

  it("scanChunkText matches text and tool names case-insensitively, like the fetch version", async () => {
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "s", path: "s" }] });
    block("s-s", summaryFor("s"));
    block("c-s-000", { chunk: 0, events: [
      { i: 0, kind: "user", text: "Deploy the APP" },
      { i: 1, kind: "tool_call", tool: { name: "ReadFile" } },
      { i: 2, kind: "assistant", text: "nothing relevant" },
    ] satisfies TraceChunk["events"] });
    const { loadIndex, scanChunkText } = await import("../data");
    await loadIndex();
    expect(await scanChunkText("s", 0, "app")).toEqual([0]);
    expect(await scanChunkText("s", 0, "readfile")).toEqual([1]);
    expect(await scanChunkText("s", 0, "absent")).toEqual([]);
  });

  it("throws a named error for a missing block, and a parse error for a corrupt one", async () => {
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "x", path: "x" }] });
    const { loadIndex } = await import("../data");
    await expect(loadIndex()).rejects.toThrow("Could not load data block #s-x");

    document.querySelectorAll('script[type="application/json"]').forEach((node) => node.remove());
    vi.resetModules();
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [] });
    const corrupt = document.createElement("script");
    corrupt.type = "application/json"; corrupt.id = "c-x-000"; corrupt.textContent = "{not json";
    document.body.append(corrupt);
    const { loadChunk } = await import("../data");
    await expect(loadChunk("x", 0)).rejects.toThrow("Could not parse data block #c-x-000");
  });

  it("surfaces only the page's own trace on a split-mode trace page", async () => {
    block("mode", { mode: "split" });
    history.replaceState(null, "", "/out/traces/a.html");
    // reduced index: {id, safeId, title} per trajectory, no path, no other summaries
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "a", safeId: "a", title: "Mine" }, { id: "b", safeId: "b", title: "Other" }] });
    block("s-a", summaryFor("a"));
    const { loadIndex } = await import("../data");
    const { traces } = await loadIndex();
    expect(traces.map((trace) => trace.id)).toEqual(["a"]);
    expect(traces[0]?.path).toBe("a"); // path falls back to id when the reduced index omits it
});

  // A version the viewer does not implement must be REFUSED, not rendered.
  // Rendering it produces blank panels and missing fields that look like data
  // problems and send whoever debugs it somewhere else entirely.
  it("refuses a document whose schema version it does not implement", async () => {
    block("index", { schemaVersion: 99, generatedAt: "", trajectories: [{ id: "a", path: "a" }] });
    block("s-a", summaryFor("a"));
    const { loadIndex } = await import("../data");
    await expect(loadIndex()).rejects.toThrow(/schema version 99.*implements version 2/s);
  });
});
