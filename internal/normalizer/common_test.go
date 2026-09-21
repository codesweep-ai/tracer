package normalizer

import (
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// hostile scalars are excluded, never coerced — and the exclusion is
// counted so a warning can disclose it.
func TestSanitizeTokenValues(t *testing.T) {
	mk := func(tokens *obj, cost any) *obj {
		e := trajectory.NewObject("kind", "assistant")
		if tokens != nil {
			e.Set("tokens", tokens)
		}
		if cost != nil {
			e.Set("cost", cost)
		}
		return e
	}

	t.Run("string and negative values are deleted", func(t *testing.T) {
		e := mk(trajectory.NewObject("input", "many", "output", jsonNum("5"), "cacheRead", jsonNum("-3")), jsonNum("-1"))
		if n := sanitizeTokenValues([]*obj{e}); n != 3 {
			t.Fatalf("excluded %d, want 3", n)
		}
		tokens := object(get(e, "tokens"))
		if _, ok := tokens.Get("input"); ok {
			t.Fatal("string input kept")
		}
		if _, ok := tokens.Get("cacheRead"); ok {
			t.Fatal("negative cacheRead kept")
		}
		if v, _ := tokens.Get("output"); str(anyString(v)) != "5" {
			t.Fatalf("valid output = %v", v)
		}
		if _, ok := e.Get("cost"); ok {
			t.Fatal("negative cost kept")
		}
	})

	t.Run("a tokens object emptied by exclusion is deleted", func(t *testing.T) {
		e := mk(trajectory.NewObject("input", "hostile"), nil)
		if n := sanitizeTokenValues([]*obj{e}); n != 1 {
			t.Fatalf("excluded %d, want 1", n)
		}
		if _, ok := e.Get("tokens"); ok {
			t.Fatal("empty tokens object kept")
		}
	})

	t.Run("JSON null is left in place", func(t *testing.T) {
		// The reference's `value != null` check skips nulls: they are a
		// statement of absence, not a hostile scalar.
		e := mk(trajectory.NewObject("input", nil), nil)
		if n := sanitizeTokenValues([]*obj{e}); n != 0 {
			t.Fatalf("excluded %d, want 0", n)
		}
		if _, ok := object(get(e, "tokens")).Get("input"); !ok {
			t.Fatal("null input was deleted")
		}
	})
}

func TestBlockTextVariants(t *testing.T) {
	// The claude blockText coerces an object block's text the way String() does;
	// the shared blockText recurses through text ?? content ?? output. The two
	// differ on purpose — this pins that difference.
	t.Run("claude coerces text with String()", func(t *testing.T) {
		v := []any{mustDecode(t, `{"text":42}`), mustDecode(t, `{"content":["x","y"]}`)}
		if got := blockTextClaude(v); got != "42xy" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("common recurses into output", func(t *testing.T) {
		v := []any{mustDecode(t, `{"output":"result"}`)}
		if got := blockText(v); got != "result" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("common does not recurse a present text", func(t *testing.T) {
		// text ?? content ?? output: a present text wins even when it is an
		// object (blockText then JSON-stringifies it).
		v := []any{mustDecode(t, `{"text":{"nested":1},"content":"ignored"}`)}
		if got := blockText(v); got != `{"nested":1}` {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("null content is empty", func(t *testing.T) {
		if got := blockText(nil); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("non-string scalars stringify", func(t *testing.T) {
		if got := blockTextClaude(jsonNum("1.5")); got != "1.5" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestJSString(t *testing.T) {
	if got := jsString(mustDecode(t, `{"a":1}`)); got != "[object Object]" {
		t.Fatalf("object: got %q", got)
	}
	if got := jsString([]any{jsonNum("1"), jsonNum("2")}); got != "1,2" {
		t.Fatalf("array: got %q", got)
	}
	if got := jsString(nil); got != "null" {
		t.Fatalf("null: got %q", got)
	}
	if got := jsString(true); got != "true" {
		t.Fatalf("bool: got %q", got)
	}
}

func TestTplUndefinedVsNull(t *testing.T) {
	o := trajectory.NewObject("present", "x", "nullable", nil)
	if got := tpl(o, "missing"); got != "undefined" {
		t.Fatalf("absent key: got %q, want undefined", got)
	}
	if got := tpl(o, "nullable"); got != "null" {
		t.Fatalf("null key: got %q, want null", got)
	}
	if got := tpl(o, "present"); got != "x" {
		t.Fatalf("present key: got %q", got)
	}
}

func TestUTF16Slice(t *testing.T) {
	// JS slices by UTF-16 code units: an astral character counts as 2.
	s := "ab\U0001F600cd"
	// Cutting at 3 units splits the surrogate pair: "ab" plus a lone high
	// surrogate, which utf16.Decode renders as U+FFFD. The boundary is the
	// whole point of slicing in code units, so it is asserted rather than
	// described — this case carried the comment and no assertion.
	if got := utf16Slice(s, 3); got != "ab�" {
		t.Errorf("slicing mid-surrogate = %q, want %q", got, "ab�")
	}
	if got := utf16Slice(s, 4); got != "ab\U0001F600" {
		t.Fatalf("got %q", got)
	}
	if got := utf16Slice("hello world", 5); got != "hello" {
		t.Fatalf("got %q", got)
	}
	if got := utf16Slice("short", 200); got != "short" {
		t.Fatalf("got %q", got)
	}
}

func TestCodexOutputIsError(t *testing.T) {
	if !codexOutputIsError("Error: boom") {
		t.Fatal("leading Error not detected")
	}
	if !codexOutputIsError("line one\nerror: boom") {
		t.Fatal("error after newline not detected")
	}
	if codexOutputIsError("Script completed successfully\nError: ignored") {
		t.Fatal("Script completed suppresses the heuristic")
	}
	// The reference tests only the first 200 UTF-16 code units.
	pad := make([]byte, 0, 300)
	for len(pad) < 195 {
		pad = append(pad, 'x')
	}
	late := string(pad) + "\nError: too late"
	if codexOutputIsError(late) {
		t.Fatal("error past the 200-unit window must not count")
	}
	early := string(pad[:190]) + "\nError: inside"
	if !codexOutputIsError(early) {
		t.Fatal("error inside the 200-unit window must count")
	}
}

// jsonNum decodes a JSON literal to the decoder's number representation.
func jsonNum(s string) any {
	v, err := trajectory.Decode([]byte(s))
	if err != nil {
		panic(err)
	}
	return v
}

func anyString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if n, ok := v.(interface{ String() string }); ok {
		return n.String()
	}
	return ""
}

// R68/R69. Idle is stamped from one place for every adapter, and only a step
// that actually stopped ends a turn.
func TestIdleIsStampedOnTurnEndsOnly(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "tool_call", "ts", "2026-01-01T00:00:00.000Z"),
		// a five minute gap after a tool call is a SLOW TOOL, never idle
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T00:05:00.000Z"),
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:07:30.000Z"),
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T00:08:00.000Z"),
	}
	markIdle(events)

	if present(get(events[0], "idleMs")) {
		t.Fatal("a tool call carries idleMs; a slow tool is work, not waiting")
	}
	if got := num(get(events[1], "idleMs")); got != 150000 {
		t.Fatalf("idleMs = %v, want 150000 (two and a half minutes to the next event)", got)
	}
	if present(get(events[3], "idleMs")) {
		t.Fatal("a turn end with nothing after it carries idleMs; absent is not zero")
	}
}

func TestIdleSkipsEventsWithNoTimestamp(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T00:00:00.000Z"),
		trajectory.NewObject("kind", "meta"),
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:01:00.000Z"),
	}
	markIdle(events)
	if got := num(get(events[0], "idleMs")); got != 60000 {
		t.Fatalf("idleMs = %v, want 60000 — an untimestamped neighbour is stepped over", got)
	}
}

// TRC-014. A record carrying no work does not end the wait, even with a
// timestamp on it. Claude Code writes these while the agent sits still, and
// stopping at one reported seconds of idle for a wait of hours.
func TestIdleRunsPastTimestampedBookkeeping(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T12:00:00.000Z"),
		trajectory.NewObject("kind", "meta", "ts", "2026-01-01T12:00:02.000Z", "text", "context attachment"),
		trajectory.NewObject("kind", "system", "ts", "2026-01-01T12:00:03.000Z"),
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T15:00:00.000Z"),
	}
	markIdle(events)
	if got := num(get(events[0], "idleMs")); got != 3*60*60*1000 {
		t.Fatalf("idleMs = %v, want three hours — bookkeeping does not end the wait", got)
	}
}

// A turn end followed only by bookkeeping carries no field. The agent never
// resumed, and "waited for nothing" is not "waited no time".
func TestIdleAbsentWhenWorkNeverResumes(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T12:00:00.000Z"),
		trajectory.NewObject("kind", "meta", "ts", "2026-01-01T12:00:02.000Z"),
	}
	markIdle(events)
	if _, ok := events[0].Get("idleMs"); ok {
		t.Fatal("idleMs is set although work never resumed")
	}
}

// R69. Only a step that stopped ends a turn. The captured fixtures cannot reach
// this: the scrubber rewrites the reason to prose, so no fixture carries the
// literal "stop" and every fixture step-finish lands on the meta branch.
func TestOpenCodeStepFinishEndsATurnOnlyWhenItStopped(t *testing.T) {
	doc, err := NormalizeBytes([]byte(`{"info":{"id":"s1"},"messages":[{"info":{"role":"assistant","time":{"created":1767225600000}},"parts":[
		{"type":"step-finish","reason":"tool-calls","time":{"start":1767225600000}},
		{"type":"step-finish","reason":"stop","time":{"start":1767225660000}}
	]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, str(get(e, "kind")))
	}
	if len(events) != 2 {
		t.Fatalf("events = %v, want two step finishes", kinds)
	}
	if kinds[0] != "meta" {
		t.Fatalf("a step finishing on tool-calls is %q, want meta — the agent carried straight on", kinds[0])
	}
	if kinds[1] != "turn_end" {
		t.Fatalf("a step finishing on stop is %q, want turn_end", kinds[1])
	}
	// Both keep the reason, so the details page still says what they were.
	for i, e := range events {
		if got := str(get(e, "text")); !strings.Contains(got, "step finish") {
			t.Fatalf("event %d text = %q, want the reason preserved", i, got)
		}
	}
}

// R70, TRC-015. The model's latency after a tool result lands on the reply it
// produced, past the bookkeeping written in between, and a tool call owns its
// own run as well as the time spent issuing it.
func TestWorkLandsOnTheReplyPastBookkeeping(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:00:00.000Z"),
		trajectory.NewObject("kind", "tool_call", "ts", "2026-01-01T00:00:02.000Z",
			"result", trajectory.NewObject("ts", "2026-01-01T00:00:05.000Z")),
		trajectory.NewObject("kind", "meta", "ts", "2026-01-01T00:00:05.100Z", "text", "context attachment"),
		trajectory.NewObject("kind", "meta"),
		trajectory.NewObject("kind", "thinking", "ts", "2026-01-01T00:00:09.000Z"),
		trajectory.NewObject("kind", "assistant", "ts", "2026-01-01T00:00:10.000Z"),
	}
	markWork(events)
	for i, want := range map[int]float64{1: 5000, 4: 4000, 5: 1000} {
		if got := num(get(events[i], "workMs")); got != want {
			t.Fatalf("events[%d].workMs = %v, want %v", i, got, want)
		}
	}
	for _, i := range []int{0, 2, 3} {
		if _, ok := events[i].Get("workMs"); ok {
			t.Fatalf("events[%d] (%s) carries workMs", i, str(get(events[i], "kind")))
		}
	}
	if got := num(get(stripEvent(events[4]), "workMs")); got != 4000 {
		t.Fatalf("strip workMs = %v, want 4000 — the bar is drawn from the strip", got)
	}
}

// A tool call issued beside a slower one is charged from its own timestamp, and
// the reply after both from the slower one's result, not from the last one listed.
func TestWorkUnderParallelToolCalls(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:00:00.000Z"),
		trajectory.NewObject("kind", "tool_call", "ts", "2026-01-01T00:00:01.000Z",
			"result", trajectory.NewObject("ts", "2026-01-01T00:00:10.000Z")),
		trajectory.NewObject("kind", "tool_call", "ts", "2026-01-01T00:00:02.000Z",
			"result", trajectory.NewObject("ts", "2026-01-01T00:00:03.000Z")),
		trajectory.NewObject("kind", "assistant", "ts", "2026-01-01T00:00:12.000Z"),
	}
	markWork(events)
	for i, want := range map[int]float64{1: 10000, 2: 1000, 3: 2000} {
		if got := num(get(events[i], "workMs")); got != want {
			t.Fatalf("events[%d].workMs = %v, want %v", i, got, want)
		}
	}
}

// The wait after a turn end is idle (R68), so the work after it starts where
// the wait stops rather than at the turn end.
func TestWorkStartsWhereIdleStops(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "assistant", "ts", "2026-01-01T00:00:00.000Z"),
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T00:00:01.000Z"),
		trajectory.NewObject("kind", "meta", "ts", "2026-01-01T00:30:00.000Z"),
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T01:00:00.000Z"),
		trajectory.NewObject("kind", "thinking", "ts", "2026-01-01T01:00:03.000Z"),
	}
	markIdle(events)
	markWork(events)
	if _, ok := events[0].Get("workMs"); ok {
		t.Fatal("the first event carries workMs, with no earlier work to measure from")
	}
	if got := num(get(events[4], "workMs")); got != 3000 {
		t.Fatalf("workMs = %v, want 3000 — the hour before the user spoke is idle", got)
	}
}

// A reply Claude Code wrote without calling a model is not the model's work. A
// captured session charged one of them the 37 minutes the user took to return.
func TestWorkSkipsSyntheticReplies(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:00:00.000Z"),
		trajectory.NewObject("kind", "assistant", "ts", "2026-01-01T00:37:00.000Z", "synthetic", true),
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:37:20.000Z"),
		trajectory.NewObject("kind", "assistant", "ts", "2026-01-01T00:37:25.000Z"),
	}
	markWork(events)
	if _, ok := events[1].Get("workMs"); ok {
		t.Fatal("a synthetic reply carries workMs")
	}
	if got := num(get(events[3], "workMs")); got != 5000 {
		t.Fatalf("workMs = %v, want 5000", got)
	}
}
