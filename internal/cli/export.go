package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// warnSizeBytes is the oversize warning threshold, derived
// from the failure it predicts rather than chosen for roundness: browsers
// parse HTML at roughly 20–50 MB/s and must finish before first paint, so a
// 3-second budget breaks somewhere around 60–150 MB; warning at 25 MB puts the
// notice well before the cliff, and 25 MB is also about six maximum-size
// (1M-token) traces — where a comparison view stops being a comfortable read
// anyway. Oversize is a warning, not a decision: stderr, exit 0, no refusal.
const warnSizeBytes int64 = 25 * 1024 * 1024

func runExport(input string, o options, stdout, stderr io.Writer) error {
	start := time.Now()
	setRoot := input
	preNormalized := false
	if _, err := os.Stat(filepath.Join(input, "index.json")); err == nil {
		preNormalized = true
	}
	if !preNormalized {
		// Normalize through a temp dir: nothing is left on disk beside the export.
		tmp, err := os.MkdirTemp("", "cs-tracer-normalize-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		if err := normalizeToTree(input, tmp, o.links, nil, stderr); err != nil {
			return err
		}
		setRoot = tmp
	}
	set, err := loadSet(setRoot)
	if err != nil {
		return err
	}
	if preNormalized && o.links != "" {
		// A previously normalized input never goes through the normalizer, so
		// merge caller-supplied link hints here: a non-empty
		// set replaces the root links, an empty one clears them.
		if err := set.mergeLinks(o.links, stderr); err != nil {
			return err
		}
	}
	dest, shown, err := destination(o, input)
	if err != nil {
		return err
	}
	if o.split {
		return exportSplit(dest, shown, set, o, stdout, stderr, start)
	}
	return exportSingle(dest, shown, set, o, stdout, stderr, start)
}

// mergeLinks parses and validates the --links file — malformed links warn and
// continue, never fatal — and rebuilds the root index with the resulting array.
func (set *dataSet) mergeLinks(path string, stderr io.Writer) error {
	links := loadLinks(path, stderr)
	var index struct {
		SchemaVersion int             `json:"schemaVersion"`
		Trajectories  json.RawMessage `json:"trajectories"`
	}
	if err := json.Unmarshal(set.Index, &index); err != nil {
		return err
	}
	rebuilt := struct {
		SchemaVersion int             `json:"schemaVersion"`
		Trajectories  json.RawMessage `json:"trajectories"`
		Links         json.RawMessage `json:"links,omitempty"`
	}{index.SchemaVersion, index.Trajectories, links}
	b, err := json.MarshalIndent(rebuilt, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	set.Index = b
	set.Links = links
	return nil
}

// loadLinks reads a JSON array of
// {fromSessionId, toSessionId, kind, label?, evidence?}; unreadable or
// malformed files warn and continue with exit 0.
func loadLinks(path string, stderr io.Writer) json.RawMessage {
	b, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(stderr, "warning: could not read links file %s: %s\n", path, err)
		return nil
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		fmt.Fprintf(stderr, "warning: links file %s must contain a JSON array; ignoring it\n", path)
		return nil
	}
	var valid []json.RawMessage
	for i, entry := range raw {
		if isLink(entry) {
			valid = append(valid, entry)
		} else {
			fmt.Fprintf(stderr, "warning: skipping invalid links entry %d in %s\n", i, path)
		}
	}
	if len(valid) == 0 {
		return nil
	}
	out, err := json.Marshal(valid)
	if err != nil {
		return nil // unreachable: every entry unmarshalled already
	}
	return out
}

// isLink reports whether raw carries the three required string fields.
// Entries that do not are dropped rather than failing the run.
func isLink(raw json.RawMessage) bool {
	var v map[string]json.RawMessage
	if err := json.Unmarshal(raw, &v); err != nil {
		return false
	}
	isString := func(key string) bool {
		raw, ok := v[key]
		if !ok {
			return false
		}
		var s string
		return json.Unmarshal(raw, &s) == nil
	}
	optionalString := func(key string) bool {
		_, ok := v[key]
		return !ok || isString(key)
	}
	return isString("fromSessionId") && isString("toSessionId") && isString("kind") &&
		optionalString("label") && optionalString("evidence")
}

