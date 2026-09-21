import { describe, expect, it } from "vitest";
import { timingLabel } from "../EventStrip";

describe("a cell's time in its tooltip", () => {
  it("names model time, and splits it where the CLI recorded the start", () => {
    expect(timingLabel({ i: 239, kind: "thinking", error: false, workMs: 48_143, activeMs: 211 })).toBe(" · model time 48.1 s (waited 47.9 s, thought 211 ms)");
    expect(timingLabel({ i: 57, kind: "assistant", error: false, workMs: 4_000, activeMs: 3_800 })).toBe(" · model time 4.0 s (waited 200 ms, wrote 3.8 s)");
    expect(timingLabel({ i: 412, kind: "thinking", error: false, workMs: 20_400 })).toBe(" · model time 20.4 s");
  });
  it("says where a bar stops short of the value", () => {
    expect(timingLabel({ i: 1, kind: "tool_call", error: false, workMs: 180_000 })).toBe(" · took 3.0 min (bar stops at 2.0 min)");
    expect(timingLabel({ i: 2, kind: "turn_end", error: false, idleMs: 4_320_000 })).toBe(" · waited 1.2 h (bar stops at 1.0 h)");
    expect(timingLabel({ i: 3, kind: "user", error: false })).toBe("");
  });
});
