// Package cli implements the cs-tracer command surface:
// export to a self-contained HTML file (--single, default) or a directory
// (--split), the normalize subcommand, and version.
package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/codesweep-ai/tracer"
)

// version is stamped by the Makefile:
//
//	-ldflags -X github.com/codesweep-ai/tracer/internal/cli.version=$(VERSION)
//
// The Go linker SILENTLY ignores -X naming a symbol that does not exist, so a
// wrong path there yields a successful build with an empty version string.
// Verify with `cs-tracer version` against `git describe --tags --always
// --dirty` — never by observing that the build succeeded.
// devVersion marks a binary that carried no release stamp.
const devVersion = "dev"

var version = devVersion

// buildVersion reports the stamp when the Makefile set one, and otherwise the
// module version the toolchain recorded. A binary installed straight from the
// module path carries no stamp, so without this it would answer "dev" and
// leave you guessing which revision produced a trajectory.
func buildVersion() string {
	if version != devVersion {
		return version
	}
	info, ok := debug.ReadBuildInfo()
	if !ok || info.Main.Version == "" || info.Main.Version == "(devel)" {
		return version
	}
	return info.Main.Version
}

// usageShort is what an error prints: enough to correct a mistake, not a wall
// of text. Full help comes from `cs-tracer --help`.
const usageShort = `usage:
  cs-tracer <path> [--single | --split] [-o <destination>] [--links <file>] [--force]
  cs-tracer normalize <path> [--out <directory>] [--links <file>]
  cs-tracer manual
  cs-tracer version

run 'cs-tracer --help' for details and examples`

const usage = `cs-tracer — turn AI coding-CLI session transcripts into a browsable trace viewer.

Reads sessions from Claude Code, Codex and OpenCode, and writes a self-contained
HTML viewer that opens straight from disk. No server, no network, no runtime deps.

usage:
  cs-tracer <path> [--single | --split] [-o <destination>] [--links <file>] [--force]
  cs-tracer normalize <path> [--out <directory>] [--links <file>]
  cs-tracer manual
  cs-tracer version

commands:
  <path>              export a session directory to a viewer (the default action)
  normalize <path>    write the intermediate JSON tree instead of a viewer
  manual              print the full manual (also shipped in this binary)
  version             print the version and exit

export flags:
  --single            one self-contained .html file, everything inlined (default)
  --split             a directory: shared assets + one page per trace
  -o <destination>    where to write. A file for --single, a directory for --split.
                      If omitted, writes into the CURRENT DIRECTORY, named after
                      the input — never beside the input, which is another
                      tool's live state.
  --force             overwrite an existing destination
  --links <file>      merge a links.json into the index, joining related sessions

normalize flags:
  --out <directory>   where to write the JSON tree (index.json, summaries, chunks)
  --links <file>      as above

  Note: export uses -o, normalize uses --out. They are not interchangeable.

examples:
  # one HTML file you can open, mail, or drop on a static host
  cs-tracer ~/.claude/projects/my-project --single -o trace.html

  # a directory, for a large session where one file would be unwieldy
  cs-tracer ~/.claude/projects/my-project --split -o ./trace-site

  # inspect the normalized JSON without producing a viewer
  cs-tracer normalize ~/.claude/projects/my-project --out ./normalized

  # a session whose sub-agent runs are described by a links file
  cs-tracer ./session --links ./session/links.json -o trace.html

<path> is the DIRECTORY holding the session, not a single transcript file:
sub-agent runs live in sibling files, and normalizing a lone file silently
loses the parent/child structure.`

type options struct {
	input     string
	output    string // -o for export, --out for normalize
	links     string
	single    bool
	split     bool
	force     bool
	normalize bool
}

var (
	errHelp    = errors.New("help requested")
	errVersion = errors.New("version requested")
)

