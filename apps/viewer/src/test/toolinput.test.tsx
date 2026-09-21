import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolInput, unifiedDiff } from "../ToolInput";

afterEach(cleanup);

/** The rendered text, with CodeBlock's line chrome collapsed to plain text. */
function text(node: HTMLElement): string {
  return node.textContent ?? "";
}

/* R63. Rendering a tool input as JSON destroys the thing worth reading: almost
   every payload is a multi-line string, and escaping is what turns one into a
   single line of \n and \" . These assert the escaping is gone AND — the part
   that lets formatted be the default — that no key is dropped on the way. */
describe("formatted tool input", () => {
  it("shows a shell command as the script it is, not as an escaped string", () => {
    const command = "cd /tmp && python3 - <<'EOF'\np = \"x.md\"\nprint(p)\nEOF";
    const { container } = render(<ToolInput view="formatted" input={{ command, description: "Save the plan" }} />);
    expect(text(container)).toContain("python3 - <<'EOF'");
    expect(text(container)).toContain('p = "x.md"');
    // the escapes JSON would have introduced
    expect(text(container)).not.toContain("\\n");
    expect(text(container)).not.toContain('\\"');
  });

  it("keeps every other key beside the command", () => {
    const { container } = render(<ToolInput view="formatted" input={{ command: "ls", description: "List it", timeout: 120000 }} />);
    expect(text(container)).toContain("description");
    expect(text(container)).toContain("List it");
    expect(text(container)).toContain("timeout");
    expect(text(container)).toContain("120000");
  });

  it("renders an edit as a diff rather than two escaped blobs", () => {
    const { container } = render(<ToolInput view="formatted" input={{ file_path: "/a/b.txt", old_string: "one\ntwo\nthree", new_string: "one\nTWO\nthree" }} />);
    const body = text(container);
    expect(body).toContain("-two");
    expect(body).toContain("+TWO");
    expect(body).toContain(" one"); // context line, unchanged
    expect(body).toContain("/a/b.txt"); // the remaining key survives
  });

  it("accepts the camelCase spelling opencode uses", () => {
    const { container } = render(<ToolInput view="formatted" input={{ filePath: "/a/b.txt", oldString: "x", newString: "y" }} />);
    expect(text(container)).toContain("-x");
    expect(text(container)).toContain("+y");
  });

  it("shows a written file as its path and its body", () => {
    const { container } = render(<ToolInput view="formatted" input={{ file_path: "/notes.md", content: "# Title\n\nbody line" }} />);
    const body = text(container);
    expect(body).toContain("/notes.md");
    expect(body).toContain("# Title");
    expect(body).toContain("body line");
    expect(body).not.toContain("\\n");
  });

  it("shows codex's bare string input as text, unquoted", () => {
    const { container } = render(<ToolInput view="formatted" input={'echo "hi"'} />);
    expect(text(container)).toContain('echo "hi"');
    expect(text(container)).not.toContain('\\"');
  });

  it("falls back to labelled fields, dropping nothing", () => {
    const { container } = render(<ToolInput view="formatted" input={{ alpha: "short", beta: 7, gamma: false, delta: { nested: true } }} />);
    const body = text(container);
    for (const key of ["alpha", "beta", "gamma", "delta"]) expect(body).toContain(key);
    expect(body).toContain("short");
    expect(body).toContain("7");
    expect(body).toContain("false");
    expect(body).toContain("nested");
  });

  it("renders every key of every shape, so the JSON view reveals nothing withheld", () => {
    const inputs: Record<string, unknown>[] = [
      { command: "ls -la", description: "list", timeout: 5 },
      { file_path: "/a", old_string: "a", new_string: "b", replace_all: false },
      { file_path: "/a", content: "body", mode: "overwrite" },
      { prompt: "do the thing", subagent_type: "general-purpose", model: "haiku" },
    ];
    for (const input of inputs) {
      const { container } = render(<ToolInput view="formatted" input={input} />);
      for (const key of Object.keys(input)) {
        const value = input[key];
        const shown = text(container);
        // Either the key is labelled, or its value is rendered as the headline
        // block (the command, the diff, the file body, the path).
        const rendered = shown.includes(key) || (typeof value === "string" && shown.includes(value));
        expect(rendered, `${key} missing from ${JSON.stringify(input)}`).toBe(true);
      }
      cleanup();
    }
  });

  it("gives back the verbatim record when asked for JSON", () => {
    const input = { command: "ls", description: "list" };
    const { container } = render(<ToolInput view="json" input={input} />);
    const body = text(container);
    expect(body).toContain('"command"');
    expect(body).toContain('"description"');
  });
});

describe("unifiedDiff", () => {
  it("marks only what changed", () => {
    expect(unifiedDiff("a\nb\nc", "a\nB\nc")).toBe(" a\n-b\n+B\n c");
  });

  it("handles pure insertion and pure deletion", () => {
    expect(unifiedDiff("a\nc", "a\nb\nc")).toBe(" a\n+b\n c");
    expect(unifiedDiff("a\nb\nc", "a\nc")).toBe(" a\n-b\n c");
  });

  it("returns nothing for identical text, beyond context", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe(" a\n b");
  });

  // A wrong diff is worse than none, and the LCS table is quadratic, so past
  // the cap the caller shows both halves whole instead.
  it("declines past the line cap", () => {
    const big = new Array(500).fill("line").join("\n");
    expect(unifiedDiff(big, big)).toBeNull();
  });
});