func exportSingle(dest, shown string, set dataSet, o options, stdout, stderr io.Writer, start time.Time) error {
	var sb strings.Builder
	dataBlocks(&sb, set, "single", nil)
	out := inject(singleShell, []byte(sb.String()))
	reportSize(stderr, shown, int64(len(out)), set, false, o.input)
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	// Single-file output overwrites freely: re-exporting over your own
	// previous foo.html is the normal case.
	if err := os.WriteFile(dest, out, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "wrote %s (%s) in %.1fs\n", shown, humanSize(int64(len(out))), time.Since(start).Seconds())
	return nil
}

func exportSplit(dest, shown string, set dataSet, o options, stdout, stderr io.Writer, start time.Time) error {
	type outFile struct {
		rel  string // slash-separated, relative to dest — what the manifest lists
		data []byte
	}
	var root strings.Builder
	dataBlocks(&root, set, "split", nil)
	files := []outFile{
		{"index.html", inject(splitShell, []byte(root.String()))},
		{"assets/app.js", splitJS},
		{"assets/app.css", splitCSS},
	}
	for i := range set.Traces {
		t := &set.Traces[i]
		// Trace pages reference ../assets relatively; they do not each inline
		// the shell (SPEC.md §5: inlining ~320 K per page would add ~42 MB across a
		// 130-trace export).
		shell := strings.ReplaceAll(splitShell, "./assets/", "../assets/")
		var page strings.Builder
		dataBlocks(&page, set, "split", t)
		files = append(files, outFile{"traces/" + t.SafeID + ".html", inject(shell, []byte(page.String()))})
	}
	m := manifest{
		ManifestVersion: 1,
		Tool:            "cs-tracer",
		ToolVersion:     version,
		GeneratedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	var total int64
	for _, f := range files {
		total += int64(len(f.data))
		m.Files = append(m.Files, f.rel)
	}
	manifestBytes, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	manifestBytes = append(manifestBytes, '\n')
	total += int64(len(manifestBytes))
	// The exact size is known before anything is written, so the report
	// carries a real number and appears before the file lands.
	reportSize(stderr, shown, total, set, true, o.input)
	if err := prepareSplit(dest, o.force); err != nil {
		return err
	}
	for _, f := range files {
		p := filepath.Join(dest, filepath.FromSlash(f.rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, f.data, 0o644); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(dest, manifestName), manifestBytes, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "wrote %s (%s) in %.1fs\n", shown, humanSize(total), time.Since(start).Seconds())
	return nil
}

// reportSize prints the exact output size ALWAYS (the number is ambient
// information, not a sudden scold) and the three-line warning past
// warnSizeBytes. stderr, exit 0 — the user asked for it.
func reportSize(stderr io.Writer, shown string, n int64, set dataSet, split bool, input string) {
	traces, events := set.stats()
	line := fmt.Sprintf("%s will be %s (%s traces, %s events)", shown, humanSize(n), comma(traces), comma(events))
	if n <= warnSizeBytes {
		fmt.Fprintln(stderr, line)
		return
	}
	fmt.Fprintln(stderr, "warning: "+line)
	fmt.Fprintln(stderr, "         browsers take ~2-5s to parse a file this size before first paint")
	if !split {
		fmt.Fprintf(stderr, "         consider: cs-tracer %s --split -o %s\n", input, strings.TrimSuffix(shown, filepath.Ext(shown))+"/")
	}
}

// humanSize renders byte counts in decimal SI units (64.2 MB). The threshold
// constant is binary (25 MiB, SPEC.md §5); only the display unit is decimal.
func humanSize(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1f MB", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1f KB", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// comma renders 50540 as "50,540", matching the size-warning format.
func comma(n int) string {
	s := strconv.Itoa(n)
	if n < 0 {
		return s // unreachable: event and trace counts are non-negative
	}
	var groups []string
	for len(s) > 3 {
		groups = append([]string{s[len(s)-3:]}, groups...)
		s = s[:len(s)-3]
	}
	return strings.Join(append([]string{s}, groups...), ",")
}
