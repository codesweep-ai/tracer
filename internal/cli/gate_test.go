package cli

// Tests in this file run the real gates against the committed
// oracle through the integrated Go normalizer and export pipeline.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/oracletest"
)

// fixtureDirs lists every fixture directory the gates cover, as
// slash-separated paths relative to the repo root, sorted, and requires the
// corpus and the goldens to correspond.
func fixtureDirs(t *testing.T) []string {
	t.Helper()
	root := repoRoot(t)
	dirs, err := listFixtureDirs(root)
	if err != nil {
		t.Fatal(err)
	}
	// Derived, not a magic number: every fixture directory must have exactly one
	// oracle tree and vice versa. A literal count here has to be edited every
	// time the corpus grows, and the edit is indistinguishable from silently
	// accepting that a fixture went missing — which is the thing this guards.
	oracleDirs, err := filepath.Glob(filepath.Join(root, "oracle", "*", "*", "*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(dirs) == 0 {
		t.Fatal("no fixture directories found")
	}
	if len(dirs) != len(oracleDirs) {
		t.Fatalf("%d fixture directories but %d oracle trees — a fixture is missing its golden, or vice versa: %v", len(dirs), len(oracleDirs), dirs)
	}
	return dirs
}

// TestNormalizeTreeMatchesOracle is the oracle-tree gate as a unit test: for
// every fixture directory, `cs-tracer normalize <dir> --out <tmp>` must
// produce a tree byte-identical to oracle/<dir>, excluding RUN.txt (which is
// a harness artifact no implementation emits).
func TestNormalizeTreeMatchesOracle(t *testing.T) {
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// The oracle records skip diagnostics relative to the repository root
	// (scripts/gen-goldens.sh runs there), so the gates run from there too.
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	for _, dir := range fixtureDirs(t) {
		t.Run(dir, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "out")
			var stdout, stderr bytes.Buffer
			code := Main(normalizeArgs(dir, out), &stdout, &stderr)
			if code != 0 {
				t.Fatalf("exit %d, stderr=%q", code, stderr.String())
			}
			oracleDir := filepath.Join(root, "oracle", strings.TrimPrefix(dir, "fixtures/"))
			oracletest.CompareTree(t, out, oracleDir)
		})
	}
}

// TestInvocationBehaviourMatchesOracle is the invocation gate: RUN.txt's
// `exit <code>` plus sorted stderr, reproduced for every fixture. It is the
// only gate covering empty-session and all-skipped, which emit no documents.
func TestInvocationBehaviourMatchesOracle(t *testing.T) {
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	for _, dir := range fixtureDirs(t) {
		t.Run(dir, func(t *testing.T) {
			// Same producer the goldens were written by (golden_test.go), so a
			// failure here is a behaviour change, never a formatting drift
			// between the gate and the generator.
			got := runFixture(dir, filepath.Join(t.TempDir(), "out"))
			want, err := os.ReadFile(filepath.Join(root, "oracle", strings.TrimPrefix(dir, "fixtures/"), "RUN.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if got != string(want) {
				t.Fatalf("RUN mismatch — if this change is intended, regenerate with scripts/gen-goldens.sh and review the diff\n--- got ---\n%s--- want ---\n%s", got, want)
			}
		})
	}
}

// TestExportBlocksMatchOracle is the export-block gate as a unit test: every data
// block in a generated export, un-escaped with a JSON-token-aware rule, must
// equal the corresponding oracle file byte-for-byte.
func TestExportBlocksMatchOracle(t *testing.T) {
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	for _, fixture := range []string{
		"fixtures/claude/v2.1/hazard-text",  // </script>, U+2028/29, literal \<, astral, RTL
		"fixtures/claude/v2.1/multi-chunk",  // the only chunkCount:2 fixture — pins chunk boundaries
		"fixtures/claude/v2.1/subagent-run", // exercises the --links merge into the root index
		"fixtures/claude/v2.1/simple",
	} {
		t.Run(fixture, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "export.html")
			args := []string{fixture, "-o", dest}
			if _, err := os.Stat(fixture + "/links.json"); err == nil {
				args = append(args, "--links", fixture+"/links.json")
			}
			var stdout, stderr bytes.Buffer
			if code := Main(args, &stdout, &stderr); code != 0 {
				t.Fatalf("exit %d, stderr=%q", code, stderr.String())
			}
			html, err := os.ReadFile(dest)
			if err != nil {
				t.Fatal(err)
			}
			blocks := extractBlocks(t, html)
			oracleDir := filepath.Join(root, "oracle", strings.TrimPrefix(fixture, "fixtures/"))
			index, err := os.ReadFile(filepath.Join(oracleDir, "index.json"))
			if err != nil {
				t.Fatal(err)
			}
			if got := jsonTokenAwareUnescape(blocks["index"]); got != string(index) {
				t.Fatalf("index block differs from oracle (%d vs %d bytes)", len(got), len(index))
			}
			entries, err := os.ReadDir(oracleDir)
			if err != nil {
				t.Fatal(err)
			}
			blockCount := 2 // mode + index
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				summary, err := os.ReadFile(filepath.Join(oracleDir, e.Name(), "summary.json"))
				if err != nil {
					t.Fatal(err)
				}
				if got := jsonTokenAwareUnescape(blocks["s-"+e.Name()]); got != string(summary) {
					t.Fatalf("summary block for %s differs from oracle", e.Name())
				}
				blockCount++
				chunks, err := os.ReadDir(filepath.Join(oracleDir, e.Name(), "chunks"))
				if err != nil {
					t.Fatal(err)
				}
				for _, c := range chunks {
					want, err := os.ReadFile(filepath.Join(oracleDir, e.Name(), "chunks", c.Name()))
					if err != nil {
						t.Fatal(err)
					}
					id := fmt.Sprintf("c-%s-%s", e.Name(), strings.TrimSuffix(c.Name(), ".json"))
					if got := jsonTokenAwareUnescape(blocks[id]); got != string(want) {
						t.Fatalf("chunk block %s differs from oracle", id)
					}
					blockCount++
				}
			}
			if len(blocks) != blockCount {
				t.Fatalf("export has %d data blocks, oracle implies %d", len(blocks), blockCount)
			}
		})
	}
}

