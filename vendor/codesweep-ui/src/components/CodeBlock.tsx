import { useState, useMemo } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "../lib/cn";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import java from "highlight.js/lib/languages/java";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("java", java);

interface CodeBlockProps {
  code: string;
  language?: string;
  source?: string;
  highlightedLines?: number[];
  /** Substring to highlight within the code text */
  highlightQuery?: string;
  maxHeight?: string;
  /** When true, expand to fill the parent's height instead of using maxHeight. */
  fillHeight?: boolean;
  /** When true, render as an inline embed — no max-height, no internal vertical
   *  scroll, flows with the parent's natural layout. Horizontal scroll is still
   *  available for long lines. Use for embedding code in scrollable pages where
   *  the outer page is the only scroll surface. Mutually exclusive with
   *  fillHeight; if both are set, fillHeight wins. */
  inline?: boolean;
  className?: string;
}

/**
 * Split hljs HTML output into per-line strings with balanced tags.
 * Tracks open <span> tags across line boundaries so each line is valid HTML.
 */
function splitHtmlIntoLines(html: string): string[] {
  const rawLines = html.split("\n");
  const result: string[] = [];
  let openTags: string[] = [];

  for (const raw of rawLines) {
    const prefix = openTags.join("");

    const nextOpenTags = [...openTags];
    const tagRegex = /<(\/?)span([^>]*)>/g;
    let m;
    while ((m = tagRegex.exec(raw)) !== null) {
      if (m[1] === "/") {
        nextOpenTags.pop();
      } else {
        nextOpenTags.push(`<span${m[2]}>`);
      }
    }

    const suffix = "</span>".repeat(nextOpenTags.length);
    result.push(prefix + raw + suffix);
    openTags = nextOpenTags;
  }

  return result;
}

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inject <mark> tags around query matches in HTML, only in text nodes (not inside tags).
 */
function injectQueryHighlight(html: string, query: string): string {
  if (!query) return html;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  // Split into HTML tags and text content
  const parts = html.split(/(<[^>]*>)/);
  return parts
    .map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(
        regex,
        '<mark class="code-query-match">$&</mark>'
      );
    })
    .join("");
}

export function CodeBlock({
  code,
  language,
  source,
  highlightedLines,
  highlightQuery,
  maxHeight = "20rem",
  fillHeight = false,
  inline = false,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const htmlLines = useMemo(() => {
    let html: string;
    if (language && hljs.getLanguage(language)) {
      try {
        html = hljs.highlight(code, { language }).value;
      } catch {
        html = escapeHtml(code);
      }
    } else {
      html = escapeHtml(code);
    }
    const lines = splitHtmlIntoLines(html);
    if (highlightQuery) {
      return lines.map((line) => injectQueryHighlight(line, highlightQuery));
    }
    return lines;
  }, [code, language, highlightQuery]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be unavailable */ }
  };

  return (
    <div
      data-component="CodeBlock"
      className={cn(
        "border border-[var(--border)] rounded-[var(--radius-sm)] overflow-hidden bg-[var(--bg)]",
        fillHeight && "h-full flex flex-col",
        className
      )}
      role="region"
      aria-label="Code block"
    >
      {/* Header bar: label + copy button (matches MarkdownViewer pattern) */}
      <div className={cn("flex items-center justify-between px-[var(--space-3)] py-[var(--space-2)] border-b border-[var(--border)] bg-[var(--card)]", fillHeight && "flex-shrink-0")}>
        {source ? (
          <span className="[font-size:var(--font-size-xs)] [color:var(--muted)] font-mono truncate">
            {source}
          </span>
        ) : language ? (
          <span className="text-label-upper">{language}</span>
        ) : (
          <span />
        )}
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-[var(--space-1)] [font-size:var(--font-size-xs)] [color:var(--muted)] hover:[color:var(--fg)] transition-colors cursor-pointer bg-transparent border-none p-0",
            copied && "[color:var(--color-success)]"
          )}
          aria-label={copied ? "Copied!" : "Copy code to clipboard"}
        >
          {copied ? <Check className="w-[var(--icon-size-md)] h-[var(--icon-size-md)]" /> : <Copy className="w-[var(--icon-size-md)] h-[var(--icon-size-md)]" />}
        </button>
      </div>
      <div
        className={cn(
          fillHeight ? "overflow-auto flex-1 min-h-0" : inline ? "overflow-x-auto" : "overflow-auto",
        )}
        style={fillHeight || inline ? undefined : { maxHeight }}
      >
        <pre className="m-0">
          <code
            data-language={language}
            className="block [font-size:var(--font-size-code)] leading-[var(--line-height-code)] [font-family:var(--font-family-mono)] [tab-size:2] hljs"
          >
            {htmlLines.map((lineHtml, i) => {
              const lineNum = i + 1;
              const isHighlighted = highlightedLines?.includes(lineNum);
              return (
                <div
                  key={i}
                  className={cn(
                    "flex",
                    isHighlighted &&
                      "bg-[var(--color-success-bg)] [font-weight:var(--font-weight-semibold)]"
                  )}
                >
                  <span
                    className="flex-shrink-0 min-w-[3ch] text-right [color:var(--muted)] select-none pr-[var(--space-2)] pl-[var(--space-4)] border-r border-[var(--border)]"
                    aria-hidden="true"
                  >
                    {lineNum}
                  </span>
                  <span
                    className="flex-1 min-w-0 px-[var(--space-3)] whitespace-pre"
                    dangerouslySetInnerHTML={{ __html: lineHtml }}
                  />
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
