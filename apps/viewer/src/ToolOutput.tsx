import { useState } from "react";
import { Block } from "./ToolInput";

/**
 * How a tool's output is drawn (R85). Outputs run far longer than inputs: in
 * four captured corpora between 13 and 42 per cent ran past 40 lines, and the
 * longest past 1,400. Drawn as one unbounded block, a single card grew taller
 * than the list it sat in. The output takes the same bounded block as an
 * input, scrolling on its own past the bound, and one control lifts the bound
 * so the whole text flows in the page.
 *
 * As with inputs, shape and never tool name picks the grammar: a document
 * that parses as JSON is coloured as JSON, a patch as a diff, and everything
 * else stays plain text. The text itself is never altered or cut.
 */

/** Past this many lines the output offers "Show all"; below it the bounded
 *  block already shows everything, so a control would be noise. */
export const OUTPUT_FOLD_LINES = 20;

/** The grammar an output's shape asks for, or undefined for plain text. */
export function outputShape(text: string): "json" | "diff" | undefined {
  const lead = text.trimStart();
  if (lead.startsWith("{") || lead.startsWith("[")) {
    try { JSON.parse(text); return "json"; } catch { /* not a document */ }
  }
  if (lead.startsWith("diff --git") || lead.startsWith("--- ") || lead.startsWith("@@ ")) return "diff";
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length >= 3 && lines.filter((line) => "+-@".includes(line[0]!)).length * 2 > lines.length) return "diff";
  return undefined;
}

export function ToolOutput({ text }: { text: string }) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.length ? text.split("\n").length : 0;
  const foldable = lines > OUTPUT_FOLD_LINES;
  return <div className="tool-output">
    <Block code={text} language={outputShape(text)} inline={foldable && showAll} />
    {foldable && <button type="button" className="tool-output-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? "Fold" : `Show all · ${lines.toLocaleString()} lines`}</button>}
  </div>;
}
