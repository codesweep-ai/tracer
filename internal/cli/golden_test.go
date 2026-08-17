package cli

// Golden generation and the format the gates compare against, in one place.
//
// oracle/ is written here (-update, via scripts/gen-goldens.sh) and read back by
// the gates in gate_test.go. Both go through runFixture, so the generator and the
// gate cannot disagree about what a run is supposed to look like.
//
// They were separate implementations until now: this file's format, and a shell
// transcription of it in scripts/gen-goldens.sh. That is duplication of the kind
// that stays correct right up until it doesn't — and it was already wrong. The
// shell sorted stderr with sort(1), whose collation follows the caller's locale,
// while the gate sorts by byte. Under en_US.UTF-8 those orders differ for lines
// starting with punctuation or a capital. Every current diagnostic starts with a
// lowercase letter, so the two agreed by luck; the first one that didn't would
// have been written one way by the generator and rejected by the gate, with the
// regeneration that was supposed to fix it changing nothing.

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var updateGoldens = flag.Bool("update", false,
	"regenerate oracle/ from the current build instead of comparing against it")

// listFixtureDirs returns every fixture directory, as a slash-separated path
// relative to the repo root, sorted.
//
// Directories, never individual files: a single file normalised on its own has no
// siblings, so set-wide reparenting degrades to a no-op and the gate would pass
// while testing nothing.
//
// This deliberately does NOT cross-check oracle/. Regeneration exists precisely
// for the moment a fixture has no golden yet, so an equal-counts assertion here
// would break -update exactly when it is needed. That check belongs to the
// compare path — see fixtureDirs.
func listFixtureDirs(root string) ([]string, error) {
	var dirs []string
	for _, cli := range []string{"claude", "codex", "opencode"} {
		base := filepath.Join(root, "fixtures", cli)
		versions, err := os.ReadDir(base)
		if err != nil {
			return nil, err
		}
		for _, v := range versions {
			if !v.IsDir() {
				continue
			}
			entries, err := os.ReadDir(filepath.Join(base, v.Name()))
			if err != nil {
				return nil, err
			}
			for _, e := range entries {
				if e.IsDir() {
					dirs = append(dirs, filepath.ToSlash(filepath.Join("fixtures", cli, v.Name(), e.Name())))
				}
			}
		}
	}
	sort.Strings(dirs)
	return dirs, nil
}

// normalizeArgs builds the invocation for one fixture. A fixture shipping
// links.json exercises the --links merge; without it index.json lacks the links
// and the diff fails for the wrong reason.
func normalizeArgs(dir, out string) []string {
	args := []string{"normalize", dir, "--out", out}
	if _, err := os.Stat(dir + "/links.json"); err == nil {
		args = append(args, "--links", dir+"/links.json")
	}
	return args
}

// runFixture normalizes dir into out and returns the RUN.txt expectation: the
// exit code, then stdout, then stderr sorted.
//
// Recording behaviour rather than just documents is what gives empty-session and
// all-skipped an expectation at all — they emit no documents by design — and it
// keeps their oracle directories non-empty, which git requires to track them.
//
// STDOUT is part of the expectation. It was once discarded, so nothing in the
// suite compared what the tool PRINTS: user-facing output could change freely
// with every gate green. The destination path is machine-specific, so it is
// replaced with <OUT>.
//
// STDERR is sorted because diagnostics come out in filesystem-walk order, which
// is not stable across machines. By byte — see the note at the top of this file.
func runFixture(dir, out string) string {
	var stdout, stderr bytes.Buffer
	code := Main(normalizeArgs(dir, out), &stdout, &stderr)

	var b strings.Builder
	fmt.Fprintf(&b, "exit %d\n", code)
	if s := strings.TrimSuffix(stdout.String(), "\n"); s != "" {
		for l := range strings.SplitSeq(s, "\n") {
			b.WriteString("stdout: " + strings.ReplaceAll(l, out, "<OUT>") + "\n")
		}
	}
	if s := strings.TrimSuffix(stderr.String(), "\n"); s != "" {
		lines := strings.Split(s, "\n")
		sort.Strings(lines)
		b.WriteString(strings.Join(lines, "\n") + "\n")
	}
	return b.String()
}

const oraclePin = "self — produced by cs-tracer; no external reference\n"

// TestUpdateGoldens rewrites oracle/. It is a test only because that is the
// cheapest way to reach the same in-process entry point the gates use;
// scripts/gen-goldens.sh is the interface, and cmd/cs-tracer is a one-line shim
// over Main, so generating in-process and generating through the binary are the
// same act.
//
// Regenerating can make ANY gate pass, because the goldens are produced by the
// tool they test. Reviewing the diff is the only check.
func TestUpdateGoldens(t *testing.T) {
	if !*updateGoldens {
		t.Skip("rewrites oracle/; run scripts/gen-goldens.sh")
	}
	root := repoRoot(t)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Diagnostics quote fixture paths relative to the repository root, so
	// generation must run from there — the same reason the gates do.
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })

	dirs, err := listFixtureDirs(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(dirs) == 0 {
		t.Fatal("no fixture directories found")
	}

	oracle := filepath.Join(root, "oracle")
	if err := os.MkdirAll(oracle, 0o755); err != nil {
		t.Fatal(err)
	}
	// Drop the existing trees first. A fixture removed from the corpus has to
	// lose its golden too, otherwise a tree nothing produces any more survives
	// and the fixture/oracle count check keeps passing against it.
	entries, err := os.ReadDir(oracle)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.IsDir() {
			if err := os.RemoveAll(filepath.Join(oracle, e.Name())); err != nil {
				t.Fatal(err)
			}
		}
	}

	for _, dir := range dirs {
		dest := filepath.Join(oracle, strings.TrimPrefix(dir, "fixtures/"))
		if err := os.MkdirAll(dest, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dest, "RUN.txt"), []byte(runFixture(dir, dest)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(oracle, "ORACLE_PIN"), []byte(oraclePin), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("regenerated %d oracle trees from cs-tracer itself", len(dirs))
}
