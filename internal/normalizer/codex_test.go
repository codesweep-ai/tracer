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

// TRC-015. `item_completed` repeats an item the adapter already reads, so it is
// tallied rather than drawn, but only for item types named as duplicates: a new
// one must still surface (R37). `compacted` is a real change and is drawn.
func TestNormalizeCodexItemCompletedIsSkippedByItemType(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"Reasoning\"}}}\n" +
			"{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"CommandExecution\"}}}\n" +
			"{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"Hologram\"}}}\n" +
			"{\"timestamp\":\"2026-09-14T20:36:16.130Z\",\"type\":\"compacted\",\"payload\":{\"message\":\"\"}}"))
	if err != nil {
		t.Fatal(err)
	}
	parse := object(get(doc, "parse"))
	if got := num(get(parse, "unrecognized")); got != 1 {
		t.Fatalf("parse.unrecognized = %v, want 1 (the unnamed item type)", got)
	}
	skipped := map[string]float64{}
	for _, s := range get(parse, "skippedByType").([]any) {
		skipped[str(get(object(s), "type"))] = num(get(object(s), "count"))
	}
	for _, k := range []string{"event_msg:item_completed:Reasoning", "event_msg:item_completed:CommandExecution"} {
		if skipped[k] != 1 {
			t.Fatalf("skippedByType[%s] = %v, want 1", k, skipped[k])
		}
	}
	var kinds []string
	for _, e := range get(doc, "events").([]*obj) {
		kinds = append(kinds, str(get(e, "rawType"))+"="+str(get(e, "text")))
	}
	want := []string{
		"event_msg:item_completed:Hologram=unrecognized Codex record/payload type: event_msg:item_completed:Hologram",
		"compacted=context compacted",
	}
	if strings.Join(kinds, "|") != strings.Join(want, "|") {
		t.Fatalf("events = %q, want %q", kinds, want)
	}
}

// Under on-request a call runs in the sandbox unasked, and only one asking for
// escalated permissions can reach a person (TRC-028).
func TestNormalizeCodexToolCallNamesWhoApprovesIt(t *testing.T) {
	call := func(id, args string) string {
		return "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"call_id\":\"" + id + "\",\"arguments\":" + args + "}}\n"
	}
	policy := func(p string) string {
		return "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt\",\"approval_policy\":\"" + p + "\"}}\n"
	}
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			policy("never") + call("a", "\"{\\\"cmd\\\":\\\"ls\\\"}\"") +
			policy("on-request") + call("b", "\"{\\\"cmd\\\":\\\"ls\\\"}\"") +
			call("c", "\"{\\\"cmd\\\":\\\"rm x\\\",\\\"sandbox_permissions\\\":\\\"require_escalated\\\"}\"") +
			policy("untrusted") + call("d", "\"{\\\"cmd\\\":\\\"ls\\\"}\"")))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range get(doc, "events").([]*obj) {
		if str(get(e, "kind")) == "tool_call" {
			got = append(got, str(get(e, "approval")))
		}
	}
	if want := "automatic,automatic,person,person"; strings.Join(got, ",") != want {
		t.Fatalf("approvals %v, want %s", got, want)
	}
}

