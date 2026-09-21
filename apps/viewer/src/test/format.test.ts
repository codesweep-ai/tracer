import { describe, expect, it } from "vitest";
import { duration, timeLabel } from "../format";

describe("time display (R77)", () => {
  it("scales a duration to a unit a reader can take in", () => {
    expect(duration(450)).toBe("450 ms");
    expect(duration(12_300)).toBe("12.3 s");
    expect(duration(150_000)).toBe("2.5 min");
    expect(duration(211.4 * 3_600_000)).toBe("211.4 h");
    expect(duration(null)).toBe("—");
  });
  it("puts working time first and elapsed time beside it", () => {
    expect(timeLabel({ elapsedMs: 211.4 * 3_600_000, idleMs: 207 * 3_600_000, workMs: 4.4 * 3_600_000 })).toBe("4.4 h working · 211.4 h open");
    expect(timeLabel({ idleMs: 0, workMs: 0 })).toBe("0 ms working");
    expect(timeLabel(undefined)).toBe("—");
  });
});
