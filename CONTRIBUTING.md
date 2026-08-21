# Contributing to cs-tracer

These rules apply to **humans and coding agents alike**. If you are an agent working in this repo,
read this file before you change anything and follow it.

This page is about working on `cs-tracer` itself. For using it, see [MANUAL.md](MANUAL.md) or run
`cs-tracer manual`. For what the output must be, see [SPEC.md](SPEC.md).

Bug reports and pull requests are welcome. For a security issue, use GitHub's private
vulnerability reporting on this repository's Security tab, rather than opening a public issue.

## How a change gets in

File a bug or an idea as a GitHub issue on this repository. For a fix that stands on its own, a pull
request on its own is enough. For anything that changes behaviour a user can see, open an issue
first, so the design gets settled before you write it.

1. Fork the repository, and create a branch off `main`.
2. Make the change, with its test.
3. Run `make check`, which is the same gate CI runs.
4. Open a pull request against `main`, and say what the change does and why.

Review asks four questions. Does the change hold the invariants below? Does a test fail without it?
Does every user-visible change land in exactly one document? Does the history read the way this file
describes? Expect comments rather than silence, and expect a small change to move quickly.

By opening a pull request you agree that your contribution ships under the
[Apache 2.0 licence](LICENSE) this project is released under.

## Before you push

```sh
make check
```

One command, every gate, non-zero on any failure. It runs `scripts/check.sh`, which is also what CI
runs, so the two lists cannot drift apart. That script covers `make docs`, `make oss` and `make
walkthrough`, so all three of `cs-lint`'s linters run before you push rather than in review.

**`make test` runs Go tests only**, and it is not the suite, despite the name. Read the summary
`make check` prints, not just its exit code. A gate whose toolchain is missing reports **SKIP** and
still exits `0`, so a run reporting skips has not verified everything.

The three Go-installable tools are the exception: they **FAIL** rather than skip, because each is
one `go install` away on a machine that already has Go. Install them once, pinning `golangci-lint`
to the version CI runs:

```sh
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
go install golang.org/x/tools/cmd/deadcode@latest
go install github.com/codesweep-ai/lint/cmd/cs-lint@latest
```

`cs-lint` is deliberately not pinned. It is this family's own linter, and CI installs it from source
the same way, so a check it gains reaches you on the day it lands.

## The three that matter most

1. **`make check` before every push.** Four of its gates skip on a machine that lacks what they
   need, and the summary says which. A skipped gate is not a passed one.
