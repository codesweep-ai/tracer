package normalizer

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// tokenFields are the token counters that roll into totals.
var tokenFields = []string{"input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "reasoning"}

// sanitizeTokenValues excludes hostile token values. Transcripts are untrusted; a hostile
// VALUE inside a recognized record (string input_tokens, negative counts,
// Infinity) must degrade to a counted warning, not poison totals. Excluded,
// not coerced — never guess a number. Returns the exclusion count.
//
// A JSON null is left in place (the `value != null` check
// excludes it) and a tokens object emptied by exclusion is deleted entirely.
func sanitizeTokenValues(events []*obj) int {
	malformed := 0
	for _, event := range events {
		if tokens := object(get(event, "tokens")); tokens != nil {
			for _, field := range tokenFields {
				v, ok := tokens.Get(field)
				if !ok || v == nil {
					continue
				}
				if n, err := parseJSONNumber(v); err != nil || n < 0 {
					tokens.Delete(field)
					malformed++
				}
			}
			if len(tokens.Members()) == 0 {
				event.Delete("tokens")
			}
		}
		if c, ok := event.Get("cost"); ok && c != nil {
			if n, err := parseJSONNumber(c); err != nil || n < 0 {
				event.Delete("cost")
				malformed++
			}
		}
	}
	return malformed
}

// malformedTokenWarning is the fail-soft notice recording how many values were
// excluded from totals.
func malformedTokenWarning(count int) *obj {
	return trajectory.NewObject(
		"message", fmt.Sprintf("%d malformed token/cost value(s) excluded from totals (fail-soft: hostile scalar in a recognized record)", count),
		"count", count,
	)
}

// blockTextClaude ports the claude adapter's own blockText: an object block's
// text is coerced with JS String() semantics, NOT recursed.
func blockTextClaude(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if a := array(v); a != nil {
		var b strings.Builder
		for _, p := range a {
			if s, ok := p.(string); ok {
				b.WriteString(s)
				continue
			}
			if o := object(p); o != nil {
				if x := get(o, "text"); x != nil {
					b.WriteString(jsString(x))
				} else if x := get(o, "content"); x != nil {
					b.WriteString(blockTextClaude(x))
				}
			}
		}
		return b.String()
	}
	return jsStringify(v)
}

// blockText flattens a content block to text (codex and opencode): object parts
// recurse through text ?? content ?? output.
func blockText(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if a := array(v); a != nil {
		var b strings.Builder
		for _, p := range a {
			if s, ok := p.(string); ok {
				b.WriteString(s)
				continue
			}
			if o := object(p); o != nil {
				b.WriteString(blockText(firstNonNull(get(o, "text"), get(o, "content"), get(o, "output"), "")))
			}
		}
		return b.String()
	}
	return jsStringify(v)
}

// firstNonNull returns the first argument that is neither nil nor Undefined —
// JS ?? (nullish coalescing).
func firstNonNull(vs ...any) any {
	for _, v := range vs {
		if v == nil {
			continue
		}
		if _, isUndef := v.(interface{ undefined() }); isUndef {
			continue
		}
		return v
	}
	return nil
}

// tpl coerces obj[key] the way a JS template literal would: an absent key is
// "undefined", a JSON null is "null", everything else follows String().
func tpl(o *obj, key string) string {
	v, ok := o.Get(key)
	if !ok {
		return "undefined"
	}
	return jsString(v)
}

// utf16Slice slices by UTF-16 code unit — not byte, not rune. The format's
// length limits are defined in those units (the isError heuristic inspects the
// first 200; deriveAutoTitle truncates at 60), so slicing any other way changes
// the output for any text outside the BMP.
// It slices from the start because that is all any caller has ever wanted; an
// offset parameter every caller passed 0 to only invited the question.
func utf16Slice(s string, end int) string {
	u := utf16.Encode([]rune(s))
	if end > len(u) {
		end = len(u)
	}
	if end <= 0 {
		return ""
	}
	return string(utf16.Decode(u[:end]))
}

// jsString coerces a decoded JSON value the way JS String() would.
func jsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = jsString(e)
		}
		return strings.Join(parts, ",")
	case *trajectory.Object:
		return "[object Object]"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	}
	if _, err := parseJSONNumber(v); err == nil {
		return jsNumberString(v)
	}
	return fmt.Sprint(v)
}

// jsStringify is JSON.stringify for values we hold as decoded JSON: numbers
// keep their source spelling via the ordered encoder.
func jsStringify(v any) string {
	b, err := trajectory.Marshal(v, false)
	if err != nil {
		return ""
	}
	return string(b)
}

