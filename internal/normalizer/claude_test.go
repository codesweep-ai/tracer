package normalizer

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

func TestNormalizeClaudeSimpleFixtureIdentity(t *testing.T) {
	path := filepath.Join("..", "..", "fixtures", "claude", "v2.1", "simple", "session.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var records []*obj
	for line := range bytes.SplitSeq(data, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		v, err := trajectory.Decode(line)
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, v.(*obj))
	}
	doc := NormalizeClaude(records)
	meta := object(get(doc, "meta"))
	// Derive the expected id from the fixture rather than hard-coding it: the
	// property under test is that the session id ROUND-TRIPS, and a literal here
	// breaks whenever fixtures are re-minted (as the scrub did) without any
	// behaviour having changed.
	var want string
	for _, r := range records {
		if s := str(get(r, "sessionId")); s != "" {
			want = s
			break
		}
	}
	if want == "" {
		t.Fatal("fixture carries no sessionId")
	}
	if got := str(get(meta, "sessionId")); got != want {
		t.Fatalf("sessionId %q, want %q", got, want)
	}
	events, _ := get(doc, "events").([]*obj)
	if got, want := len(events), 90; got != want {
		t.Fatalf("events %d, want %d", got, want)
	}
	if got := str(get(events[0], "kind")); got != "user" {
		t.Fatalf("first event kind %q", got)
	}
}

func TestClaudeUsageDeduplicatesMessageID(t *testing.T) {
	usage := trajectory.NewObject("input_tokens", 7, "output_tokens", 3)
	message := func(text string) *obj {
		return trajectory.NewObject("uuid", text, "sessionId", "s", "type", "assistant", "message", trajectory.NewObject("id", "same", "usage", usage, "content", []any{trajectory.NewObject("type", "text", "text", text)}))
	}
	doc := NormalizeClaude([]*obj{message("one"), message("two")})
	events := get(doc, "events").([]*obj)
	if get(events[0], "tokens") == nil || get(events[1], "tokens") != nil {
		t.Fatal("duplicate message usage was not attached exactly once")
	}
}

// A fork's first record answers the Fork call with a tool_result and carries
// the fork's task as a text block beside it. The adapter read arrays of
// results and arrays of text, and drew the mixed form as an unrecognized
// `user-content:text`, losing the one instruction the fork acts on.
func TestClaudeToolResultBesideTextIsTheForkInstruction(t *testing.T) {
	doc := NormalizeClaude([]*obj{
		trajectory.NewObject("uuid", "a1", "sessionId", "s", "type", "assistant", "timestamp", "2026-11-05T10:00:00.000Z",
			"message", trajectory.NewObject("role", "assistant", "content", []any{
				trajectory.NewObject("type", "tool_use", "id", "toolu_1", "name", "Fork", "input", trajectory.NewObject("directive", "run the suite")),
			})),
		trajectory.NewObject("uuid", "u1", "sessionId", "s", "type", "user", "isSidechain", true, "agentId", "ab79", "timestamp", "2026-11-05T10:00:01.000Z",
			"message", trajectory.NewObject("role", "user", "content", []any{
				trajectory.NewObject("type", "tool_result", "tool_use_id", "toolu_1", "content", []any{trajectory.NewObject("type", "text", "text", "Fork started")}),
				trajectory.NewObject("type", "text", "text", "<fork-boilerplate>\nYou are a worker fork. Execute ONE directive, then stop."),
			})),
	})
	events := get(doc, "events").([]*obj)
	if len(events) != 2 {
		t.Fatalf("events = %d, want the call and the instruction", len(events))
	}
	if got := str(get(object(get(events[0], "result")), "text")); got != "Fork started" {
		t.Fatalf("the result did not reach its call: %q", got)
	}
	instruction := events[1]
	if got := str(get(instruction, "kind")); got != "user" {
		t.Fatalf("kind = %q, want user", got)
	}
	if got := str(get(instruction, "text")); !strings.HasPrefix(got, "<fork-boilerplate>") {
		t.Fatalf("text = %q, want the fork's task", got)
	}
	if got := str(get(instruction, "lane")); got != "sidechain" {
		t.Fatalf("lane = %q, want sidechain", got)
	}
	if n := num(get(object(get(doc, "parse")), "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
}
