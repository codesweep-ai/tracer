# Contributing to cs-tracer

These rules apply to **humans and coding agents alike**. If you are an agent working in this repo,
read this file before you change anything and follow it.

This page is about working on `cs-tracer` itself. For using it, see [MANUAL.md](MANUAL.md) or run
`cs-tracer manual`. For what the output must be, see [SPEC.md](SPEC.md).

Bug reports and pull requests are welcome. For a security issue, use GitHub's private
vulnerability reporting on this repository's Security tab, rather than opening a public issue.

## Submitting a change

File a bug or an idea as a GitHub issue on this repository. For a fix that stands on its own, a pull
request on its own is enough. For anything that changes behaviour a user can see, open an issue
first, so the design gets settled before you write it.

1. Fork the repository, and create a branch off `main`.
2. Make the change, with its test.
3. Run `make check`, which is the same gate CI runs.
4. Open a pull request against `main`, and say what the change does and why.

Expect comments rather than silence, and expect a small change to move quickly. A reviewer asks
whether the change keeps the design rules below, whether a test fails without it, and where a reader
would find it documented.

By opening a pull request you agree that your contribution ships under the
[Apache 2.0 licence](LICENSE) this project is released under.

## Before you push

One command:

```sh
make ci
```

That is every gate the CI workflow has, on this machine and in the order the workflow takes them,
so a green run here is a green run there. `make check` is the faster subset to keep beside you
while you work, and `make ci` is the one that has to pass.

It shells out to tools the Go distribution does not carry. Install them once:

```bash
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.1
go install golang.org/x/tools/cmd/deadcode@latest
go install github.com/codesweep-ai/lint/cmd/cs-lint@latest
go install github.com/codesweep-ai/ledger/cmd/cs-ledger@latest
```

`golangci-lint` is pinned to the version CI runs, so a release that gains checks reaches you when
you move the pin rather than on an unrelated pull request. `cs-lint` is not pinned: CI installs it
from source the same way you do, so a check it gains reaches you on the day it lands.

**`make test` runs Go tests only**, and it is not the suite, despite the name. Read what the run
prints, not just its exit code. A gate whose toolchain is missing reports **SKIP** where it runs
and the run carries on, so a run reporting skips has not verified everything.

This repository keeps a **ledger** of open issues in `ledger/`. Read
[`ledger/AGENTS.md`](ledger/AGENTS.md) before you start work, and follow it as you go. A commit
that touches `ledger/` needs `cs-ledger render && cs-ledger check` to pass first, and
`make ledger` runs the check half.

## Design rules

1. **`make check` before every push.** Four of its gates skip on a machine that lacks what they
   need, and each says so where it runs. A skipped gate is not a passed one.
2. **Never regenerate a golden to make a gate pass.** A **golden** is committed expected output, and
   `oracle/` holds one per fixture. Since the goldens are produced by the tool they test, "make it
   pass" is always available, which is why this is a rule and not a preference.
   [`SPEC.md`](SPEC.md#testing) states what each gate proves and what to do when output should
   change.
3. **A green run is not proof.** The oracle diff catches *change*, not *wrongness*, and the parity
   gate proves the two export modes agree rather than that either is correct. Weight the checks
   that hold independently of the goldens.

## Tests

Ship a test with your change. Where a behaviour genuinely cannot be observed in a test, say so in
the pull request.

The gates compare whole trees: they tell you **that** something differs, never **where**. Unit tests
exist to localise. Ask of a new test not what percentage it moves, but *"if this breaks, will a test
name the bug in seconds?"* Concentrate coverage where a byte diff cannot
help: serialization order, encoding edge cases, chunk boundaries, re-run merging, flag parsing and
destination semantics.

**When you add a user-facing surface, add the test that keeps it documented.** A flag, a command or
an output format each has somewhere it must be described, and prose describing code drifts the
moment nobody is looking. Assert the link instead of remembering it.

Never lower a coverage baseline to make a run green. [`SPEC.md`](SPEC.md#testing) holds the gate
list, what each gate proves, how a golden is updated, how a fixture is added, and how coverage is
measured. Read it before you touch `oracle/` or `fixtures/`.

## Issues

This repo keeps a **ledger** of open issues in `ledger/`. Read
[`ledger/AGENTS.md`](ledger/AGENTS.md) before you start work, and follow it as you go. A commit
that touches `ledger/` needs `cs-ledger render ledger && cs-ledger check ledger` to pass first.
That tool is a sibling project, and `make check` skips its gate when it is absent:

```sh
go install github.com/codesweep-ai/ledger/cmd/cs-ledger@latest
```

## Commits

**Keep it short.** One idea per commit, and a message a reader takes in at a glance. If a change
will not fit one idea, split it.

**Subject**, always. Under 60 characters, imperative, no trailing period, completing *"If applied,
this commit will …"*. Say what the change does, in plain English rather than in this project's
internal shorthand. Use no category label: `fix(proxy):`, `bugfix:` and `[docs]` each name a class
of change rather than the change itself, which the diff already shows. The gate fails on one, so
amend before you push.

**Body**, rarely. Most commits need none. Add one only when the subject leaves a question a reader
would otherwise have to open the diff to answer, and then answer that question. A sentence or two
does it. Wrap it at 72 columns.

Leave out how the work was scheduled, how you tested it, and what led you to it, and stop once the
question is answered. A second paragraph usually means the message has turned into a report of the
session. A rule's reason belongs beside the rule in [`SPEC.md`](SPEC.md), and the investigation that
found it belongs in the pull request.

```
Fix the asset path a split trace page points at
```

```
Compare the pixels the parity gate says it compares

Buffer.compare over a PNG reports on the compressor, and the
first page in a fresh browser rasterises differently.
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
prints it. Do not move or rename it. `cs-lint surface` compares the copy inside
`bin/cs-tracer` against the file, so run `make build` after editing it. Without that, the gate
reports a mismatch you did not cause.

`AGENTS.md` carries nothing of its own. It is the filename agent harnesses discover by themselves,
so it routes to the documents above and holds no knowledge that could go stale against them.

A comment or a document citing a spec section by number, as `§3.1`, is checked by `cs-lint
refs` against the numbered sections of [SPEC.md](SPEC.md). Renumbering one breaks every
citation into it at once.

## Writing

Six principles do most of the work. Read them before you write a document, and apply them when you
edit one:

1. **Introduce a term where you first use it**, in the same sentence, or link to the page that
   defines it. A reader should never meet a word the docs have not explained.
2. **State the point first, then qualify it.** Opening with the qualifier makes the reader decode
   the sentence backwards.
3. **Give every sentence a subject and a verb.** "Two version numbers, one verdict, one remedy"
   reads as knowing rather than clear. Say what the thing is.
4. **A how-to is steps that work.** Put the reasons somewhere else. A reader working through
   one wants commands that run.
5. **Describe what the software does, not how it came to do it.** Leave out what the project used
   to do, what was tried and dropped, and numbers from a run somebody did once.
6. **Do not explain a design by contrast with a worse one.** Say what it is and what you get,
   rather than asking the reader to picture a design nobody proposed.

The mechanical rules are enforced rather than restated here.
[`cs-lint`](https://github.com/codesweep-ai/lint) carries them, and `make check` runs it over this
repository. To read what a rule wants and the guidance behind it:

```bash
cs-lint prose --explain
```

That listing is the authority. Where this section and the linter disagree, the linter is right.
Turning a check off is a waiver: write it under `allow` in [`.cs-lint.yaml`](.cs-lint.yaml) with the
reason, which is printed with the finding.

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