// jsNumberString renders a number the way JS String(number) / JSON.stringify
// would for the magnitudes transcripts actually carry: source spellings are
// preserved verbatim, and computed integers print without a fraction.
func jsNumberString(v any) string {
	if n, ok := v.(interface{ String() string }); ok {
		return n.String()
	}
	if f, err := parseJSONNumber(v); err == nil {
		if f == float64(int64(f)) {
			return strconv.FormatInt(int64(f), 10)
		}
		return fmt.Sprintf("%v", f)
	}
	return ""
}

// skipTally counts records that produced no event, BY RECORD TYPE.
//
// A bare integer told you 981 records were skipped but not which kinds, so
// "correctly ignored bookkeeping" and "silently lost data" looked identical, and
// a record type newly introduced by a CLI could not be noticed at all. Diffing
// this map between two runs surfaces a new type immediately.
type skipTally map[string]int

func (t skipTally) add(recordType string) {
	if recordType == "" {
		recordType = "(no type)"
	}
	t[recordType]++
}

// list renders the tally as a SORTED array of {type, count}.
//
// Sorted, and an array rather than an object, on purpose: object key order here
// would be data-dependent — whichever types happened to appear first — and this
// output is compared byte for byte (SPEC.md §3.1). An array sorted by type is
// deterministic for a given input, which is the property the gates need.
func (t skipTally) list() []any {
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, trajectory.NewObject("type", k, "count", t[k]))
	}
	return out
}

// warningReport builds the parse report shared by every adapter.
func warningReport(adapter, version, cli string, skipped skipTally, counts map[string]int, order []string) *obj {
	warnings := []any{}
	total := 0
	for _, k := range order {
		n := counts[k]
		total += n
		warnings = append(warnings, trajectory.NewObject("message", fmt.Sprintf("unrecognized type '%s' rendered as meta", k), "rawType", k, "count", n))
	}
	return trajectory.NewObject("adapter", adapter, "adapterVersion", version, "cliVersionRange", cli, "skippedByType", skipped.list(), "unrecognized", total, "warnings", warnings)
}

// finalize completes a document (codex and opencode): index events,
// sanitize hostile scalars, roll totals, stamp meta. sessionCost is the
// opencode info.cost override (nil = absent).
func finalize(meta *obj, events []*obj, parse *obj, sessionCost any) *obj {
	for i, e := range events {
		e.Set("i", i)
	}
	if malformed := sanitizeTokenValues(events); malformed > 0 {
		warnings := get(parse, "warnings").([]any)
		parse.Set("warnings", append(warnings, malformedTokenWarning(malformed)))
	}
	tot := trajectory.NewObject("events", len(events), "toolCalls", 0, "toolErrors", 0, "input", 0, "output", 0, "cacheRead", 0, "cacheWrite", 0, "reasoning", 0)
	for _, e := range events {
		if str(get(e, "kind")) == "tool_call" {
			tot.Set("toolCalls", int(num(get(tot, "toolCalls")))+1)
		}
		if r := object(get(e, "result")); r != nil && truthy(get(r, "isError")) {
			tot.Set("toolErrors", int(num(get(tot, "toolErrors")))+1)
		}
		if tok := object(get(e, "tokens")); tok != nil {
			for _, f := range []string{"input", "output", "cacheRead", "cacheWrite", "reasoning"} {
				tot.Set(f, addNumbers(get(tot, f), get(tok, f)))
			}
		}
		if c, ok := e.Get("cost"); ok && isJSNumber(c) {
			tot.Set("cost", addNumbers(get(tot, "cost"), c))
		}
	}
	if isJSNumber(sessionCost) {
		tot.Set("cost", sessionCost)
	}
	var firstTS, lastTS string
	for _, e := range events {
		if ts := str(get(e, "ts")); ts != "" {
			if firstTS == "" {
				firstTS = ts
			}
			lastTS = ts
		}
	}
	meta.Set("startedAt", undef(firstTS))
	meta.Set("endedAt", undef(lastTS))
	meta.Set("durationMs", millis(firstTS, lastTS))
	return trajectory.NewObject("schemaVersion", 2, "meta", meta, "totals", tot, "events", events, "parse", parse)
}

// addNumbers is JS `a ?? 0) + (b ?? 0` for values already sanitized to
// numbers-or-absent; a missing b leaves a unchanged (but still numerically
// coerced, which JSON.stringify renders identically for integers).
func addNumbers(a, b any) any {
	sum := num(a) + num(b)
	return integer(sum)
}
