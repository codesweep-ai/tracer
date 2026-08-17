package normalizer

import (
	"fmt"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// NormalizeClaude is the Claude 2.1 adapter; it returns an insertion-ordered
// document. Two rules from SPEC.md §3.1 drive the shape of this code:
//
//   - A key declared absent still occupies its slot, even though it never
//     serializes — so every field is Set here, with Undefined for "absent", in
//     declaration order.
//   - Assigning to an already-declared key keeps its original slot — so later
//     attachments (result, childSessionId, i) Set on the same object.
func NormalizeClaude(records []*obj) *obj {
	meta := trajectory.NewObject("source", "claude-code")
	var events []*obj
	calls := map[string]*obj{}
	seen := map[string]bool{}
	warnings := map[string]int{}
	var warningOrder []string
	skipped := skipTally{}
	unknown := func(kind string, ts, lane any) {
		if warnings[kind] == 0 {
			warningOrder = append(warningOrder, kind)
		}
		warnings[kind]++
		events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "lane", lane, "rawType", kind, "text", "unrecognized Claude record/content type: "+kind))
	}
	for _, r := range records {
		if truthy(get(r, "__parseError")) {
			unknown("parse-error", trajectory.Undefined, trajectory.Undefined)
			continue
		}
		// Records with no `uuid` are not events — they carry session state and
		// bookkeeping. They must still be CLASSIFIED, not silently dropped.
		//
		// This adapter used to drop every one of them except `ai-title`, which
		// meant a session's own name vanished (134 `custom-title` records ->
		// meta.title null) and any record type a future CLI release adds would
		// disappear with no trace. The codex and opencode adapters already do
		// this correctly: they name what they ignore and route the rest to
		// unknown(), so a new type surfaces as a visible meta event plus a
		// warning. This brings claude in line with them.
		if !present(get(r, "uuid")) {
			t := str(get(r, "type"))
			switch t {
			case "ai-title":
				if present(get(r, "aiTitle")) {
					meta.Set("title", get(r, "aiTitle"))
				}
			case "custom-title":
				// The user's chosen name. ai-title is generated, so it does not
				// overwrite a title already set here.
				if present(get(r, "customTitle")) && !present(get(meta, "title")) {
					meta.Set("title", get(r, "customTitle"))
				}
			case "agent-name":
				setDefaultKey(meta, "agentNickname", r, "agentName")
			case "mode":
				setDefaultKey(meta, "mode", r, "mode")
			case "permission-mode":
				setDefaultKey(meta, "permissionMode", r, "permissionMode")
			case "bridge-session", "last-prompt", "queue-operation",
				"file-history-snapshot", "file-history-delta":
				// Internal bookkeeping and transient state: no user-facing value.
				// Named rather than defaulted, so the omission is a decision.
			case "":
				// No `type` at all. This is not an unclassified record type — it
				// is not a record: a non-object JSON line reads as all-undefined,
				// exactly like JS property access on a primitive, and genuinely
				// broken lines already arrive as __parseError above.
			default:
				// LOUD by default. A record type nobody has classified becomes a
				// visible event and a warning rather than vanishing.
				unknown("session-record:"+t, trajectory.Undefined, trajectory.Undefined)
				continue
			}
			// Every branch above except `default` produced no event, so it is
			// tallied by type — including the harvested ones, which contributed
			// to `meta` rather than to the timeline.
			skipped.add(t)
			continue
		}
		// meta.sessionId ??= record.sessionId ?? record.session_id, etc. — ??=
		// triggers on null too, and assigning an absent value still creates the
		// slot (with undefined) at this point in the record stream.
		setDefaultCoalesce(meta, "sessionId", r, "sessionId", "session_id")
		setDefaultKey(meta, "agentId", r, "agentId")
		setDefaultKey(meta, "cwd", r, "cwd")
		setDefaultKey(meta, "cliVersion", r, "version")
		// const ts = typeof record.timestamp === "string" ? ... : undefined
		ts := tsOrUndef(get(r, "timestamp"))
		var lane any = trajectory.Undefined
		if truthy(get(r, "isSidechain")) {
			lane = "sidechain"
		}
		typ := str(get(r, "type"))
		// One arm tests typ AND a subtype, so this cannot be a tagged switch,
		// and `switch { case }` over arms this long reads no better than the
		// chain does.
		//nolint:gocritic // ifElseChain: the arms are not all on typ alone
		if typ == "user" {
			m := object(get(r, "message"))
			content := get(m, "content")
			blocks := array(content)
			hasResult := false
			for _, x := range blocks {
				if str(get(object(x), "type")) == "tool_result" {
					hasResult = true
				}
			}
			if blocks != nil && hasResult {
				for _, x := range blocks {
					b := object(x)
					if str(get(b, "type")) != "tool_result" {
						unknown("user-content:"+fallback(str(get(b, "type")), "unknown"), ts, lane)
						continue
					}
					call := calls[str(get(b, "tool_use_id"))]
					if call == nil {
						unknown("orphan-tool-result", ts, lane)
						continue
					}
					call.Set("result", trajectory.NewObject(
						"text", blockTextClaude(get(b, "content")),
						"isError", truthy(get(b, "is_error")),
						"ts", ts,
						"durationMs", millis(str(get(call, "ts")), str(ts)),
					))
					if truthy(get(call, "subtask")) {
						tur := object(get(r, "toolUseResult"))
						if present(get(tur, "agentId")) {
							call.Set("childSessionId", jsString(get(tur, "agentId")))
						}
					}
				}
			} else {
				events = append(events, trajectory.NewObject("kind", "user", "ts", ts, "lane", lane, "text", blockTextClaude(content)))
			}
		} else if typ == "assistant" {
			m := object(get(r, "message"))
			setDefaultKey(meta, "model", m, "model")
			var token *obj
			usage := object(get(m, "usage"))
			id := str(get(m, "id"))
			if usage != nil && id != "" && !seen[id] {
				seen[id] = true
				// Claude input_tokens excludes cache tokens; preserve each
				// bucket independently.
				token = trajectory.NewObject(
					"input", nullishOr(get(usage, "input_tokens"), 0),
					"output", nullishOr(get(usage, "output_tokens"), 0),
					"cacheRead", nullishOr(get(usage, "cache_read_input_tokens"), 0),
					"cacheWrite", nullishOr(get(usage, "cache_creation_input_tokens"), 0),
				)
				// TTL split, only when the record actually carries
				// cache_creation.
				if c := object(get(usage, "cache_creation")); c != nil {
					token.Set("cacheWrite5m", nullishOr(get(c, "ephemeral_5m_input_tokens"), 0))
					token.Set("cacheWrite1h", nullishOr(get(c, "ephemeral_1h_input_tokens"), 0))
				}
				// serving mode lives inside usage; 'not_available' is
				// the source saying it does not know — captured as absence.
				if s, ok := get(usage, "speed").(string); ok && s != "" {
					setDefaultValue(meta, "speed", s)
				}
				if geo, ok := get(usage, "inference_geo").(string); ok && geo != "" && geo != "not_available" {
					setDefaultValue(meta, "inferenceGeo", geo)
				}
			}
			content := array(get(m, "content"))
			if len(content) == 0 {
				unknown("assistant-content:missing", ts, lane)
			}
			for _, x := range content {
				b := object(x)
				// const base = { ts, lane, ...(token ? { tokens: token } : {}) }
				base := trajectory.NewObject("ts", ts, "lane", lane)
				if token != nil {
					base.Set("tokens", token)
					token = nil
				}
				bt := str(get(b, "type"))
				switch bt {
				case "thinking":
					copyEvent(base, "kind", "thinking", "text", fallback(str(get(b, "thinking")), ""))
					events = append(events, base)
				case "text":
					copyEvent(base, "kind", "assistant", "text", fallback(str(get(b, "text")), ""))
					events = append(events, base)
				case "tool_use":
					tool := trajectory.NewObject(
						"name", jsStringOr(get(b, "name"), "unknown"),
						"callId", keepOrUndef(b, "id"),
						"input", keepOrUndef(b, "input"),
						"command", trajectory.Undefined,
					)
					copyEvent(base, "kind", "tool_call", "tool", tool)
					if str(get(b, "name")) == "Task" || str(get(b, "name")) == "Agent" {
						base.Set("subtask", true)
						in := object(get(b, "input"))
						if truthy(get(in, "description")) {
							tool.Set("command", fmt.Sprintf("spawn(%s): %s", jsStringOr(get(in, "subagent_type"), "agent"), jsString(get(in, "description"))))
						}
					}
					if id := str(get(b, "id")); id != "" {
						calls[id] = base
					}
					events = append(events, base)
				default:
					unknown("assistant-content:"+fallback(bt, "unknown"), ts, lane)
				}
			}
		} else if typ == "system" && str(get(r, "subtype")) == "turn_duration" {
			text := any(trajectory.Undefined)
			if mc := get(r, "messageCount"); mc != nil {
				text = fmt.Sprintf("turn: %s messages", jsString(mc))
			}
			events = append(events, trajectory.NewObject("kind", "turn_end", "ts", ts, "lane", lane, "durationMs", keepOrUndef(r, "durationMs"), "text", text))
		} else if typ == "system" {
			events = append(events, trajectory.NewObject("kind", "system", "ts", ts, "lane", lane, "rawType", fallback(str(get(r, "subtype")), "system"), "text", blockTextClaude(firstNonNull(get(r, "message"), get(r, "content"), get(r, "subtype"), "system"))))
		} else if typ == "attachment" {
			a := object(get(r, "attachment"))
			events = append(events, trajectory.NewObject("kind", "meta", "ts", ts, "lane", lane, "text", "context attachment: "+fallback(str(get(a, "type")), "unknown")))
		} else {
			unknown(fallback(typ, "missing-type"), ts, lane)
		}
	}
	if _, exists := meta.Get("sessionId"); !exists {
		meta.Set("sessionId", fallback(str(get(meta, "agentId")), "unknown-session"))
	}
	if present(get(meta, "agentId")) {
		root := get(meta, "sessionId")
		meta.Set("parentSessionId", root)
		meta.Set("sessionId", get(meta, "agentId"))
	}
	for i, e := range events {
		e.Set("i", i)
	}
	var firstTS, lastTS string
	for _, e := range events {
		if ts := str(get(e, "ts")); ts != "" {
			if firstTS == "" {
				firstTS = ts
			}
			lastTS = ts
		}
	}
	meta.Set("startedAt", undef(firstTS))
	meta.Set("endedAt", undef(lastTS))
	meta.Set("durationMs", millis(firstTS, lastTS))

	// Warnings are ordered: unrecognized-type warnings first (in first-seen
	// order), then the malformed-scalar count, then the TTL-split notice. The
	// sequence is part of the output, not incidental.
	ws := []any{}
	for _, k := range warningOrder {
		ws = append(ws, trajectory.NewObject("message", fmt.Sprintf("unrecognized type '%s' rendered as meta", k), "rawType", k, "count", warnings[k]))
	}
	if malformed := sanitizeTokenValues(events); malformed > 0 {
		ws = append(ws, malformedTokenWarning(malformed))
	}
	tot, partialSplit := claudeTotals(events)
	if partialSplit {
		ws = append(ws, trajectory.NewObject("message", "cache-write TTL split is incomplete: some usage records carry cache_creation and others do not, so totals.cacheWrite5m/cacheWrite1h are omitted rather than published as a partial sum"))
	}
	parse := trajectory.NewObject("adapter", "claude-code", "adapterVersion", "1.0.0", "cliVersionRange", "2.1.x", "skippedByType", skipped.list(), "unrecognized", sumWarnings(warnings), "warnings", ws)
	return trajectory.NewObject("schemaVersion", 2, "meta", meta, "totals", tot, "events", events, "parse", parse)
}

