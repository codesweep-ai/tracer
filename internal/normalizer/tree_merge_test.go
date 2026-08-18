package normalizer

import (
	"os"

	"github.com/codesweep-ai/tracer/internal/trajectory"
	"path/filepath"
	"strings"
	"testing"
)

// The all-skipped exit-0 rule still creates the output directory —
// the reference mkdirs before processing, so diffing the empty result against
// the oracle works.
func TestAllSkippedStillCreatesOutputDir(t *testing.T) {
	in := t.TempDir()
	out := filepath.Join(t.TempDir(), "out")
	if err := os.WriteFile(filepath.Join(in, "a.jsonl"), []byte("{bad json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := NormalizeDirectory(in, out, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != 1 || len(res.Documents) != 0 {
		t.Fatalf("result = %+v", res)
	}
	st, err := os.Stat(out)
	if err != nil || !st.IsDir() {
		t.Fatalf("out dir missing after all-skipped run: %v", err)
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatalf("out dir not empty: %v", entries)
	}
	var hasSummary bool
	for _, d := range res.Diagnostics {
		if strings.Contains(d, "0 sessions normalized (1 file(s) skipped, reported above)") {
			hasSummary = true
		}
	}
	if !hasSummary {
		t.Fatalf("missing all-skipped summary diagnostic: %q", res.Diagnostics)
	}
}

// The all-skipped summary says "reported above", so it has to print after the
// skip lines it counts. Sorting it in with them put it first, because "0" sorts
// before "skipping".
func TestAllSkippedSummaryFollowsTheLinesItCounts(t *testing.T) {
	in := t.TempDir()
	for _, name := range []string{"a.jsonl", "b.jsonl"} {
		if err := os.WriteFile(filepath.Join(in, name), []byte("{bad json\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := NormalizeDirectory(in, filepath.Join(t.TempDir(), "out"), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Diagnostics) != 3 {
		t.Fatalf("want two skip lines and one summary, got %q", res.Diagnostics)
	}
	if !strings.HasPrefix(res.Diagnostics[0], "skipping ") || !strings.HasPrefix(res.Diagnostics[1], "skipping ") {
		t.Errorf("the skip lines must come first: %q", res.Diagnostics)
	}
	if !strings.Contains(res.Diagnostics[2], "0 sessions normalized (2 file(s) skipped, reported above)") {
		t.Errorf("the summary must come last: %q", res.Diagnostics)
	}
}

func TestNoCandidateFilesIsAnError(t *testing.T) {
	in := t.TempDir()
	_, err := NormalizeDirectory(in, filepath.Join(t.TempDir(), "out"), "")
	if err == nil || !strings.Contains(err.Error(), "no supported session files found") {
		t.Fatalf("err = %v", err)
	}
}

// Re-normalizing into an existing cache dir merges: previous trajectories
// survive, re-normalized ids keep their position, and a stale links set is
// preserved unless a non-empty --links replaces it.
func TestIndexMergePreservesPreviousTrajectories(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	fixture := filepath.Join("fixtures", "claude", "v2.1", "simple")
	out := t.TempDir()

	res, err := NormalizeDirectory(fixture, out, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Documents) != 1 {
		t.Fatalf("documents = %d", len(res.Documents))
	}
	id := str(get(object(get(res.Documents[0], "meta")), "sessionId"))

	// Simulate a pre-existing cache from another session by hand-authoring a
	// previous index, then re-normalizing the same fixture into it.
	previous := `{"schemaVersion":1,"trajectories":[{"id":"older-session","path":"older-session"}],"links":[{"fromSessionId":"a","toSessionId":"b","kind":"spawned"}]}` + "\n"
	if err := os.WriteFile(filepath.Join(out, "index.json"), []byte(previous), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeDirectory(fixture, out, ""); err != nil {
		t.Fatal(err)
	}
	index := mustReadIndex(t, out)
	trajs := array(get(index, "trajectories"))
	if len(trajs) != 2 {
		t.Fatalf("trajectories = %v", trajs)
	}
	if got := str(get(object(trajs[0]), "id")); got != "older-session" {
		t.Fatalf("previous entry lost its position: %q", got)
	}
	if got := str(get(object(trajs[1]), "id")); got != id {
		t.Fatalf("new entry = %q, want %q", got, id)
	}
	links := array(get(index, "links"))
	if len(links) != 1 {
		t.Fatalf("previous links not preserved: %v", links)
	}

	// A fresh non-empty --links set replaces the preserved one.
	linksFile := filepath.Join(t.TempDir(), "links.json")
	if err := os.WriteFile(linksFile, []byte(`[{"fromSessionId":"x","toSessionId":"y","kind":"handoff"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeDirectory(fixture, out, linksFile); err != nil {
		t.Fatal(err)
	}
	links = array(get(mustReadIndex(t, out), "links"))
	if len(links) != 1 || str(get(object(links[0]), "fromSessionId")) != "x" {
		t.Fatalf("links not replaced: %v", links)
	}
}

func TestInvalidPreviousIndexWarnsAndRewrites(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	fixture := filepath.Join("fixtures", "claude", "v2.1", "simple")
	out := t.TempDir()
	if err := os.WriteFile(filepath.Join(out, "index.json"), []byte(`{"nope":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := NormalizeDirectory(fixture, out, "")
	if err != nil {
		t.Fatal(err)
	}
	var warned bool
	for _, d := range res.Diagnostics {
		if strings.Contains(d, "could not merge existing") && strings.Contains(d, "missing trajectories array") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("missing merge warning: %q", res.Diagnostics)
	}
	if trajs := array(get(mustReadIndex(t, out), "trajectories")); len(trajs) != 1 {
		t.Fatalf("rewritten index trajectories = %v", trajs)
	}
}

func mustReadIndex(t *testing.T, out string) *obj {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(out, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := trajectory.Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	return object(v)
}
