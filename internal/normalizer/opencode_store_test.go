package normalizer

import (
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

func normalizeOpenCodeJSON(t *testing.T, doc string) *obj {
	t.Helper()
	v, err := trajectory.Decode([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	return NormalizeOpenCode(object(v))
}

func eventKinds(doc *obj) []string {
	var kinds []string
	for _, e := range get(doc, "events").([]*obj) {
		kinds = append(kinds, str(get(e, "kind")))
	}
	return kinds
}

// A generation-2 store file is read in full: the session row names the
// session, each assistant row's `content` gives its thinking, tool calls and
// text, its `finish` is the step's reason, and its tokens and cost land on the
// step's last event. An `idle` row yields no event and is counted.
func TestOpenCodeStoreGeneration2(t *testing.T) {
	doc := normalizeOpenCodeJSON(t, `{"store":{"generation":2,"version":"2.2.5"},
	"session":{"id":"ses_root","parent_id":null,"title":"d002","directory":"/srv/work","version":"2.2.5","cost":0.5,"model":null},
	"messages":[
	 {"id":"msg_1","session_id":"ses_root","type":"user","seq":1,"data":{"time":{"created":1000},"text":"read it","files":[]},"parts":[]},
	 {"id":"msg_2","session_id":"ses_root","type":"synthetic","seq":2,"data":{"time":{"created":1100},"text":"Instructions from: AGENTS.md"},"parts":[]},
	 {"id":"msg_3","session_id":"ses_root","type":"assistant","seq":3,"data":{"time":{"created":2000,"completed":5000},"agent":"build","model":{"id":"kimi-k3","providerID":"fireworks-ai"},"content":[
	   {"type":"reasoning","text":"think","time":{"created":2100,"completed":2200}},
	   {"type":"tool","id":"call_1","name":"read","state":{"status":"completed","input":{"path":"x"},"content":[{"type":"text","text":"line 1"},{"type":"text","text":"line 2"}],"metadata":{"truncated":false}},"time":{"created":2300,"ran":2400,"completed":2500}},
	   {"type":"tool","id":"call_2","name":"subagent","state":{"status":"completed","input":{"agent":"explore","description":"check claim 1","prompt":"go"},"content":[{"type":"text","text":"done"}],"metadata":{"sessionID":"ses_child"}},"time":{"created":2600,"ran":2600,"completed":4000}}
	  ],"finish":"tool-calls","rawFinish":"tool_calls","cost":0.2,"tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":7,"write":0}}},"parts":[]},
	 {"id":"msg_4","session_id":"ses_root","type":"assistant","seq":4,"data":{"time":{"created":6000,"completed":7000},"agent":"build","model":{"id":"kimi-k3","providerID":"fireworks-ai"},"content":[{"type":"text","text":"done"}],"finish":"stop","cost":0.3,"tokens":{"input":20,"output":6,"reasoning":0,"cache":{"read":0,"write":0}}},"parts":[]},
	 {"id":"msg_5","session_id":"ses_root","type":"idle","seq":5,"data":{"time":{"created":7100},"outcome":"succeeded"},"parts":[]}
	]}`)
	meta := object(get(doc, "meta"))
	for k, want := range map[string]string{"sessionId": "ses_root", "title": "d002", "cwd": "/srv/work", "cliVersion": "2.2.5", "model": "fireworks-ai/kimi-k3", "provider": "fireworks-ai"} {
		if got := str(get(meta, k)); got != want {
			t.Errorf("meta.%s = %q, want %q", k, got, want)
		}
	}
	if _, present := meta.Get("parentSessionId"); present {
		t.Error("a root carries no parentSessionId")
	}
	want := []string{"user", "system", "thinking", "tool_call", "tool_call", "meta", "assistant", "turn_end"}
	if got := eventKinds(doc); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("events %v, want %v", got, want)
	}
	events := get(doc, "events").([]*obj)
	if ts := str(get(events[0], "ts")); ts != "1970-01-01T00:00:01.000Z" {
		t.Errorf("user ts %q", ts)
	}
	if ts, start := str(get(events[2], "ts")), str(get(events[2], "startTs")); ts != "1970-01-01T00:00:02.200Z" || start != "1970-01-01T00:00:02.100Z" {
		t.Errorf("thinking stamped %q from %q; want its end and its start", ts, start)
	}
	read := events[3]
	tool := object(get(read, "tool"))
	if str(get(tool, "name")) != "read" || str(get(tool, "callId")) != "call_1" {
		t.Errorf("tool = %v", tool)
	}
	if ts := str(get(read, "ts")); ts != "1970-01-01T00:00:02.400Z" {
		t.Errorf("a tool call is stamped when it ran, got %q", ts)
	}
	result := object(get(read, "result"))
	if text := str(get(result, "text")); text != "line 1\nline 2" {
		t.Errorf("result text %q: the output's text pieces are joined", text)
	}
	if d := num(get(result, "durationMs")); d != 100 {
		t.Errorf("durationMs = %v, want completed minus ran", d)
	}
	if truthy(get(result, "isError")) {
		t.Error("a completed call is not an error")
	}
	spawn := events[4]
	if !truthy(get(spawn, "subtask")) || str(get(spawn, "childSessionId")) != "ses_child" {
		t.Errorf("subagent call is the spawn of ses_child: %v", spawn)
	}
	if cmd := str(get(object(get(spawn, "tool")), "command")); cmd != "subagent(explore): check claim 1" {
		t.Errorf("spawn command %q", cmd)
	}
	// The step's tokens and cost land on its last event, as a 1.18
	// step-finish part lands them, and the step's end is the message's.
	if tokens := object(get(spawn, "tokens")); num(get(tokens, "input")) != 10 || num(get(tokens, "cacheRead")) != 7 || num(get(spawn, "reportedCostUSD")) != 0.2 {
		t.Errorf("step tokens and cost did not land on the step's last event: %v", spawn)
	}
	if ts, text := str(get(events[5], "ts")), str(get(events[5], "text")); ts != "1970-01-01T00:00:05.000Z" || text != "step finish — tool-calls" {
		t.Errorf("step finish %q at %q", text, ts)
	}
	reply := events[6]
	if ts, start := str(get(reply, "ts")), str(get(reply, "startTs")); ts != "1970-01-01T00:00:07.000Z" || start != "1970-01-01T00:00:06.000Z" {
		t.Errorf("assistant text stamped %q from %q; want the message's completion and creation", ts, start)
	}
	if num(get(object(get(reply, "tokens")), "input")) != 20 || num(get(reply, "reportedCostUSD")) != 0.3 {
		t.Errorf("the reply's tokens and cost: %v", reply)
	}
	if ts := str(get(events[7], "ts")); ts != "1970-01-01T00:00:07.000Z" {
		t.Errorf("turn end at %q", ts)
	}
	parse := object(get(doc, "parse"))
	if got := str(get(parse, "cliVersionRange")); got != "2.2.x" {
		t.Errorf("cliVersionRange %q", got)
	}
	skipped := get(parse, "skippedByType").([]any)
	if len(skipped) != 1 || str(get(object(skipped[0]), "type")) != "message:idle" || num(get(object(skipped[0]), "count")) != 1 {
		t.Errorf("skippedByType = %v, want the one idle row", skipped)
	}
	if num(get(parse, "unrecognized")) != 0 {
		t.Errorf("unrecognized = %v", get(parse, "unrecognized"))
	}
}

// A child session names its parent from the row's parent_id.
func TestOpenCodeStoreChildNamesItsParent(t *testing.T) {
	doc := normalizeOpenCodeJSON(t, `{"store":{"generation":2,"version":"2.2.5"},"session":{"id":"ses_child","parent_id":"ses_root","version":"2.2.5"},"messages":[]}`)
	if got := str(get(object(get(doc, "meta")), "parentSessionId")); got != "ses_root" {
		t.Fatalf("parentSessionId = %q", got)
	}
}

// A message type the adapter does not know is rendered as meta and counted
// as unrecognized, never dropped.
func TestOpenCodeStoreUnknownMessageTypeIsReported(t *testing.T) {
	doc := normalizeOpenCodeJSON(t, `{"store":{"generation":2},"session":{"id":"ses_a"},"messages":[{"id":"m","session_id":"ses_a","type":"compaction","data":{"time":{"created":1}},"parts":[]}]}`)
	if got := eventKinds(doc); strings.Join(got, " ") != "meta" {
		t.Fatalf("events %v", got)
	}
	if num(get(object(get(doc, "parse")), "unrecognized")) != 1 {
		t.Fatalf("unrecognized = %v", get(object(get(doc, "parse")), "unrecognized"))
	}
}

// A generation-1 store file reads exactly as the CLI's own export of the same
// session: the message row's data is the export's message info, and the part
// rows' data are its parts.
func TestOpenCodeStoreGeneration1ReadsAsTheExport(t *testing.T) {
	const user = `{"role":"user","time":{"created":1000}}`
	const assistant = `{"role":"assistant","time":{"created":2000,"completed":3000},"modelID":"kimi-k3","providerID":"fireworks-ai","cost":0.1,"tokens":{"input":1,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}`
	parts := []string{
		`{"type":"step-start"}`,
		`{"type":"tool","tool":"read","callID":"c1","state":{"status":"completed","input":{},"output":"x","time":{"start":2100,"end":2200}}}`,
		`{"type":"text","text":"ok","time":{"start":2300,"end":2900}}`,
		`{"type":"step-finish","reason":"stop","cost":0.1,"tokens":{"input":1,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}`,
	}
	export := normalizeOpenCodeJSON(t, `{"info":{"id":"ses_a","version":"1.18.32","directory":"/srv/work","cost":0.1,"model":{"id":"kimi-k3","providerID":"fireworks-ai"}},"messages":[
	 {"info":`+strings.TrimSuffix(user, "}")+`,"id":"msg_1","sessionID":"ses_a"},"parts":[{"type":"text","text":"hi"}]},
	 {"info":`+strings.TrimSuffix(assistant, "}")+`,"id":"msg_2","sessionID":"ses_a"},"parts":[`+strings.Join(parts, ",")+`]}]}`)
	var rows []string
	for i, p := range parts {
		rows = append(rows, `{"id":"prt_`+string(rune('0'+i))+`","message_id":"msg_2","session_id":"ses_a","data":`+p+`}`)
	}
	store := normalizeOpenCodeJSON(t, `{"store":{"generation":1,"version":"1.18.32"},"session":{"id":"ses_a","parent_id":null,"version":"1.18.32","directory":"/srv/work","cost":0.1,"model":"{\"id\":\"kimi-k3\",\"providerID\":\"fireworks-ai\"}"},"messages":[
	 {"id":"msg_1","session_id":"ses_a","time_created":1000,"data":`+user+`,"parts":[{"id":"prt_u","message_id":"msg_1","session_id":"ses_a","data":{"type":"text","text":"hi"}}]},
	 {"id":"msg_2","session_id":"ses_a","time_created":2000,"data":`+assistant+`,"parts":[`+strings.Join(rows, ",")+`]}]}`)
	for _, k := range []string{"meta", "events", "totals", "parse"} {
		a, err := trajectory.Marshal(get(export, k), false)
		if err != nil {
			t.Fatal(err)
		}
		b, err := trajectory.Marshal(get(store, k), false)
		if err != nil {
			t.Fatal(err)
		}
		if string(a) != string(b) {
			t.Errorf("%s differs\nexport: %s\nstore:  %s", k, a, b)
		}
	}
	if got := eventKinds(store); strings.Join(got, " ") != "user tool_call assistant turn_end" {
		t.Fatalf("events %v", got)
	}
}
