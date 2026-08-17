package normalizer

import (
	"regexp"
	"slices"
	"strings"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

var execCommand = regexp.MustCompile(`["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"`)

// extractExec ports extractExecCommand: pull the cmd string out of a shell
// tool's JSON-ish input, unescaping through JSON when possible.
func extractExec(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	m := execCommand.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	if x, e := trajectory.Decode([]byte(`"` + m[1] + `"`)); e == nil {
		return str(x)
	}
	return m[1]
}

// The reference's isError heuristic: /(^|\n)(Error|error:|failed)/ on the
// first 200 UTF-16 code units of the output, unless it starts with
// "Script completed".
var codexErrorPattern = regexp.MustCompile(`(^|\n)(Error|error:|failed)`)

func codexOutputIsError(text string) bool {
	return codexErrorPattern.MatchString(utf16Slice(text, 200)) && !strings.HasPrefix(text, "Script completed")
}

func NormalizeCodex(records []*obj) *obj {
	meta := trajectory.NewObject("source", "codex", "sessionId", "unknown-session")
	var events []*obj
	calls := map[string]*obj{}
	counts := map[string]int{}
	var order []string
	skipped := skipTally{}
	unknown := func(k string, ts any) {
		if counts[k] == 0 {
			order = append(order, k)
		}
		counts[k]++
		events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "rawType", k, "text", "unrecognized Codex record/payload type: "+k))
	}
	attach := func(usage *obj) {
		if usage == nil {
			return
		}
		for _, v := range slices.Backward(events) {
			e := v
			k := str(get(e, "kind"))
			if (k == "assistant" || k == "tool_call" || k == "thinking") && get(e, "tokens") == nil {
				// source input_tokens is the full prompt (cache reads
				// AND writes are subsets). Normalize to disjoint buckets; raw
				// input_tokens stays recoverable as input+cacheRead+cacheWrite.
				read := num(get(usage, "cached_input_tokens"))
				write := num(get(usage, "cache_write_input_tokens"))
				e.Set("tokens", trajectory.NewObject(
					"input", integer(max(0, num(get(usage, "input_tokens"))-read-write)),
					"output", nullishOr(get(usage, "output_tokens"), 0),
					"cacheRead", nullishOr(get(usage, "cached_input_tokens"), 0),
					"cacheWrite", nullishOr(get(usage, "cache_write_input_tokens"), 0),
					"reasoning", nullishOr(get(usage, "reasoning_output_tokens"), 0),
				))
				return
			}
		}
	}
	for _, r := range records {
		ts := tsOrUndef(get(r, "timestamp"))
		payload := object(get(r, "payload"))
		if payload == nil {
			payload = trajectory.NewObject()
		}
		if truthy(get(r, "__parseError")) {
			unknown("parse-error", trajectory.Undefined)
			continue
		}
		typ := str(get(r, "type"))
		switch typ {
		case "session_meta":
			if str(get(meta, "sessionId")) == "unknown-session" {
				// meta.sessionId = payload.id ?? payload.session_id ?? meta.sessionId
				if x := firstNonNull(get(payload, "id"), get(payload, "session_id")); x != nil {
					meta.Set("sessionId", x)
				}
				meta.Set("cwd", keepOrUndef(payload, "cwd"))
				meta.Set("cliVersion", keepOrUndef(payload, "cli_version"))
				// the serving host, read (not assumed) from
				// session_meta; turn_context carries no provider key.
				if s, ok := get(payload, "model_provider").(string); ok && s != "" {
					meta.Set("provider", s)
				}
				source := object(get(payload, "source"))
				sub := object(get(source, "subagent"))
				spawn := object(get(sub, "thread_spawn"))
				if spawn != nil {
					meta.Set("parentSessionId", keepOrUndef(spawn, "parent_thread_id"))
					meta.Set("agentPath", keepOrUndef(spawn, "agent_path"))
					meta.Set("agentNickname", keepOrUndef(spawn, "agent_nickname"))
					meta.Set("agentDepth", keepOrUndef(spawn, "depth"))
				}
			} else {
				skipped.add("turn_context:no-spawn")
			}
		case "turn_context":
			setDefaultKey(meta, "model", payload, "model")
			events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "text", "turn context — model "+jsStringOr(get(payload, "model"), "unknown")))
		case "response_item":
			pt := str(get(payload, "type"))
			switch pt {
			case "message":
				kind := "system"
				if str(get(payload, "role")) == "assistant" {
					kind = "assistant"
				} else if str(get(payload, "role")) == "user" {
					kind = "user"
				}
				e := trajectory.NewObject("kind", kind, "ts", ts, "text", blockText(get(payload, "content")))
				if truthy(get(payload, "phase")) {
					e.Set("phase", get(payload, "phase"))
				}
				if kind == "system" {
					e.Set("label", keepOrUndef(payload, "role"))
				}
				events = append(events, e)
			case "reasoning":
				events = append(events, trajectory.NewObject("kind", "thinking", "ts", ts, "text", blockText(firstNonNull(get(payload, "summary"), get(payload, "content")))))
			case "custom_tool_call", "function_call":
				input := firstNonNull(get(payload, "input"), get(payload, "arguments"))
				if pt == "function_call" {
					if s, ok := input.(string); ok {
						if v, e := trajectory.Decode([]byte(s)); e == nil {
							input = v
						}
					}
				}
				cmd := extractExec(firstNonNull(get(payload, "input"), get(payload, "arguments")))
				tool := trajectory.NewObject("name", nullishOr(get(payload, "name"), "unknown"), "callId", keepOrUndef(payload, "call_id"), "input", nullishOr(input, trajectory.Undefined))
				if cmd != "" {
					tool.Set("command", cmd)
				}
				e := trajectory.NewObject("kind", "tool_call", "ts", ts, "tool", tool)
				if str(get(payload, "name")) == "spawn_agent" {
					e.Set("subtask", true)
					if in := object(input); in != nil && truthy(get(in, "task_name")) {
						tool.Set("command", "spawn "+jsString(get(in, "task_name")))
					}
				}
				if id := str(get(payload, "call_id")); id != "" {
					calls[id] = e
				}
				events = append(events, e)
			case "agent_message":
				var b strings.Builder
				for _, p := range array(get(payload, "content")) {
					x := object(p)
					text := str(get(x, "text"))
					if present(get(x, "encrypted_content")) || strings.HasPrefix(text, "gAAAAAB") {
						b.WriteString("[encrypted payload]")
					} else {
						b.WriteString(text)
					}
				}
				events = append(events, trajectory.NewObject("kind", "system", "ts", ts, "text", b.String(), "label", "msg "+tpl(payload, "author")+" → "+tpl(payload, "recipient")))
			case "custom_tool_call_output", "function_call_output":
				text := blockText(get(payload, "output"))
				call := calls[str(get(payload, "call_id"))]
				isErr := codexOutputIsError(text)
				if call != nil {
					call.Set("result", trajectory.NewObject("text", text, "ts", ts, "isError", isErr, "durationMs", millis(str(get(call, "ts")), str(ts))))
				} else {
					unknown("orphan-tool-result", ts)
				}
			default:
				unknown("response_item:"+fallback(pt, "missing"), ts)
			}
		case "event_msg":
			pt := str(get(payload, "type"))
			switch pt {
			case "token_count":
				info := object(get(payload, "info"))
				attach(object(get(info, "last_token_usage")))
			case "sub_agent_activity":
				call := calls[str(get(payload, "event_id"))]
				if call != nil && truthy(get(call, "subtask")) {
					call.Set("childSessionId", keepOrUndef(payload, "agent_thread_id"))
					if tool := object(get(call, "tool")); tool != nil {
						tool.Set("command", "spawn "+tpl(payload, "agent_path"))
					}
				}
				events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "text", "sub-agent "+tpl(payload, "agent_path")+" "+tpl(payload, "kind")+" (thread "+tpl(payload, "agent_thread_id")+")"))
			case "task_started":
				events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "text", "turn started"))
			case "task_complete":
				events = append(events, trajectory.NewObject("kind", "turn_end", "ts", ts, "durationMs", keepOrUndef(payload, "duration_ms"), "text", "turn complete"))
			case "user_message", "agent_message", "patch_apply_end", "thread_settings_applied":
				// Notifications duplicating content that arrives via response
				// items. Rendering them would double every turn.
				skipped.add("event_msg:" + pt)
			default:
				unknown("event_msg:"+fallback(pt, "missing"), ts)
			}
		case "world_state", "inter_agent_communication_metadata":
			skipped.add(typ)
		default:
			unknown(fallback(typ, "missing-type"), ts)
		}
	}
	return finalize(meta, events, warningReport("codex", "1.1.0", "0.146.x", skipped, counts, order), nil)
}
