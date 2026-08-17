package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// repoRoot locates the repository root from this source file, so oracle and
// fixture paths resolve regardless of the test working directory.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate repository root")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

// sampleSet builds a trace set whose payloads exercise the escaping rules: a
// literal "</script>" (must not terminate a block) and a literal `<`
// sequence (must survive round-tripping exactly).
func sampleSet() dataSet {
	return dataSet{
		Index: []byte("{\n  \"schemaVersion\": 1,\n  \"trajectories\": [\n    {\n      \"id\": \"trace/one\",\n      \"path\": \"trace-one\"\n    }\n  ]\n}\n"),
		Traces: []trajectory{{
			ID:      "trace/one",
			SafeID:  "trace-one",
			Title:   "hazard </title>",
			Summary: []byte("{\"schemaVersion\":1,\"meta\":{\"title\":\"hazard\"},\"totals\":{\"events\":1},\"parse\":{\"adapter\":\"claude-code\"},\"chunkCount\":1,\"strip\":[]}\n"),
			Chunks:  [][]byte{[]byte("{\"chunk\":0,\"events\":[{\"i\":0,\"text\":\"close </script> now\"},{\"i\":1,\"text\":\"literal \\\\u003c stays\"}]}\n")},
			Events:  1,
		}},
	}
}

