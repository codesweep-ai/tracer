import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OUTPUT_FOLD_LINES, ToolOutput, outputShape } from "../ToolOutput";
import { EventCard } from "../EventCard";

afterEach(cleanup);

/* R85. A tool output takes the same bounded block as an input, whole, with one
   control past the fold, and its shape picks the grammar. */
describe("tool output", () => {
  it("colours a JSON document as JSON, a patch as a diff, and leaves prose plain", () => {
    expect(outputShape('{"ok": true}')).toBe("json");
    expect(outputShape("[1, 2]")).toBe("json");
    expect(outputShape("{not json")).toBeUndefined();
    expect(outputShape("diff --git a/x b/x\n--- a/x\n+++ b/x")).toBe("diff");
    expect(outputShape("-one\n+ONE\n-two\n+TWO")).toBe("diff");
    expect(outputShape("total 3\n-rw-r--r-- 1 a b\ndrwxr-xr-x 2 c d")).toBeUndefined(); // an ls, not a patch
    expect(outputShape("plain text\nmore")).toBeUndefined();
  });

  it("renders the text whole, unescaped, and marks the block with its grammar", () => {
    const { container } = render(<ToolOutput text={'{"a": "line one\\nline two"}'} />);
    expect(container.textContent).toContain('"a"');
    expect(container.querySelector("[data-language=json]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /show all/i })).toBeNull(); // short: no fold control
  });

  it("offers Show all past the fold, and lifts the bound when asked", () => {
    const text = Array.from({ length: OUTPUT_FOLD_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const { container } = render(<ToolOutput text={text} />);
    expect(container.textContent).toContain(`line ${OUTPUT_FOLD_LINES + 4}`); // whole text is present before the control
    const more = screen.getByRole("button", { name: `Show all · ${OUTPUT_FOLD_LINES + 5} lines` });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Fold" })).toHaveAttribute("aria-expanded", "true");
  });

  it("draws a card's result through the same block", () => {
    const { container } = render(<EventCard event={{ i: 5, kind: "tool_call", tool: { name: "Bash" }, result: { text: "out\nput", isError: true } }} />);
    expect(container.querySelector(".tool-output pre")).not.toBeNull();
    expect(container.textContent).toContain("output".slice(0, 3));
  });
});
