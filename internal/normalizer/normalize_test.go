package normalizer

import (
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

func docWithUserText(text string) *obj {
	return trajectory.NewObject(
		"meta", trajectory.NewObject("source", "claude-code"),
		"events", []*obj{trajectory.NewObject("kind", "user", "text", text)},
	)
}

func autoTitleOf(doc *obj) string {
	deriveAutoTitle(doc)
	return str(get(object(get(doc, "meta")), "autoTitle"))
}

func TestDeriveAutoTitle(t *testing.T) {
	t.Run("first user text wins, whitespace collapsed", func(t *testing.T) {
		doc := docWithUserText("hello\n\t world  \n again")
		if got := autoTitleOf(doc); got != "hello world again" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("empty and environment_context messages are skipped", func(t *testing.T) {
		doc := trajectory.NewObject(
			"meta", trajectory.NewObject("source", "codex"),
			"events", []*obj{
				trajectory.NewObject("kind", "user", "text", "   "),
				trajectory.NewObject("kind", "user", "text", "  <environment_context>stuff"),
				trajectory.NewObject("kind", "user", "text", "real prompt"),
			},
		)
		if got := autoTitleOf(doc); got != "real prompt" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("no user text leaves autoTitle absent", func(t *testing.T) {
		doc := trajectory.NewObject("meta", trajectory.NewObject(), "events", []*obj{
			trajectory.NewObject("kind", "assistant", "text", "hi"),
		})
		deriveAutoTitle(doc)
		if _, ok := object(get(doc, "meta")).Get("autoTitle"); ok {
			t.Fatal("autoTitle set without a user message")
		}
	})
	t.Run("truncation is word-boundary aware at 60 UTF-16 units", func(t *testing.T) {
		// 61 units: 30 'a', space, 30 'b' — slice(0,60) = 30a + space + 29b,
		// and /\s+\S*$/ removes the trailing partial word.
		text := strings.Repeat("a", 30) + " " + strings.Repeat("b", 30)
		got := autoTitleOf(docWithUserText(text))
		if got != strings.Repeat("a", 30)+"…" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("a trailing space in the slice is removed", func(t *testing.T) {
		// /\s+\S*$/ matches trailing whitespace too (\S* allows zero), so a
		// slice ending in a space loses it. Verified against Node:
		// "a".repeat(59)+" "+"b".repeat(10) -> 59 a's + "…".
		text := strings.Repeat("a", 59) + " " + strings.Repeat("b", 10)
		got := autoTitleOf(docWithUserText(text))
		if got != strings.Repeat("a", 59)+"…" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("exactly 60 units is not truncated", func(t *testing.T) {
		text := strings.Repeat("x", 60)
		if got := autoTitleOf(docWithUserText(text)); got != text {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("the 60-unit budget counts UTF-16 units", func(t *testing.T) {
		// 58 ASCII + one astral (2 units) = 60 units: no truncation.
		exact := strings.Repeat("x", 58) + "\U0001F600"
		if got := autoTitleOf(docWithUserText(exact)); got != exact {
			t.Fatalf("exact: got %q", got)
		}
		// 59 ASCII + one astral = 61 units: truncated; the slice boundary
		// falls inside the surrogate pair and Go replaces the lone surrogate
		// (JS would emit it escaped — the documented lone-surrogate gap).
		over := strings.Repeat("x", 59) + "\U0001F600" + "tail"
		got := autoTitleOf(docWithUserText(over))
		if !strings.HasPrefix(got, strings.Repeat("x", 59)) || !strings.HasSuffix(got, "…") {
			t.Fatalf("over: got %q", got)
		}
		if len(utf16.Encode([]rune(strings.TrimSuffix(got, "…")))) > 60 {
			t.Fatalf("truncated title exceeds the budget: %q", got)
		}
	})
	t.Run("unicode whitespace collapses like JS \\s", func(t *testing.T) {
		doc := docWithUserText("a\u00a0b\ufeffc\u2028d")
		if got := autoTitleOf(doc); got != "a b c d" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestNormalizeBytesNonObjectLines(t *testing.T) {
	// A valid JSON line that is not an object must not crash; in the claude
	// path it reads as all-undefined (skipped), exactly like JS property
	// access on a primitive.
	doc, err := NormalizeBytes([]byte("[1,2,3]\n{\"type\":\"user\",\"uuid\":\"1\",\"sessionId\":\"s\",\"message\":{\"content\":\"hi\"}}"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 1 || str(get(events[0], "kind")) != "user" {
		t.Fatalf("events = %v", events)
	}
	// The non-object line is counted under "(no type)": it is not a record, and
	// parse.skippedByType records WHY something produced no event, not just how
	// many did.
	entries, _ := get(object(get(doc, "parse")), "skippedByType").([]any)
	total := 0
	noType := 0
	for _, e := range entries {
		n := int(num(get(object(e), "count")))
		total += n
		if str(get(object(e), "type")) == "(no type)" {
			noType += n
		}
	}
	if total != 1 || noType != 1 {
		t.Fatalf("skippedByType = %v, want a single '(no type)' entry", entries)
	}
}

// A line that is not JSON is DAMAGE, not an unrecognized record type (R56):
// it carries rawType "unreadable", names its line, and is counted in
// parse.unreadable while leaving parse.unrecognized alone.
func TestNormalizeBytesParseErrorRecord(t *testing.T) {
	doc, err := NormalizeBytes([]byte("not json at all\n{\"type\":\"user\",\"uuid\":\"1\",\"sessionId\":\"s\",\"message\":{\"content\":\"hi\"}}"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 2 {
		t.Fatalf("events = %d", len(events))
	}
	if got := str(get(events[0], "rawType")); got != "unreadable" {
		t.Fatalf("first event rawType = %q", got)
	}
	if got := str(get(events[0], "text")); !strings.Contains(got, "1 unreadable line (line 1)") {
		t.Fatalf("first event text = %q", got)
	}
	parse := object(get(doc, "parse"))
	if got := num(get(parse, "unreadable")); got != 1 {
		t.Fatalf("parse.unreadable = %v, want 1", got)
	}
	if got := num(get(parse, "unrecognized")); got != 0 {
		t.Fatalf("parse.unrecognized = %v, want 0 — damage is not an unknown type", got)
	}
}

// R57: a run of consecutive unreadable lines collapses to ONE event naming the
// range, and a readable record between two runs keeps them apart.
func TestNormalizeBytesCollapsesDamageRuns(t *testing.T) {
	doc, err := NormalizeBytes([]byte("bad\nbad\nbad\n{\"type\":\"user\",\"uuid\":\"1\",\"sessionId\":\"s\",\"message\":{\"content\":\"hi\"}}\nbad\nbad"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 3 {
		t.Fatalf("events = %d, want 3 (run, message, run)", len(events))
	}
	if got := str(get(events[0], "text")); !strings.Contains(got, "3 unreadable lines (lines 1-3)") {
		t.Fatalf("first run text = %q", got)
	}
	if got := str(get(events[1], "kind")); got != "user" {
		t.Fatalf("middle event kind = %q, want the readable record in its place", got)
	}
	if got := str(get(events[2], "text")); !strings.Contains(got, "2 unreadable lines (lines 5-6)") {
		t.Fatalf("trailing run text = %q", got)
	}
	if got := num(get(object(get(doc, "parse")), "unreadable")); got != 5 {
		t.Fatalf("parse.unreadable = %v, want 5 lines across both runs", got)
	}
}

func TestNormalizeBytesCRLF(t *testing.T) {
	doc, err := NormalizeBytes([]byte("{\"type\":\"user\",\"uuid\":\"1\",\"sessionId\":\"s\",\"message\":{\"content\":\"hi\"}}\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := get(doc, "events").([]*obj); len(got) != 1 {
		t.Fatalf("events = %d", len(got))
	}
}
