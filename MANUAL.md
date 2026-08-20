# The cs-tracer manual

## Name

`cs-tracer`: turn AI coding-CLI session transcripts into a self-contained, browsable trace viewer.

## Synopsis

```
cs-tracer <path> [--single | --split] [-o <destination>] [--links <file>] [--force]
cs-tracer normalize <path> [--out <directory>] [--links <file>]
cs-tracer manual
cs-tracer version
```

Run `cs-tracer manual` to print this document from the binary itself.

## Description

`cs-tracer` reads the session files an AI coding CLI leaves on disk. It writes a viewer you can
open: one HTML file to keep, to mail, or to drop on a static host. It needs no server, no network
and no runtime dependency. It reads sessions from **Claude Code**, **Codex** and **OpenCode**.

Two ideas carry the whole tool. A **trajectory** is one agent session after normalizing: its
metadata, its totals, and its ordered events. An **event** is one step of that session: a message, a
tool call, a tool result, or a record the viewer shows because nothing classified it.

The default action turns a directory of sessions into a viewer. The `normalize` command stops one
step earlier and gives you the JSON those pages are built from, so another program can read it.
Nothing else is stored, and nothing runs in the background.

The shortest useful run is two lines:

```sh
cs-tracer ~/.claude/projects/my-project --single -o trace.html
open trace.html
```

## Commands

### `cs-tracer <path>`: export

The default action, and the one most people ever run. It normalizes every session under `<path>` and
writes a viewer. `--single` (the default) writes one HTML file with the viewer, its styles and all
data inlined. `--split` writes a directory instead: `index.html`, shared `assets/`, and one page per
trajectory under `traces/`.

Both modes render the same page. Only the transport differs, and a gate holds the two to it. Choose
`--split` when one file would be unwieldy, or when you publish to a static host and want each page
to load on its own.

```sh
cs-tracer ./session --single -o trace.html
cs-tracer ./session --split  -o ./trace-site
```

### `cs-tracer normalize <path>`: the JSON underneath

Writes the intermediate JSON rather than a viewer. Use it to inspect what the tool extracted, or to
feed another program.

```sh
cs-tracer normalize ./session --out ./normalized   # a directory tree
cs-tracer normalize ./session                      # JSON Lines on stdout
```

With `--out` you get a shard tree: `index.json`, a `summary.json` per trajectory, and its events in
`chunks/`. Without it you get JSON Lines on stdout, one whole document per line.

`--out` reports what it wrote, and appends the number of input files it could not turn into a
trajectory:

```
normalized 1 trajectory(s) to ./normalized
normalized 0 trajectory(s) to ./empty; skipped 1
```

A skipped file is usually not a session at all: a links file, or a transcript that parsed and held
no conversation. Each one is named on stderr with the reason.

Records are counted separately, inside each trajectory. Session files carry bookkeeping records that
are not conversation, and `summary.json`'s `parse.skippedByType` breaks those down by record type.
That is what separates "correctly ignored" from "something was lost".

### `cs-tracer manual`

Prints this document to stdout. The binary carries it, so a machine holding only the executable
still has the documentation.

### `cs-tracer version`

Prints the version and exits. `--version` does the same thing.

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `--single` | export | One self-contained `.html` file, everything inlined. The default. |
| `--split` | export | A directory of pages plus shared assets. |
| `-o <dest>` | export | Where to write: a **file** for `--single`, a **directory** for `--split`. |
| `--force` | export | Overwrite a destination directory that carries no manifest of this tool's. |
| `--links <file>` | both | Merge a `links.json`. Export joins the sessions in its index; a bare `normalize` attaches the links to every document instead. |
| `--out <dir>` | `normalize` | Where to write the shard tree. |
| `--help`, `-h` | all | Print the full help, with examples. |
| `--version` | all | Print the version. |

**`-o` and `--out` are not interchangeable.** Export takes `-o`, and `normalize` takes `--out`.
Using the wrong one is an error rather than a guess.

**Without `-o`, output lands in the current directory**, named after the input, and never beside the
input. Session directories belong to another tool and hold live state, so writing into one risks
the tool re-reading its own output.

### `<path>` is a directory, not a file

Point `cs-tracer` at the **directory holding the session**, not at a single transcript file.

