package normalizer

import (
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// claudeAssistant builds an assistant record carrying usage.
func claudeAssistant(uuid, messageID string, usage *obj) *obj {
	return trajectory.NewObject(
		"uuid", uuid, "sessionId", "s", "type", "assistant",
		"message", trajectory.NewObject("id", messageID, "model", "m", "usage", usage,
			"content", []any{trajectory.NewObject("type", "text", "text", "hi")}),
	)
}

// The TTL split is published only when every cache-writing record carried it: a
// document mixing split and unsplit cache writes omits both keys and warns
// instead of publishing a partial sum.
func TestClaudePartialSplitIsNotPublished(t *testing.T) {
	withSplit := trajectory.NewObject("input_tokens", 1, "cache_creation_input_tokens", 10,
		"cache_creation", trajectory.NewObject("ephemeral_5m_input_tokens", 6, "ephemeral_1h_input_tokens", 4))
	withoutSplit := trajectory.NewObject("input_tokens", 1, "cache_creation_input_tokens", 5)

	doc := NormalizeClaude([]*obj{claudeAssistant("a", "m1", withSplit), claudeAssistant("b", "m2", withoutSplit)})
	totals := object(get(doc, "totals"))
	if _, ok := totals.Get("cacheWrite5m"); ok {
		t.Fatal("cacheWrite5m published for a partial split")
	}
	if _, ok := totals.Get("cacheWrite1h"); ok {
		t.Fatal("cacheWrite1h published for a partial split")
	}
	if got := num(get(totals, "cacheWrite")); got != 15 {
		t.Fatalf("cacheWrite = %v, want 15", got)
	}
	warnings := get(object(get(doc, "parse")), "warnings").([]any)
	found := false
	for _, w := range warnings {
		if strings.Contains(str(get(object(w), "message")), "TTL split is incomplete") {
			found = true
		}
	}
	if !found {
		t.Fatalf("partial-split warning missing: %v", warnings)
	}
}

func TestClaudeCompleteSplitIsPublished(t *testing.T) {
	withSplit := trajectory.NewObject("input_tokens", 1, "cache_creation_input_tokens", 10,
		"cache_creation", trajectory.NewObject("ephemeral_5m_input_tokens", 6, "ephemeral_1h_input_tokens", 4))
	doc := NormalizeClaude([]*obj{claudeAssistant("a", "m1", withSplit)})
	totals := object(get(doc, "totals"))
	if got := num(get(totals, "cacheWrite5m")); got != 6 {
		t.Fatalf("cacheWrite5m = %v, want 6", got)
	}
	if got := num(get(totals, "cacheWrite1h")); got != 4 {
		t.Fatalf("cacheWrite1h = %v, want 4", got)
	}
	warnings := get(object(get(doc, "parse")), "warnings").([]any)
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
}

// Fail-soft in the claude path: hostile scalars are excluded from totals and the
// warning lands after any unrecognized-type warnings.
func TestClaudeMalformedTokenWarning(t *testing.T) {
	hostile := trajectory.NewObject("input_tokens", "all of them", "output_tokens", 3)
	doc := NormalizeClaude([]*obj{claudeAssistant("a", "m1", hostile)})
	totals := object(get(doc, "totals"))
	if got := num(get(totals, "input")); got != 0 {
		t.Fatalf("hostile input_tokens poisoned totals: %v", got)
	}
	warnings := get(object(get(doc, "parse")), "warnings").([]any)
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v", warnings)
	}
	w := object(warnings[0])
	if !strings.Contains(str(get(w, "message")), "1 malformed token/cost value(s)") {
		t.Fatalf("warning = %v", get(w, "message"))
	}
	if got := num(get(w, "count")); got != 1 {
		t.Fatalf("count = %v", got)
	}
}

// `kind` lands first or third depending on whether the event came through the
// base spread — the insertion-order property the whole model exists for.
func TestClaudeEventKeyOrder(t *testing.T) {
	usage := trajectory.NewObject("input_tokens", 7, "output_tokens", 3)
	rec := func(uuid string) *obj {
		return trajectory.NewObject("uuid", uuid, "sessionId", "s", "type", "assistant",
			"message", trajectory.NewObject("id", uuid, "usage", usage,
				"content", []any{trajectory.NewObject("type", "text", "text", "hi")}))
	}
	user := trajectory.NewObject("uuid", "u1", "sessionId", "s", "type", "user",
		"message", trajectory.NewObject("content", "hello"))
	doc := NormalizeClaude([]*obj{user, rec("a1")})
	events := get(doc, "events").([]*obj)

	userKeys := keysOf(events[0])
	if strings.Join(userKeys, ",") != "kind,ts,lane,text,i" {
		t.Fatalf("user event keys %v", userKeys)
	}
	assistantKeys := keysOf(events[1])
	if strings.Join(assistantKeys, ",") != "ts,lane,tokens,kind,text,i" {
		t.Fatalf("assistant event keys %v", assistantKeys)
	}
}

// meta.title lands wherever the ai-title record appears in the input stream.
func TestClaudeTitleSlotFollowsTheAITitleRecord(t *testing.T) {
	titleFirst := []*obj{
		trajectory.NewObject("type", "ai-title", "aiTitle", "named"),
		trajectory.NewObject("uuid", "u1", "sessionId", "s", "cwd", "/tmp", "type", "user", "message", trajectory.NewObject("content", "hi")),
	}
	doc := NormalizeClaude(titleFirst)
	if got := strings.Join(keysOf(object(get(doc, "meta"))), ","); !strings.HasPrefix(got, "source,title,") {
		t.Fatalf("title-first order: %s", got)
	}

	titleLate := []*obj{
		trajectory.NewObject("uuid", "u1", "sessionId", "s", "cwd", "/tmp", "type", "user", "message", trajectory.NewObject("content", "hi")),
		trajectory.NewObject("type", "ai-title", "aiTitle", "named"),
	}
	doc = NormalizeClaude(titleLate)
	// ??= creates a slot even when the record lacks the key (assigning
	// undefined), so agentId/cliVersion occupy slots here although the JSON
	// output omits them. title lands after them because the ai-title record
	// arrives later in the stream.
	if got := strings.Join(keysOf(object(get(doc, "meta"))), ","); !strings.HasPrefix(got, "source,sessionId,agentId,cwd,cliVersion,title,") {
		t.Fatalf("title-late order: %s", got)
	}
}

func keysOf(o *obj) []string {
	var keys []string
	for _, m := range o.Members() {
		keys = append(keys, m.Key)
	}
	return keys
}