// Codex 0.165 names a spawned child only in an `item_completed` notice whose
// item is a `SubAgentActivity`, keyed by the spawning call's id. The spawn
// call must learn its child from it, as it learned it from 0.146's
// `sub_agent_activity`, or no Codex child can point back at its spawn.
func TestNormalizeCodexSubAgentActivityItemJoinsTheSpawn(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:08.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"spawn_agent\",\"call_id\":\"call_1\",\"arguments\":\"{\\\"task_name\\\":\\\"state_checks\\\"}\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:08.571Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"SubAgentActivity\",\"id\":\"call_1\",\"kind\":\"started\",\"agent_thread_id\":\"t2\",\"agent_path\":\"/root/state_checks\"}}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:09.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"{\\\"task_name\\\":\\\"/root/state_checks\\\"}\"}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 2 {
		t.Fatalf("events = %d, want the spawn and the activity notice", len(events))
	}
	spawn := events[0]
	if !truthy(get(spawn, "subtask")) || str(get(spawn, "childSessionId")) != "t2" {
		t.Fatalf("the spawn does not name its child: %v", spawn)
	}
	if cmd := str(get(object(get(spawn, "tool")), "command")); cmd != "spawn /root/state_checks" {
		t.Fatalf("spawn command %q", cmd)
	}
	if text := str(get(events[1], "text")); text != "sub-agent /root/state_checks started (thread t2)" {
		t.Fatalf("activity notice %q", text)
	}
	if n := num(get(object(get(doc, "parse")), "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
}

// In multi-agent v1 the spawn's notice is a `CollabAgentToolCall` item whose
// receivers are the threads it started. Written from the 0.165 source: no v1
// capture backs it, so the shape here is the struct every collaboration tool
// shares, as the `wait` notices of a v2 capture show it.
func TestNormalizeCodexCollabSpawnNoticeNamesTheChild(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:08.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"spawn_agent\",\"call_id\":\"call_1\",\"arguments\":\"{\\\"task_name\\\":\\\"state_checks\\\"}\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:08.571Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"CollabAgentToolCall\",\"id\":\"call_1\",\"tool\":\"spawn_agent\",\"status\":\"completed\",\"sender_thread_id\":\"t1\",\"receiver_thread_ids\":[\"t2\"],\"receiver_agents\":[],\"agents_states\":{}}}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:09.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"CollabAgentToolCall\",\"id\":\"call_9\",\"tool\":\"wait\",\"status\":\"completed\",\"sender_thread_id\":\"t1\",\"receiver_thread_ids\":[],\"receiver_agents\":[],\"agents_states\":{}}}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 1 {
		t.Fatalf("events = %d, want the spawn alone: a collaboration notice repeats a call", len(events))
	}
	if str(get(events[0], "childSessionId")) != "t2" {
		t.Fatalf("the spawn does not name its child: %v", events[0])
	}
	parse := object(get(doc, "parse"))
	if n := num(get(parse, "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
	for _, s := range get(parse, "skippedByType").([]any) {
		if str(get(object(s), "type")) == "event_msg:item_completed:CollabAgentToolCall" && num(get(object(s), "count")) == 2 {
			return
		}
	}
	t.Fatal("the two notices are not tallied under their item type")
}

// Codex 0.165 writes a `token_usage_record` beside every `token_count`
// notice, carrying the same usage. The notice is the source the adapter
// reads, so the record is tallied, and reading both would count every
// response twice (TRC-060).
func TestNormalizeCodexTokenUsageRecordIsTalliedNotCounted(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:49:45.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n" +
			"{\"timestamp\":\"2026-11-07T05:49:45.463Z\",\"type\":\"token_usage_record\",\"payload\":{\"thread_id\":\"t1\",\"response_id\":\"r1\",\"usage\":{\"input_tokens\":100,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":9,\"reasoning_output_tokens\":2,\"total_tokens\":109}}}\n" +
			"{\"timestamp\":\"2026-11-07T05:49:45.685Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":9,\"reasoning_output_tokens\":2,\"total_tokens\":109}}}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 1 {
		t.Fatalf("events = %d, want the assistant message alone", len(events))
	}
	if got := num(get(object(get(events[0], "tokens")), "output")); got != 9 {
		t.Fatalf("output tokens = %v, want 9 from token_count", got)
	}
	parse := object(get(doc, "parse"))
	if n := num(get(parse, "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
	if n := num(get(object(get(doc, "totals")), "output")); n != 9 {
		t.Fatalf("totals.output = %v, want 9: the record must not be counted a second time", n)
	}
	for _, s := range get(parse, "skippedByType").([]any) {
		if str(get(object(s), "type")) == "token_usage_record" && num(get(object(s), "count")) == 1 {
			return
		}
	}
	t.Fatal("the record is not tallied under its type")
}

// A developer-role `additional_tools` record lists the schemas of the tools a
// turn may call. Nothing happens in it, so it is tallied like the other
// records that repeat what the adapter already reads (TRC-060).
func TestNormalizeCodexAdditionalToolsIsTalliedNotRendered(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:49:33.789Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"additional_tools\",\"id\":\"at_1\",\"role\":\"developer\",\"tools\":[{\"type\":\"custom\",\"name\":\"exec\",\"description\":\"run a command\"}]}}\n" +
			"{\"timestamp\":\"2026-11-07T05:49:34.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 1 || str(get(events[0], "text")) != "turn started" {
		t.Fatalf("events = %v, want the turn start alone", events)
	}
	parse := object(get(doc, "parse"))
	if n := num(get(parse, "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
	for _, s := range get(parse, "skippedByType").([]any) {
		if str(get(object(s), "type")) == "response_item:additional_tools" && num(get(object(s), "count")) == 1 {
			return
		}
	}
	t.Fatal("the record is not tallied under its type")
}

// R67. A turn that was interrupted ends in `turn_aborted` and never reaches
// `task_complete`. It still ended the turn, so the wait after it is idle
// (R68), and it ended in failure, so it is marked as an error with the reason
// as its label, as a failed task_complete is.
func TestNormalizeCodexAbortedTurnIsAnError(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:08.550Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\",\"turn_id\":\"turn_1\",\"reason\":\"interrupted\",\"started_at\":1794030573}}\n" +
			"{\"timestamp\":\"2026-11-07T05:50:18.550Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"carry on\"}]}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 3 {
		t.Fatalf("events = %d, want the start, the abort and the instruction", len(events))
	}
	turn := events[1]
	if got := str(get(turn, "kind")); got != "turn_end" {
		t.Fatalf("kind = %q, want turn_end", got)
	}
	if !truthy(get(turn, "isError")) {
		t.Fatal("the aborted turn is not marked as an error")
	}
	if got := str(get(turn, "text")); got != "turn aborted" {
		t.Fatalf("text = %q, want \"turn aborted\"", got)
	}
	if got := str(get(turn, "label")); got != "interrupted" {
		t.Fatalf("label = %q, want the reason", got)
	}
	if got := str(get(turn, "ts")); got != "2026-11-07T05:50:08.550Z" {
		t.Fatalf("ts = %q, want the record's timestamp", got)
	}
	if got := num(get(turn, "idleMs")); got != 10000 {
		t.Fatalf("idleMs = %v, want 10000: the abort ends the turn and starts the wait", got)
	}
	if !truthy(get(stripEvent(turn), "error")) {
		t.Fatal("the aborted turn does not reach the strip's error channel")
	}
	if n := num(get(object(get(doc, "parse")), "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
}

// Codex 0.148 and later write an `ImageView` notice for each image the model
// looked at. In every capture on hand the view is a `tools.view_image` call
// inside an exec script the adapter already draws, so the notice is tallied,
// not drawn a second time.
func TestNormalizeCodexImageViewNoticeIsTallied(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-09-25T15-50-10.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\",\"call_id\":\"call_1\",\"input\":\"const r=await tools.view_image({path:\\\"/work/results/story.png\\\"});\"}}\n" +
			"{\"timestamp\":\"2026-09-25T15-50-10.211Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"ImageView\",\"id\":\"exec-1\",\"path\":\"file:///work/results/story.png\"},\"started_at_ms\":1790351410210,\"completed_at_ms\":1790351410211}}\n" +
			"{\"timestamp\":\"2026-09-25T15-50-10.300Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"call_1\",\"output\":\"Script completed\"}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 1 || str(get(events[0], "kind")) != "tool_call" {
		t.Fatalf("events = %v, want the exec call alone", events)
	}
	parse := object(get(doc, "parse"))
	if n := num(get(parse, "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
	for _, s := range get(parse, "skippedByType").([]any) {
		if str(get(object(s), "type")) == "event_msg:item_completed:ImageView" && num(get(object(s), "count")) == 1 {
			return
		}
	}
	t.Fatal("the notice is not tallied under its item type")
}

// An `Extension` notice reports a built-in tool by its kind: `web.search`
// from an exec script's search call, `clock.sleep` from a `sleep` call. In
// every capture on hand the call that ran it is drawn already, so the notice
// is a named skip rather than a tool call of its own, tallied under its kind
// so a reader sees which built-ins ran.
func TestNormalizeCodexExtensionNoticeIsTalliedByKind(t *testing.T) {
	doc, err := NormalizeBytes([]byte(
		"{\"type\":\"session_meta\",\"payload\":{\"id\":\"t1\"}}\n" +
			"{\"timestamp\":\"2026-09-25T15-45-50.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\",\"call_id\":\"call_1\",\"input\":\"const r=await tools.web__run({search:[{q:\\\"site:vitest.dev mock timers\\\"}]});\"}}\n" +
			"{\"timestamp\":\"2026-09-25T15-45-55.092Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"Extension\",\"kind\":\"web.search\",\"id\":\"exec-1\",\"query\":\"site:vitest.dev mock timers\",\"action\":{\"type\":\"search\",\"query\":null,\"queries\":[\"site:vitest.dev mock timers\"]},\"results\":null},\"started_at_ms\":1790351150000,\"completed_at_ms\":1790351155092}}\n" +
			"{\"timestamp\":\"2026-09-25T15-45-56.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"call_1\",\"output\":\"Script completed\"}}\n" +
			"{\"timestamp\":\"2026-09-25T15-46-00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"Extension\",\"kind\":\"clock.sleep\",\"id\":\"exec-2\"}}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	events := get(doc, "events").([]*obj)
	if len(events) != 1 || str(get(events[0], "kind")) != "tool_call" {
		t.Fatalf("events = %v, want the exec call alone", events)
	}
	parse := object(get(doc, "parse"))
	if n := num(get(parse, "unrecognized")); n != 0 {
		t.Fatalf("unrecognized = %v", n)
	}
	skipped := map[string]float64{}
	for _, s := range get(parse, "skippedByType").([]any) {
		skipped[str(get(object(s), "type"))] = num(get(object(s), "count"))
	}
	for _, k := range []string{"event_msg:item_completed:Extension:web.search", "event_msg:item_completed:Extension:clock.sleep"} {
		if skipped[k] != 1 {
			t.Fatalf("skippedByType[%s] = %v, want 1", k, skipped[k])
		}
	}
}
