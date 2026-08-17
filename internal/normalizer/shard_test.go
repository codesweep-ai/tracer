package normalizer

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/codesweep-ai/tracer/internal/oracletest"
)

func TestClaudeSimpleShardsMatchOracle(t *testing.T) {
	root := filepath.Join("..", "..")
	doc, err := NormalizeFile(filepath.Join(root, "fixtures", "claude", "v2.1", "simple", "session.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	files, err := ShardBytes(doc)
	if err != nil {
		t.Fatal(err)
	}
	id := str(get(object(get(doc, "meta")), "sessionId"))
	var names []string
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		want, err := os.ReadFile(filepath.Join(root, "oracle", "claude", "v2.1", "simple", id, name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(files[name], want) {
			n := oracletest.FirstDifference(files[name], want)
			t.Fatalf("%s differs at byte %d\n got: %q\nwant: %q", name, n, oracletest.Window(files[name], n), oracletest.Window(want, n))
		}
	}
}
