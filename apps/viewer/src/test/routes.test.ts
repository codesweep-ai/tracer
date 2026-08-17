import { beforeEach, describe, expect, it } from "vitest";
import { currentTraceId, inTracePage, indexLink, linkTo, mode, traceFilename } from "../routes";
import type { LoadedTrace } from "../types";

function block(id: string, value: unknown) {
  const node = document.createElement("script");
  node.type = "application/json";
  node.id = id;
  node.textContent = JSON.stringify(value).replaceAll("<", "\\u003c");
  document.body.append(node);
}
const trace = (id: string): LoadedTrace => ({ id, path: id, summary: { schemaVersion: 2, meta: { source: "t", sessionId: id, parentSessionId: null }, totals: { events: 0, toolCalls: 0, toolErrors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, parse: { adapter: "t", adapterVersion: "1", skippedByType: [], unrecognized: 0, warnings: [] }, chunkSize: 1000, chunkCount: 1, strip: [] } });

beforeEach(() => {
  document.querySelectorAll('script[type="application/json"]').forEach((node) => node.remove());
  history.replaceState(null, "", "/index.html");
});

describe("mode block", () => {
  it("defaults to single when absent, unreadable, or anything but split", () => {
    expect(mode()).toBe("single");
    block("mode", { mode: "split" });
    expect(mode()).toBe("split");
    document.getElementById("mode")!.textContent = "{corrupt";
    expect(mode()).toBe("single");
  });
});

describe("linkTo", () => {
  it("keeps the ?trace=<id>#ev-<n> scheme in single mode", () => {
    expect(linkTo("abc123")).toBe("?trace=abc123");
    expect(linkTo("abc123", 42)).toBe("?trace=abc123#ev-42");
    expect(linkTo("a/b?c", 1)).toBe("?trace=a%2Fb%3Fc#ev-1"); // query-safe
  });

  it("uses the filename in split mode: traces/<safeId>.html from the index, sibling from a trace page", () => {
    block("mode", { mode: "split" });
    history.replaceState(null, "", "/out/index.html");
    expect(linkTo("abc123", 7)).toBe("traces/abc123.html#ev-7");
    history.replaceState(null, "", "/out/traces/abc123.html");
    expect(linkTo("def456", 3)).toBe("def456.html#ev-3");
    expect(linkTo("def456")).toBe("def456.html");
  });

  it("honours the exporter's id→filename mapping before falling back to the safeId transform", () => {
    block("mode", { mode: "split" });
    // reduced index on a trace page: {id, safeId, title} — the collision-disambiguated name wins
    block("index", { schemaVersion: 2, generatedAt: "", trajectories: [{ id: "a/b", safeId: "a-b-2" }] });
    expect(traceFilename("a/b")).toBe("a-b-2.html");
    expect(linkTo("a/b")).toBe("traces/a-b-2.html");
    // full index on the root page: path already IS the safeId
    document.getElementById("index")!.textContent = JSON.stringify({ schemaVersion: 2, generatedAt: "", trajectories: [{ id: "a/b", path: "a-b" }] });
    expect(traceFilename("a/b")).toBe("a-b.html");
    // no index entry at all: fall back to the safeId transform
    document.getElementById("index")!.remove();
    expect(traceFilename("a/b")).toBe("a-b.html");
    expect(traceFilename("")).toBe("trajectory.html");
  });
});

describe("indexLink", () => {
  it("is a query-only reset in single mode and a relative path in split mode", () => {
    expect(indexLink()).toBe("?");
    block("mode", { mode: "split" });
    history.replaceState(null, "", "/out/index.html");
    expect(indexLink()).toBe("index.html");
    history.replaceState(null, "", "/out/traces/abc.html");
    expect(indexLink()).toBe("../index.html");
  });
});

describe("inTracePage", () => {
  it("matches only traces/<file>.html", () => {
    expect(inTracePage()).toBe(false);
    history.replaceState(null, "", "/out/traces/abc.html");
    expect(inTracePage()).toBe(true);
    history.replaceState(null, "", "/out/traces/"); // a bare directory is the index, not a trace
    expect(inTracePage()).toBe(false);
  });
});

describe("currentTraceId", () => {
  it("reads ?trace= exactly as before in both modes", () => {
    history.replaceState(null, "", "/index.html?trace=abc123");
    expect(currentTraceId([])).toBe("abc123");
    expect(currentTraceId([trace("abc123")])).toBe("abc123");
    block("mode", { mode: "split" });
    expect(currentTraceId([trace("abc123")])).toBe("abc123"); // explicit param wins even in split
  });

  it("lets the filename do the job of ?trace= on split trace pages only", () => {
    block("mode", { mode: "split" });
    history.replaceState(null, "", "/out/traces/abc.html");
    expect(currentTraceId([trace("abc")])).toBe("abc");
    expect(currentTraceId([trace("a"), trace("b")])).toBeNull(); // corrupt page: refuse to guess
    history.replaceState(null, "", "/out/index.html");
    expect(currentTraceId([trace("only")])).toBeNull(); // a one-trace corpus still shows the IndexPage
  });
});
