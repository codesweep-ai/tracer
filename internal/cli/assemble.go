package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// trajectory carries one trace's raw shard bytes from the normalized tree.
// The bytes are preserved verbatim — never re-encoded — so that data blocks
// un-escape to exactly the oracle's files (the export-block gate: the root
// index.json is pretty-printed while summaries and chunks are compact, and
// hazard-text exercises raw U+2028/U+2029 that a Go re-encode would escape).
type trajectory struct {
	ID      string
	SafeID  string // tree directory name; also the --split trace page basename
	Title   string
	Summary []byte   // raw summary.json bytes
	Chunks  [][]byte // raw chunks/NNN.json bytes, in order
	Events  int
}

// dataSet is the in-memory form of a normalized tree.
type dataSet struct {
	Index  []byte          // raw index.json bytes
	Traces []trajectory    // in index order
	Links  json.RawMessage // the root index's links array, nil when absent
}

// loadSet reads a normalized tree (index.json + <path>/summary.json +
// <path>/chunks/NNN.json). A tree with no index.json — produced when every
// input file was skipped — loads as an empty set.
func loadSet(root string) (dataSet, error) {
	indexBytes, err := os.ReadFile(filepath.Join(root, "index.json"))
	if errors := os.IsNotExist(err); errors {
		return dataSet{Index: []byte("{\"schemaVersion\":1,\"trajectories\":[]}\n")}, nil
	}
	if err != nil {
		return dataSet{}, err
	}
	var index struct {
		Trajectories []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"trajectories"`
		Links json.RawMessage `json:"links"`
	}
	if err := json.Unmarshal(indexBytes, &index); err != nil {
		return dataSet{}, fmt.Errorf("%s: %w", filepath.Join(root, "index.json"), err)
	}
	set := dataSet{Index: indexBytes, Links: index.Links}
	seen := map[string]string{} // safeId -> first session id that claimed it
	for _, entry := range index.Trajectories {
		// safeId maps every character outside [A-Za-z0-9._-] to '-', so two
		// distinct session ids can collapse to one path. The
		// tree on disk has already collided, so there is nothing to
		// disambiguate here — fail loudly instead of silently shipping one
		// trace under the other's name.
		if first, dup := seen[entry.Path]; dup {
			return dataSet{}, fmt.Errorf("safeId collision: session ids %q and %q both map to %q", first, entry.ID, entry.Path)
		}
		seen[entry.Path] = entry.ID
		summary, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(entry.Path), "summary.json"))
		if err != nil {
			return dataSet{}, err
		}
		var info struct {
			Meta struct {
				Title string `json:"title"`
			} `json:"meta"`
			Totals struct {
				Events int `json:"events"`
			} `json:"totals"`
			ChunkCount int `json:"chunkCount"`
		}
		if err := json.Unmarshal(summary, &info); err != nil {
			return dataSet{}, fmt.Errorf("summary for %s: %w", entry.ID, err)
		}
		t := trajectory{ID: entry.ID, SafeID: entry.Path, Title: info.Meta.Title, Summary: summary, Events: info.Totals.Events}
		for n := 0; n < info.ChunkCount; n++ {
			chunk, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(entry.Path), "chunks", fmt.Sprintf("%03d.json", n)))
			if err != nil {
				return dataSet{}, err
			}
			t.Chunks = append(t.Chunks, chunk)
		}
		set.Traces = append(set.Traces, t)
	}
	return set, nil
}

func (set dataSet) stats() (traces, events int) {
	for _, t := range set.Traces {
		events += t.Events
	}
	return len(set.Traces), events
}

// writeBlock serializes one data block. Every `<` in the
// payload is written as the JSON unicode escape \u003c so a literal
// "</script>" in trace content cannot terminate the block early.
// Within JSON text `<` can only occur inside a string literal, so this byte
// replacement is exactly the escaping a JSON string encoder applies — and a
// literal backslash-u003c sequence in the source text stays `\\u003c`, which a
// naive string-replace un-escaper would corrupt but a JSON-token-aware one
// will not (fixtures/claude/v2.1/hazard-text pins this).
func writeBlock(sb *strings.Builder, id string, payload []byte) {
	sb.WriteString(`<script type="application/json" id="`)
	sb.WriteString(id)
	sb.WriteString(`">`)
	sb.Write(bytes.ReplaceAll(payload, []byte("<"), []byte(`\u003c`)))
	sb.WriteString("</script>\n")
}

// reducedIndex is the trace-page index block: {id, safeId, title} per
// trajectory, nothing else — its job is id→filename resolution for links,
// while the root index.html keeps the complete index for IndexPage.
func reducedIndex(set dataSet) []byte {
	var sb strings.Builder
	// schemaVersion first: every index a consumer can load must declare its
	// version, or a viewer that refuses unknown versions sees `undefined` and
	// rejects a document it should have rendered. The reduced index omitted it,
	// which broke every split-mode trace page the moment the viewer started
	// checking.
	sb.WriteString(`{"schemaVersion":` + strconv.Itoa(schemaVersion) + `,"trajectories":[`)
	for i, t := range set.Traces {
		if i > 0 {
			sb.WriteByte(',')
		}
		entry, _ := json.Marshal(struct {
			ID     string `json:"id"`
			SafeID string `json:"safeId"`
			Title  string `json:"title"`
		}{t.ID, t.SafeID, t.Title})
		sb.Write(entry)
	}
	sb.WriteString("]}\n")
	return []byte(sb.String())
}

// dataBlocks assembles the blocks for one output page: #mode, #index (full on
// the root page, reduced on trace pages), then the #s-<id> summary and
// #c-<id>-NNN chunk blocks for every trace the page carries (SPEC.md §5).
func dataBlocks(sb *strings.Builder, set dataSet, mode string, one *trajectory) {
	writeBlock(sb, "mode", fmt.Appendf(nil, "{\"mode\":%q}\n", mode))
	if one == nil {
		writeBlock(sb, "index", set.Index)
	} else {
		writeBlock(sb, "index", reducedIndex(set))
	}
	traces := set.Traces
	if one != nil {
		traces = []trajectory{*one}
	}
	for i := range traces {
		t := &traces[i]
		writeBlock(sb, "s-"+t.SafeID, t.Summary)
		for n, chunk := range t.Chunks {
			writeBlock(sb, fmt.Sprintf("c-%s-%03d", t.SafeID, n), chunk)
		}
	}
}

// inject inserts the data blocks immediately before the shell's closing
// </body>. A shell without one still carries the data — appended at the end.
func inject(shell string, blocks []byte) []byte {
	i := strings.LastIndex(strings.ToLower(shell), "</body>")
	if i < 0 {
		return append(append([]byte(shell), blocks...), '\n')
	}
	out := make([]byte, 0, len(shell)+len(blocks))
	out = append(out, shell[:i]...)
	out = append(out, blocks...)
	out = append(out, shell[i:]...)
	return out
}

// schemaVersion is the document version this build emits and the viewer
// implements. It must match schema/trajectory.v1.json's const and
// apps/viewer/src/data.ts's SUPPORTED_SCHEMA_VERSION; a mismatch makes the
// viewer refuse documents this tool just produced.
const schemaVersion = 2