Sub-agent runs live in sibling files next to the parent, and the tool reads them to reconstruct the
real nesting. A lone file has no siblings, so every sub-agent flattens onto the root and you get a
shallow tree that looks plausible and is wrong.

```sh
cs-tracer ~/.claude/projects/my-project            # right
cs-tracer ~/.claude/projects/my-project/abc.jsonl  # loses the nesting
```

### `--links`

Some sessions ship a `links.json` describing relationships between runs. Pass it and those links
merge into the index:

```sh
cs-tracer ./session --links ./session/links.json -o trace.html
```

**If a session has one and you omit it, the export is quietly incomplete.** The index lacks
the links, and nothing errors. Check for a `links.json` beside the session before you export it.

A malformed entry is dropped with a warning rather than failing the run, and `--links` accepts one
file: repeating it is an error.

### `--force` and overwriting

`--single` writes over its output without asking. Re-exporting your own `trace.html` is normal.

`--split` is careful, because a directory may hold files the tool does not own. It writes a
`.cs-tracer.json` manifest listing everything it generated:

| Destination | Behaviour |
|---|---|
| missing or empty | create and write |
| holds our manifest | delete what the manifest lists, regenerate; no flag needed |
| non-empty, no manifest | refuse; pass `--force` if you mean it |

`--force` never means `rm -rf`. It removes only `index.html`, `traces/` and `assets/`, which are the
paths `cs-tracer` owns, so a mistyped destination cannot destroy unrelated files.

## Reading the exported page

The index lists each trajectory with its title, its model, its token count, its duration and a cost
estimate. Beside each one sits an activity strip, and clicking a cell jumps to that event.

- **Deep links.** `#ev-1050` jumps to an event, and works in both export modes.
- **Filter.** The search box matches event text and tool names, scanning across chunk boundaries.
- **Sub-agents.** Each appears as its own trajectory, linked from the parent event that spawned it.

Above **25 MiB** the tool prints the size and continues. That is a warning rather than a refusal. If
one file is impractical at that size, `--split` puts each trajectory on its own page, so opening one
loads that page rather than the whole export.

## Files

| Path | Read or written |
|---|---|
| `<path>/**/*.jsonl`, `<path>/**/*.json` | read: every session file under the input directory |
| `<path>/**/*.meta.json` | read: the sidecar that names a sub-agent's parent |
| the `--links` file | read: a JSON array of link records |
| `-o <dest>` | written: one `.html` file, or a directory with `--split` |
| `<dest>/.cs-tracer.json` | written by `--split`: the manifest of generated paths |
| `--out <dir>` | written: `index.json`, `<trace>/summary.json`, `<trace>/chunks/NNN.json` |
| `$TMPDIR/cs-tracer-normalize-*` | written and removed: the scratch tree an export normalizes into |

Where each CLI keeps its sessions:

| CLI | Location |
|---|---|
| Claude Code | `~/.claude/projects/<slug>/` |
| Codex | `~/.codex/sessions/` |
| OpenCode | its own session store |

Inside the input directory, `node_modules`, `dist`, `.trace-cache` and `chunks` are skipped, as are
`index.json` and `summary.json`. Pointing the tool at a tree it already normalized therefore
re-exports that tree rather than normalizing it twice.

## Environment

`cs-tracer` reads no environment variable of its own. Every setting is a flag, and there is no
configuration file.

| Variable | Effect |
|---|---|
| `TMPDIR` | Where the scratch normalize tree goes. The directory is removed when the run ends. |

## Exit status

| Code | Meaning |
|---|---|
| `0` | Success, **including** a run that produced no documents. |
| `1` | A genuine failure: bad arguments, unreadable input, an unwritable or protected destination. |

A session with no events is not an error. It exits `0`, and the skip messages on stderr say what
happened.

Stdout carries the payload or the one-line report, and stderr carries diagnostics and the size line.
An export prints the size to stderr on every run, not only when the output is large.

## Diagnostics

Every message below is what the tool actually prints, with the exit code it leaves.

**`expected a session path, got --single`** (exit 1)

Flags come after the path. Write `cs-tracer ./session --single`, not `cs-tracer --single ./session`.

**`unknown option: --nope`** (exit 1)

A flag the parser does not accept. `cs-tracer --help` lists every one.

