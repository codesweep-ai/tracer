# tracer

> **Turn the session transcripts your AI coding CLI leaves on disk into one self-contained HTML
> page you can read, keep, mail or publish.**

[![CI](https://github.com/codesweep-ai/tracer/actions/workflows/ci.yml/badge.svg)](https://github.com/codesweep-ai/tracer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Clients](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode-informational)
![Platforms](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS-lightgrey)

Every AI coding CLI writes its sessions somewhere: Claude Code under `~/.claude/projects`, Codex
under `~/.codex/sessions`, OpenCode in a store of its own. Each format is different, and each is
append-only JSON written for the tool rather than for you. None of them is readable when you want to
know what the agent actually did. `cs-tracer` reads all three and writes a page: the timeline, the
tool calls, the sub-agents, the tokens and the cost.

The whole product is one static Go binary. The viewer is compiled into it, so an export needs no
server, no network and no runtime dependency. The page it writes opens from `file://` years later,
on a machine that has never heard of this tool. Other viewers exist as web applications you upload a
transcript to. `cs-tracer` is a file you run and a file you keep, which is what makes the output
something you can commit beside the code it describes.

```
 session files            cs-tracer                                   what you open
 ────────────────         ─────────────────────────────────────       ──────────────────
 ~/.claude/projects  ┐                                            ┌─  trace.html
 ~/.codex/sessions   ├──►  normalizer  ──►  trajectory  ──►  viewer│   (one file, inlined)
 an OpenCode store   ┘     one adapter      ordered JSON:    React │
                           per CLI          events, totals,  app   └─  trace-site/
                           family           metadata                   (index + one page
                                                                        per trajectory)
```

## Quickstart

Build it, or get it any of the other ways in [INSTALL.md](INSTALL.md):

```sh
git clone https://github.com/codesweep-ai/tracer && cd tracer
make install                    # -> ~/.local/bin/cs-tracer
```

That build needs **Go 1.26 or newer**. It also rebuilds the viewer whenever `npm` is on your PATH,
which needs **Node 22.13 or newer**. [INSTALL.md](INSTALL.md#or-build-from-source) shows how to build
from the committed viewer assets instead.

Then point it at a session directory and open the result:

```sh
cs-tracer ~/.claude/projects/my-project -o trace.html
open trace.html
```

That is the whole tool for most uses. It prints the size of what it is about to write to stderr,
then the destination to stdout once the file lands. [INSTALL.md](INSTALL.md#2-verify-the-installation)
walks the same run end to end with its real output.

**Point at the directory, not at one transcript file.** Sub-agent runs live in sibling files, and a
lone file has no siblings, so every sub-agent flattens onto the root and the nesting is lost.

## Trajectories

A **trajectory** is one agent session after normalizing: its metadata, its totals, and its ordered
events. An event is one step, which is a message, a tool call, a tool result, or a record the viewer
shows because nothing classified it. A sub-agent run is its own trajectory, linked from the event
that spawned it.

The page opens on an index of trajectories, each with its model, its token count, its duration and a
cost estimate. Beside each one sits an activity strip, and clicking a cell opens the timeline at
that event. The search box matches event text and tool names, and `#ev-1050` is a deep link.

## One file or a directory

```sh
cs-tracer ./session --single -o trace.html    # the default
cs-tracer ./session --split  -o ./trace-site
```

`--single` inlines the viewer, the styles and all the data into one HTML file. `--split` writes a
directory instead: `index.html`, shared `assets/`, and one page per trajectory under `traces/`.
Choose it when one file would be unwieldy, or when you publish to a static host and want each page
to load on its own.

Both modes render the same page. Only the transport differs, and a gate compares the two: the DOM
digest, the full-page pixels, and the end state after an interaction.

## The JSON underneath

`normalize` stops one step earlier and hands you the data the pages are built from:

```sh
cs-tracer normalize ./session --out ./normalized   # a tree of JSON files
cs-tracer normalize ./session                      # JSON Lines on stdout
```

The **normalizer** is the part that reads a CLI's own format, one adapter per family, and produces a
trajectory. Its output is specified byte for byte, so two runs over one input give identical files
and a diff between versions means something. [SPEC.md](SPEC.md) is the whole contract.

## Docs

- [INSTALL.md](INSTALL.md) · getting the binary, and checking that it works
- [MANUAL.md](MANUAL.md) · every command, option, file, exit code and diagnostic
- [SPEC.md](SPEC.md) · what the output must be, and how the binary is built
- [CONTRIBUTING.md](CONTRIBUTING.md) · working on `cs-tracer` itself

`cs-tracer manual` prints the manual from inside the binary, so a machine with only the executable
still has the reference.

## License

[Apache-2.0](LICENSE).
