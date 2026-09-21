package normalizer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

const ChunkSize = 1000

func compact(v any) ([]byte, error) {
	b, e := trajectory.Marshal(v, false)
	if e != nil {
		return nil, e
	}
	return append(b, '\n'), nil
}
func pretty(v any) ([]byte, error) {
	raw, e := trajectory.Marshal(v, false)
	if e != nil {
		return nil, e
	}
	var b bytes.Buffer
	if e = json.Indent(&b, raw, "", "  "); e != nil {
		return nil, e
	}
	b.WriteByte('\n')
	return b.Bytes(), nil
}

func stripEvent(e *obj) *obj {
	raw, _ := trajectory.Marshal(e, false)
	r := object(get(e, "result"))
	// A tool reports failure through its result; an event with no result reports
	// its own (R67), which is how a failed turn reaches the strip's error channel.
	out := trajectory.NewObject("i", get(e, "i"), "kind", get(e, "kind"), "error", truthy(get(e, "isError")) || (r != nil && truthy(get(r, "isError"))))
	if present(get(e, "ts")) {
		out.Set("ts", get(e, "ts"))
	}
	if truthy(get(e, "subtask")) {
		out.Set("subtask", true)
	}
	if present(get(e, "childSessionId")) {
		out.Set("childSessionId", get(e, "childSessionId"))
	}
	if str(get(e, "kind")) == "turn_end" {
		out.Set("turnEnd", true)
		// The idle row is drawn from the strip alone, so the interval travels
		// with it (R68). Computing it in the viewer would mean subtracting
		// timestamps across filtered-out neighbours.
		//
		// Tested for existence, not with present(): that helper stringifies, so
		// it reads every number as absent.
		if idle, ok := e.Get("idleMs"); ok {
			out.Set("idleMs", idle)
		}
	}
	// Bar height is drawn from the strip alone, for the same reason (R70).
	if work, ok := e.Get("workMs"); ok {
		out.Set("workMs", work)
	}
	if str(get(e, "kind")) == "thinking" && str(get(e, "text")) == "" {
		out.Set("redacted", true)
	}
	out.Set("size", len(raw))
	tool := object(get(e, "tool"))
	if present(get(tool, "name")) {
		out.Set("label", get(tool, "name"))
	} else if present(get(e, "label")) {
		out.Set("label", get(e, "label"))
	}
	return out
}

// ShardBytes returns the relative sharded files for one trajectory.
func ShardBytes(doc *obj) (map[string][]byte, error) {
	events := get(doc, "events").([]*obj)
	var strip []any
	for _, e := range events {
		strip = append(strip, stripEvent(e))
	}
	count := (len(events) + ChunkSize - 1) / ChunkSize
	summary := trajectory.NewObject("schemaVersion", 2, "meta", get(doc, "meta"), "totals", get(doc, "totals"), "parse", get(doc, "parse"), "chunkSize", ChunkSize, "chunkCount", count, "strip", strip)
	out := map[string][]byte{}
	b, e := compact(summary)
	if e != nil {
		return nil, e
	}
	out["summary.json"] = b
	for n := range count {
		end := min((n+1)*ChunkSize, len(events))
		chunk := trajectory.NewObject("chunk", n, "events", events[n*ChunkSize:end])
		b, e := compact(chunk)
		if e != nil {
			return nil, e
		}
		out[fmt.Sprintf("chunks/%03d.json", n)] = b
	}
	return out, nil
}

func WriteSharded(doc *obj, dir string) error {
	files, e := ShardBytes(doc)
	if e != nil {
		return e
	}
	for name, b := range files {
		p := filepath.Join(dir, name)
		if e = os.MkdirAll(filepath.Dir(p), 0o755); e != nil {
			return e
		}
		if e = os.WriteFile(p, b, 0o644); e != nil {
			return e
		}
	}
	return nil
}

func safeID(s string) string {
	var b []byte
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			b = append(b, c)
		} else {
			b = append(b, '-')
		}
	}
	if len(b) == 0 {
		return "trajectory"
	}
	return string(b)
}