**`normalize uses --out <directory>, not -o`** (exit 1)

The mirror image is `export uses -o <destination>, not --out`. The two flags are not
interchangeable.

**`--single and --split are mutually exclusive`** (exit 1)

Pick one export mode.

**`normalize does not accept --single, --split or --force`** (exit 1)

Those are export flags.

**`--links is not repeatable`** (exit 1)

Pass one links file.

**`--links requires a JSON file`** (exit 1)

The flag was last on the command line, with no value after it.

**`error: stat /nowhere: no such file or directory`** (exit 1)

The input path does not exist.

**`error: no supported session files found`** (exit 1)

The directory holds no `.json` or `.jsonl` file at all. A directory whose files all parse to nothing
exits `0` instead, with a skip line for each of them.

**`error: not a cs-tracer output directory; use --force`** (exit 1)

The `--split` destination is non-empty and carries no manifest of this tool's. Pass `--force` if you
mean to overwrite it.

**`error: --split writes a directory`** (exit 1)

`-o` named a `.html` file while `--split` was given.

**`error: <dir> is an existing directory; without --split, -o must be a file path`** (exit 1)

This is the mirror image of the message above.

**`skipping <file>: normalized to zero events (adapter: claude-code) — not a session file`**
(exit 0)

The file parsed but held no conversation. That is common, and usually correct.

**`skipping <file>: file contains no recognizable records`** (exit 0)

No adapter claimed the file. A `links.json` beside a session produces this line, which is expected.

**`warning: could not read links file <path>`** (exit 0)

The export continues without the links.

**`warning: skipping invalid links entry 3 in <path>`** (exit 0)

That entry lacks one of `fromSessionId`, `toSessionId` or `kind`, or carries a `label` or `evidence`
that is not a string. The rest are merged.

**The page says the trace uses a different schema version.** The export carries a document version
the viewer embedded beside it does not implement. Re-export the session with the binary you are
reading this manual from.

**Sub-agents are missing or flattened.** You pointed at a file rather than at its directory.

**The index lacks links between related sessions.** The session ships a `links.json` and it was not
passed with `--links`.

## Notes for agents

- **Every command is non-interactive.** Nothing prompts, and nothing reads stdin. A run either
  finishes or exits `1` with the reason on stderr.
- **Nothing touches the network**, at any point, in any command.
- **The machine-readable surface is `normalize`.** A bare `normalize` streams JSON Lines to stdout,
  one whole document per line. `normalize --out <dir>` writes the same data as a shard tree.
- **Keep the streams apart.** Diagnostics, warnings and the size line go to stderr, so
  `cs-tracer normalize <path> 2>/dev/null` gives you clean JSON.
- **Writes stay inside the destination**, plus one scratch directory under `$TMPDIR` that the run
  removes. Nothing is written beside the input.
- **Check readiness with `cs-tracer version`**, which prints one line and exits `0`.
- **Exit `0` does not mean documents were produced.** Read the stdout report, or count the entries
  in `index.json`.
- **Two runs over the same input produce byte-identical output**, apart from the manifest's
  timestamp, so a diff between runs is meaningful.

## Examples

Export one Claude Code project to a single file and open it:

```sh
cs-tracer ~/.claude/projects/my-project --single -o trace.html
open trace.html
```

Publish a large session as a static site, overwriting a directory you own:

```sh
cs-tracer ~/.claude/projects/my-project --split -o ./trace-site --force
python3 -m http.server --directory ./trace-site
```

Join related runs through their links file:

```sh
cs-tracer ./session --links ./session/links.json -o trace.html
```

Feed the normalized documents into another program, one JSON object per line:

```sh
cs-tracer normalize ./session 2>/dev/null | jq -c '{id: .meta.sessionId, events: .totals.events}'
```

Keep the intermediate tree, then export from it without normalizing again:

```sh
cs-tracer normalize ./session --out ./normalized
cs-tracer ./normalized -o trace.html
```

## See also

- [README.md](README.md): what this is, and the shortest path to a working page.
- [INSTALL.md](INSTALL.md): how to get the binary, and how to check it works.
- [SPEC.md](SPEC.md): what the output must be, byte for byte, and how the binary is built.
- [CONTRIBUTING.md](CONTRIBUTING.md): working on `cs-tracer` itself.