// claudeTotals is the claude adapter's own totals(): unlike the shared finalize
// it tracks the cacheWrite 5m/1h TTL split, publishing the split only when every
// cache-write event carried one. A partial split would silently sum to less than
// cacheWrite, so neither key is published and the caller warns instead.
func claudeTotals(events []*obj) (totals *obj, partialSplitWarning bool) {
	tot := trajectory.NewObject("events", len(events), "toolCalls", 0, "toolErrors", 0, "input", 0, "output", 0, "cacheRead", 0, "cacheWrite", 0, "reasoning", 0)
	var write5m, write1h float64
	splitSeen := false
	partial := false
	for _, e := range events {
		if str(get(e, "kind")) == "tool_call" {
			tot.Set("toolCalls", int(num(get(tot, "toolCalls")))+1)
		}
		if r := object(get(e, "result")); r != nil && truthy(get(r, "isError")) {
			tot.Set("toolErrors", int(num(get(tot, "toolErrors")))+1)
		}
		tok := object(get(e, "tokens"))
		if tok == nil {
			continue
		}
		for _, f := range []string{"input", "output", "cacheRead", "cacheWrite", "reasoning"} {
			tot.Set(f, addNumbers(get(tot, f), get(tok, f)))
		}
		_, has5m := tok.Get("cacheWrite5m")
		_, has1h := tok.Get("cacheWrite1h")
		if has5m || has1h {
			splitSeen = true
			write5m += num(get(tok, "cacheWrite5m"))
			write1h += num(get(tok, "cacheWrite1h"))
		} else if num(get(tok, "cacheWrite")) > 0 {
			partial = true
		}
	}
	complete := splitSeen && !partial
	if complete {
		tot.Set("cacheWrite5m", integer(write5m))
		tot.Set("cacheWrite1h", integer(write1h))
	}
	return tot, partial && splitSeen
}

