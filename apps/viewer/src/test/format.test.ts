import { describe, expect, it } from "vitest";
import { money } from "../format";

describe("cost display", () => {
  it("distinguishes estimates, real costs, and unknown prices", () => {
    expect(money(0.0142, true)).toBe("~$0.0142 est.");
    expect(money(0.0142, false)).toBe("$0.0142");
    expect(money(null, false)).toBe("");
  });
});
