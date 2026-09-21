package normalizer

import (
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

func costOfDoc(doc *obj) *obj { return object(get(object(get(doc, "totals")), "cost")) }

// opencodeSession builds a session whose two steps each state a cost, and whose
// own figure is sessionCost.
func opencodeSession(t *testing.T, sessionCost string) *obj {
	t.Helper()
	doc, err := NormalizeBytes([]byte(`{"info":{"id":"s1","cost":` + sessionCost + `},"messages":[{"info":{"role":"assistant","time":{"created":1767225600000}},"parts":[
		{"type":"text","text":"a","time":{"start":1767225600000}},
		{"type":"step-finish","reason":"tool-calls","cost":0.25,"tokens":{"input":1,"output":1},"time":{"start":1767225600000}},
		{"type":"text","text":"b","time":{"start":1767225660000}},
		{"type":"step-finish","reason":"stop","cost":0.5,"tokens":{"input":1,"output":1},"time":{"start":1767225660000}}
	]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

// R71, R72. OpenCode's session figure covers that session alone, and is kept
// beside the sum of its steps rather than replacing it.
func TestOpenCodeCostIsReportedAtBothLevels(t *testing.T) {
	cost := costOfDoc(opencodeSession(t, "0.75"))
	reported := array(get(cost, "reported"))
	if len(reported) != 1 || num(get(object(reported[0]), "usd")) != 0.75 || str(get(object(reported[0]), "covers")) != "trajectory" {
		t.Fatalf("reported = %v, want one figure of 0.75 covering the trajectory", reported)
	}
	byEvents := object(get(cost, "reportedByEvents"))
	if num(get(byEvents, "usd")) != 0.75 || num(get(byEvents, "events")) != 2 || num(get(byEvents, "of")) != 2 {
		t.Fatalf("reportedByEvents = %v, want 0.75 over 2 of 2 events", byEvents)
	}
}

// R74. When the session figure and its steps disagree, both are kept and the
// document says so.
func TestOpenCodeCostDisagreementIsWarned(t *testing.T) {
	doc := opencodeSession(t, "0.9")
	if got := num(get(object(array(get(costOfDoc(doc), "reported"))[0]), "usd")); got != 0.9 {
		t.Fatalf("reported usd = %v, want 0.9 kept", got)
	}
	if got := num(get(object(get(costOfDoc(doc), "reportedByEvents")), "usd")); got != 0.75 {
		t.Fatalf("reportedByEvents usd = %v, want 0.75 kept", got)
	}
	found := false
	for _, w := range get(object(get(doc, "parse")), "warnings").([]any) {
		found = found || strings.Contains(str(get(object(w), "message")), "disagrees")
	}
	if !found {
		t.Fatal("no warning for a reported cost that disagrees with its events")
	}
	if agreed := opencodeSession(t, "0.75"); len(get(object(get(agreed, "parse")), "warnings").([]any)) != 0 {
		t.Fatal("a warning was raised although the figures agree")
	}
}

// R72. Claude Code's figure covers the session and its sub-agents, and only the
// last of its running totals is the whole figure.
func TestClaudeCostStateCoversTheTree(t *testing.T) {
	state := func(total float64, unknown bool) *obj {
		return trajectory.NewObject("type", "cost-state", "sessionId", "s", "totalCostUSD", total, "hasUnknownModelCost", unknown,
			"modelUsage", trajectory.NewObject(
				"model-b", trajectory.NewObject("costUSD", 2.5),
				"model-a", trajectory.NewObject("costUSD", 1.5)))
	}
	doc := NormalizeClaude([]*obj{state(1, false), state(4, true)})
	reported := array(get(costOfDoc(doc), "reported"))
	if len(reported) != 1 {
		t.Fatalf("reported = %v, want the last running total only", reported)
	}
	figure := object(reported[0])
	if num(get(figure, "usd")) != 4 || str(get(figure, "covers")) != "tree" || get(figure, "incomplete") != true {
		t.Fatalf("figure = %v, want 4 covering the tree, marked incomplete", figure)
	}
	byModel := array(get(figure, "byModel"))
	if len(byModel) != 2 || str(get(object(byModel[0]), "model")) != "model-a" {
		t.Fatalf("byModel = %v, want both models sorted by name", byModel)
	}
	if got := num(get(object(get(doc, "parse")), "unrecognized")); got != 0 {
		t.Fatalf("parse.unrecognized = %v, want 0", got)
	}
}

// R73. A document with no reported figure gets none, whatever its adapter.
func TestNoReportedCostIsInvented(t *testing.T) {
	doc, err := NormalizeBytes([]byte("{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}"))
	if err != nil {
		t.Fatal(err)
	}
	cost := costOfDoc(doc)
	for _, k := range []string{"reported", "reportedByEvents"} {
		if _, ok := cost.Get(k); ok {
			t.Fatalf("a codex document carries %s", k)
		}
	}
}
