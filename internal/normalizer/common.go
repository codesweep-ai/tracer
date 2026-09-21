package normalizer

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
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
		if c, ok := event.Get("reportedCostUSD"); ok && c != nil {
			if n, err := parseJSONNumber(c); err != nil || n < 0 {
				event.Delete("reportedCostUSD")
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

// damageRun collapses a run of consecutive unreadable lines into ONE event.
//
// A line that is not JSON is a DAMAGED FILE; a record whose `type` nothing
// knows is an ADAPTER BEHIND ITS CLI (SPEC.md §7). Both used to arrive as
// unknown("parse-error"), which made them one indistinguishable grey cell —
// yet they need opposite reactions from a reader: restore the file, versus
// teach the adapter. R56 separates them.
//
// Collapsing the run is what makes the report legible. A captured session held
// 2,771 consecutive unreadable lines (its first 721 KB overwritten with binary);
// drawn one cell each, they are wallpaper a reader scrolls past rather than the
// loud report §7 asks for. One event naming the range is louder (R57).
//
// `lines` counts the OPEN run; `total` counts every unreadable line in the
// document and survives flush, because it is what parse.unreadable reports.
type damageRun struct {
	first, last, lines, total int
}

// add extends the open run with a 1-based source line number.
func (d *damageRun) add(line int) {
	if d.lines == 0 {
		d.first = line
	}
	d.last = line
	d.lines++
	d.total++
}

// flush closes an open run, appending its single collapsed event. Callers must
// call it wherever a readable record interrupts a run AND once after the record
// loop, so the last run is not dropped.
func (d *damageRun) flush(events []*obj) []*obj {
	if d.lines == 0 {
		return events
	}
	where := fmt.Sprintf("line %d", d.first)
	noun := "line"
	if d.last != d.first {
		where = fmt.Sprintf("lines %d-%d", d.first, d.last)
		noun = "lines"
	}
	text := fmt.Sprintf("%d unreadable %s (%s): not JSON — the file may be damaged", d.lines, noun, where)
	d.first, d.last, d.lines = 0, 0, 0
	return append(events, trajectory.NewObject("kind", "meta", "ts", trajectory.Undefined, "rawType", "unreadable", "text", text))
}

// warningReport builds the parse report shared by every adapter. `unreadable`
// is the document's damageRun total; adapters whose format has no per-line
// records (opencode reads one whole document) pass 0.
func warningReport(adapter, version, cli string, skipped skipTally, counts map[string]int, order []string, unreadable int) *obj {
	warnings := []any{}
	total := 0
	for _, k := range order {
		n := counts[k]
		total += n
		warnings = append(warnings, trajectory.NewObject("message", fmt.Sprintf("unrecognized type '%s' rendered as meta", k), "rawType", k, "count", n))
	}
	// Damage is reported apart from `unrecognized`, which counts record types
	// nothing classified (R42). A damaged line has no type to count.
	if unreadable > 0 {
		noun := "line"
		if unreadable != 1 {
			noun = "lines"
		}
		warnings = append(warnings, trajectory.NewObject("message", fmt.Sprintf("%d %s could not be read as JSON — the file may be damaged", unreadable, noun), "rawType", "unreadable", "count", unreadable))
	}
	return trajectory.NewObject("adapter", adapter, "adapterVersion", version, "cliVersionRange", cli, "skippedByType", skipped.list(), "unrecognized", total, "unreadable", unreadable, "warnings", warnings)
}

// resumesWork is the set of kinds whose arrival means the waiting is over
// (R68). A user instruction arrives, or the agent thinks, speaks or calls a
// tool. Everything else is the agent standing still.
var resumesWork = map[string]bool{
	"user": true, "assistant": true, "thinking": true, "tool_call": true, "tool_result": true,
}

// markIdle stamps `idleMs` on every event that ends a turn (R68): the interval
// between that event and the moment work resumes, which is the agent sitting
// still waiting for its next instruction. It runs for every adapter from one
// place, because the whole point of the requirement is that the three cannot
// disagree about what idle means.
//
// The interval ends at the next event that does work, NOT at the next record
// (TRC-014). Claude Code writes context attachments and queue operations while
// the agent waits, each carrying a timestamp, and stopping at one of those
// reported two seconds of idle for a wait of three hours. It cost 18% of the
// measured waiting across thirty captured trajectories. The other two adapters
// write nothing in that gap, so two corpora out of three agreed with the wrong
// reading.
//
// A turn end with no work after it gets no field rather than a zero. The session
// stopped there, and "waited for nothing" and "waited no time" are different
// claims. An event with no timestamp is stepped over for the same reason:
// absent is not zero.
//
// Only a turn end carries it. A long gap after a tool call is a slow tool, which
// is work, and calling that idle was the mistake the requirement exists to stop.
func markIdle(events []*obj) {
	for i, e := range events {
		if str(get(e, "kind")) != "turn_end" {
			continue
		}
		from := str(get(e, "ts"))
		if from == "" {
			continue
		}
		for _, next := range events[i+1:] {
			if !resumesWork[str(get(next, "kind"))] {
				continue
			}
			to := str(get(next, "ts"))
			if to == "" {
				continue
			}
			if ms := millis(from, to); isJSNumber(ms) {
				e.Set("idleMs", ms)
			}
			break
		}
	}
}

// drawsWork is the set of kinds that carry `workMs` (R70): the model thinking,
// speaking or calling a tool. A user instruction bounds the interval without
// owning it, since the time before it is the agent's, not the user's.
var drawsWork = map[string]bool{"assistant": true, "thinking": true, "tool_call": true}

// markWork stamps `workMs` on every event that does the model's work (R70): the
// interval from the end of the previous piece of work to the end of this one. A
// tool call ends when its result arrives, and a turn end once its idle is over.
//
// The interval looks BACKWARD, not forward. The model's latency sits between a
// tool result and the reply, and a record is written when its block is done, so
// the reply is what the time produced. Measured forward, from each response to
// the next event, that latency belonged to nothing, because a tool call already
// has its own run time. It was 8% to 26% of elapsed time across thirty captured
// trajectories, most of it on bookkeeping records (TRC-015).
//
// Bookkeeping is stepped over for the same reason markIdle steps over it: a
// context attachment landing mid-wait marks no work. The end only moves forward,
// so a tool call issued in parallel with a slower one is charged from its own
// timestamp, and the reply after both is charged from the slower one's result.
func markWork(events []*obj) {
	var last time.Time
	for _, e := range events {
		kind := str(get(e, "kind"))
		// A reply the CLI wrote itself neither owns the interval nor ends it, so
		// a wait on the provider lands on the reply that finally came.
		if (!resumesWork[kind] && kind != "turn_end") || truthy(get(e, "synthetic")) {
			continue
		}
		at, ok := parseTS(get(e, "ts"))
		if !ok {
			continue
		}
		end := at
		if done, ok := parseTS(get(object(get(e, "result")), "ts")); ok && done.After(end) {
			end = done
		}
		if idle, ok := e.Get("idleMs"); ok && isJSNumber(idle) {
			end = at.Add(time.Duration(num(idle)) * time.Millisecond)
		}
		if drawsWork[kind] && !last.IsZero() {
			start := last
			if at.Before(start) {
				start = at
			}
			e.Set("workMs", end.Sub(start).Milliseconds())
		}
		if end.After(last) {
			last = end
		}
	}
}

// SchemaVersion is the version every document declares (R6). Version 3 made
// totals.cost an object of figures kept apart by provenance (§9).
const SchemaVersion = 3

// reportedCost is one figure a CLI stated for a span of work (R71, R72):
// "trajectory" for this trajectory alone, "tree" for it and its sub-agents.
func reportedCost(usd any, covers string) *obj {
	return trajectory.NewObject("usd", usd, "covers", covers)
}

// costTotals builds totals.cost from what the adapter found (§9). A figure the
// CLI stated is kept as reported, the per-event costs are summed beside it, and
// tracer's estimate is added later by estimateCost. None stands in for another
// (R73), so every member is absent when its source is.
//
// The per-event sum carries how many events were priced out of how many
// carried token usage. A sum over some of them is not a total, and a reader has
// to be able to tell.
//
// Only when every such event was priced do the sum and a trajectory figure cover
// the same work, and then a disagreement is warned about rather than settled
// (R74). OpenCode states both, and its session figure used to replace the sum.
func costTotals(events []*obj, reported []any, parse *obj) *obj {
	cost := trajectory.NewObject()
	if len(reported) > 0 {
		cost.Set("reported", reported)
	}
	var sum any = 0
	priced, of := 0, 0
	for _, e := range events {
		if get(e, "tokens") != nil {
			of++
		}
		if c, ok := e.Get("reportedCostUSD"); ok && isJSNumber(c) {
			sum = addNumbers(sum, c)
			priced++
		}
	}
	if priced == 0 {
		return cost
	}
	cost.Set("reportedByEvents", trajectory.NewObject("usd", sum, "events", priced, "of", of))
	if priced < of {
		return cost
	}
	for _, r := range reported {
		figure := object(r)
		if str(get(figure, "covers")) == "trajectory" && math.Abs(num(get(figure, "usd"))-num(sum)) >= 0.005 {
			warnings := get(parse, "warnings").([]any)
			parse.Set("warnings", append(warnings, trajectory.NewObject("message", fmt.Sprintf(
				"the reported cost of $%s disagrees with its events' costs, which sum to $%s; both are kept",
				jsNumberString(get(figure, "usd")), jsNumberString(sum)))))
		}
	}
	return cost
}

// finalize completes a document (codex and opencode): index events,
// sanitize hostile scalars, roll totals, stamp meta. reported holds the cost
// figures the CLI stated for the session (§9), empty when it stated none.
func finalize(meta *obj, events []*obj, parse *obj, reported []any) *obj {
	for i, e := range events {
		e.Set("i", i)
	}
	if malformed := sanitizeTokenValues(events); malformed > 0 {
		warnings := get(parse, "warnings").([]any)
		parse.Set("warnings", append(warnings, malformedTokenWarning(malformed)))
	}
	markIdle(events)
	markWork(events)
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
	}
	tot.Set("cost", costTotals(events, reported, parse))
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
	return trajectory.NewObject("schemaVersion", SchemaVersion, "meta", meta, "totals", tot, "events", events, "parse", parse)
}

// addNumbers is JS `a ?? 0) + (b ?? 0` for values already sanitized to
// numbers-or-absent; a missing b leaves a unchanged (but still numerically
// coerced, which JSON.stringify renders identically for integers).
func addNumbers(a, b any) any {
	sum := num(a) + num(b)
	return integer(sum)
}