// Main is the entry point; it returns the process exit code.
func Main(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usageShort)
		return 1
	}
	switch args[0] {
	case "version", "--version": // --version aliases the version subcommand
		fmt.Fprintf(stdout, "cs-tracer %s (%s/%s, %s)\n", buildVersion(), runtime.GOOS, runtime.GOARCH, runtime.Version())
		return 0
	case "help", "--help", "-h":
		fmt.Fprintln(stdout, usage)
		return 0
	case "manual":
		fmt.Fprint(stdout, tracer.ManualMD)
		return 0
	}
	o, err := parseArgs(args)
	if err != nil {
		switch {
		case errors.Is(err, errHelp):
			fmt.Fprintln(stdout, usage)
			return 0
		case errors.Is(err, errVersion):
			fmt.Fprintf(stdout, "cs-tracer %s (%s/%s, %s)\n", buildVersion(), runtime.GOOS, runtime.GOARCH, runtime.Version())
			return 0
		}
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := run(o, stdout, stderr); err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

func parseArgs(args []string) (options, error) {
	var o options
	if args[0] == "normalize" {
		o.normalize = true
		args = args[1:]
	}
	// --help/-h and --version must be recognised BEFORE the positional check.
	// Otherwise `cs-tracer normalize --help` — the most reflexive thing a user
	// types — is parsed as a session PATH and errors with "expected a session
	// path, got --help".
	for _, a := range args {
		switch a {
		case "--help", "-h", "help":
			return o, errHelp
		case "--version":
			return o, errVersion
		}
	}
	if len(args) == 0 {
		return o, errors.New(usageShort)
	}
	if strings.HasPrefix(args[0], "-") {
		return o, fmt.Errorf("expected a session path, got %s\n\n%s", args[0], usageShort)
	}
	o.input = args[0]
	args = args[1:]
	for len(args) > 0 {
		f := args[0]
		args = args[1:]
		switch f {
		case "-o":
			if o.normalize {
				return o, errors.New("normalize uses --out <directory>, not -o")
			}
			v, err := flagValue(f, "a path", args)
			if err != nil {
				return o, err
			}
			o.output = v
			args = args[1:]
		case "--out":
			if !o.normalize {
				return o, errors.New("export uses -o <destination>, not --out")
			}
			v, err := flagValue(f, "a directory", args)
			if err != nil {
				return o, err
			}
			o.output = v
			args = args[1:]
		case "--links":
			if o.links != "" {
				return o, errors.New("--links is not repeatable")
			}
			v, err := flagValue(f, "a JSON file", args)
			if err != nil {
				return o, err
			}
			o.links = v
			args = args[1:]
		case "--single":
			o.single = true
		case "--split":
			o.split = true
		case "--force":
			o.force = true
		case "--help", "-h":
			return o, errHelp
		case "--version":
			return o, errVersion
		default:
			return o, fmt.Errorf("unknown option: %s\n\n%s", f, usageShort)
		}
	}
	if o.single && o.split {
		return o, errors.New("--single and --split are mutually exclusive")
	}
	if o.normalize && (o.single || o.split || o.force) {
		return o, errors.New("normalize does not accept --single, --split or --force")
	}
	return o, nil
}

func flagValue(flag, what string, args []string) (string, error) {
	if len(args) == 0 {
		return "", fmt.Errorf("%s requires %s", flag, what)
	}
	return args[0], nil
}

func run(o options, stdout, stderr io.Writer) error {
	input, err := filepath.Abs(o.input)
	if err != nil {
		return err
	}
	if _, err := os.Stat(input); err != nil {
		return err
	}
	if o.normalize {
		return runNormalize(input, o, stdout, stderr)
	}
	return runExport(input, o, stdout, stderr)
}

// destination resolves the output root: -o means a
// file path without --split and a directory path with it; with no -o the
// output lands in the CURRENT WORKING DIRECTORY named from the input's
// basename with one extension stripped — never alongside the input, which is
// another tool's live state. Returns the absolute path to write plus the path
// as the user named it (for diagnostics).
func destination(o options, input string) (dest, shown string, err error) {
	if o.output != "" {
		p, err := filepath.Abs(o.output)
		if err != nil {
			return "", "", err
		}
		if o.split && strings.EqualFold(filepath.Ext(p), ".html") {
			return "", "", errors.New("--split writes a directory")
		}
		if !o.split {
			if s, e := os.Stat(p); e == nil && s.IsDir() {
				return "", "", fmt.Errorf("%s is an existing directory; without --split, -o must be a file path", o.output)
			}
		}
		return p, o.output, nil
	}
	base := filepath.Base(filepath.Clean(input))
	base = strings.TrimSuffix(base, filepath.Ext(base))
	if base == "" {
		base = "trace"
	}
	shown = base
	if !o.split {
		shown += ".html"
	}
	p, err := filepath.Abs(shown)
	if err != nil {
		return "", "", err
	}
	return p, shown, nil
}