// nullish reports JS nullishness: absent (nil), JSON null (also nil after
// decoding), or an Undefined slot left by an earlier ??=.
func nullish(v any) bool {
	return v == nil || v == trajectory.Undefined
}

// setDefaultKey is `meta[key] ??= record[recordKey]`: assigns when meta's
// current value is nullish (absent, null, or undefined); an absent record
// value still creates the slot as Undefined, exactly where the reference
// would.
func setDefaultKey(meta *obj, key string, record *obj, recordKey string) {
	if cur, ok := meta.Get(key); ok && !nullish(cur) {
		return
	}
	meta.Set(key, keepOrUndef(record, recordKey))
}

// setDefaultCoalesce is `meta[key] ??= record[a] ?? record[b]`.
func setDefaultCoalesce(meta *obj, key string, record *obj, a, b string) {
	if cur, ok := meta.Get(key); ok && !nullish(cur) {
		return
	}
	if v, ok := record.Get(a); ok && v != nil {
		meta.Set(key, v)
		return
	}
	meta.Set(key, keepOrUndef(record, b))
}

// setDefaultValue is `meta[key] ??= value` for a concrete (non-nullish) value.
func setDefaultValue(meta *obj, key string, value any) {
	if cur, ok := meta.Get(key); ok && !nullish(cur) {
		return
	}
	meta.Set(key, value)
}

// keepOrUndef mirrors object-literal passthrough: an absent key is an
// Undefined slot; a JSON null stays null (JS emits null); values pass through.
func keepOrUndef(o *obj, key string) any {
	v, ok := o.Get(key)
	if !ok {
		return trajectory.Undefined
	}
	return v
}

// jsStringOr is String(v ?? fallback): nullish becomes the fallback, anything
// else is coerced with JS String() semantics.
func jsStringOr(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	return jsString(v)
}

// nullishOr is `v ?? fallback`: the raw value passes through when present
// (even a hostile non-number, which sanitizeTokenValues excludes later) and only
// nullish falls back — no coercion.
func nullishOr(v any, fallback any) any {
	if v == nil {
		return fallback
	}
	return v
}

func fallback(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
func copyEvent(o *obj, kv ...any) {
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
}
func sumWarnings(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}
