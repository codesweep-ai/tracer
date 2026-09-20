import { CodeBlock } from "@codesweep-ai/ui/code";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";

/**
 * How a tool call's input is drawn. "json" is the verbatim record; "formatted"
 * is the same data laid out so a human can read it (R63).
 */
export type ToolInputView = "formatted" | "json";

/**
 * Rendering a tool input as JSON destroys exactly the thing worth reading.
 * Almost every tool's payload is a MULTI-LINE STRING — a shell script, a file
 * body, the two halves of an edit — and JSON escaping is what turns a
 * multi-line string into one line of \n and \" . In one captured corpus, 3,159
 * of 3,432 tool calls were shell commands, so the common case was the worst
 * affected: a heredoc arrived as a single unreadable line.
 *
 * Detection is by SHAPE, never by tool name. Tool names differ per CLI —
 * claude's `file_path` is opencode's `filePath`, and codex hands over a bare
 * string — and the fixture scrubber rewrites tool names to prose, so a table
 * keyed by name could not be exercised by the corpus at all. Field shapes
 * survive scrubbing; names do not.
 */

/** Grammars this module needs. CodeBlock registers none by default: an
 *  unregistered language renders escaped and uncoloured, which reads as a
 *  styling bug rather than a missing grammar. */
const GRAMMARS = { bash, diff, json };

/** JSON.stringify, but a string input is its own text — quoting and escaping a
 *  bare string (codex's `exec`) adds nothing to read. */
function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First present string among `names`, with its key, or null. Spelling varies
 *  by CLI, so every shape test takes the alternatives it accepts. */
function pick(input: Record<string, unknown>, names: readonly string[]): { key: string; value: string } | null {
  for (const key of names) {
    const value = input[key];
    if (typeof value === "string") return { key, value };
  }
  return null;
}

const COMMAND_KEYS = ["command", "cmd"] as const;
const PATH_KEYS = ["file_path", "filePath", "path"] as const;
const OLD_KEYS = ["old_string", "oldString"] as const;
const NEW_KEYS = ["new_string", "newString"] as const;
const CONTENT_KEYS = ["content", "contents", "text"] as const;

/**
 * A minimal line diff, longest-common-subsequence over lines.
 *
 * Quadratic in lines, which is correct here: an edit's two halves are a
 * fragment of a file, not a file. Guarded anyway — past the cap the two halves
 * are shown whole rather than diffed, because a wrong diff is worse than none.
 */
const DIFF_LINE_CAP = 400;
export function unifiedDiff(before: string, after: string): string | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) return null;
  // lengths[i][j] = LCS length of a[i:] and b[j:]
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) { out.push(`-${a[i]}`); i++; }
    else { out.push(`+${b[j]}`); j++; }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

/** A value short and single-line enough to sit beside its label. */
function isInline(value: unknown): boolean {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && !value.includes("\n") && value.length <= 80;
}

/**
 * CodeBlock at its default height: bounded, with its own scroll past 20rem.
 *
 * NOT `inline`. A payload here is routinely hundreds of lines — one captured
 * command carried a 515-line heredoc — and unbounded blocks would make single
 * cards taller than the list they sit in. JSON hid that behind one very long
 * line; formatting it must not trade an unreadable card for an unnavigable one.
 */
function Block({ code, language }: { code: string; language?: string }) {
  return <CodeBlock code={code} language={language} languages={GRAMMARS} />;
}

/**
 * Every remaining key, labelled. This is the fallback AND the tail of every
 * other shape, which is what makes the formatted view a RENDERING rather than a
 * summary: no key is ever dropped, so switching to JSON reveals nothing that
 * was hidden. That is what lets formatted be the default.
 */
function Fields({ input, omit }: { input: Record<string, unknown>; omit?: ReadonlySet<string> }) {
  const keys = Object.keys(input).filter((key) => !omit?.has(key));
  if (!keys.length) return null;
  return <dl className="tool-fields">
    {keys.map((key) => {
      const value = input[key];
      return <div key={key} className="tool-field">
        <dt className="tool-field-name text-label-upper">{key}</dt>
        <dd className="tool-field-value">
          {isInline(value)
            ? <span className="tool-field-inline">{typeof value === "string" ? value : JSON.stringify(value)}</span>
            : <Block code={stringify(value)} language={typeof value === "string" ? undefined : "json"} />}
        </dd>
      </div>;
    })}
  </dl>;
}

/** The formatted rendering of one tool input, or null when nothing was given. */
function Formatted({ input }: { input: unknown }) {
  // codex's exec hands over a bare string. It is already the thing to read.
  if (typeof input === "string") return <Block code={input} language="bash" />;
  if (!isRecord(input)) return <Block code={stringify(input)} language="json" />;

  const command = pick(input, COMMAND_KEYS);
  if (command) return <>
    <Block code={command.value} language="bash" />
    <Fields input={input} omit={new Set([command.key])} />
  </>;

  const before = pick(input, OLD_KEYS);
  const after = pick(input, NEW_KEYS);
  if (before && after) {
    const patch = unifiedDiff(before.value, after.value);
    const omit = new Set([before.key, after.key]);
    // Past the diff cap both halves are shown whole: a wrong diff would be
    // worse than none, and this is still legible where JSON was not.
    return <>
      {patch == null
        ? <><Block code={before.value} /><Block code={after.value} /></>
        : <Block code={patch} language="diff" />}
      <Fields input={input} omit={omit} />
    </>;
  }

  const content = pick(input, CONTENT_KEYS);
  const path = pick(input, PATH_KEYS);
  if (content && path) return <>
    <p className="tool-field-inline">{path.value}</p>
    <Block code={content.value} />
    <Fields input={input} omit={new Set([content.key, path.key])} />
  </>;

  return <Fields input={input} />;
}

export function ToolInput({ input, view }: { input: unknown; view: ToolInputView }) {
  if (view === "json") return <Block code={stringify(input)} language="json" />;
  return <Formatted input={input} />;
}
