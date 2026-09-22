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
// malformedRef reports a cross-session reference that cannot be an identifier.
// Whitespace is the discriminator: every CLI in scope emits ids as unbroken
// tokens (uuid, ses_..., hex), so a space means the value was rewritten by
// something that took it for prose.
func malformedRef(ref string) bool {
	return ref != "" && strings.ContainsAny(ref, " \t\n")
}

// skippedDirs are never entered: a dependency tree, a build, a cache, and a
// normalized tree's own chunks, whose files would otherwise read as sessions.
var skippedDirs = map[string]bool{"node_modules": true, "dist": true, ".trace-cache": true, "chunks": true}

// candidate reports whether a file name is one discovery reads: a .json or
// .jsonl file that is not a sidecar and not a normalized tree's own index or
// summary (SPEC.md §4).
func candidate(name string) bool {
	return (strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".jsonl")) && !strings.HasSuffix(name, ".meta.json") && name != "index.json" && name != "summary.json"
}

// discover lists the candidate files under input, depth first and in name
// order within each directory, so two runs read the same files in the same
// order (R36). A link to a folder is followed (R86): a set assembled from links
// is the user saying what counts, and a sub-agent folder linked beside its
// session used to vanish with no word said (TRC-038). Each real folder is read
// once, however many paths lead to it, so a link back up the tree cannot loop
// and a folder linked and present cannot ship its sessions twice. A link that
// leads nowhere is returned in dangling for the caller to report as a skip.
func discover(input string) (files, dangling []string, err error) {
	info, err := os.Stat(input)
	if err != nil {
		return nil, nil, err
	}
	if !info.IsDir() {
		if candidate(filepath.Base(input)) {
			files = append(files, input)
		}
		return files, nil, nil
	}
	visited := map[string]bool{}
	var walk func(dir string) error
	walk = func(dir string) error {
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			return err
		}
		if visited[real] {
			return nil
		}
		visited[real] = true
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, d := range entries {
			path := filepath.Join(dir, d.Name())
			isDir := d.IsDir()
			if d.Type()&fs.ModeSymlink != 0 {
				target, err := os.Stat(path)
				if err != nil {
					dangling = append(dangling, path)
					continue
				}
				isDir = target.IsDir()
			}
			if isDir {
				if skippedDirs[d.Name()] {
					continue
				}
				if err := walk(path); err != nil {
					return err
				}
				continue
			}
			if candidate(d.Name()) {
				files = append(files, path)
			}
		}
		return nil
	}
	if err := walk(input); err != nil {
		return nil, nil, err
	}
	return files, dangling, nil
}

func NormalizeDirectory(input, out, linksPath string) (TreeResult, error) {
	var result TreeResult
	// Resolve the input to an absolute path before discovery, but report skips
	// relative to the working directory — SPEC.md §4 makes that wording part of
	// the contract.
	if abs, err := filepath.Abs(input); err == nil {
		input = abs
	}
	files, dangling, err := discover(input)
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
	for _, link := range dangling {
		result.Skipped++
		rel := link
		if r, x := filepath.Rel(cwd, link); x == nil {
			rel = r
		}
		result.Diagnostics = append(result.Diagnostics, fmt.Sprintf("skipping %s: link leads nowhere", filepath.ToSlash(rel)))
	}
	candidates := len(files) + len(dangling)
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
		// Where under the input the session was read from (TRC-005). Relative,
		// so a site built over several directories can tell their sessions
		// apart by it, and it reads the same on any machine.
		if dir, x := filepath.Rel(input, filepath.Dir(file)); x == nil {
			object(get(doc, "meta")).Set("sourceDir", filepath.ToSlash(dir))
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
		if candidates > 0 && result.Skipped == candidates {
			// Sort the skip lines for a stable order, then add the summary,
			// which says "reported above" and has to follow them. Sorting the
			// summary in with them put it first, because "0" sorts before "s".
			sort.Strings(result.Diagnostics)
			result.Diagnostics = append(result.Diagnostics, fmt.Sprintf("0 sessions normalized (%d file(s) skipped, reported above)", result.Skipped))
			return result, nil
		}
		return result, errors.New("no supported session files found")
	}
	// A reference that is absent from the corpus is NOT reported: exporting one
	// trajectory without its children is a legitimate scope choice, and the
	// viewer already declines to offer a link it cannot resolve. What is
	// reported is a reference that cannot be a session id at all — no CLI emits
	// one containing whitespace — because that means something upstream
	// rewrote it. That is not hypothetical: the fixture scrubber exempts a
	// session's own id from prose redaction but did not exempt the keys that
	// REFERENCE it, so codex and opencode corpora shipped with every
	// parent/child edge replaced by prose ("each reads when"), and nothing
	// noticed for four runs — the reconciliation below only ever ran for
	// claude-code, whose reference keys happened to be exempt.
	for _, doc := range result.Documents {
		meta := object(get(doc, "meta"))
		sid := str(get(meta, "sessionId"))
		if pid := str(get(meta, "parentSessionId")); malformedRef(pid) {
			result.Diagnostics = append(result.Diagnostics,
				fmt.Sprintf("session %s: parentSessionId %q is not a session id", sid, pid))
		}
		for _, event := range get(doc, "events").([]*obj) {
			if cid := str(get(event, "childSessionId")); malformedRef(cid) {
				result.Diagnostics = append(result.Diagnostics,
					fmt.Sprintf("session %s: childSessionId %q is not a session id", sid, cid))
			}
		}
	}
	for _, doc := range result.Documents {
		meta := object(get(doc, "meta"))
		// Was gated to claude-code, so codex and opencode never had their
		// parent/child edges reconciled at all.
		if !present(get(meta, "parentSessionId")) {
			continue
		}
		sid := str(get(meta, "sessionId"))
		for _, candidate := range result.Documents {
			if candidate == doc {
				continue
			}
			// The index of the spawning event, or -1 for no match. This loop is
			// the ONLY place both documents are in hand, so it is the only place
			// the position can be learned: an adapter sees one transcript, and a
			// split-mode trace page carries its own summary plus a reduced index
			// of {id, safeId, title}. Stamping it on the child is what lets that
			// page offer the way back (R59).
			found := -1
			for _, event := range get(candidate, "events").([]*obj) {
				tool := object(get(event, "tool"))
				if (spawn[sid] != "" && str(get(tool, "callId")) == spawn[sid]) || str(get(event, "childSessionId")) == sid {
					found = int(num(get(event, "i")))
					break
				}
			}
			parentID := str(get(object(get(candidate, "meta")), "sessionId"))
			if found < 0 {
				continue
			}
			// Set whenever the spawn is found, not only when the declared
			// parent disagreed: a child whose parentSessionId was already
			// correct still needs the position.
			meta.Set("parentEventIndex", found)
			if parentID != str(get(meta, "parentSessionId")) {
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
	o := trajectory.NewObject("schemaVersion", SchemaVersion, "trajectories", list)
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