// TestNormalizeJSONL is the §7 consumer interface: bare `normalize` streams
// one normalized document per line on stdout, diagnostics on stderr.
func TestNormalizeJSONL(t *testing.T) {
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	t.Run("one document per line", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"normalize", "fixtures/claude/v2.1/subagent-run", "--links", "fixtures/claude/v2.1/subagent-run/links.json"}, &stdout, &stderr)
		if code != 0 {
			t.Fatalf("exit %d, stderr=%q", code, stderr.String())
		}
		lines := strings.Split(strings.TrimSuffix(stdout.String(), "\n"), "\n")
		if len(lines) != 3 {
			t.Fatalf("lines: %d", len(lines))
		}
		for _, line := range lines {
			var doc map[string]json.RawMessage
			if err := json.Unmarshal([]byte(line), &doc); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"schemaVersion", "meta", "totals", "parse", "links", "events"} {
				if _, ok := doc[key]; !ok {
					t.Fatalf("JSONL doc lacks %q", key)
				}
			}
		}
		// The links ride on the documents in JSONL; a doc's events
		// must reassemble across chunk boundaries.
		var doc struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.Unmarshal([]byte(lines[0]), &doc); err != nil {
			t.Fatal(err)
		}
		if len(doc.Events) == 0 {
			t.Fatal("no events reassembled")
		}
	})
	t.Run("multi-chunk events reassemble fully", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		if code := Main([]string{"normalize", "fixtures/claude/v2.1/multi-chunk"}, &stdout, &stderr); code != 0 {
			t.Fatalf("exit %d, stderr=%q", code, stderr.String())
		}
		lines := strings.Split(strings.TrimSuffix(stdout.String(), "\n"), "\n")
		if len(lines) != 2 {
			t.Fatalf("lines: %d", len(lines))
		}
		var total int
		for _, line := range lines {
			var doc struct {
				Events []json.RawMessage `json:"events"`
			}
			if err := json.Unmarshal([]byte(line), &doc); err != nil {
				t.Fatal(err)
			}
			total += len(doc.Events)
		}
		// 1,104 events on the root (2 chunks), 96 on the subagent — read from
		// the oracle summaries so the number is never invented.
		if total != 1104+96 {
			t.Fatalf("events: %d", total)
		}
	})
	t.Run("all-skipped still exits 0 with no output", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		if code := Main([]string{"normalize", "fixtures/claude/v2.1/all-skipped"}, &stdout, &stderr); code != 0 {
			t.Fatalf("exit %d", code)
		}
		if stdout.Len() != 0 {
			t.Fatalf("stdout=%q", stdout.String())
		}
		if !strings.Contains(stderr.String(), "0 sessions normalized (2 file(s) skipped, reported above)") {
			t.Fatalf("stderr=%q", stderr.String())
		}
	})
}

// TestExportEndToEndDeterminism drives two full single-file exports through
// the subprocess bridge and requires byte-identical output (CONTRIBUTING.md gate 3
// for --single; export_test.go covers --split).
func TestExportEndToEndDeterminism(t *testing.T) {
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	dir := t.TempDir()
	var prev []byte
	for i := range 2 {
		dest := filepath.Join(dir, fmt.Sprintf("run%d.html", i))
		var stdout, stderr bytes.Buffer
		if code := Main([]string{"fixtures/claude/v2.1/hazard-text", "-o", dest}, &stdout, &stderr); code != 0 {
			t.Fatalf("exit %d, stderr=%q", code, stderr.String())
		}
		b, err := os.ReadFile(dest)
		if err != nil {
			t.Fatal(err)
		}
		if prev != nil && !bytes.Equal(prev, b) {
			t.Fatal("two consecutive single-file exports differ")
		}
		prev = b
	}
}

// TestMalformedLinksWarnAndContinue end to end: a malformed --links file must
// not fail the run: a malformed --links warns and continues.
func TestMalformedLinksWarnAndContinue(t *testing.T) {
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	dir := t.TempDir()
	put(t, filepath.Join(dir, "links.json"), `{"not":"an array"}`)
	var stdout, stderr bytes.Buffer
	dest := filepath.Join(dir, "out.html")
	code := Main([]string{"fixtures/claude/v2.1/simple", "-o", dest, "--links", filepath.Join(dir, "links.json")}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(stderr.String(), "warning: links file") || !strings.Contains(stderr.String(), "must contain a JSON array") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}
