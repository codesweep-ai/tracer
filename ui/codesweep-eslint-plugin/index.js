/**
 * @codesweep-ai/eslint-plugin
 *
 * ESLint rules enforcing design-token usage (Convention 7.16).
 * Rules:
 *   - no-hardcoded-colors: flags hex colors, rgb(), hsl() outside tokens
 *   - no-hardcoded-pixels: flags px values on tokenized CSS properties
 *   - no-unknown-token: flags var(--...) references not defined in tokens.css
 *   - no-hardcoded-chart-colors: flags hex/rgb/hsl color literals passed to
 *     d3 .attr("fill"|"stroke", …) / .style("fill"|"stroke"|"color", …)
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";

// ── Helpers ──────────────────────────────────────────────────

/** Return a Set of [startLine, endLine] ranges covered by comments. */
function commentLineSet(sourceCode) {
  const set = new Set();
  for (const comment of sourceCode.getAllComments()) {
    for (let l = comment.loc.start.line; l <= comment.loc.end.line; l++) {
      set.add(l);
    }
  }
  return set;
}

/** True if the line is a JS/TS import statement. */
function isImportLine(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith("import ") || trimmed.startsWith("import{");
}

// ── Rule: no-hardcoded-colors ────────────────────────────────

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FN_COLOR_RE = /\b(rgba?|hsla?)\s*\(/g;

/** Validate hex length (3, 4, 6, or 8 after #). */
function isValidHex(match) {
  const len = match.length - 1; // minus the #
  return len === 3 || len === 4 || len === 6 || len === 8;
}

const noHardcodedColors = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hardcoded color values; use CSS custom properties instead.",
    },
    messages: {
      hardcodedColor:
        "Hardcoded color '{{match}}'. Use a CSS custom property: var(--color-*), var(--fg), var(--muted), etc.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          // Hex colors
          let m;
          HEX_RE.lastIndex = 0;
          while ((m = HEX_RE.exec(lineText)) !== null) {
            if (!isValidHex(m[0])) continue;
            context.report({
              messageId: "hardcodedColor",
              data: { match: m[0] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }

          // rgb()/rgba()/hsl()/hsla()
          FN_COLOR_RE.lastIndex = 0;
          while ((m = FN_COLOR_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "hardcodedColor",
              data: { match: m[0].trim() },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-hardcoded-pixels ────────────────────────────────

const TOKENIZED_PROPS =
  "padding|paddingTop|paddingRight|paddingBottom|paddingLeft|paddingInline|paddingBlock" +
  "|margin|marginTop|marginRight|marginBottom|marginLeft|marginInline|marginBlock" +
  "|fontSize|gap|rowGap|columnGap" +
  "|maxWidth|minWidth|maxHeight|minHeight" +
  "|borderRadius|letterSpacing|top|right|bottom|left";

const PX_RE = new RegExp(
  `(${TOKENIZED_PROPS})\\s*[:=]\\s*["'\`{]?\\s*\\d+(\\.\\d+)?px`,
  "g",
);

const noHardcodedPixels = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hardcoded pixel values on tokenized CSS properties; use CSS custom properties.",
    },
    messages: {
      hardcodedPixel:
        "Hardcoded pixel value in '{{prop}}'. Use a CSS custom property: var(--space-*), var(--radius-*), var(--font-size-*), etc.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;
          if (lineText.includes("var(")) return;

          let m;
          PX_RE.lastIndex = 0;
          while ((m = PX_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "hardcodedPixel",
              data: { prop: m[1] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-unknown-token ────────────────────────────────────

/** Parse a CSS file and return a Set of all custom property names. */
function parseTokens(cssPath) {
  try {
    const css = readFileSync(cssPath, "utf-8");
    const set = new Set();
    const re = /--([\w-]+)\s*:/g;
    let m;
    while ((m = re.exec(css)) !== null) {
      set.add(`--${m[1]}`);
    }
    return set;
  } catch {
    return null;
  }
}

const VAR_RE = /var\((--[\w-]+)\)/g;

/** Cache parsed tokens per CSS path to avoid re-reading on every file. */
const tokenCache = new Map();

const noUnknownToken = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow var() references to custom properties not defined in the token source file.",
    },
    messages: {
      unknownToken:
        "Unknown design token '{{token}}'. This token is not defined in the token source file.",
    },
    schema: [
      {
        type: "object",
        properties: {
          tokenSource: {
            type: "string",
            description:
              "Path to the CSS file containing token definitions (relative to CWD or absolute).",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const tokenSource = options.tokenSource;
    if (!tokenSource) return {};

    const cwd = context.cwd ?? context.getCwd();
    const cssPath = resolve(cwd, tokenSource);

    if (!tokenCache.has(cssPath)) {
      tokenCache.set(cssPath, parseTokens(cssPath));
    }
    const validTokens = tokenCache.get(cssPath);
    if (!validTokens) return {};

    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          VAR_RE.lastIndex = 0;
          while ((m = VAR_RE.exec(lineText)) !== null) {
            const token = m[1];
            if (!validTokens.has(token)) {
              context.report({
                messageId: "unknownToken",
                data: { token },
                loc: {
                  start: { line: lineNum, column: m.index },
                  end: { line: lineNum, column: m.index + m[0].length },
                },
              });
            }
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-spacing ─────────────────────────────────────

const SPACING_PREFIXES =
  "p|px|py|pt|pb|pl|pr|ps|pe" +
  "|m|mx|my|mt|mb|ml|mr|ms|me" +
  "|gap|gap-x|gap-y|space-x|space-y";

const BARE_SPACING_RE = new RegExp(
  `\\b(${SPACING_PREFIXES})-(\\d+)(?!\\])\\b`,
  "g",
);

const noBareSpacing = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind spacing utilities; use token-based arbitrary values.",
    },
    messages: {
      bareSpacing:
        "Bare Tailwind spacing '{{match}}'. Use a design token: {{prefix}}-[var(--space-*)].",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_SPACING_RE.lastIndex = 0;
          while ((m = BARE_SPACING_RE.exec(lineText)) !== null) {
            const value = parseInt(m[2], 10);
            if (value === 0) continue;
            context.report({
              messageId: "bareSpacing",
              data: { match: m[0], prefix: m[1] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-radius ──────────────────────────────────────

const BARE_RADIUS_RE = /\brounded-(xs|sm|md|lg|xl)\b/g;

const noBareRadius = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind border-radius utilities; use token-based arbitrary values.",
    },
    messages: {
      bareRadius:
        "Bare Tailwind radius '{{match}}'. Use rounded-[var(--radius-{{size}})].",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_RADIUS_RE.lastIndex = 0;
          while ((m = BARE_RADIUS_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "bareRadius",
              data: { match: m[0], size: m[1] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-z-index-literal ──────────────────────────────────

const Z_CLASS_RE = /\bz-(\d+)\b/g;
const Z_ARB_RE = /\bz-\[(\d+)\]/g;
const Z_STYLE_RE = /zIndex\s*:\s*(\d+)/g;

const noZIndexLiteral = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow literal z-index values; use z-index token custom properties.",
    },
    messages: {
      zIndexLiteral:
        "Hardcoded z-index '{{match}}'. Use a design token: z-[var(--z-sticky)], z-[var(--z-header)], or z-[var(--z-modal)].",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          for (const re of [Z_CLASS_RE, Z_ARB_RE, Z_STYLE_RE]) {
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(lineText)) !== null) {
              context.report({
                messageId: "zIndexLiteral",
                data: { match: m[0] },
                loc: {
                  start: { line: lineNum, column: m.index },
                  end: { line: lineNum, column: m.index + m[0].length },
                },
              });
            }
          }
        });
      },
    };
  },
};

// ── Rule: no-text-shorthand ───────────────────────────────────

const TEXT_VAR_RE = /\btext-\[var\((--[\w-]+)\)\]/g;

const noTextShorthand = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow text-[var(--...)] shorthand; use explicit [color:var(...)] or [font-size:var(...)] to prevent tailwind-merge collisions.",
    },
    messages: {
      textShorthand:
        "Ambiguous 'text-[var({{token}})]'. Use {{suggestion}} to avoid tailwind-merge collisions.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          TEXT_VAR_RE.lastIndex = 0;
          while ((m = TEXT_VAR_RE.exec(lineText)) !== null) {
            const token = m[1];
            const isFont = token.startsWith("--font-size");
            const suggestion = isFont
              ? `[font-size:var(${token})]`
              : `[color:var(${token})]`;

            context.report({
              messageId: "textShorthand",
              data: { token, suggestion },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-arbitrary-pixels ─────────────────────────────────

const ARB_PX_PREFIXES =
  "w|h|min-w|max-w|min-h|max-h" +
  "|p|px|py|pt|pb|pl|pr|ps|pe" +
  "|m|mx|my|mt|mb|ml|mr|ms|me" +
  "|gap|gap-x|gap-y|space-x|space-y" +
  "|top|right|bottom|left|inset|inset-x|inset-y" +
  "|rounded|rounded-t|rounded-b|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br" +
  "|text|tracking|leading";

const ARB_PX_RE = new RegExp(
  `(?<![\\w])-?(${ARB_PX_PREFIXES})-\\[(\\d+\\.?\\d*)px\\]`,
  "g",
);

const noArbitraryPixels = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hardcoded pixel values in Tailwind arbitrary-value brackets; use CSS custom properties.",
    },
    messages: {
      arbitraryPixel:
        "Hardcoded pixel value in '{{match}}'. Use a design token: {{prefix}}-[var(--space-*)] or {{prefix}}-[var(--...)].",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          ARB_PX_RE.lastIndex = 0;
          while ((m = ARB_PX_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "arbitraryPixel",
              data: { match: m[0], prefix: m[1] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-color ──────────────────────────────────────

const TW_COLORS =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green" +
  "|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

const COLOR_PREFIXES =
  "bg|text|border|ring|outline|divide|from|to|via" +
  "|fill|stroke|accent|caret|decoration|placeholder|shadow";

const BARE_COLOR_RE = new RegExp(
  `(?<!--)\\b(${COLOR_PREFIXES})-(${TW_COLORS})(?:-(\\d+))?(?:\\/(\\d+))?\\b`,
  "g",
);

const noBareColor = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind color utilities; use CSS custom properties.",
    },
    messages: {
      bareColor:
        "Bare Tailwind color '{{match}}'. Use a design token: {{prefix}}-[var(--color-*)] or [color:var(--...)].",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_COLOR_RE.lastIndex = 0;
          while ((m = BARE_COLOR_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "bareColor",
              data: { match: m[0], prefix: m[1] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-font-size ──────────────────────────────────

const BARE_FONT_SIZE_RE =
  /(?<!--)\btext-(xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g;

const noBareFontSize = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind font-size utilities; use CSS custom properties.",
    },
    messages: {
      bareFontSize:
        "Bare Tailwind font size '{{match}}'. Use [font-size:var(--font-size-*)] instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_FONT_SIZE_RE.lastIndex = 0;
          while ((m = BARE_FONT_SIZE_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "bareFontSize",
              data: { match: m[0] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-shadow ─────────────────────────────────────

const BARE_SHADOW_RE = /(?<!--)\bshadow-(sm|md|lg|xl|2xl|inner)\b/g;

const noBareShadow = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind shadow utilities; use CSS custom properties.",
    },
    messages: {
      bareShadow:
        "Bare Tailwind shadow '{{match}}'. Use [box-shadow:var(--shadow-{{size}})] instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_SHADOW_RE.lastIndex = 0;
          while ((m = BARE_SHADOW_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "bareShadow",
              data: { match: m[0], size: m[1] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-lucide-size-prop ────────────────────────────────

const LUCIDE_SIZE_RE = /\bsize=\{(\d+)\}/g;

const noLucideSizeProp = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow numeric size prop on icon components; use className with icon-size tokens.",
    },
    messages: {
      lucideSizeProp:
        "Numeric size prop '{{match}}'. Use className=\"w-[var(--icon-size-*)] h-[var(--icon-size-*)]\" instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          LUCIDE_SIZE_RE.lastIndex = 0;
          while ((m = LUCIDE_SIZE_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "lucideSizeProp",
              data: { match: m[0] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-transition ─────────────────────────────────

const BARE_TRANSITION_RE = /(?<!--)\b(duration|ease)-(75|100|150|200|300|500|700|1000|linear|in|out|in-out)\b/g;

const noBareTransition = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind transition utilities; use CSS custom properties.",
    },
    messages: {
      bareTransition:
        "Bare Tailwind transition '{{match}}'. Use a design token: var(--transition-fast) or var(--transition-normal).",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_TRANSITION_RE.lastIndex = 0;
          while ((m = BARE_TRANSITION_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "bareTransition",
              data: { match: m[0] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── Rule: no-bare-font-weight ────────────────────────────────

const BARE_FONT_WEIGHT_RE = /(?<!--)\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g;

const noBareFontWeight = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow bare Tailwind font-weight utilities; use CSS custom properties.",
    },
    messages: {
      bareFontWeight:
        "Bare Tailwind font weight '{{match}}'. Use [font-weight:var(--font-weight-*)] instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const commentLines = commentLineSet(sourceCode);
        const lines = sourceCode.getText().split("\n");

        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (commentLines.has(lineNum)) return;
          if (isImportLine(lineText)) return;

          let m;
          BARE_FONT_WEIGHT_RE.lastIndex = 0;
          while ((m = BARE_FONT_WEIGHT_RE.exec(lineText)) !== null) {
            context.report({
              messageId: "bareFontWeight",
              data: { match: m[0] },
              loc: {
                start: { line: lineNum, column: m.index },
                end: { line: lineNum, column: m.index + m[0].length },
              },
            });
          }
        });
      },
    };
  },
};

// ── components-need-state-props ──────────────────────────────
// Heuristic rule: flag exported React function components whose body
// signals async-data work (uses `useEffect` + a fetch-like call OR a
// useQuery / useSWR hook, OR receives a `data` prop) but whose
// destructured props don't include any of the canonical state-coverage
// props (loading, error, emptyMessage, onRetry).
//
// Warning level by design — false positives are expected for
// purely-presentational components that take a `data` prop without
// async semantics. Suppress with `// eslint-disable-next-line
// @codesweep-ai/components-need-state-props` on the export line.

const STATE_PROP_NAMES = new Set([
  "loading",
  "error",
  "emptyMessage",
  "onRetry",
]);
const ASYNC_HOOK_NAMES = new Set([
  "useQuery",
  "useSWR",
  "useFetch",
  "useAsync",
]);

const componentsNeedStateProps = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Components that touch async data should accept the canonical state-coverage props (loading, error, emptyMessage, onRetry). See patterns/ComponentStates.md.",
    },
    messages: {
      missing:
        "Component '{{name}}' appears to handle async data but doesn't accept any state-coverage props (loading, error, emptyMessage, onRetry). See patterns/ComponentStates.md.",
    },
    schema: [],
  },
  create(context) {
    function getDestructuredPropNames(param) {
      if (!param || param.type !== "ObjectPattern") return new Set();
      const names = new Set();
      for (const prop of param.properties) {
        if (prop.type === "Property" && prop.key && prop.key.name) {
          names.add(prop.key.name);
        } else if (prop.type === "RestElement") {
          // Components with ...rest skip the check (unknown surface)
          names.add("__rest__");
        }
      }
      return names;
    }

    function bodyLooksAsync(body) {
      if (!body || body.type !== "BlockStatement") return false;
      const src = context.sourceCode.getText(body);
      // Signals: useEffect mention + (fetch/axios/api), or a known async hook
      const hasUseEffect = /\buseEffect\s*\(/.test(src);
      const hasFetchLike =
        /\b(fetch|axios|api\.|client\.|request\()/i.test(src);
      const hasAsyncHook = Array.from(ASYNC_HOOK_NAMES).some((h) =>
        new RegExp(`\\b${h}\\s*\\(`).test(src),
      );
      return (hasUseEffect && hasFetchLike) || hasAsyncHook;
    }

    function checkComponent(node, name) {
      const firstParam = node.params?.[0];
      const destructured = getDestructuredPropNames(firstParam);
      if (destructured.has("__rest__")) return;
      const propNames = Array.from(destructured);
      // Skip non-component-looking declarations (must start with uppercase)
      if (!name || !/^[A-Z]/.test(name)) return;
      // Accept if any state prop is present
      const hasState = propNames.some((p) => STATE_PROP_NAMES.has(p));
      if (hasState) return;
      // Accept if no async signal
      if (!bodyLooksAsync(node.body)) return;
      // Accept if no `data` prop AND no async hook (mere useEffect isn't enough)
      const hasDataProp =
        propNames.includes("data") ||
        propNames.includes("items") ||
        propNames.includes("rows") ||
        propNames.includes("content");
      const src = context.sourceCode.getText(node.body);
      const hasAsyncHook = Array.from(ASYNC_HOOK_NAMES).some((h) =>
        new RegExp(`\\b${h}\\s*\\(`).test(src),
      );
      if (!hasDataProp && !hasAsyncHook) return;
      context.report({ node, messageId: "missing", data: { name } });
    }

    return {
      // `export function Foo({...}) { ... }`
      "ExportNamedDeclaration > FunctionDeclaration"(node) {
        checkComponent(node, node.id?.name);
      },
      // `export const Foo = ({...}) => { ... }`
      "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression"(
        node,
      ) {
        const name = node.parent?.id?.name;
        checkComponent(node, name);
      },
    };
  },
};

// ── Rule: no-hardcoded-chart-colors ──────────────────────────
// AST-based (not line-regex) to avoid false positives. Flags a hardcoded
// color string passed as the value of a d3/chart `.attr("fill"|"stroke", …)`
// or `.style("fill"|"stroke"|"color", …)` call. The correct pattern is to
// pull colors from `useChartTheme()` (theme.categorical[i], theme.accent,
// styleAxis(sel, theme), etc.) — see patterns/Chart.md.
//
// Only string-literal values are flagged. `var(--…)` strings and JS
// expressions (theme.categorical[i]) are not literals-with-a-hex, so they
// pass cleanly.

const CHART_COLOR_VALUE_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;
const ATTR_COLOR_KEYS = new Set(["fill", "stroke"]);
const STYLE_COLOR_KEYS = new Set(["fill", "stroke", "color"]);

/** Return the string value of a string Literal or a no-expression template literal; else null. */
function staticStringValue(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

const noHardcodedChartColors = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hardcoded color values in d3/chart .attr()/.style() calls; use useChartTheme(). See patterns/Chart.md.",
    },
    messages: {
      hardcodedChartColor:
        "Hardcoded color '{{match}}' in .{{method}}(\"{{key}}\", …). Pull chart colors from useChartTheme() (theme.categorical[i], theme.accent, …). See patterns/Chart.md.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== "MemberExpression") return;
        const method = callee.property && callee.property.name;
        if (method !== "attr" && method !== "style") return;

        const key = staticStringValue(node.arguments[0]);
        if (key == null) return;
        const allowed = method === "attr" ? ATTR_COLOR_KEYS : STYLE_COLOR_KEYS;
        if (!allowed.has(key)) return;

        const value = staticStringValue(node.arguments[1]);
        if (value == null) return;
        const m = value.match(CHART_COLOR_VALUE_RE);
        if (!m) return;

        context.report({
          node: node.arguments[1],
          messageId: "hardcodedChartColor",
          data: { match: m[0].trim(), method, key },
        });
      },
    };
  },
};

// ── Plugin export ────────────────────────────────────────────

const plugin = {
  rules: {
    "no-hardcoded-colors": noHardcodedColors,
    "no-hardcoded-pixels": noHardcodedPixels,
    "no-unknown-token": noUnknownToken,
    "no-bare-spacing": noBareSpacing,
    "no-bare-radius": noBareRadius,
    "no-z-index-literal": noZIndexLiteral,
    "no-text-shorthand": noTextShorthand,
    "no-arbitrary-pixels": noArbitraryPixels,
    "no-bare-color": noBareColor,
    "no-bare-font-size": noBareFontSize,
    "no-bare-shadow": noBareShadow,
    "no-lucide-size-prop": noLucideSizeProp,
    "no-bare-transition": noBareTransition,
    "no-bare-font-weight": noBareFontWeight,
    "components-need-state-props": componentsNeedStateProps,
    "no-hardcoded-chart-colors": noHardcodedChartColors,
  },
};

plugin.configs = {
  recommended: {
    plugins: { "@codesweep-ai": plugin },
    rules: {
      "@codesweep-ai/no-hardcoded-colors": "warn",
      "@codesweep-ai/no-hardcoded-pixels": "warn",
      "@codesweep-ai/no-bare-spacing": "warn",
      "@codesweep-ai/no-bare-radius": "warn",
      "@codesweep-ai/no-z-index-literal": "warn",
      "@codesweep-ai/no-text-shorthand": "warn",
      "@codesweep-ai/no-arbitrary-pixels": "warn",
      "@codesweep-ai/no-bare-color": "warn",
      "@codesweep-ai/no-bare-font-size": "warn",
      "@codesweep-ai/no-bare-shadow": "warn",
      "@codesweep-ai/no-lucide-size-prop": "warn",
      "@codesweep-ai/no-bare-transition": "warn",
      "@codesweep-ai/no-bare-font-weight": "warn",
      "@codesweep-ai/components-need-state-props": "warn",
      "@codesweep-ai/no-hardcoded-chart-colors": "warn",
    },
  },
};

export default plugin;
