package normalizer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/codesweep-ai/tracer/internal/oracletest"
)

// TestOracleTrees checks the LIBRARY seam: NormalizeDirectory must produce a
// tree byte-identical to oracle/. It reports the first differing byte offset,
// which is what makes a whole-tree mismatch diagnosable.
//
// Exit code, stdout and stderr are NOT checked here. RUN.txt belongs to the CLI
// seam and is owned by internal/cli's golden_test.go, which both writes and
// reads it — deriving the format a second time here is how a generator and a
// gate drift apart.
//
// It chdirs to the repository root because skip paths are printed relative to
// the working directory, and oracle/ was recorded from the root.
func TestOracleTrees(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	sources := []struct{ source, version string }{
		{"claude", "v2.1"},
		{"codex", "v0.146"},
		{"opencode", "v1.18"},
	}
	fixtureCount := 0
	for _, s := range sources {
		fixtures := filepath.Join("fixtures", s.source, s.version)
		entries, err := os.ReadDir(fixtures)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			fixtureCount++
			t.Run(s.source+"/"+s.version+"/"+entry.Name(), func(t *testing.T) {
				in := filepath.Join(fixtures, entry.Name())
				out := t.TempDir()
				links := ""
				if _, e := os.Stat(filepath.Join(in, "links.json")); e == nil {
					links = filepath.Join(in, "links.json")
				}
				if _, err := NormalizeDirectory(in, out, links); err != nil {
					t.Fatal(err)
				}
				wantRoot := filepath.Join("oracle", s.source, s.version, entry.Name())
				oracletest.CompareTree(t, out, wantRoot)
			})
		}
	}
	// Derived, not a magic number: assert every oracle tree was actually walked.
	// A literal count must be edited whenever the corpus grows, and that edit is
	// indistinguishable from silently accepting that a fixture disappeared —
	// which is the thing this guard exists to catch.
	// t.Chdir(root) above means relative paths resolve from the repo root here.
	oracleDirs, err := filepath.Glob(filepath.Join("oracle", "*", "*", "*"))
	if err != nil {
		t.Fatal(err)
	}
	if fixtureCount == 0 {
		t.Fatal("no fixture directories were exercised")
	}
	if fixtureCount != len(oracleDirs) {
		t.Fatalf("exercised %d fixture directories but %d oracle trees exist — a fixture is missing its golden, or vice versa", fixtureCount, len(oracleDirs))
	}
}
