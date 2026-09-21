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

// One message spans several records sharing a message id. A record written
// while the message was streaming carries a partial output_tokens, so the last
// record supplies the counts, and they are still counted once, on the
// message's first event.
func TestClaudeLastUsageRecordForAMessageWins(t *testing.T) {
	streaming := trajectory.NewObject("input_tokens", 3, "output_tokens", 2, "cache_read_input_tokens", 100)
	final := trajectory.NewObject("input_tokens", 3, "output_tokens", 900, "cache_read_input_tokens", 100)

	doc := NormalizeClaude([]*obj{claudeAssistant("a", "m1", streaming), claudeAssistant("b", "m1", final)})
	totals := object(get(doc, "totals"))
	if got := num(get(totals, "output")); got != 900 {
		t.Fatalf("output = %v, want the final record's 900", got)
	}
	if got := num(get(totals, "input")); got != 3 {
		t.Fatalf("input = %v, want 3 counted once", got)
	}
	if got := num(get(totals, "cacheRead")); got != 100 {
		t.Fatalf("cacheRead = %v, want 100 counted once", got)
	}
	events := get(doc, "events").([]*obj)
	if _, ok := events[0].Get("tokens"); !ok {
		t.Fatal("the message's first event carries no tokens")
	}
	if _, ok := events[1].Get("tokens"); ok {
		t.Fatal("the message's second event repeats the tokens")
	}
}

// TRC-015. Session settings Claude Code restates with no timestamp are ignored
// by name, not reported as unrecognized.
func TestClaudeRestatedSettingsAreIgnored(t *testing.T) {
	var records []*obj
	for _, typ := range []string{"atis-latch", "agent-color", "relocated"} {
		records = append(records, trajectory.NewObject("type", typ, "sessionId", "s"))
	}
	doc := NormalizeClaude(records)
	parse := object(get(doc, "parse"))
	if got := num(get(parse, "unrecognized")); got != 0 {
		t.Fatalf("parse.unrecognized = %v, want 0", got)
	}
	if got := len(get(doc, "events").([]*obj)); got != 0 {
		t.Fatalf("events = %d, want 0", got)
	}
	if got := len(get(parse, "skippedByType").([]any)); got != 3 {
		t.Fatalf("skippedByType has %d types, want 3", got)
	}
}

// TRC-016. The echo of a local command is Claude Code's own record, not an
// instruction, so the wait runs past it. An isMeta record with any other parent,
// such as a sub-agent's hand-back, still starts work.
func TestClaudeLocalCommandEchoDoesNotEndIdle(t *testing.T) {
	rec := func(uuid, parent, typ, ts string, kv ...any) *obj {
		o := trajectory.NewObject("uuid", uuid, "parentUuid", parent, "sessionId", "s", "type", typ, "timestamp", ts)
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
		return o
	}
	text := func(s string) *obj { return trajectory.NewObject("role", "user", "content", s) }
	doc := NormalizeClaude([]*obj{
		rec("a", "", "system", "2026-01-01T10:00:00.000Z", "subtype", "turn_duration"),
		rec("b", "a", "system", "2026-01-01T10:05:00.000Z", "subtype", "local_command", "content", "<command-name>/context</command-name>"),
		rec("c", "b", "user", "2026-01-01T10:05:00.000Z", "isMeta", true, "message", text("## Context Usage")),
		rec("d", "c", "user", "2026-01-01T12:00:00.000Z", "message", text("carry on")),
		rec("e", "d", "system", "2026-01-01T12:10:00.000Z", "subtype", "turn_duration"),
		rec("f", "e", "user", "2026-01-01T13:00:00.000Z", "isMeta", true, "message", text("Another Claude session sent a message")),
	})
	events := get(doc, "events").([]*obj)
	if got := str(get(events[2], "kind")); got != "system" {
		t.Fatalf("the local command's echo is kind %q, want system", got)
	}
	if got := num(get(events[0], "idleMs")); got != 2*60*60*1000 {
		t.Fatalf("idleMs = %v, want two hours — the echo does not end the wait", got)
	}
	if got := str(get(events[5], "kind")); got != "user" {
		t.Fatalf("a hand-back is kind %q, want user", got)
	}
	if got := num(get(events[4], "idleMs")); got != 50*60*1000 {
		t.Fatalf("idleMs = %v, want fifty minutes — a hand-back does end the wait", got)
	}
}

// Claude Code writes a `<synthetic>` reply itself when the API call fails, and
// flags it isApiErrorMessage. The shapes are those of real records: a login that
// expired mid-session, after a session that opened on "No response requested."
func TestClaudeAPIErrorReplyIsAnError(t *testing.T) {
	reply := func(uuid, model, text string, kv ...any) *obj {
		o := trajectory.NewObject("uuid", uuid, "sessionId", "s", "type", "assistant", "timestamp", "2026-01-01T10:00:00.000Z",
			"message", trajectory.NewObject("id", uuid, "model", model, "content", []any{trajectory.NewObject("type", "text", "text", text)}))
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
		return o
	}
	doc := NormalizeClaude([]*obj{
		reply("a", "<synthetic>", "No response requested."),
		reply("b", "claude-opus-5", "Working on it."),
		reply("c", "<synthetic>", "Login expired · Please run /login", "error", "authentication_failed", "isApiErrorMessage", true),
	})
	if got := str(get(object(get(doc, "meta")), "model")); got != "claude-opus-5" {
		t.Fatalf("meta.model = %q, want the first real model", got)
	}
	events := get(doc, "events").([]*obj)
	if truthy(get(events[0], "isError")) {
		t.Fatal("a synthetic reply that is not an API error is marked as one")
	}
	failed := events[2]
	if !truthy(get(failed, "isError")) || str(get(failed, "label")) != "authentication_failed" {
		t.Fatalf("API error reply: isError %v, label %q", get(failed, "isError"), str(get(failed, "label")))
	}
	if str(get(failed, "text")) != "Login expired · Please run /login" || !truthy(get(failed, "synthetic")) {
		t.Fatal("API error reply lost its text or its synthetic mark")
	}

	// A session of nothing but synthetic replies names no model at all.
	alone := NormalizeClaude([]*obj{reply("a", "<synthetic>", "No response requested.")})
	if model, ok := object(get(alone, "meta")).Get("model"); ok && !nullish(model) {
		t.Fatalf("meta.model = %v, want absent", model)
	}
}
