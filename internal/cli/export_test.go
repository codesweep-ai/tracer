package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSizeReportedAlwaysAndWarnsPastThreshold(t *testing.T) {
	set := sampleSet()
	dest := filepath.Join(t.TempDir(), "trace.html")
	var stdout, stderr bytes.Buffer
	// Below the threshold the size is still printed — ambient information,
	// not a sudden scold — and there is no "warning:".
	if err := exportSingle(dest, "trace.html", set, options{input: "in"}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "trace.html will be") || !strings.Contains(stderr.String(), "(1 traces, 1 events)") {
		t.Fatalf("stderr=%q", stderr.String())
	}
	if strings.Contains(stderr.String(), "warning:") {
		t.Fatalf("unexpected warning: %q", stderr.String())
	}
	if !strings.Contains(stdout.String(), "wrote trace.html (") {
		t.Fatalf("stdout=%q", stdout.String())
	}
}

func TestSizeWarningPastThreshold(t *testing.T) {
	set := sampleSet()
	// Pad a chunk past the 25 MB threshold without writing 25 MB of source.
	chunk := set.Traces[0].Chunks[0]
	pad := `,"pad":"` + strings.Repeat("x", int(warnSizeBytes)) + `"}`
	set.Traces[0].Chunks[0] = []byte(strings.TrimSuffix(string(chunk), "}\n") + pad + "\n")
	dest := filepath.Join(t.TempDir(), "big.html")
	var stdout, stderr bytes.Buffer
	if err := exportSingle(dest, "big.html", set, options{input: "sessions/"}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	err := stderr.String()
	if !strings.Contains(err, "warning: big.html will be ") {
		t.Fatalf("stderr=%q", err)
	}
	if !strings.Contains(err, "browsers take ~2-5s to parse a file this size before first paint") {
		t.Fatalf("stderr=%q", err)
	}
	if !strings.Contains(err, "consider: cs-tracer sessions/ --split -o big/") {
		t.Fatalf("stderr=%q", err)
	}
	// Oversize is a warning, not a decision: the file is written and the run
	// still succeeds.
	if _, e := os.Stat(dest); e != nil {
		t.Fatal(e)
	}
}

func TestSplitWarningOmitsConsiderLine(t *testing.T) {
	var stderr bytes.Buffer
	set := sampleSet()
	reportSize(&stderr, "out/", warnSizeBytes+1, set, true, "in")
	if strings.Contains(stderr.String(), "consider:") {
		t.Fatalf("split mode suggested --split: %q", stderr.String())
	}
	if !strings.Contains(stderr.String(), "warning: out/ will be") {
		t.Fatalf("%q", stderr.String())
	}
}

func TestComma(t *testing.T) {
	for in, want := range map[int]string{0: "0", 12: "12", 999: "999", 1000: "1,000", 50540: "50,540", 1000000: "1,000,000"} {
		if got := comma(in); got != want {
			t.Errorf("comma(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestHumanSize(t *testing.T) {
	if got := humanSize(int64(64.2 * 1000 * 1000)); got != "64.2 MB" {
		t.Fatalf("%q", got)
	}
	if got := humanSize(43631); got != "43.6 KB" {
		t.Fatalf("%q", got)
	}
	if got := humanSize(512); got != "512 B" {
		t.Fatalf("%q", got)
	}
}

func TestExportSingleLayout(t *testing.T) {
	set := sampleSet()
	dest := filepath.Join(t.TempDir(), "deep", "nested", "trace.html")
	var stdout, stderr bytes.Buffer
	// Missing parent directories are created; single-file output overwrites
	// freely.
	if err := exportSingle(dest, "trace.html", set, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	blocks := extractBlocks(t, b)
	if len(blocks) != 4 {
		t.Fatalf("blocks: %v", reflect.ValueOf(blocks).MapKeys())
	}
	// Overwrite: same destination again must succeed with no flag.
	if err := exportSingle(dest, "trace.html", set, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestExportSplitLayoutAndManifest(t *testing.T) {
	set := sampleSet()
	dest := filepath.Join(t.TempDir(), "out")
	var stdout, stderr bytes.Buffer
	if err := exportSplit(dest, "out", set, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"index.html", "assets/app.js", "assets/app.css", "traces/trace-one.html", ".cs-tracer.json"} {
		if _, err := os.Stat(filepath.Join(dest, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("missing %s: %v", rel, err)
		}
	}
	b, err := os.ReadFile(filepath.Join(dest, ".cs-tracer.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m.ManifestVersion != 1 || m.Tool != "cs-tracer" || m.ToolVersion != version || m.GeneratedAt == "" {
		t.Fatalf("%+v", m)
	}
	if _, err := time.Parse(time.RFC3339, m.GeneratedAt); err != nil {
		t.Fatal(err)
	}
	want := []string{"index.html", "assets/app.js", "assets/app.css", "traces/trace-one.html"}
	if !reflect.DeepEqual(m.Files, want) {
		t.Fatalf("files=%v want %v", m.Files, want)
	}
	// The manifest lists no path outside the directory and never itself.
	for _, f := range m.Files {
		if strings.HasPrefix(f, "/") || strings.HasPrefix(f, "..") || f == manifestName {
			t.Fatalf("manifest path %q", f)
		}
	}
	// Trace pages reference ../assets relatively; they do not inline the shell.
	page, err := os.ReadFile(filepath.Join(dest, "traces", "trace-one.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), `src="../assets/app.js"`) || !strings.Contains(string(page), `href="../assets/app.css"`) {
		t.Fatalf("trace page does not reference ../assets relatively")
	}
	blocks := extractBlocks(t, page)
	if blocks["mode"] != "{\"mode\":\"split\"}\n" {
		t.Fatalf("mode: %q", blocks["mode"])
	}
	// The reduced form is identified by what it OMITS (per-trajectory `path`)
	// rather than by lacking a version — every index declares its version.
	if strings.Contains(blocks["index"], `"path"`) {
		t.Fatal("trace page carries the full index; it must carry the reduced one")
	}
	if !strings.Contains(blocks["index"], `"schemaVersion"`) {
		t.Fatal("reduced index must still declare its schema version")
	}
	// Root index keeps the complete index.
	root, err := os.ReadFile(filepath.Join(dest, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(extractBlocks(t, root)["index"], `"schemaVersion": 1`) {
		t.Fatal("root index lost the full index")
	}
}

// Regenerating into your own previous --split output needs no flag.
func TestExportSplitRegenerateIntoOwnOutput(t *testing.T) {
	set := sampleSet()
	dest := filepath.Join(t.TempDir(), "out")
	var stdout, stderr bytes.Buffer
	if err := exportSplit(dest, "out", set, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	// A second run over a SMALLER set orphans nothing: the manifest's file
	// list is what gets cleaned.
	smaller := dataSet{Index: set.Index, Traces: nil}
	if err := exportSplit(dest, "out", smaller, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "traces", "trace-one.html")); !os.IsNotExist(err) {
		t.Fatal("stale trace page survived regeneration")
	}
}

// A foreign directory refuses without --force and proceeds with it, leaving
// unrelated files untouched.
func TestExportSplitRefuseThenForce(t *testing.T) {
	set := sampleSet()
	dest := filepath.Join(t.TempDir(), "Documents")
	put(t, filepath.Join(dest, "thesis.pdf"), "important")
	var stdout, stderr bytes.Buffer
	err := exportSplit(dest, "Documents", set, options{}, &stdout, &stderr, time.Now())
	if err == nil || !strings.Contains(err.Error(), "not a cs-tracer output directory; use --force") {
		t.Fatalf("%v", err)
	}
	if err := exportSplit(dest, "Documents", set, options{force: true}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "thesis.pdf")); err != nil {
		t.Fatal("--force destroyed an unrelated file")
	}
	if _, err := os.Stat(filepath.Join(dest, "index.html")); err != nil {
		t.Fatal("index.html was not written")
	}
}

// snapshot returns rel-path → bytes for every file under root except the
// manifest (which carries generatedAt by design and is excluded from the
// determinism gate, CONTRIBUTING.md gate 3).
func snapshot(t *testing.T, root string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if rel == manifestName {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = b
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDeterminismExcludingManifest(t *testing.T) {
	set := sampleSet()
	root := t.TempDir()
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	var stdout, stderr bytes.Buffer
	if err := exportSplit(a, "a", set, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond) // cross at least one generatedAt second
	if err := exportSplit(b, "b", set, options{}, &stdout, &stderr, time.Now()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(snapshot(t, a), snapshot(t, b)) {
		t.Fatal("two consecutive runs differ (excluding .cs-tracer.json)")
	}
	// And the manifests really do carry distinct timestamps across the sleep.
	ma, _ := os.ReadFile(filepath.Join(a, manifestName))
	mb, _ := os.ReadFile(filepath.Join(b, manifestName))
	if bytes.Equal(ma, mb) {
		t.Fatal("generatedAt did not advance; the exclusion above is unexercised")
	}
}

func TestLoadLinksWarnsAndContinues(t *testing.T) {
	dir := t.TempDir()
	var stderr bytes.Buffer
	// Missing file: warning, continue.
	if got := loadLinks(filepath.Join(dir, "missing.json"), &stderr); got != nil {
		t.Fatal("missing file should yield no links")
	}
	if !strings.Contains(stderr.String(), "warning: could not read links file") {
		t.Fatalf("%q", stderr.String())
	}
	// Non-array: warning, continue.
	stderr.Reset()
	bad := filepath.Join(dir, "bad.json")
	put(t, bad, `{"not":"an array"}`)
	if got := loadLinks(bad, &stderr); got != nil {
		t.Fatal("non-array should yield no links")
	}
	if !strings.Contains(stderr.String(), "must contain a JSON array; ignoring it") {
		t.Fatalf("%q", stderr.String())
	}
	// Mixed entries: invalid ones warn and are skipped, valid ones survive.
	stderr.Reset()
	mixed := filepath.Join(dir, "mixed.json")
	put(t, mixed, `[
	  {"fromSessionId":"a","toSessionId":"b","kind":"references","label":"ok"},
	  {"fromSessionId":"a"},
	  [1,2],
	  "nope",
	  {"fromSessionId":"c","toSessionId":"d","kind":"retry-of","label":3}
	]`)
	got := loadLinks(mixed, &stderr)
	var links []map[string]any
	if err := json.Unmarshal(got, &links); err != nil {
		t.Fatal(err)
	}
	if len(links) != 1 || links[0]["label"] != "ok" {
		t.Fatalf("%v", links)
	}
	for _, want := range []string{"skipping invalid links entry 1", "entry 2", "entry 3", "entry 4"} {
		if !strings.Contains(stderr.String(), want) {
			t.Fatalf("stderr missing %q: %q", want, stderr.String())
		}
	}
}

func TestMergeLinksOnPreNormalizedInput(t *testing.T) {
	set := sampleSet()
	linksFile := filepath.Join(t.TempDir(), "links.json")
	put(t, linksFile, `[{"fromSessionId":"a","toSessionId":"b","kind":"references"}]`)
	var stderr bytes.Buffer
	if err := set.mergeLinks(linksFile, &stderr); err != nil {
		t.Fatal(err)
	}
	var index map[string]json.RawMessage
	if err := json.Unmarshal(set.Index, &index); err != nil {
		t.Fatal(err)
	}
	var links []map[string]string
	if err := json.Unmarshal(index["links"], &links); err != nil || len(links) != 1 || links[0]["kind"] != "references" {
		t.Fatalf("%v %v", links, err)
	}
	// The index remains pretty-printed (the oracle's root index style).
	if !strings.Contains(string(set.Index), "\n  \"schemaVersion\": 1,") {
		t.Fatalf("index lost its pretty shape:\n%s", set.Index)
	}
}
