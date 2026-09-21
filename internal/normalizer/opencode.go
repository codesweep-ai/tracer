package normalizer

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// iso ports `(value) => typeof value === "number" && Number.isFinite(value)
// ? new Date(value).toISOString() : undefined` — including epoch 0, which is
// a valid instant, not an absence.
func iso(v any) any {
	n, err := parseJSONNumber(v)
	if err != nil {
		return trajectory.Undefined
	}
	// JS Date clips to integer milliseconds (TimeClip uses
	// ToIntegerOrInfinity).
	return time.UnixMilli(int64(n)).UTC().Format("2006-01-02T15:04:05.000Z")
}

// markStepStart records when the model began a step (TRC-023), where the part
// carries both ends: the event is stamped with the end, and the start is what
// separates the model's generation from the wait before it.
func markStepStart(e *obj, start, end any) {
	if from, to := iso(start), iso(end); from != trajectory.Undefined && to != trajectory.Undefined {
		e.Set("startTs", from)
	}
}

func NormalizeOpenCode(doc *obj) *obj {
	info := object(get(doc, "info"))
	meta := trajectory.NewObject("source", "opencode", "sessionId", nullishOr(get(info, "id"), "unknown-session"))
	if truthy(get(info, "title")) {
		meta.Set("title", get(info, "title"))
	}
	if truthy(get(info, "parentID")) {
		meta.Set("parentSessionId", get(info, "parentID"))
	}
	path := object(get(info, "path"))
	meta.Set("cwd", nullishOr(firstNonNull(get(info, "directory"), get(path, "cwd")), trajectory.Undefined))
	meta.Set("cliVersion", keepOrUndef(info, "version"))
	if model := object(get(info, "model")); model != nil {
		meta.Set("model", joinParts(truthyString(get(model, "providerID")), truthyString(firstNonNull(get(model, "id"), get(model, "modelID")))))
	}
	var events []*obj
	counts := map[string]int{}
	var order []string
	skipped := skipTally{}
	providers := map[string]bool{}
	unknown := func(k string, ts any) {
		if counts[k] == 0 {
			order = append(order, k)
		}
		counts[k]++
		events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "rawType", k, "text", "unrecognized opencode part: "+k))
	}
	attach := func(tokens *obj, cost any) {
		for _, e := range slices.Backward(events) {
			k := str(get(e, "kind"))
			if (k == "assistant" || k == "tool_call" || k == "thinking") && get(e, "tokens") == nil {
				cache := object(get(tokens, "cache"))
				e.Set("tokens", trajectory.NewObject(
					"input", nullishOr(get(tokens, "input"), 0),
					"output", nullishOr(get(tokens, "output"), 0),
					"reasoning", nullishOr(get(tokens, "reasoning"), 0),
					"cacheRead", nullishOr(get(cache, "read"), 0),
					"cacheWrite", nullishOr(get(cache, "write"), 0),
				))
				// The cost OpenCode stated for this step (§9).
				if isJSNumber(cost) {
					e.Set("reportedCostUSD", cost)
				}
				return
			}
		}
	}
	for _, mv := range array(get(doc, "messages")) {
		message := object(mv)
		mi := object(get(message, "info"))
		role := str(get(mi, "role"))
		step := false
		if p := str(get(mi, "providerID")); p != "" {
			providers[p] = true
		}
		if role == "assistant" {
			// if (role === "assistant" && !meta.model && mi.modelID) — a falsy
			// (including empty-string) model is replaced.
			if !truthy(get(meta, "model")) && truthy(get(mi, "modelID")) {
				meta.Set("model", joinParts(truthyString(get(mi, "providerID")), truthyString(get(mi, "modelID"))))
			}
		}
		for _, pv := range array(get(message, "parts")) {
			p := object(pv)
			tm := object(get(p, "time"))
			mit := object(get(mi, "time"))
			ts := firstISO(get(tm, "start"), get(tm, "created"), get(mit, "created"))
			// The model's output is stamped when it finished, as Claude Code and
			// codex stamp a finished block: R70 reads a timestamp as the end of the
			// step. Stamped at its start, a step was charged the wait before it and
			// its own generation landed on the event after it (TRC-022).
			finished := firstISO(get(tm, "end"), ts)
			switch typ := str(get(p, "type")); typ {
			case "text":
				kind := "system"
				at := ts
				switch role {
				case "assistant":
					kind = "assistant"
					at = finished
				case "user":
					kind = "user"
				}
				e := trajectory.NewObject("kind", kind, "ts", at, "text", nullishOr(get(p, "text"), ""))
				if kind == "assistant" {
					markStepStart(e, get(tm, "start"), get(tm, "end"))
				}
				events = append(events, e)
			case "reasoning":
				e := trajectory.NewObject("kind", "thinking", "ts", finished, "text", nullishOr(get(p, "text"), ""))
				markStepStart(e, get(tm, "start"), get(tm, "end"))
				events = append(events, e)
			case "tool":
				state := object(get(p, "state"))
				st := object(get(state, "time"))
				tool := trajectory.NewObject("name", nullishOr(get(p, "tool"), "unknown"), "callId", keepOrUndef(p, "callID"), "input", keepOrUndef(state, "input"))
				if truthy(get(state, "title")) {
					tool.Set("command", get(state, "title"))
				}
				e := trajectory.NewObject("kind", "tool_call", "ts", firstISO(get(st, "start"), ts), "tool", tool)
				if str(get(p, "tool")) == "task" {
					e.Set("subtask", true)
					md := object(get(state, "metadata"))
					if truthy(get(md, "sessionId")) {
						e.Set("childSessionId", get(md, "sessionId"))
					}
					in := object(get(state, "input"))
					tool.Set("command", fmt.Sprintf("task(%s): %s", jsStringOr(get(in, "subagent_type"), "agent"), jsStringOr(get(in, "description"), "")))
				}
				status := str(get(state, "status"))
				if status == "completed" || status == "error" {
					text := get(state, "output")
					if status == "error" {
						text = get(state, "error")
					}
					e.Set("result", trajectory.NewObject(
						"text", jsString(nullishOr(text, "")),
						"isError", status == "error",
						"ts", iso(get(st, "end")),
						"durationMs", duration(get(st, "start"), get(st, "end")),
					))
				}
				events = append(events, e)
			case "subtask":
				input := trajectory.NewObject("prompt", keepOrUndef(p, "prompt"), "description", keepOrUndef(p, "description"), "agent", keepOrUndef(p, "agent"))
				events = append(events, trajectory.NewObject("kind", "tool_call", "ts", ts, "tool", trajectory.NewObject("name", "subtask("+jsStringOr(get(p, "agent"), "agent")+")", "input", input), "subtask", true))
			case "step-finish":
				attach(object(get(p, "tokens")), get(p, "cost"))
				step = true
				// A step finishes after every batch of tool calls, and the agent
				// carries straight on. Only `stop` ends the turn and leaves it
				// waiting (R68), so only `stop` is a turn end; the rest are
				// bookkeeping and read as meta with their reason intact. Drawn as
				// turn ends they were 31% of every strip against three real
				// endings per trajectory, and no consumer could tell which was
				// which without reading the text (R65).
				reason := jsStringOr(get(p, "reason"), "")
				kind := "meta"
				if reason == "stop" {
					kind = "turn_end"
				}
				// The part carries no time, and the message's creation time is
				// when the step STARTED. Stamped with it, the idle a stop begins
				// overlapped the step's own reply (TRC-019). The message's
				// completion is when the step finished.
				finished := firstISO(get(mit, "completed"), ts)
				events = append(events, trajectory.NewObject("kind", kind, "ts", finished, "text", "step finish — "+reason))
			case "compaction":
				events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "text", "compaction ("+jsStringOr(get(p, "reason"), "?")+")"))
			case "step-start":
				skipped.add("part:step-start")
			default:
				unknown(fallback(typ, "missing"), ts)
			}
		}
		if role == "assistant" && get(mi, "tokens") != nil && !step {
			attach(object(get(mi, "tokens")), get(mi, "cost"))
		}
	}
	// providerID is per-message. One agreed value is the serving
	// host; disagreement means we do not know which one priced the session.
	if len(providers) == 1 {
		for p := range providers {
			meta.Set("provider", p)
		}
	}
	// 0 unreadable: an opencode transcript is one JSON document extracted from
	// the CLI's SQL store, so there are no per-line records to lose. A damaged
	// extract fails whole, and is reported at detection (R58) — the fix there
	// is to run the extraction again, not to salvage part of a file.
	parse := warningReport("opencode", "1.0.0", "1.18.x", skipped, counts, order, 0)
	if len(providers) > 1 {
		var p []string
		for x := range providers {
			p = append(p, x)
		}
		sort.Strings(p)
		w := get(parse, "warnings").([]any)
		parse.Set("warnings", append(w, trajectory.NewObject("message", fmt.Sprintf("messages disagree on providerID (%s); meta.provider left absent", joinComma(p)))))
	}
	// The session's own figure covers this session alone: a parent's equals its
	// own steps, and each sub-agent session states its own (R72).
	var reported []any
	if c := get(info, "cost"); isJSNumber(c) {
		reported = append(reported, reportedCost(c, "trajectory"))
	}
	return finalize(meta, events, parse, reported)
}

// firstISO is `iso(a) ?? iso(b) ?? ...` over candidate time values: the first
// value that converts to a timestamp wins.
func firstISO(v ...any) any {
	for _, x := range v {
		if s, ok := x.(string); ok && s != "" {
			return s
		}
		if x != nil {
			if y := iso(x); y != trajectory.Undefined {
				return y
			}
		}
	}
	return trajectory.Undefined
}

// duration is `Number.isFinite(end) && Number.isFinite(start) ? end - start :
// undefined` — a float difference, printed as an integer when whole.
func duration(a, b any) any {
	x, ea := parseJSONNumber(a)
	y, eb := parseJSONNumber(b)
	if ea != nil || eb != nil {
		return trajectory.Undefined
	}
	return integer(y - x)
}

// truthyString keeps only truthy strings, mirroring [a, b].filter(Boolean)
// before a join.
func truthyString(v any) string {
	if !truthy(v) {
		return ""
	}
	return str(v)
}

func joinParts(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	return a + "/" + b
}
func joinComma(a []string) string {
	r := ""
	var rSb232 strings.Builder
	for i, x := range a {
		if i > 0 {
			rSb232.WriteString(", ")
		}
		rSb232.WriteString(x)
	}
	r += rSb232.String()
	return r
}
