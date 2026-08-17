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
				// JS: if (typeof cost === "number") event.cost = cost.
				if isJSNumber(cost) {
					e.Set("cost", cost)
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
			switch typ := str(get(p, "type")); typ {
			case "text":
				kind := "system"
				switch role {
				case "assistant":
					kind = "assistant"
				case "user":
					kind = "user"
				}
				events = append(events, trajectory.NewObject("kind", kind, "ts", ts, "text", nullishOr(get(p, "text"), "")))
			case "reasoning":
				events = append(events, trajectory.NewObject("kind", "thinking", "ts", ts, "text", nullishOr(get(p, "text"), "")))
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
				events = append(events, trajectory.NewObject("kind", "turn_end", "ts", ts, "text", "step finish — "+jsStringOr(get(p, "reason"), "")))
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
	parse := warningReport("opencode", "1.0.0", "1.18.x", skipped, counts, order)
	if len(providers) > 1 {
		var p []string
		for x := range providers {
			p = append(p, x)
		}
		sort.Strings(p)
		w := get(parse, "warnings").([]any)
		parse.Set("warnings", append(w, trajectory.NewObject("message", fmt.Sprintf("messages disagree on providerID (%s); meta.provider left absent", joinComma(p)))))
	}
	// The reference passes info.cost through only when it is a number, then
	// marks costEstimated=false whenever totals.cost ended up a number — which
	// includes sessions whose event costs summed without any info.cost.
	var sessionCost any
	if c := get(info, "cost"); isJSNumber(c) {
		sessionCost = c
	}
	out := finalize(meta, events, parse, sessionCost)
	t := object(get(out, "totals"))
	if isJSNumber(get(t, "cost")) {
		t.Set("costEstimated", false)
	}
	return out
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
