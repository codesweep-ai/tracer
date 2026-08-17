package normalizer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadLinksWarnsAndKeepsValidEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "links.json")
	data := `[{"fromSessionId":"a","toSessionId":"b","kind":"spawn"},{"fromSessionId":"a","kind":"broken"}]`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	links, diagnostics := loadLinks(path)
	if len(links) != 1 || len(diagnostics) != 1 || !strings.Contains(diagnostics[0], "invalid links entry 1") {
		t.Fatalf("links=%d diagnostics=%q", len(links), diagnostics)
	}
}

func TestLoadLinksMalformedJSONWarns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "links.json")
	if err := os.WriteFile(path, []byte(`{`), 0o644); err != nil {
		t.Fatal(err)
	}
	links, diagnostics := loadLinks(path)
	if len(links) != 0 || len(diagnostics) != 1 || !strings.Contains(diagnostics[0], "could not read links file") {
		t.Fatalf("links=%d diagnostics=%q", len(links), diagnostics)
	}
}
