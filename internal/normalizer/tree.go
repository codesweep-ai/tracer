package normalizer

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

type TreeResult struct {
	Documents   []*obj
	Skipped     int
	Diagnostics []string
}

// NormalizeDirectory normalizes a set and writes the oracle-compatible tree.
func NormalizeDirectory(input, out, linksPath string) (TreeResult, error) {
	var result TreeResult
	// Resolve the input to an absolute path before discovery, but report skips
	// relative to the working directory — SPEC.md §4 makes that wording part of
	// the contract.
	if abs, err := filepath.Abs(input); err == nil {
		input = abs
	}
	var files []string
	err := filepath.WalkDir(input, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != input && (d.Name() == "node_modules" || d.Name() == "dist" || d.Name() == ".trace-cache" || d.Name() == "chunks") {
				return filepath.SkipDir
			}
			return nil
		}
		n := d.Name()
		if (strings.HasSuffix(n, ".json") || strings.HasSuffix(n, ".jsonl")) && !strings.HasSuffix(n, ".meta.json") && n != "index.json" && n != "summary.json" {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	// Create the output directory before processing any file, so even an
	// all-skipped run leaves an existing-but-empty output tree (SPEC.md §4: a run
	// producing no documents is not an error).
	if err = os.MkdirAll(out, 0o755); err != nil {
		return result, err
	}
	cwd, _ := os.Getwd()
	spawn := map[string]string{}
	for _, file := range files {
		doc, e := NormalizeFile(file)
		if e == nil && len(get(doc, "events").([]*obj)) == 0 {
			e = fmt.Errorf("normalized to zero events (adapter: %s) — not a session file", str(get(object(get(doc, "parse")), "adapter")))
		}
		if e != nil {
			result.Skipped++
			// The reference reports path.relative(process.cwd(), file).
			rel := file
			if r, x := filepath.Rel(cwd, file); x == nil {
				rel = r
			}
			result.Diagnostics = append(result.Diagnostics, fmt.Sprintf("skipping %s: %v", filepath.ToSlash(rel), e))
			continue
		}
		result.Documents = append(result.Documents, doc)
		if str(get(object(get(doc, "meta")), "source")) == "claude-code" && strings.Contains(filepath.ToSlash(file), "subagents/") {
			side := strings.TrimSuffix(file, ".jsonl") + ".meta.json"
			if b, x := os.ReadFile(side); x == nil {
				if v, x := trajectory.Decode(b); x == nil {
					if id := str(get(object(v), "toolUseId")); id != "" {
						spawn[str(get(object(get(doc, "meta")), "sessionId"))] = id
					}
				}
			}
		}
	}
	if len(result.Documents) == 0 {
		if len(files) > 0 && result.Skipped == len(files) {
			result.Diagnostics = append(result.Diagnostics, fmt.Sprintf("0 sessions normalized (%d file(s) skipped, reported above)", result.Skipped))
			sort.Strings(result.Diagnostics)
			return result, nil
		}
		return result, errors.New("no supported session files found")
	}
	for _, doc := range result.Documents {
		meta := object(get(doc, "meta"))
		if str(get(meta, "source")) != "claude-code" || !present(get(meta, "parentSessionId")) {
			continue
		}
		sid := str(get(meta, "sessionId"))
		for _, candidate := range result.Documents {
			if candidate == doc {
				continue
			}
			found := false
			for _, event := range get(candidate, "events").([]*obj) {
				tool := object(get(event, "tool"))
				if (spawn[sid] != "" && str(get(tool, "callId")) == spawn[sid]) || str(get(event, "childSessionId")) == sid {
					found = true
					break
				}
			}
			parentID := str(get(object(get(candidate, "meta")), "sessionId"))
			if found && parentID != str(get(meta, "parentSessionId")) {
				meta.Set("parentSessionId", parentID)
			}
		}
	}
	if e := os.MkdirAll(out, 0o755); e != nil {
		return result, e
	}
	for _, doc := range result.Documents {
		id := str(get(object(get(doc, "meta")), "sessionId"))
		if e := WriteSharded(doc, filepath.Join(out, safeID(id))); e != nil {
			return result, e
		}
	}
	links, linkDiagnostics := loadLinks(linksPath)
	result.Diagnostics = append(result.Diagnostics, linkDiagnostics...)
	if _, e := writeIndex(out, result.Documents, links, &result); e != nil {
		return result, e
	}
	sort.Strings(result.Diagnostics)
	return result, nil
}

// writeIndex writes the final index. Previous
// trajectories survive a re-run into the same directory — a re-normalized id
// keeps its position, new ids append in document order — and a fresh non-empty
// --links set replaces previously merged links, while an empty one preserves
// them.
func writeIndex(out string, docs []*obj, links []any, result *TreeResult) ([]byte, error) {
	previous, warning := readPreviousIndex(out)
	if warning != "" {
		result.Diagnostics = append(result.Diagnostics, warning)
	}
	type entry struct{ id, path string }
	var order []string
	entries := map[string]entry{}
	for _, p := range previous {
		if _, ok := entries[p.id]; !ok {
			order = append(order, p.id)
		}
		entries[p.id] = p
	}
	for _, d := range docs {
		id := str(get(object(get(d, "meta")), "sessionId"))
		if _, ok := entries[id]; !ok {
			order = append(order, id)
		}
		entries[id] = entry{id, safeID(id)}
	}
	list := make([]any, 0, len(order))
	for _, id := range order {
		e := entries[id]
		list = append(list, trajectory.NewObject("id", e.id, "path", e.path))
	}
	o := trajectory.NewObject("schemaVersion", 2, "trajectories", list)
	rootLinks := links
	if len(rootLinks) == 0 {
		rootLinks = previousLinks(out)
	}
	if len(rootLinks) > 0 {
		o.Set("links", rootLinks)
	}
	b, err := pretty(o)
	if err != nil {
		return nil, err
	}
	return b, os.WriteFile(filepath.Join(out, "index.json"), b, 0o644)
}

// readPreviousIndex reads and validates an existing index.json the way the
// reference does: any structural problem (beyond absence) downgrades to a
// warning and a rewrite.
func readPreviousIndex(out string) (entries []struct{ id, path string }, warning string) {
	indexPath := filepath.Join(out, "index.json")
	b, err := os.ReadFile(indexPath)
	if err != nil {
		return nil, "" // ENOENT: create a new cache index.
	}
	fail := func(msg string) ([]struct{ id, path string }, string) {
		return nil, fmt.Sprintf("warning: could not merge existing %s; rewriting it: %s", indexPath, msg)
	}
	v, err := trajectory.Decode(b)
	if err != nil {
		return fail(err.Error())
	}
	root := object(v)
	if root == nil {
		return fail("missing trajectories array")
	}
	raw, ok := root.Get("trajectories")
	if !ok {
		return fail("missing trajectories array")
	}
	items := array(raw)
	if items == nil {
		return fail("missing trajectories array")
	}
	var out2 []struct{ id, path string }
	for _, item := range items {
		e := object(item)
		id, idOK := get(e, "id").(string)
		p, pOK := get(e, "path").(string)
		if !idOK || !pOK {
			return fail("invalid trajectory entry")
		}
		out2 = append(out2, struct{ id, path string }{id, p})
	}
	if l, ok := root.Get("links"); ok {
		if _, isArr := l.([]any); !isArr {
			return fail("invalid links value")
		}
	}
	return out2, ""
}

// previousLinks extracts the links array of an existing index.json, if valid.
func previousLinks(out string) []any {
	b, err := os.ReadFile(filepath.Join(out, "index.json"))
	if err != nil {
		return nil
	}
	v, err := trajectory.Decode(b)
	if err != nil {
		return nil
	}
	root := object(v)
	if root == nil {
		return nil
	}
	raw, ok := root.Get("trajectories")
	if !ok || array(raw) == nil {
		return nil
	}
	for _, item := range array(raw) {
		e := object(item)
		if _, ok := get(e, "id").(string); !ok {
			return nil
		}
		if _, ok := get(e, "path").(string); !ok {
			return nil
		}
	}
	l, ok := root.Get("links")
	if !ok {
		return nil
	}
	return array(l)
}

func loadLinks(path string) ([]any, []string) {
	if path == "" {
		return nil, nil
	}
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, []string{fmt.Sprintf("warning: could not read links file %s: %v", path, err)}
	}
	value, err := trajectory.Decode(b)
	if err != nil {
		return nil, []string{fmt.Sprintf("warning: could not read links file %s: %v", path, err)}
	}
	entries, ok := value.([]any)
	if !ok {
		return nil, []string{fmt.Sprintf("warning: links file %s must contain a JSON array; ignoring it", path)}
	}
	valid := make([]any, 0, len(entries))
	var diagnostics []string
	for i, entry := range entries {
		link := object(entry)
		if link != nil && presentString(link, "fromSessionId") && presentString(link, "toSessionId") && presentString(link, "kind") && optionalString(link, "label") && optionalString(link, "evidence") {
			valid = append(valid, entry)
			continue
		}
		diagnostics = append(diagnostics, fmt.Sprintf("warning: skipping invalid links entry %d in %s", i, path))
	}
	return valid, diagnostics
}

func presentString(value *obj, key string) bool {
	_, ok := get(value, key).(string)
	return ok
}

func optionalString(value *obj, key string) bool {
	v, exists := value.Get(key)
	if !exists {
		return true
	}
	_, ok := v.(string)
	return ok
}
