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
