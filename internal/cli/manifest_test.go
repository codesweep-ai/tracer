package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validManifest(files ...string) string {
	b, _ := json.Marshal(manifest{ManifestVersion: 1, Tool: "cs-tracer", ToolVersion: "test", Files: files})
	return string(b)
}

// TestPrepareSplitOverwriteMatrix covers every row of prepareSplit's overwrite
// matrix plus the treated-as-absent manifest cases.
func TestPrepareSplitOverwriteMatrix(t *testing.T) {
	type row struct {
		name        string
		setup       string
		force       bool
		wantErr     bool
		ownedGone   string
		keepSurvive bool
	}
	rows := []row{
		{"does not exist: create and write", "missing", false, false, "", false},
		{"empty: write", "empty", false, false, "", false},
		{"our manifest: clean listed files, no flag", "manifest", false, false, "owned.txt", true},
		{"our manifest with --force: same cleaning", "manifest", true, false, "owned.txt", true},
		{"non-empty no manifest: refuse", "foreign", false, true, "", true},
		{"non-empty no manifest with --force: clean owned paths only", "foreign", true, false, "index.html", true},
		{"unparseable manifest is absent: refuse", "bad-manifest", false, true, "", true},
		{"wrong manifestVersion is absent: refuse", "old-version", false, true, "", true},
		{"wrong tool is absent: refuse", "wrong-tool", false, true, "", true},
		{"unparseable manifest with --force: clean owned paths only", "bad-manifest", true, false, "index.html", true},
	}
	for _, tt := range rows {
		t.Run(tt.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "out")
			switch tt.setup {
			case "missing":
			case "empty":
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			case "manifest":
				put(t, filepath.Join(dir, "owned.txt"), "owned")
				put(t, filepath.Join(dir, "keep.txt"), "keep")
				put(t, filepath.Join(dir, ".cs-tracer.json"), validManifest("owned.txt"))
			case "foreign":
				put(t, filepath.Join(dir, "index.html"), "foreign")
				put(t, filepath.Join(dir, "keep.txt"), "keep")
			case "bad-manifest":
				put(t, filepath.Join(dir, "index.html"), "foreign")
				put(t, filepath.Join(dir, "keep.txt"), "keep")
				put(t, filepath.Join(dir, ".cs-tracer.json"), "{")
			case "old-version":
				put(t, filepath.Join(dir, "owned.txt"), "owned")
				put(t, filepath.Join(dir, "keep.txt"), "keep")
				put(t, filepath.Join(dir, ".cs-tracer.json"), `{"manifestVersion":2,"tool":"cs-tracer","files":["owned.txt"]}`)
			case "wrong-tool":
				put(t, filepath.Join(dir, "owned.txt"), "owned")
				put(t, filepath.Join(dir, "keep.txt"), "keep")
				put(t, filepath.Join(dir, ".cs-tracer.json"), `{"manifestVersion":1,"tool":"other","files":["owned.txt"]}`)
			}
			err := prepareSplit(dir, tt.force)
			if (err != nil) != tt.wantErr {
				t.Fatalf("error=%v wantErr=%v", err, tt.wantErr)
			}
			if tt.wantErr && !strings.Contains(err.Error(), "not a cs-tracer output directory; use --force") {
				t.Fatalf("wrong refusal: %v", err)
			}
			if tt.ownedGone != "" {
				if _, e := os.Stat(filepath.Join(dir, tt.ownedGone)); !os.IsNotExist(e) {
					t.Errorf("owned path %s survived cleaning: %v", tt.ownedGone, e)
				}
			}
			if tt.keepSurvive {
				b, e := os.ReadFile(filepath.Join(dir, "keep.txt"))
				if e != nil || string(b) != "keep" {
					t.Errorf("unrelated file did not survive: %q %v", b, e)
				}
			}
		})
	}
}

func TestReadManifestHostilePathsAreAbsent(t *testing.T) {
	for name, files := range map[string][]string{
		"parent escape":    {"../outside.txt"},
		"exact parent":     {".."},
		"absolute":         {"/etc/passwd"},
		"empty":            {""},
		"nested escape":    {"a/../../outside.txt"},
		"manifest itself?": {".cs-tracer.json"}, // legal to list; treated as a normal file
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			put(t, filepath.Join(dir, ".cs-tracer.json"), validManifest(files...))
			_, ok := readManifest(dir)
			if name == "manifest itself?" {
				if !ok {
					t.Fatal("listing the manifest itself is not hostile")
				}
				return
			}
			if ok {
				t.Fatalf("hostile manifest %v was trusted", files)
			}
		})
	}
}

// TestForceNeverDestroysUnrelatedFiles is the mistyped
// `-o ~/Documents --split --force` guard: only cs-tracer's own paths go.
func TestForceNeverDestroysUnrelatedFiles(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "Documents")
	put(t, filepath.Join(dest, "thesis.pdf"), "important")
	put(t, filepath.Join(dest, "index.html"), "some page")
	put(t, filepath.Join(dest, "traces", "old.html"), "old")
	put(t, filepath.Join(dest, "assets", "old.js"), "old")
	if err := prepareSplit(dest, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "thesis.pdf")); err != nil {
		t.Fatalf("unrelated file destroyed: %v", err)
	}
	for _, p := range []string{"index.html", "traces", "assets"} {
		if _, err := os.Stat(filepath.Join(dest, p)); !os.IsNotExist(err) {
			t.Errorf("owned path %s survived --force cleaning", p)
		}
	}
}

// TestManifestCleanHonorsListedPathsNotLayout: output from an older layout is
// cleaned by manifest contents, not by assumed paths.
func TestManifestCleanHonorsListedPathsNotLayout(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "old-layout", "page.html"), "old")
	put(t, filepath.Join(dir, "unrelated.txt"), "keep")
	put(t, filepath.Join(dir, ".cs-tracer.json"), validManifest("old-layout/page.html", "old-layout"))
	if err := prepareSplit(dir, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old-layout")); !os.IsNotExist(err) {
		t.Fatal("manifest-listed directory survived")
	}
	if _, err := os.Stat(filepath.Join(dir, "unrelated.txt")); err != nil {
		t.Fatal("unrelated file removed")
	}
}