2. **Never regenerate a golden to make a gate pass.** A **golden** is committed expected output, and
   `oracle/` holds one per fixture. Since the goldens are produced by the tool they test, "make it
   pass" is always available, which is why this is a rule and not a preference.
   [`SPEC.md`](SPEC.md#testing) states what each gate proves and what to do when output should
   change.
3. **A green run is not proof.** The oracle diff catches *change*, not *wrongness*, and the parity
   gate proves the two export modes agree rather than that either is correct. Weight the checks
   that hold independently of the goldens.

## Tests are part of the change

Every behavior change ships with test coverage. A change with no test is only acceptable when the
behavior genuinely cannot be observed in a test. Say so in the pull request.

The gates compare whole trees: they tell you **that** something differs, never **where**. Unit tests
exist to localise. So the question to ask of a new test is not what percentage it moves but *"if
this breaks, will a test name the bug in seconds?"*

Concentrate coverage where a byte diff cannot help. Serialization order, encoding edge cases, chunk
boundaries, re-run merging, flag parsing and destination semantics all qualify. An assertion that
holds independently of the goldens is worth more than one that does not.

**When you add a user-facing surface, add the test that keeps it documented.** A flag, a command or
an output format each has somewhere it must be described, and prose describing code drifts the
moment nobody is looking. Assert the link instead of remembering it. `--help` must name every flag,
the usage strings must list every command, and `cs-lint walkthrough` requires
[MANUAL.md](MANUAL.md) to document every flag.

[`SPEC.md`](SPEC.md#testing) holds the gate list, what each gate proves, how a golden is updated,
and how a fixture is added. Read it before you touch `oracle/` or `fixtures/`.

### Coverage

Every test target writes coverage into its own tier under `.coverage/`, so running several
aggregates rather than overwrites. `make coverage` merges what is there and prints the report.

`make coverage-check` runs inside `make check` and in CI. It fails when a package
`.coverage-baseline` lists stops being reached: presence, not a percentage. What it catches is a
suite that stopped running while the tests still report green. When a package is meant to lose its
coverage, rerun `make coverage-baseline` and commit the result.

## Issues

This repo keeps a **ledger** of open issues in `ledger/`. Read
[`ledger/AGENTS.md`](ledger/AGENTS.md) before you start work, and follow it as you go. A commit
that touches `ledger/` needs `cs-ledger render ledger && cs-ledger check ledger` to pass first.
That tool is a sibling project, and `make check` skips its gate when it is absent:

```sh
go install github.com/codesweep-ai/ledger/cmd/cs-ledger@latest
```

## Commits

Keep one idea per commit. If a change will not fit that shape, it is doing more than one thing, so
split it.

**Subject**, always. Under 60 characters, imperative, no trailing period, completing *"If applied,
this commit will …"*. Say what the change does, in plain English rather than in this project's
internal shorthand. Use no conventional-commit prefix: `fix(proxy):` names a category rather than a
change, and the category is already in the diff.

**Body**, only when the subject leaves a real question a reader would otherwise have to open the
diff to answer. Write the answer in plain English, in whole sentences, addressed to somebody who was
not there. Wrap it at 72 columns. Most commits need no body at all.

Say what the change does and what constrained it. Leave out how the work was scheduled, how it was
tested, and what prompted it. A rule's reason belongs beside the rule in [`SPEC.md`](SPEC.md), and
the investigation that found it belongs in the pull request.

Where a body carries more than one independent point, one line each reads better than a paragraph.
Never reach for another point to fill the shape. A line that restates the subject in different words
is worse than no body, and a body written to a length is the commonest way a message stops being
read.

```
Fix the asset path a split trace page points at
```

```
Compare the pixels the parity gate says it compares

Buffer.compare over a PNG reports on the compressor, and the
first page in a fresh browser rasterises differently.
```

```
Sort skippedByType by record type

- Key order would follow whichever type arrived first.
- Output is compared byte for byte, so order is data.
```

Keep the `Co-Authored-By:` trailer when an agent wrote the change. Drop any trailer linking to the
agent's session or transcript. Such a link is private to whoever ran it and dead to everyone else,
and it cannot be fixed after publication.

## Docs

Behaviour a user can see belongs in the docs, updated in the same commit as the code. Each document
has one job, so a fact lives in exactly one of them and the others link to it.

| If you are writing | It goes in |
|---|---|
| Why someone would want a trace viewer, and the first five minutes | `README.md` |
| How to get the binary, and how to check that it works | `INSTALL.md` |
| What a command does, what a flag means, what an error means | `MANUAL.md` |
| A rule the output must satisfy, or the reason a rule exists | `SPEC.md` |
| How to work on `cs-tracer` itself | `CONTRIBUTING.md` |
| Where an agent working in this repository looks first | `AGENTS.md` |

`MANUAL.md` is embedded in the binary through `//go:embed` in `assets.go`, and `cs-tracer manual`
prints it. Do not move or rename it. `cs-lint walkthrough` compares the copy inside
`bin/cs-tracer` against the file, so run `make build` after editing it. Without that, the gate
reports a mismatch you did not cause.

`AGENTS.md` carries nothing of its own. It is the filename agent harnesses discover by themselves,
so it routes to the documents above and holds no knowledge that could go stale against them.

A comment or a document citing a spec section by number, as `§3.1`, is checked by `cs-lint
walkthrough` against the numbered sections of [SPEC.md](SPEC.md). Renumbering one breaks every
citation into it at once.

## Writing

Six principles carry the voice. Read them before you write a document, and apply them when you edit
one:

1. **Introduce a term where you first use it**, in the same sentence, or link to the page that
   defines it. A reader should never meet a word the docs have not explained.
2. **State the point first, then qualify it.** Opening with the qualifier makes the reader decode
   the sentence backwards.
3. **Give every sentence a subject and a verb.** "Two version numbers, one verdict, one remedy"
   reads as knowing rather than clear. Say what the thing is.
4. **A walkthrough is steps that work.** Put the reasons somewhere else. A reader working through
   one wants commands that run.
5. **Describe what the software does, not how it came to do it.** Leave out what the project used
   to do, what was tried and dropped, and numbers from a run somebody did once.
6. **Do not explain a design by contrast with a worse one.** Say what it is and what you get,
   rather than asking the reader to picture a design nobody proposed.

The mechanical rules are enforced rather than restated here.
[`cs-lint`](https://github.com/codesweep-ai/lint) carries them, and `make check` runs all three of
its linters over this repository:

| Command | Target | What it checks |
|---|---|---|
| `cs-lint docs` | `make docs` | How the documents are written. |
| `cs-lint oss` | `make oss` | What this repository owes a reader as a published project. |
| `cs-lint walkthrough` | `make walkthrough` | Whether the documents still describe the software. |

`--explain` prints what each rule wants and the guidance behind it:

```bash
cs-lint docs --explain
```

That listing is the authority. Where this section and the linter disagree, the linter is right and
this section is a bug. Every knob lives in [`.cs-lint.yaml`](.cs-lint.yaml), and a check that
reports noise is a check to fix rather than a report to work around.

A check turned off here is a waiver, written under `allow` as an identifier and the reason it was
traded away. The reason is required, and it is printed with the finding, because a waiver nobody can
review is a rule deleted in private.

**What not to change.** This project's voice is a strength: concrete, opinionated, free of
marketing padding. These rules are about mechanics. Where one of them fights the voice, the voice
wins, and the exception is worth a sentence in the pull request.

## Style

Match the file you are editing: dense, comment-light code with occasional long explanatory comments
where something is genuinely non-obvious. Keep those. Every one marks a place where the obvious
implementation is wrong.

## AI-assisted contributions

An agent wrote most of this repository, and you are welcome to use one. The standard is the same
either way: you are responsible for what you submit.

Point your tool at [`AGENTS.md`](AGENTS.md), which routes it to the documents that hold the
conventions, and check three things before you open the pull request:

- You understand every line, and can answer a question about it without going back to the tool.
- You ran `make check` and it passed.
- You cut what the tool added to fill space. A model pads a commit body to the shape it was shown,
  and comments that restate the code around them. Both read as noise to a maintainer, and both are
  yours to remove.

Keep the `Co-Authored-By:` trailer, which is how the work is disclosed. An unattended agent must not
open pull requests or comment on this repository.
