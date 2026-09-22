import { describe, expect, it } from "vitest";
import { FAILED_MARKER_TOKEN, FULL_MAGNITUDE, SPAWN_MARKER_TOKEN, STRIP_PALETTE, failedKind, stripHiddenKinds, stripLaneEvents } from "../EventStrip";
import type { StripEvent } from "../types";

const step = (i: number, extra: Partial<StripEvent> = {}): StripEvent => ({ i, kind: "tool_call", error: false, ts: "2026-01-01T00:00:00.000Z", size: 1, workMs: 2_000, ...extra } as StripEvent);

/* R47 (TRC-039). A failed step is drawn in the error colour with the accent dot
   above it, and with errors only on it rises to the top of its row. The cross
   inside the cell was two strokes nobody found. */
describe("failed steps on the strip", () => {
  it("paints a failed step in the error colour, as its own kind, with nothing drawn inside it", () => {
    const [ok, failed] = stripLaneEvents([step(1), step(2, { error: true })]);
    expect(ok!.kind).toBe("tool_call");
    expect(ok!.marker).toBeUndefined();
    expect(failed!.kind).toBe(failedKind("tool_call"));
    expect(STRIP_PALETTE[failed!.kind]).toBe("--color-error");
    expect(failed!.marker).toBeUndefined(); // the dot belongs to errors only
    expect((failed as { error?: boolean }).error).toBeUndefined(); // no cross
  });

  it("keeps a failed step at its own height until errors only is on, then raises it with a dot", () => {
    const [ordinary] = stripLaneEvents([step(1, { error: true })]);
    const [raised] = stripLaneEvents([step(1, { error: true })], true);
    const [okRaised] = stripLaneEvents([step(2)], true);
    expect(ordinary!.magnitude).toBeLessThan(FULL_MAGNITUDE);
    expect(raised!.magnitude).toBe(FULL_MAGNITUDE);
    expect(raised!.marker).toBe("failed");
    expect(raised!.markerToken).toBe(FAILED_MARKER_TOKEN);
    expect(okRaised!.magnitude).toBeLessThan(FULL_MAGNITUDE); // only the failed ones rise
    expect(okRaised!.marker).toBeUndefined();
  });

  it("leaves headroom above the tallest bar for the dot", () => {
    expect(FULL_MAGNITUDE).toBeGreaterThan(0.5);
    expect(FULL_MAGNITUDE).toBeLessThan(1);
    const [ceiling] = stripLaneEvents([step(1, { workMs: 10 * 60_000 })]);
    expect(ceiling!.magnitude).toBeCloseTo(FULL_MAGNITUDE);
    expect(ceiling!.clipped).toBe(true);
  });

  it("gives a spawn's marker a colour of its own, so the two dots never read alike", () => {
    const [spawn] = stripLaneEvents([step(1, { subtask: true, childSessionId: "child" })]);
    expect(spawn!.marker).toBe("spawn");
    expect(spawn!.markerToken).toBe(SPAWN_MARKER_TOKEN);
    expect(SPAWN_MARKER_TOKEN).not.toBe(FAILED_MARKER_TOKEN);
  });

  it("hides a kind's failed steps along with the kind", () => {
    const hidden = stripHiddenKinds(new Set(["tool_call"]));
    expect(hidden?.has("tool_call")).toBe(true);
    expect(hidden?.has(failedKind("tool_call"))).toBe(true);
    expect(hidden?.has("assistant")).toBe(false);
    expect(stripHiddenKinds(undefined)).toBeUndefined();
  });
});
