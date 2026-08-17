// Tests for scripts/assemble.mjs — the data-block contract the Go
// exporter implements. Each value is round-tripped through a REAL HTML parse
// (jsdom), because the hazards live exactly at the HTML/JSON boundary.
import { describe, expect, it } from "vitest";
import { block, chunkBlockId, escapeBlock, injectBlocks, reducedIndex, safeId, summaryBlockId } from "../../scripts/assemble.mjs";

const SHELL = "<!doctype html><html><body><div id=\"root\"></div></body></html>";

function roundTrip(value) {
  const html = injectBlocks(SHELL, [block("test-block", value)]);
  const container = document.createElement("div");
  container.innerHTML = html;
  const el = container.querySelector("#test-block");
  expect(el, "block survives the HTML parse").toBeTruthy();
  return JSON.parse(el.textContent);
}

describe("data-block assembly", () => {
  it("escapes < so a </script> in trace text cannot terminate the block", () => {
    const value = { text: "run </script> to finish <b>bold</b> </SCRIPT>" };
    const html = block("x", value);
    expect(html).not.toContain("</script> to finish"); // the literal close tag is gone from the source
    expect(html).toContain("\\u003c/script>");
    expect(roundTrip(value)).toEqual(value);
  });

  it("round-trips U+2028/U+2029, astral pairs, RTL override and control chars", () => {
        const value = { text: "line-sep\u2028 para-sep\u2029 astral \uD83D\uDE00 rtl \u202E ctrl\u0009A" };
    expect(roundTrip(value)).toEqual(value);
  });

  it("keeps a LITERAL \\u003c sequence intact (naive un-escaping would corrupt it)", () => {
    const value = { text: "literal six chars: \\u003c (not a less-than)" };
    const result = roundTrip(value);
    expect(result.text).toBe(value.text); // the six characters \< are preserved verbatim
    expect(result.text).toContain("\\u003c");
    expect(result.text).not.toContain("<");
  });

  it("does not let `$'`, `$$`, `$&` or `$`` in block JSON corrupt the shell (String.replace trap)", () => {
    // fixtures/claude/v2.1/hazard-text carries `squashfs$'` — with a string
    // replacer, `$'` would insert the shell tail (</html>) mid-block and the
    // JSON would gain a raw newline + unescaped </html>, breaking the parse.
    const value = { command: "grep -E 'squashfs$' | sort", dollar: "$$ $& $` $' $1" };
    const html = injectBlocks(SHELL, [block("test-block", value)]);
    expect(html.endsWith("</body></html>")).toBe(true); // shell tail appears exactly once, at the end
    expect(html.indexOf("</body>")).toBe(html.lastIndexOf("</body>"));
    expect(roundTrip(value)).toEqual(value);
  });

  it("injects multiple blocks in order before </body>", () => {
    const html = injectBlocks(SHELL, [block("a", 1), block("b", 2)]);
    expect(html.indexOf('id="a"')).toBeLessThan(html.indexOf('id="b"'));
    expect(html.indexOf('id="b"')).toBeLessThan(html.indexOf("</body>"));
  });

  it("rejects a shell with no </body>", () => {
    expect(() => injectBlocks("<html>", [])).toThrow("no </body>");
  });
});

describe("block naming and safeId", () => {
  it("names blocks per the export contract: #s-<id>, #c-<id>-NNN zero-padded", () => {
    expect(summaryBlockId("abc")).toBe("s-abc");
    expect(chunkBlockId("abc", 0)).toBe("c-abc-000");
    expect(chunkBlockId("abc", 12)).toBe("c-abc-012");
    expect(chunkBlockId("abc", 1000)).toBe("c-abc-1000");
  });

  it("safeId maps a trace id to its on-disk filename", () => {
    expect(safeId("58e37c63-95c0-4672-aca5-ad8a7e7ddc41")).toBe("58e37c63-95c0-4672-aca5-ad8a7e7ddc41");
    expect(safeId("ses_04a436e44ffecFufRBJP9S31dl")).toBe("ses_04a436e44ffecFufRBJP9S31dl");
    expect(safeId("a/b:c d")).toBe("a-b-c-d");
    expect(safeId("")).toBe("trajectory");
  });

  it("reducedIndex carries only {id, safeId, title} per trajectory, plus links", () => {
    const index = { schemaVersion: 1, generatedAt: "now", trajectories: [{ id: "a", path: "a" }, { id: "b", path: "b" }], links: [{ fromSessionId: "a", toSessionId: "b", kind: "spawned" }] };
    const reduced = reducedIndex(index, (id) => (id === "a" ? "Title A" : undefined), (id) => safeId(id));
    expect(reduced.trajectories).toEqual([{ id: "a", safeId: "a", title: "Title A" }, { id: "b", safeId: "b", title: undefined }]);
    expect(reduced.links).toHaveLength(1);
    expect(JSON.stringify(reduced.trajectories[0])).not.toContain("path"); // no full-index fields leak in
  });
});

describe("escapeBlock", () => {
  it("escapes every < and nothing else", () => {
    expect(escapeBlock('{"a":"<x>&"y""}')).toBe('{"a":"\\u003cx>&"y""}');
  });
});