// jsonTokenAwareUnescape reverses the assembler's `<` → `<` escaping
// the way a correct harness must: an odd-length run of
// backslashes before `u003c` means the escape is real JSON string escaping;
// an even run means the backslash itself was escaped and `<` is literal
// text that must not be touched.
func jsonTokenAwareUnescape(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			out.WriteByte(s[i])
			continue
		}
		n := 0
		for i+n < len(s) && s[i+n] == '\\' {
			n++
		}
		if n%2 == 1 && i+n+5 <= len(s) && s[i+n] == 'u' && s[i+n+1:i+n+5] == "003c" {
			out.WriteString(strings.Repeat(`\`, (n-1)/2) + "<")
			i += n + 4
			continue
		}
		out.WriteString(strings.Repeat(`\`, n))
		i += n - 1
	}
	return out.String()
}

// extractBlocks returns id → payload for every data block in the page.
func extractBlocks(t *testing.T, html []byte) map[string]string {
	t.Helper()
	blocks := map[string]string{}
	rest := html
	for {
		start := bytes.Index(rest, []byte(`<script type="application/json" id="`))
		if start < 0 {
			return blocks
		}
		rest = rest[start+len(`<script type="application/json" id="`):]
		endID := bytes.Index(rest, []byte(`">`))
		if endID < 0 {
			t.Fatal("unterminated block tag")
		}
		id := string(rest[:endID])
		rest = rest[endID+2:]
		end := bytes.Index(rest, []byte("</script>"))
		if end < 0 {
			t.Fatalf("block %s has no closing tag — payload terminated it early", id)
		}
		blocks[id] = string(rest[:end])
		rest = rest[end+len("</script>"):]
	}
}

func TestDataBlocksEscapeScriptTerminator(t *testing.T) {
	set := sampleSet()
	var sb strings.Builder
	dataBlocks(&sb, set, "single", nil)
	html := inject(singleShell, []byte(sb.String()))
	blocks := extractBlocks(t, html)
	for _, id := range []string{"mode", "index", "s-trace-one", "c-trace-one-000"} {
		if _, ok := blocks[id]; !ok {
			t.Fatalf("missing block %s", id)
		}
	}
	if blocks["mode"] != "{\"mode\":\"single\"}\n" {
		t.Fatalf("mode block: %q", blocks["mode"])
	}
	chunk := blocks["c-trace-one-000"]
	if strings.Contains(chunk, "</script>") {
		t.Fatal("a literal </script> survived into the block payload")
	}
	if !strings.Contains(chunk, `\u003c/script>`) {
		t.Fatalf("the terminator was not escaped: %q", chunk)
	}
	// Round-trip: token-aware un-escaping must restore the exact source bytes.
	if got := jsonTokenAwareUnescape(chunk); got != string(set.Traces[0].Chunks[0]) {
		t.Fatalf("round-trip mismatch:\n got %q\nwant %q", got, set.Traces[0].Chunks[0])
	}
	// The literal backslash-u003c sequence in the source text is stored in the
	// JSON as an escaped backslash (\\u003c in the bytes) and must survive
	// un-escaping as exactly those bytes — a naive string replace would turn
	// it into `\<`, which is what fixtures/claude/v2.1/hazard-text pins.
	unescaped := jsonTokenAwareUnescape(chunk)
	if !strings.Contains(unescaped, `literal \\u003c stays`) {
		t.Fatalf("literal backslash-u003c sequence corrupted: %q", unescaped)
	}
	if strings.Contains(unescaped, `\<`) {
		t.Fatalf("naive un-escape corruption present: %q", unescaped)
	}
}

func TestBlockIDsUseSafeIDAndChunkNumbers(t *testing.T) {
	set := sampleSet()
	set.Traces[0].Chunks = append(set.Traces[0].Chunks, []byte("{\"chunk\":1,\"events\":[]}\n"))
	var sb strings.Builder
	dataBlocks(&sb, set, "split", nil)
	blocks := extractBlocks(t, inject(splitShell, []byte(sb.String())))
	for _, id := range []string{"c-trace-one-000", "c-trace-one-001"} {
		if _, ok := blocks[id]; !ok {
			t.Fatalf("missing %s", id)
		}
	}
}

func TestReducedIndexOnTracePages(t *testing.T) {
	set := sampleSet()
	var sb strings.Builder
	dataBlocks(&sb, set, "split", &set.Traces[0])
	blocks := extractBlocks(t, inject(splitShell, []byte(sb.String())))
	index := blocks["index"]
	if !strings.Contains(index, `"id":"trace/one"`) || !strings.Contains(index, `"safeId":"trace-one"`) || !strings.Contains(index, `"title"`) {
		t.Fatalf("reduced index lacks id/safeId/title: %s", index)
	}
	// {id, safeId, title} per trajectory and nothing more — the full summaries
	// stay on the root page; the trace page carries only its own.
	//
	// Checked by the fields that actually distinguish the two forms. This used to
	// assert the ABSENCE of schemaVersion, which was a proxy: every index must
	// declare its version, or a viewer that refuses unknown versions rejects a
	// document it should have rendered.
	if strings.Contains(index, "strip") || strings.Contains(index, `"path"`) {
		t.Fatalf("trace page index is not the reduced form: %s", index)
	}
	if !strings.Contains(index, `"schemaVersion"`) {
		t.Fatalf("reduced index must still declare its schema version: %s", index)
	}
	if _, ok := blocks["s-trace-one"]; !ok {
		t.Fatal("trace page lacks its own summary block")
	}
}

func TestRootPageKeepsFullIndexBytes(t *testing.T) {
	set := sampleSet()
	var sb strings.Builder
	dataBlocks(&sb, set, "split", nil)
	blocks := extractBlocks(t, inject(splitShell, []byte(sb.String())))
	// Raw bytes are preserved verbatim (only `<` is escaped): the index is
	// pretty-printed in the oracle and must stay pretty.
	if blocks["index"] != strings.ReplaceAll(string(set.Index), "<", `\u003c`) {
		t.Fatalf("root index was re-encoded:\n%s", blocks["index"])
	}
}

func TestInjectBeforeClosingBody(t *testing.T) {
	shell := "<html><body><div id=\"root\"></div></body></html>"
	out := string(inject(shell, []byte("BLOCKS")))
	if !strings.Contains(out, "</div>BLOCKS</body>") {
		t.Fatalf("%s", out)
	}
	out = string(inject("<html><body>no closing tag", []byte("BLOCKS")))
	if !strings.HasSuffix(out, "no closing tagBLOCKS\n") {
		t.Fatalf("%s", out)
	}
}

func TestLoadSetFromOracleTree(t *testing.T) {
	root := repoRoot(t)
	set, err := loadSet(filepath.Join(root, "oracle", "claude", "v2.1", "simple"))
	if err != nil {
		t.Fatal(err)
	}
	if len(set.Traces) != 1 {
		t.Fatalf("traces: %d", len(set.Traces))
	}
	tr := set.Traces[0]
	// The id is read from the tree rather than hard-coded: the properties under
	// test are that loadSet surfaces the tree's id at all, and that safeId is a
	// no-op on a UUID (SafeID == ID). A literal here breaks whenever fixtures are
	// re-minted without any behaviour having changed.
	var index struct {
		Trajectories []struct{ ID string } `json:"trajectories"`
	}
	raw, err := os.ReadFile(filepath.Join(root, "oracle", "claude", "v2.1", "simple", "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Trajectories) != 1 {
		t.Fatalf("index lists %d trajectories", len(index.Trajectories))
	}
	if tr.ID != index.Trajectories[0].ID || tr.SafeID != tr.ID {
		t.Fatalf("%+v (index id %q)", tr, index.Trajectories[0].ID)
	}
	if tr.Title == "" || tr.Events != 90 || len(tr.Chunks) != 1 {
		t.Fatalf("title=%q events=%d chunks=%d", tr.Title, tr.Events, len(tr.Chunks))
	}
	// The summary bytes must be the file's bytes verbatim — compact, trailing
	// newline, raw U+2028 unescaped where present.
	if !bytes.HasSuffix(tr.Summary, []byte("}\n")) {
		t.Fatal("summary lost its trailing newline")
	}
}

func TestLoadSetMissingIndexLoadsEmpty(t *testing.T) {
	set, err := loadSet(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(set.Traces) != 0 || !strings.Contains(string(set.Index), `"trajectories":[]`) {
		t.Fatalf("%+v", set)
	}
}

func TestLoadSetDetectsSafeIDCollision(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "index.json"), `{"schemaVersion":1,"trajectories":[{"id":"a/b","path":"a-b"},{"id":"aXb","path":"a-b"}]}`)
	put(t, filepath.Join(dir, "a-b", "summary.json"), `{}`)
	if _, err := loadSet(dir); err == nil || !strings.Contains(err.Error(), "safeId collision") {
		t.Fatalf("%v", err)
	}
}

func TestWriteJSONLShape(t *testing.T) {
	set := sampleSet()
	set.Links = json.RawMessage(`[{"fromSessionId":"trace/one","toSessionId":"x","kind":"references"}]`)
	var out bytes.Buffer
	if err := set.writeJSONL(&out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("lines: %d", len(lines))
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(lines[0]), &doc); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"schemaVersion", "meta", "totals", "parse", "links", "events"} {
		if _, ok := doc[key]; !ok {
			t.Fatalf("doc lacks %s", key)
		}
	}
	if _, shardKey := doc["strip"]; shardKey {
		t.Fatal("JSONL document carries shard bookkeeping (strip)")
	}
	var events []json.RawMessage
	if err := json.Unmarshal(doc["events"], &events); err != nil || len(events) != 2 {
		t.Fatalf("events: %v %d", err, len(events))
	}
	// toWholeDocument key order: schemaVersion first, events last.
	if !strings.HasPrefix(lines[0], `{"schemaVersion":`) || !strings.HasSuffix(lines[0], `]}`) {
		t.Fatalf("key order: %s", lines[0])
	}
}
