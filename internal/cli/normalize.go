package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/codesweep-ai/tracer/internal/normalizer"
)

// normalizeToTree writes the index/summary/chunks tree into out (SPEC.md §2).
func normalizeToTree(input, out, links string, stdout, stderr io.Writer) error {
	result, err := normalizer.NormalizeDirectory(input, out, links)
	for _, diagnostic := range result.Diagnostics {
		fmt.Fprintln(stderr, diagnostic)
	}
	// Report what was written: `export` reports its output, so `normalize` must
	// too — otherwise a user gets no confirmation, no path and no count. The
	// skipped count is appended only when non-zero, which is what makes a dropped
	// input file visible on the terminal rather than only in summary.json's
	// parse.skipped. RUN.txt pins this wording.
	if err == nil && stdout != nil {
		line := fmt.Sprintf("normalized %d trajectory(s) to %s", len(result.Documents), out)
		if result.Skipped > 0 {
			line += fmt.Sprintf("; skipped %d", result.Skipped)
		}
		fmt.Fprintln(stdout, line)
	}
	return err
}

func runNormalize(input string, o options, stdout, stderr io.Writer) error {
	if o.output != "" {
		// --out is the oracle interface: emit the shard tree.
		out, err := filepath.Abs(o.output)
		if err != nil {
			return err
		}
		return normalizeToTree(input, out, o.links, stdout, stderr)
	}
	// Bare normalize is the consumer interface: JSON Lines, one
	// normalized document per line, diagnostics on stderr.
	tmp, err := os.MkdirTemp("", "cs-tracer-normalize-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := normalizeToTree(input, tmp, o.links, nil, stderr); err != nil {
		return err
	}
	set, err := loadSet(tmp)
	if err != nil {
		return err
	}
	return set.writeJSONL(stdout)
}

// writeJSONL emits one normalized document per line, in the
// shape of the normalizer's toWholeDocument: schemaVersion, meta, totals,
// parse, links?, events — the summary fields minus the shard bookkeeping
// (chunkSize/chunkCount/strip), with events reassembled from the chunks.
// Link hints travel on the documents they belong to rather than on a root
// index: there is no index in JSONL, so every document carries the set's links.
func (set dataSet) writeJSONL(out io.Writer) error {
	for i := range set.Traces {
		t := &set.Traces[i]
		line, err := t.wholeDocument(set.Links)
		if err != nil {
			return err
		}
		if _, err := out.Write(line); err != nil {
			return err
		}
	}
	return nil
}

func (t *trajectory) wholeDocument(links json.RawMessage) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(t.Summary, &fields); err != nil {
		return nil, fmt.Errorf("summary for %s: %w", t.ID, err)
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	put := func(key string, raw json.RawMessage) {
		if !first {
			buf.WriteByte(',')
		}
		first = false
		k, _ := json.Marshal(key)
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(raw)
	}
	// Key order is part of the format, not an implementation detail — the whole
	// document must serialize in first-declaration order (SPEC.md §3.1).
	for _, key := range []string{"schemaVersion", "meta", "totals", "parse"} {
		raw, ok := fields[key]
		if !ok {
			return nil, fmt.Errorf("summary for %s lacks %q", t.ID, key)
		}
		put(key, raw)
	}
	if len(links) > 0 {
		// Links arrive as a slice of the pretty-printed root index; JSONL is
		// one document per line, so they must be compacted before riding on
		// the document.
		var compact bytes.Buffer
		if err := json.Compact(&compact, links); err != nil {
			return nil, fmt.Errorf("links for %s: %w", t.ID, err)
		}
		put("links", compact.Bytes())
	}
	events, err := t.allEvents()
	if err != nil {
		return nil, err
	}
	put("events", events)
	buf.WriteString("}\n")
	return buf.Bytes(), nil
}

// allEvents concatenates the raw events arrays of every chunk, preserving
// their bytes verbatim.
func (t *trajectory) allEvents() (json.RawMessage, error) {
	var buf bytes.Buffer
	buf.WriteByte('[')
	first := true
	for n, chunk := range t.Chunks {
		var body struct {
			Events json.RawMessage `json:"events"`
		}
		if err := json.Unmarshal(chunk, &body); err != nil {
			return nil, fmt.Errorf("chunk %d for %s: %w", n, t.ID, err)
		}
		inner := bytes.TrimSpace(body.Events)
		if len(inner) < 2 {
			return nil, fmt.Errorf("chunk %d for %s: no events array", n, t.ID)
		}
		inner = bytes.TrimSpace(inner[1 : len(inner)-1]) // strip the array brackets
		if len(inner) == 0 {
			continue
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		buf.Write(inner)
	}
	buf.WriteByte(']')
	return buf.Bytes(), nil
}
