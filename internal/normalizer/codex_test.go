package normalizer

import (
	"strings"
	"testing"
)

// R56/R57 on the codex adapter. The claude path has a fixture behind it
// (claude/v2.1/malformed); this one had no coverage at all, so the codex
// __parseError branch could have kept routing damage to unknown() unnoticed.
func TestNormalizeCodexDamageIsNotUnrecognized(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\nbad\nbad\n" +
			"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}"))
	if err != nil {
		t.Fatal(err)
	}
	if got := str(get(object(get(doc, "meta")), "source")); got != "codex" {
		t.Fatalf("source = %q, want codex", got)
	}
	parse := object(get(doc, "parse"))
	if got := num(get(parse, "unreadable")); got != 2 {
		t.Fatalf("parse.unreadable = %v, want 2", got)
	}
	if got := num(get(parse, "unrecognized")); got != 0 {
		t.Fatalf("parse.unrecognized = %v, want 0 — damage is not an unknown type", got)
	}
	events := get(doc, "events").([]*obj)
	var runs int
	for _, e := range events {
		if str(get(e, "rawType")) == "unreadable" {
			runs++
			if got := str(get(e, "text")); !strings.Contains(got, "2 unreadable lines (lines 2-3)") {
				t.Fatalf("run text = %q", got)
			}
		}
	}
	if runs != 1 {
		t.Fatalf("collapsed runs = %d, want 1", runs)
	}
}

// R67. `task_complete` carries `error` when the turn died, and null when it
// finished. Both used to normalize to the text "turn complete" with nothing
// marking the failure, so a run a provider limit killed read as a run that
// worked.
func TestNormalizeCodexFailedTurnIsAnError(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"error\":" +
			"{\"message\":\"rate limit exceeded: try again in 14s\",\"codex_error_info\":\"rate_limit_exceeded\"}}}\n" +
			"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"error\":null}}"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	var turns []*obj
	for _, e := range events {
		if str(get(e, "kind")) == "turn_end" {
			turns = append(turns, e)
		}
	}
	if len(turns) != 2 {
		t.Fatalf("turn_end events = %d, want 2", len(turns))
	}
	failed, done := turns[0], turns[1]

	if !truthy(get(failed, "isError")) {
		t.Fatal("the failed turn is not marked as an error")
	}
	if got := str(get(failed, "text")); got != "rate limit exceeded: try again in 14s" {
		t.Fatalf("failed turn text = %q, want the provider's message", got)
	}
	if got := str(get(failed, "label")); got != "rate_limit_exceeded" {
		t.Fatalf("failed turn label = %q, want the machine-readable reason", got)
	}

	if present(get(done, "isError")) {
		t.Fatal("a turn that finished must not carry isError")
	}
	if got := str(get(done, "text")); got != "turn complete" {
		t.Fatalf("completed turn text = %q, want \"turn complete\"", got)
	}

	// The strip is the error channel a reader actually sees (R67).
	if !truthy(get(stripEvent(failed), "error")) {
		t.Fatal("the failed turn does not reach the strip's error channel")
	}
	if truthy(get(stripEvent(done), "error")) {
		t.Fatal("the completed turn reaches the strip as an error")
	}
}
