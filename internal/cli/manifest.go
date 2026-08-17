package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// manifestName is the bookkeeping file --split writes into its output
// directory. It makes regenerating into your own previous
// output need no flag, and it makes --force safe: cleaning deletes exactly the
// listed paths, so a mistyped `-o ~/Documents --split --force` cannot destroy
// unrelated content. Paths are relative to the manifest, so the directory
// stays movable.
const manifestName = ".cs-tracer.json"

type manifest struct {
	ManifestVersion int      `json:"manifestVersion"`
	Tool            string   `json:"tool"`
	ToolVersion     string   `json:"toolVersion"`
	GeneratedAt     string   `json:"generatedAt"`
	Files           []string `json:"files"`
}

// readManifest loads the manifest in dir. An unparseable manifest, a wrong
// manifestVersion, the wrong tool, or a hostile path (absolute, empty,
// escaping the directory) all mean ABSENT: the caller then refuses
// without --force rather than guessing at what to delete.
func readManifest(dir string) (manifest, bool) {
	b, err := os.ReadFile(filepath.Join(dir, manifestName))
	if err != nil {
		return manifest{}, false
	}
	var m manifest
	if json.Unmarshal(b, &m) != nil || m.ManifestVersion != 1 || m.Tool != "cs-tracer" {
		return manifest{}, false
	}
	for _, p := range m.Files {
		clean := filepath.Clean(filepath.FromSlash(p))
		if p == "" || filepath.IsAbs(p) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return manifest{}, false
		}
	}
	return m, true
}

// prepareSplit implements the overwrite matrix for --split:
//
//	target does not exist, or is empty   → create and write
//	target contains our manifest         → delete exactly the files it lists, regenerate — no flag
//	target non-empty, no manifest        → refuse: not a cs-tracer output directory; use --force
//	any of the above, with --force       → proceed
//
// --force never means `rm -rf <dir>`: without a trustworthy manifest it
// deletes only index.html, traces/ and assets/ — the paths cs-tracer owns —
// so output from an older layout is still cleaned correctly by manifest
// contents, and foreign files always survive.
func prepareSplit(dir string, force bool) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return os.MkdirAll(dir, 0o755)
	}
	if err != nil {
		return fmt.Errorf("split output directory: %w", err)
	}
	if len(entries) == 0 {
		return nil
	}
	m, ours := readManifest(dir)
	switch {
	case ours:
		for _, p := range m.Files {
			if err := os.RemoveAll(filepath.Join(dir, filepath.FromSlash(p))); err != nil {
				return err
			}
		}
		_ = os.Remove(filepath.Join(dir, manifestName))
		return nil
	case !force:
		return errors.New("not a cs-tracer output directory; use --force")
	default:
		for _, p := range []string{"index.html", "traces", "assets"} {
			if err := os.RemoveAll(filepath.Join(dir, p)); err != nil {
				return err
			}
		}
		return nil
	}
}
