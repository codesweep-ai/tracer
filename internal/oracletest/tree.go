// Package oracletest holds the byte-exact comparison helpers the oracle gates
// share.
//
// It exists because of a Go rule rather than a design preference: identifiers
// declared in _test.go files are not visible outside their own package. The same
// tree is checked at two seams — internal/normalizer against NormalizeDirectory,
// internal/cli against the full command — and with no importable home the
// helper was simply copied.
//
// The copies then drifted, which is the argument for this package. They took
// their arguments in OPPOSITE orders (got, want) and (want, got), so a
// correct-looking copy between them silently inverted the comparison; and only
// one of them reported where the bytes diverged, leaving the other to say
// "differs (1234 vs 1240 bytes)" about a format whose whole contract is its
// bytes.
//
// Nothing outside _test.go files imports this package, so it is not linked into
// the binary.
package oracletest

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// CompareTree requires got and want to contain exactly the same files with
// exactly the same bytes.
//
// Argument order is (got, want) — the Go convention, and the one order used
// everywhere now.
//
// RUN.txt is excluded. It records the invocation itself (exit code, stdout,
// stderr), which no implementation writes into its output tree; internal/cli
// owns that comparison.
func CompareTree(tb testing.TB, got, want string) {
	tb.Helper()
	read := func(base string) map[string][]byte {
		files := map[string][]byte{}
		err := filepath.WalkDir(base, func(p string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.IsDir() || d.Name() == "RUN.txt" {
				return nil
			}
			rel, e := filepath.Rel(base, p)
			if e != nil {
				return e
			}
			b, e := os.ReadFile(p)
			if e != nil {
				return e
			}
			files[filepath.ToSlash(rel)] = b
			return nil
		})
		if err != nil {
			tb.Fatal(err)
		}
		return files
	}

	gotFiles, wantFiles := read(got), read(want)
	// Report EVERY difference rather than stopping at the first. A deliberate
	// format change moves many files at once, and failing fast would turn one
	// review into a run-fix-rerun loop.
	for name, w := range wantFiles {
		g, ok := gotFiles[name]
		if !ok {
			tb.Errorf("missing %s", name)
			continue
		}
		if !bytes.Equal(g, w) {
			i := FirstDifference(g, w)
			tb.Errorf("%s differs at byte %d\n got: %q\nwant: %q", name, i, Window(g, i), Window(w, i))
		}
	}
	for name := range gotFiles {
		if _, ok := wantFiles[name]; !ok {
			tb.Errorf("unexpected file %s", name)
		}
	}
}

// FirstDifference returns the index of the first differing byte, or the length
// of the shorter slice when one is a prefix of the other.
func FirstDifference(a, b []byte) int {
	n := min(len(a), len(b))
	for i := range n {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

// Window renders the bytes around n, so a byte offset in a compact one-line
// JSON document is actually readable.
func Window(b []byte, n int) string {
	lo := max(0, n-80)
	hi := min(len(b), n+160)
	return string(b[lo:hi])
}
