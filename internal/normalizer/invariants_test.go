package normalizer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// The assertions in this file are deliberately NOT anchored to oracle/.
//
// The goldens are produced by the tool they test, so a golden-anchored test
// agrees with whatever the implementation currently does — regenerate and it
// goes green. These assert properties that are true or false on their own terms,
// which is the only kind of check that survives that weakness.

// Every record that produces no event must be counted, exactly once, under its
// own type. This is the accounting rule from SPEC.md §6: nothing is dropped
// without being named.
func TestSkippedByTypeAccountsForEveryRecord(t *testing.T) {
	for _, fixture := range []string{
		"claude/v2.1/large-session",
		"claude/v2.1/simple",
		"codex/v0.146/tool-heavy",
		"opencode/v1.18/tool-heavy",
	} {
		t.Run(fixture, func(t *testing.T) {
			dir := filepath.Join("..", "..", "fixtures", fixture)
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			var doc *obj
			for _, e := range entries {
				if e.IsDir() || !strings.Contains(e.Name(), ".json") {
					continue
				}
				d, err := NormalizeFile(filepath.Join(dir, e.Name()))
				if err != nil {
					continue
				}
				doc = d
				break
			}
			if doc == nil {
				// Not a skip. These four fixtures are known-normalizable, so
				// "nothing normalized" means the adapter broke — precisely when
				// this test must speak up rather than go quiet.
				t.Fatal("no file in this fixture normalized")
			}
			parse := object(get(doc, "parse"))
			raw, ok := get(parse, "skippedByType").([]any)
			if !ok {
				t.Fatalf("parse.skippedByType is not an array: %T", get(parse, "skippedByType"))
			}
			seen := map[string]bool{}
			total := 0
			var previous string
			for i, entry := range raw {
				e := object(entry)
				typ := str(get(e, "type"))
				count := int(num(get(e, "count")))
				if typ == "" {
					t.Errorf("entry %d has an empty type; a record with no type must be recorded as '(no type)'", i)
				}
				if count < 1 {
					t.Errorf("entry %q has count %d; entries exist only when something was counted", typ, count)
				}
				if seen[typ] {
					t.Errorf("type %q appears more than once — counts must be aggregated", typ)
				}
				seen[typ] = true
				// Sorted, so the byte-compared output is deterministic rather
				// than depending on which type happened to appear first.
				if previous != "" && typ < previous {
					t.Errorf("entry %d (%q) sorts before %q — skippedByType must be sorted by type", i, typ, previous)
				}
				previous = typ
				total += count
			}
			if total < 0 {
				t.Fatalf("negative total %d", total)
			}
		})
	}
}

// An unrecognised record type must become visible — an event AND a warning —
// rather than being dropped. Asserted with a synthetic record so it holds no
// matter what the fixtures happen to contain.
func TestUnknownRecordTypeIsLoud(t *testing.T) {
	records := []*obj{
		trajectory.NewObject("type", "a-type-from-the-future", "sessionId", "s"),
		trajectory.NewObject("type", "user", "uuid", "1", "sessionId", "s",
			"message", trajectory.NewObject("role", "user", "content", "hello")),
	}
	doc := NormalizeClaude(records)

	events, _ := get(doc, "events").([]*obj)
	var found *obj
	for _, e := range events {
		if strings.Contains(str(get(e, "rawType")), "a-type-from-the-future") {
			found = e
		}
	}
	if found == nil {
		t.Fatal("an unclassified record type produced no event — it was silently dropped (SPEC.md §6)")
	}
	if str(get(found, "kind")) != "meta" {
		t.Errorf("diagnostic event kind = %q, want meta", str(get(found, "kind")))
	}

	parse := object(get(doc, "parse"))
	if n := int(num(get(parse, "unrecognized"))); n < 1 {
		t.Errorf("parse.unrecognized = %d, want >= 1", n)
	}
	warnings, _ := get(parse, "warnings").([]any)
	if len(warnings) == 0 {
		t.Error("an unclassified record type raised no warning")
	}
}

// A record type on the ignore list is counted, not rendered — the distinction
// between "deliberately ignored" and "silently lost".
func TestIgnoredRecordIsCountedNotRendered(t *testing.T) {
	records := []*obj{
		trajectory.NewObject("type", "bridge-session", "sessionId", "s", "bridgeSessionId", "cse_x"),
		trajectory.NewObject("type", "user", "uuid", "1", "sessionId", "s",
			"message", trajectory.NewObject("role", "user", "content", "hello")),
	}
	doc := NormalizeClaude(records)
	events, _ := get(doc, "events").([]*obj)
	for _, e := range events {
		if strings.Contains(str(get(e, "rawType")), "bridge-session") {
			t.Fatal("an explicitly ignored record type produced an event")
		}
	}
	entries, _ := get(object(get(doc, "parse")), "skippedByType").([]any)
	for _, entry := range entries {
		if str(get(object(entry), "type")) == "bridge-session" {
			return
		}
	}
	t.Fatal("an ignored record was not counted in skippedByType — that is a silent drop")
}

// Session state must reach meta rather than disappearing with the record.
func TestSessionStateIsHarvestedIntoMeta(t *testing.T) {
	records := []*obj{
		trajectory.NewObject("type", "custom-title", "sessionId", "s", "customTitle", "my session"),
		trajectory.NewObject("type", "agent-name", "sessionId", "s", "agentName", "builder"),
		trajectory.NewObject("type", "mode", "sessionId", "s", "mode", "normal"),
		trajectory.NewObject("type", "permission-mode", "sessionId", "s", "permissionMode", "default"),
		trajectory.NewObject("type", "user", "uuid", "1", "sessionId", "s",
			"message", trajectory.NewObject("role", "user", "content", "hello")),
	}
	meta := object(get(NormalizeClaude(records), "meta"))
	for _, c := range []struct{ field, want string }{
		{"title", "my session"},
		{"agentNickname", "builder"},
		{"mode", "normal"},
		{"permissionMode", "default"},
	} {
		if got := str(get(meta, c.field)); got != c.want {
			t.Errorf("meta.%s = %q, want %q — session state was dropped with its record", c.field, got, c.want)
		}
	}
}

// The emitted schemaVersion must match what schema/trajectory.v1.json declares.
// Drift here is what makes a viewer refuse a document it should have rendered.
func TestSchemaVersionMatchesSchemaFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "schema", "trajectory.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := NormalizeClaude([]*obj{
		trajectory.NewObject("type", "user", "uuid", "1", "sessionId", "s",
			"message", trajectory.NewObject("role", "user", "content", "hi")),
	})
	emitted := int(num(get(doc, "schemaVersion")))
	if !strings.Contains(string(raw), `"const": `+itoa(emitted)) {
		t.Fatalf("normalizer emits schemaVersion %d, which the schema file does not declare as const", emitted)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
