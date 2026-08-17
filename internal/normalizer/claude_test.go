package normalizer

import (
	"bytes"
	"os"
	"path/filepath"
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
