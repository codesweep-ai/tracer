package normalizer

import (
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// R77, TRC-018. Elapsed, idle and work are separate figures. Work is a union, so
// tool calls running at once count once, and what is neither stays visible as
// the difference rather than being folded into either.
func TestTimeTotalsKeepElapsedIdleAndWorkApart(t *testing.T) {
	events := []*obj{
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T00:00:00.000Z"),
		trajectory.NewObject("kind", "tool_call", "ts", "2026-01-01T00:00:01.000Z",
			"result", trajectory.NewObject("ts", "2026-01-01T00:00:10.000Z")),
		trajectory.NewObject("kind", "tool_call", "ts", "2026-01-01T00:00:02.000Z",
			"result", trajectory.NewObject("ts", "2026-01-01T00:00:03.000Z")),
		trajectory.NewObject("kind", "assistant", "ts", "2026-01-01T00:00:12.000Z"),
		trajectory.NewObject("kind", "turn_end", "ts", "2026-01-01T00:00:12.000Z"),
		trajectory.NewObject("kind", "user", "ts", "2026-01-01T02:00:12.000Z"),
		trajectory.NewObject("kind", "system", "ts", "2026-01-01T02:00:20.000Z"),
	}
	markIdle(events)
	markWork(events)
	got := timeTotals(events, "2026-01-01T00:00:00.000Z", "2026-01-01T02:00:20.000Z", nil)
	for k, want := range map[string]float64{"elapsedMs": 2*3600000 + 20000, "idleMs": 2 * 3600000, "workMs": 12000} {
		if v := num(get(got, k)); v != want {
			t.Fatalf("%s = %v, want %v", k, v, want)
		}
	}
	if _, ok := got.Get("reported"); ok {
		t.Fatal("a reported member appeared with nothing reported")
	}
}

// R78. Claude Code's durations are kept as reported, covering the tree, beside
// tracer's own figures and never in place of them.
func TestClaudeCostStateDurationsAreReported(t *testing.T) {
	doc := NormalizeClaude([]*obj{trajectory.NewObject("type", "cost-state", "sessionId", "s", "totalCostUSD", 1,
		"totalDuration", 5000, "totalAPIDuration", 3000, "totalAPIDurationWithoutRetries", 2500, "totalToolDuration", 1000)})
	tm := object(get(object(get(doc, "totals")), "time"))
	reported := array(get(tm, "reported"))
	if len(reported) != 1 {
		t.Fatalf("reported = %v, want one figure", reported)
	}
	figure := object(reported[0])
	for k, want := range map[string]float64{"elapsedMs": 5000, "modelMs": 3000, "modelMsWithoutRetries": 2500, "toolMs": 1000} {
		if v := num(get(figure, k)); v != want {
			t.Fatalf("%s = %v, want %v", k, v, want)
		}
	}
	if str(get(figure, "covers")) != "tree" {
		t.Fatalf("covers = %v, want tree", get(figure, "covers"))
	}
	if v := num(get(tm, "workMs")); v != 0 {
		t.Fatalf("workMs = %v, want tracer's own 0, not the reported figure", v)
	}
}
