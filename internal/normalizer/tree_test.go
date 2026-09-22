package normalizer

import (
	"os"
	"path/filepath"
	"strings"
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

// R58: a damaged transcript must not be skipped with the same line an unrelated
// file gets. It matters most for opencode, whose transcript is one JSON document
// extracted from the CLI's SQL store: a damaged extract parses as nothing at all
// and so cannot degrade into a partial trajectory the way a JSONL session does.
// Before this, both said "file contains no recognizable records" — the line a
// links.json beside a session also produces — so a damaged session vanished
// behind an expected-looking diagnostic.
func TestNormalizeDirectoryNamesDamagedInput(t *testing.T) {
	dir := t.TempDir()
	// A whole-document opencode export whose leading bytes were overwritten:
	// no line parses, and the bytes are not valid text.
	damaged := append([]byte{0xff, 0xfe, 0x00, 0x23, 0x83, 0x28}, []byte(`ages":[]}`)...)
	if err := os.WriteFile(filepath.Join(dir, "ses_damaged.json"), damaged, 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := NormalizeDirectory(dir, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 {
		t.Fatalf("Skipped = %d, want 1", result.Skipped)
	}
	var found bool
	for _, d := range result.Diagnostics {
		if strings.Contains(d, "binary or damaged") {
			found = true
		}
		if strings.Contains(d, "no recognizable records") {
			t.Fatalf("damaged input reported as unrecognized: %q", d)
		}
	}
	if !found {
		t.Fatalf("no damage diagnostic in %q", result.Diagnostics)
	}
}

// R59: the child carries the index of the event that spawned it. The index page
// could already derive this by scanning the parent's strip, because it holds
// every summary; a split-mode trace page holds only its own, so without the
// stamp a child had no way back to its fork point.
//
// Counts are pinned per fixture so a join that quietly stops resolving is a
// failure rather than a smaller number. claude/v2.1/subagent-depth2 stamps one
// of its two children: the other is the depth-2 agent whose `toolUseId` and
// `parentAgentId` the fixture scrubber rewrote to prose, which is the corpus
// hazard NormalizeDirectory's own comment records. A child with no discoverable
// spawn is not an error — the viewer falls back to the depth connector — so the
// contract is that a stamp, where present, is correct.
func TestNormalizeDirectoryStampsParentEventIndex(t *testing.T) {
	for _, tc := range []struct {
		fixture           string
		children, stamped int
	}{
		{"claude/v2.1/subagent-run", 2, 2},
		{"claude/v2.1/subagent-depth2", 2, 1},
		{"codex/v0.146/multi-agent-run", 2, 2},
		{"codex/v0.146/subagent-depth2", 2, 2},
		{"opencode/v1.18/multi-agent-run", 2, 2},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			result, err := NormalizeDirectory(filepath.Join("..", "..", "fixtures", tc.fixture), t.TempDir(), "")
			if err != nil {
				t.Fatal(err)
			}
			byID := map[string]*obj{}
			for _, doc := range result.Documents {
				byID[str(get(object(get(doc, "meta")), "sessionId"))] = doc
			}
			var children, stamped int
			for _, doc := range result.Documents {
				meta := object(get(doc, "meta"))
				parent, ok := byID[str(get(meta, "parentSessionId"))]
				if !ok {
					continue // a root, or a child exported without its parent
				}
				children++
				idx, present := meta.Get("parentEventIndex")
				if !present {
					continue
				}
				stamped++
				events := get(parent, "events").([]*obj)
				at := int(num(idx))
				if at < 0 || at >= len(events) {
					t.Fatalf("parentEventIndex %d out of range for a parent of %d events", at, len(events))
				}
				// It must name the event that spawned THIS child, not merely a
				// valid position in the parent.
				spawnEvent := events[at]
				if !truthy(get(spawnEvent, "subtask")) {
					t.Fatalf("parent event %d is not a spawn", at)
				}
				if cid := str(get(spawnEvent, "childSessionId")); cid != "" && cid != str(get(meta, "sessionId")) {
					t.Fatalf("parent event %d spawns %q, not this child %q", at, cid, str(get(meta, "sessionId")))
				}
			}
			if children != tc.children || stamped != tc.stamped {
				t.Fatalf("children=%d stamped=%d, want %d and %d", children, stamped, tc.children, tc.stamped)
			}
		})
	}
}

// Each session records the directory it was read from, relative to the input,
// so a site built over several directories can tell them apart (TRC-005).
func TestNormalizeDirectoryRecordsSourceDir(t *testing.T) {
	input := t.TempDir()
	copyInto := func(from, dir string) {
		b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", from))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(input, dir), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(input, dir, filepath.Base(from)), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	copyInto("claude/v2.1/simple/session.jsonl", "a/nested")
	copyInto("codex/v0.146/multi-agent-run/rollout-2026-07-31T01-13-27-77f0e564-f5d7-a937-aa50-ed64762175c7.jsonl", ".")
	result, err := NormalizeDirectory(input, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, doc := range result.Documents {
		meta := object(get(doc, "meta"))
		got[str(get(meta, "source"))] = str(get(meta, "sourceDir"))
	}
	if got["claude-code"] != "a/nested" || got["codex"] != "." {
		t.Fatalf("sourceDir by source: %v", got)
	}
}

// R86 (TRC-038). A link to a folder is followed, a folder reached twice is read
// once, a link back up the tree does not loop, and a link that leads nowhere is
// reported as a skip. The walk used to pass a linked folder over in silence, so
// a sub-agent folder linked beside its session vanished from the export.
func TestNormalizeDirectoryFollowsLinkedFolders(t *testing.T) {
	fixture, err := filepath.Abs(filepath.Join("..", "..", "fixtures", "claude", "v2.1", "subagent-run"))
	if err != nil {
		t.Fatal(err)
	}
	input := t.TempDir()
	link := func(target, name string) {
		if err := os.Symlink(target, filepath.Join(input, name)); err != nil {
			t.Fatal(err)
		}
	}
	link(filepath.Join(fixture, "4f00d255-46e9-4373-7232-09f72fda039e.jsonl"), "session.jsonl")
	link(filepath.Join(fixture, "58e37c63-95c0-4672-aca5-ad8a7e7ddc41"), "58e37c63-95c0-4672-aca5-ad8a7e7ddc41")
	link(filepath.Join(fixture, "58e37c63-95c0-4672-aca5-ad8a7e7ddc41"), "same-folder-again")
	link(input, "loop")
	link(filepath.Join(input, "missing.jsonl"), "gone.jsonl")
	result, err := NormalizeDirectory(input, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Documents) != 3 {
		t.Fatalf("documents = %d, want 3: the session and its two sub-agents, read once each", len(result.Documents))
	}
	seen := map[string]bool{}
	for _, doc := range result.Documents {
		id := str(get(object(get(doc, "meta")), "sessionId"))
		if seen[id] {
			t.Fatalf("session %s read twice", id)
		}
		seen[id] = true
	}
	if result.Skipped != 1 {
		t.Fatalf("Skipped = %d, want 1 (the link that leads nowhere)", result.Skipped)
	}
	var found bool
	for _, d := range result.Diagnostics {
		if strings.Contains(d, "gone.jsonl") && strings.Contains(d, "link leads nowhere") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no diagnostic for the dangling link in %q", result.Diagnostics)
	}
}
