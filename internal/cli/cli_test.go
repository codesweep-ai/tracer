package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParseArgs(t *testing.T) {
	t.Run("path only defaults to single mode", func(t *testing.T) {
		o, err := parseArgs([]string{"in.jsonl"})
		if err != nil {
			t.Fatal(err)
		}
		if o.input != "in.jsonl" || o.split || o.single || o.force || o.normalize {
			t.Fatalf("%+v", o)
		}
	})
	t.Run("--single is accepted explicitly", func(t *testing.T) {
		o, err := parseArgs([]string{"in.jsonl", "--single"})
		if err != nil || !o.single {
			t.Fatalf("%+v %v", o, err)
		}
	})
	t.Run("--single and --split are mutually exclusive", func(t *testing.T) {
		_, err := parseArgs([]string{"in.jsonl", "--single", "--split"})
		if err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("flags and output", func(t *testing.T) {
		o, err := parseArgs([]string{"in.jsonl", "--split", "-o", "out", "--links", "l.json", "--force"})
		if err != nil {
			t.Fatal(err)
		}
		if !o.split || o.output != "out" || o.links != "l.json" || !o.force {
			t.Fatalf("%+v", o)
		}
	})
	t.Run("normalize rejects export mode flags", func(t *testing.T) {
		for _, args := range [][]string{
			{"normalize", "in", "--split"},
			{"normalize", "in", "--single"},
			{"normalize", "in", "--force"},
		} {
			if _, err := parseArgs(args); err == nil || !strings.Contains(err.Error(), "normalize does not accept") {
				t.Fatalf("%v: %v", args, err)
			}
		}
	})
	t.Run("normalize takes --out, export takes -o", func(t *testing.T) {
		if _, err := parseArgs([]string{"normalize", "in", "-o", "x"}); err == nil || !strings.Contains(err.Error(), "--out") {
			t.Fatalf("%v", err)
		}
		if _, err := parseArgs([]string{"in", "--out", "x"}); err == nil || !strings.Contains(err.Error(), "-o") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("normalize accepts --links", func(t *testing.T) {
		o, err := parseArgs([]string{"normalize", "in", "--links", "l.json"})
		if err != nil || !o.normalize || o.links != "l.json" {
			t.Fatalf("%+v %v", o, err)
		}
	})
	t.Run("--links is not repeatable", func(t *testing.T) {
		_, err := parseArgs([]string{"in", "--links", "a.json", "--links", "b.json"})
		if err == nil || !strings.Contains(err.Error(), "not repeatable") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("flag values are required", func(t *testing.T) {
		for _, args := range [][]string{
			{"in", "-o"}, {"in", "--links"}, {"normalize", "in", "--out"},
		} {
			if _, err := parseArgs(args); err == nil || !strings.Contains(err.Error(), "requires") {
				t.Fatalf("%v: %v", args, err)
			}
		}
	})
	t.Run("unknown option fails loudly", func(t *testing.T) {
		_, err := parseArgs([]string{"in", "--spilt"})
		if err == nil || !strings.Contains(err.Error(), "unknown option: --spilt") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("second positional is not silently swallowed", func(t *testing.T) {
		if _, err := parseArgs([]string{"a", "b"}); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("no path fails", func(t *testing.T) {
		if _, err := parseArgs([]string{"normalize"}); err == nil {
			t.Fatal("expected an error")
		}
		if _, err := parseArgs([]string{"--split"}); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("help and version are honored mid-command", func(t *testing.T) {
		if _, err := parseArgs([]string{"in", "--help"}); err != errHelp {
			t.Fatalf("%v", err)
		}
		if _, err := parseArgs([]string{"in", "--version"}); err != errVersion {
			t.Fatalf("%v", err)
		}
	})
}

func TestMainHelpAndVersion(t *testing.T) {
	var stdout, stderr strings.Builder
	if code := Main([]string{"--help"}, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), "usage:") {
		t.Fatalf("code=%d out=%q", code, stdout.String())
	}
	stdout.Reset()
	if code := Main([]string{"-h"}, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), "usage:") {
		t.Fatalf("code=%d", code)
	}
	stdout.Reset()
	if code := Main([]string{}, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}
	stdout.Reset()
	if code := Main([]string{"version"}, &stdout, &stderr); code != 0 || strings.TrimSpace(stdout.String()) != version {
		t.Fatalf("code=%d out=%q want %q", code, stdout.String(), version)
	}
	stdout.Reset()
	// --version is an alias for the version subcommand.
	if code := Main([]string{"--version"}, &stdout, &stderr); code != 0 || strings.TrimSpace(stdout.String()) != version {
		t.Fatalf("code=%d out=%q", code, stdout.String())
	}
}

// Help must be reachable AFTER a subcommand and alongside other flags. This
// regressed once: --help was parsed as the positional session path, so
// `cs-tracer normalize --help` answered "expected a session path, got --help" —
// the most reflexive thing a user can type produced an error instead of help.
func TestHelpIsReachableEverywhere(t *testing.T) {
	for _, args := range [][]string{
		{"normalize", "--help"},
		{"normalize", "-h"},
		{"./some-session", "--help"},
		{"./some-session", "--single", "--help"},
		{"normalize", "--out", "x", "--help"},
	} {
		var stdout, stderr strings.Builder
		code := Main(args, &stdout, &stderr)
		if code != 0 {
			t.Fatalf("%v: exit %d, stderr=%q", args, code, stderr.String())
		}
		if !strings.Contains(stdout.String(), "usage:") || !strings.Contains(stdout.String(), "examples:") {
			t.Fatalf("%v: did not print full help, got %q", args, stdout.String())
		}
	}
}

// The help text documents flags and behaviour, so it is a place documentation
// silently drifts from code. These assert the claims that have a single source
// of truth elsewhere in this package.
func TestHelpDocumentsRealBehaviour(t *testing.T) {
	var stdout, stderr strings.Builder
	Main([]string{"--help"}, &stdout, &stderr)
	help := stdout.String()
	for _, want := range []string{"--single", "--split", "-o ", "--out ", "--links", "--force", "normalize", "version"} {
		if !strings.Contains(help, want) {
			t.Errorf("help does not mention %q", want)
		}
	}
	// destination() writes into the CURRENT directory when -o is omitted, never
	// beside the input. An earlier draft of this help claimed the opposite.
	if !strings.Contains(help, "CURRENT DIRECTORY") {
		t.Error("help must state where output goes when -o is omitted")
	}
}

// Both usage strings must list every command. The short one is what a bare
// invocation and every error prints, so it is the text most users see — and it
// silently missed `manual` when that command was added, because only the full
// help was asserted.
func TestBothUsageStringsListEveryCommand(t *testing.T) {
	for _, command := range []string{"normalize", "manual", "version"} {
		if !strings.Contains(usageShort, command) {
			t.Errorf("usageShort does not list %q — it is what a bare invocation prints", command)
		}
		if !strings.Contains(usage, command) {
			t.Errorf("usage does not list %q", command)
		}
	}
	// And each must actually work, so the lists cannot drift into fiction.
	for _, command := range []string{"manual", "version"} {
		var stdout, stderr strings.Builder
		if code := Main([]string{command}, &stdout, &stderr); code != 0 {
			t.Errorf("%q is listed in usage but exits %d: %s", command, code, stderr.String())
		}
		if stdout.Len() == 0 {
			t.Errorf("%q printed nothing", command)
		}
	}
}

func TestDestination(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Run("default strips one extension and lands in the working directory", func(t *testing.T) {
		dest, shown, err := destination(options{}, filepath.Join(t.TempDir(), "session.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		if dest != filepath.Join(cwd, "session.html") || shown != "session.html" {
			t.Fatalf("dest=%q shown=%q", dest, shown)
		}
	})
	t.Run("default from a directory basename", func(t *testing.T) {
		_, shown, err := destination(options{}, "/home/user/.claude/projects/foo")
		if err != nil {
			t.Fatal(err)
		}
		if shown != "foo.html" {
			t.Fatalf("shown=%q", shown)
		}
	})
	t.Run("default split names a directory in the working directory", func(t *testing.T) {
		dest, shown, err := destination(options{split: true}, "/home/user/.claude/projects/foo")
		if err != nil {
			t.Fatal(err)
		}
		if dest != filepath.Join(cwd, "foo") || shown != "foo" {
			t.Fatalf("dest=%q shown=%q", dest, shown)
		}
	})
	t.Run("split with an .html destination is an error", func(t *testing.T) {
		_, _, err := destination(options{split: true, output: "result.html"}, "in")
		if err == nil || err.Error() != "--split writes a directory" {
			t.Fatalf("%v", err)
		}
	})
	t.Run("single with an existing directory destination is an error", func(t *testing.T) {
		dir := t.TempDir()
		_, _, err := destination(options{output: dir}, "in")
		if err == nil || !strings.Contains(err.Error(), "must be a file") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("split with an existing directory destination is fine", func(t *testing.T) {
		_, _, err := destination(options{split: true, output: t.TempDir()}, "in")
		if err != nil {
			t.Fatal(err)
		}
	})
	t.Run("single with a nonexistent directory-looking path is a file", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "newdir")
		_, shown, err := destination(options{output: p}, "in")
		if err != nil || shown != p {
			t.Fatalf("%q %v", shown, err)
		}
	})
}
