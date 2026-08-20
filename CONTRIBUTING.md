# Contributing to cs-tracer

These rules apply to **humans and coding agents alike**. If you are an agent working in this repo,
read this file before you change anything and follow it.

This page is about working on `cs-tracer` itself. For using it, see [MANUAL.md](MANUAL.md) or run
`cs-tracer manual`. For what the output must be, see [SPEC.md](SPEC.md).

Bug reports and pull requests are welcome. For a security issue, use GitHub's private
vulnerability reporting on this repository's Security tab, rather than opening a public issue.

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
3. **A green run is not proof.** The oracle diff catches *change*, not *wrongness*, and the parity
   gate proves the two export modes agree rather than that either is correct. Weight the checks
   that hold independently of the goldens.

## The gates, and what each one proves

| Gate | Proves | Skips when |
|---|---|---|
| gofmt | every tracked Go file is formatted | never |
| go vet | no vet findings, including a language-version mismatch between `go.mod` and the APIs in use | never |
| build | the binary links, and where the viewer sources resolve, both Vite builds emit and their artifact assertions hold | never |
| version stamp | the binary's version equals `git describe`, which catches a plain `go build` | never |
| Go tests | the unit tier, plus the oracle, invocation and determinism gates | never |
| eslint | the viewer sources and its build scripts are clean | npm is not installed |
| viewer tests + schema conformance | the React app behaves, and output validates against the schema, both the committed goldens **and** output produced fresh by the current binary | as above |
| visual parity | `--single` and `--split` render identically: DOM digest, full-page pixels, interaction end-state across a chunk boundary | as above, or no browser |
| prose | the writing rules below, and that no sentence asserts a count the repo counts itself | never |
| open-source readiness | the licence, the document set, that no tracked file carries a home path, a mail address or a user name, and what a stranger's clone can do | never |
| docs against the binary | every documented command exists, the paths and spec sections the docs and the source cite resolve, and the manual the binary prints is the manual in the tree | never |

**The viewer gates skip rather than fail without npm.** `apps/viewer` resolves
`@codesweep-ai/ui` from `vendor/`, so no second checkout is involved, but rebuilding it still needs
a Node toolchain. The compiled viewer assets are committed, so every Go gate above runs in any
clone and the binary builds with Go alone.

Rebuilding needs **Node 20 or newer**, and `make build` takes that path whenever `npm` is on your
PATH. It runs `npm ci` and the Vite builds first, because `//go:embed` reads the artifacts at
compile time. A full `make check` needs npm for the viewer gates, so install it before you push.
Re-run `make build` after you edit `apps/viewer`, which is what keeps the committed artifacts
matching the sources.

Visual parity needs npm **and** a browser. It finds `/usr/bin/chromium-browser` by itself, and
`CS_TRACER_CHROMIUM` names one anywhere else.

`oracle/` earns its place by catching what nothing else does. A change can alter output BYTES
without altering meaning: keys emitted in a different order, or a number rendered differently.
Semantic tests and schema validation both pass such a change, and the tree diff does not.
Byte-exactness is the contract (SPEC.md §3), so it needs a check that compares bytes.

There is no separate "goldens reproduce" gate. The Go tests already normalize every fixture and
diff against `oracle/`, so a hand-edited golden fails there.

`oracle/` holds committed expected output, one tree per fixture. Beside each tree sits a `RUN.txt`
recording the exit code, then each stdout line with the destination normalised to `<OUT>`, then
sorted stderr. `RUN.txt` is a harness artifact, because the tool emits no record of its own
invocation. It is excluded from the tree diff and checked by running the tool and comparing.

**Read the oracle diff for what it is.** It compares output against `oracle/`, which `cs-tracer`
produced. That makes it a **regression** test rather than a correctness test: it catches unintended
change. It cannot tell you the implementation is wrong, only that it changed, and regenerating
makes it agree with whatever you did.

The checks that survive that weakness are the ones not anchored to a golden:
`internal/normalizer/invariants_test.go`, schema conformance against fresh output, determinism, and
parity. Weight those accordingly, and treat a green tree diff as a net rather than a proof. If your
change makes only the golden diff go green, you have not verified it.

Parity likewise proves the two transports **agree**, not that either is **correct**. Both could be
wrong identically. The `file://` smoke check, where React mounts with zero page errors, is the
remaining backstop.

## The one rule

**Never regenerate a golden to make a gate pass.**

`oracle/` is not test scaffolding. It is the specification, expressed as expected bytes. When a gate
fails, exactly one of two things is true:

1. **Your change is wrong.** Fix the code.
2. **The specification changed.** That is a deliberate act, and it deserves its own commit and its
   own review.

The failure this prevents is easy and quiet. A gate goes red, you regenerate, everything goes green,
and a real regression is now baked into the expected output where nobody will ever see it.

### The golden-update ritual

When output *should* change:

1. Make the code change. Let the gates fail.
2. Regenerate with `scripts/gen-goldens.sh`, in a **commit that changes nothing else**.
3. State in that commit what changed in the output, and why.
4. **Review the golden diff.** That diff *is* the specification change, so it is the most important
   thing in the review rather than a mechanical byproduct.
5. Update [SPEC.md](SPEC.md) if a documented rule moved.

Bundled with the change that motivated it, the diff can no longer distinguish intended output
changes from accidental ones.

Nothing outside this repository verifies the goldens, so this review is the only check there is. A
regenerated golden agrees with whatever the tool now does, correct or not.

## Prefer fixing the fixture over loosening the gate

A gate relaxed to pass is a gate that no longer tests anything. A guard that skips instead of
failing is the same thing more quietly.

## Code you should not "simplify"

Three places look more complicated than necessary and are not. Each replaces an obvious
implementation that is wrong, and each carries a comment explaining why:

- `internal/trajectory`: the ordered-object model. Go maps cannot reproduce insertion-order
  semantics, including keys first declared with `undefined` that still occupy their slot.
- `internal/normalizer/value.go`: coercion rules mirroring JavaScript property access on
  primitives.
- `internal/cli/assemble.go`: the byte-level escaping pass. A decode and re-encode corrupts raw
  U+2028/U+2029 and a literal `<` in source text. `fixtures/claude/v2.1/hazard-text` is the
  fixture that catches you.

The gates will catch you, but they report "bytes differ" across a whole tree, which is an expensive
way to rediscover a documented reason.

## Tests are part of the change

Every behavior change ships with test coverage. A change with no test is only acceptable when the
behavior genuinely cannot be observed in a test. Say so in the PR.

The gates compare whole trees: they tell you **that** something differs, never **where**. Unit tests
exist to localise. So the question to ask of a new test is not what percentage it moves but *"if
this breaks, will a test name the bug in seconds?"*

Concentrate coverage where a byte diff cannot help. Serialization order, encoding edge cases, chunk
boundaries, re-run merging, flag parsing and destination semantics all qualify. An assertion that
holds independently of the goldens is worth more than one that does not.

**When you add a user-facing surface, add the test that keeps it documented.** A flag, a command or
an output format each has somewhere it must be described, and prose describing code drifts the
moment nobody is looking. Assert the link instead of remembering it. Three such assertions already
exist, and they are all the same shape. `--help` must name every flag, the usage strings must list
every command, and `cs-lint walkthrough` requires [MANUAL.md](MANUAL.md) to document every flag.
`manual` was added to the full help and missed in the short usage precisely because that third
assertion did not exist yet.

### Coverage

Every test target writes coverage into its own tier under `.coverage/`, so running several
aggregates rather than overwrites. `make coverage` merges what is there and prints the report.

`make coverage-check` runs inside `make check` and in CI. It fails when a package
`.coverage-baseline` lists stops being reached: presence, not a percentage. What it catches is a
suite that stopped running while the tests still report green. When a package is meant to lose its
coverage, rerun `make coverage-baseline` and commit the result.

### Adding a fixture

A **fixture** is a captured session under `fixtures/`, and the gates run every one of them.

1. Add the session under `fixtures/<cli>/<version>/<name>/`.
2. Run `scripts/scrub-fixtures.mjs --dir fixtures/<cli>/<version>/<name>` over it. Pass `--dir`,
   which is the only safe form: run bare it refuses, and `--all` rewrites the whole corpus. A
   scrubbed id is still id-shaped, so a second pass remaps every fixture and regenerates every
   golden. Scrubbing alone does not clear a captured session for publication.
3. Generate its golden with `scripts/gen-goldens.sh` and review the diff.
4. Confirm it exercises something no existing fixture does. Near-identical fixtures cost runtime and
   prove one thing.
5. If it pins a byte-level hazard, say so in a comment on the relevant test. Unusual encoding,
   embedded markup and an awkward float are the three that recur. Without the comment, a later
   cleanup quietly removes the property under test.

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
this commit will …"*. Say what the change does.

**Body**, only when the subject leaves a real question. Use bullets, one line each, under 60
characters, describing the design: the shape the change takes, or the constraint that ruled out the
obvious alternative. Do not describe the diff, and do not describe how you arrived at it.

Write as many bullets as there are points and no more. Most commits need none, one is common, and
three is the rare maximum.

```
Fix the asset path a split trace page points at
```

```
Compare the pixels the parity gate says it compares

- Buffer.compare over a PNG reports on the compressor.
- The first page in a fresh browser rasterises differently.
```

```
Sort skippedByType by record type

- Key order would follow whichever type arrived first.
- Output is compared byte for byte, so order is data.
```

Keep the `Co-Authored-By:` trailer when an agent wrote the change. Drop any trailer linking to the
agent's session or transcript: private to whoever ran it, dead to everyone else.

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

The docs drift into a style that reads as terse and knowing rather than clear. These rules push
back. [`cs-lint`](https://github.com/codesweep-ai/lint) enforces the mechanical ones. It carries
three linters, and `make check` runs all three:

| Command | Target | What it checks |
|---|---|---|
| `cs-lint docs` | `make docs` | How the documents are written. |
| `cs-lint oss` | `make oss` | What this repository owes a reader as a published project. |
| `cs-lint walkthrough` | `make walkthrough` | Whether the documents still describe the software. |

The third checks the claims rather than the prose. Every command the docs name goes against the
binary's help tree, every setting against the code that reads it, and every sample output against
the command re-run now. `--run` lists every command the documents tell a reader to run, in reading
order, and `--review` prints the half that needs a reader.

Read what a rule wants with `--explain`, which prints the guidance behind each one rather than
leaving you to argue with the tool:

```bash
cs-lint oss --explain
```

1. **Write to the reader, in second person.** "Run `make check` before you push", not "the check
   should be run before pushing".

2. **Introduce a term where you first use it.** A reader meeting *trajectory*, *shard* or *golden*
   for the first time needs it introduced. Give a definition on the spot, an entry in a glossary
   table, or a link to the page that defines it.

3. **No em-dash.** The aside one introduces is a full stop, a comma, or a cut. It is also the
   first punctuation a model reaches for, so a page full of them reads as unedited whoever wrote it.

4. **Sentences under 30 words.** Longer than that and a sentence is carrying two ideas. A list of
   ordered steps belongs in a numbered list, not in one sentence separated by semicolons.

5. **Every sentence has a verb.** "One commit per idea" is an epigram, not a sentence. It sounds
   knowing and tells the reader nothing.

6. **Delete the frame.** "It is worth noting that", "put simply", "in other words", "to be clear".
   Each one comments on the writing instead of getting on with it. Say the thing.

7. **Do not say a thing twice in one sentence.** A sentence that circles back on its own subject
   lands nowhere.

8. **Show a file before running it.** A block that runs `./build.sh` has to have shown the reader
   what is in `build.sh`.

9. **Explain the case, or leave it out.** If a walkthrough has two shapes, walk through both fully,
   or pick one. Half an explanation, hedged, is worse than either.

10. **Do not mention what does not happen.** "The `--force` flag is ignored here" makes a reader
    wonder why they were told. Cut it.

11. **Do not document the absence of a feature** as a section of its own. Non-goals belong in the
    spec, where a reader is looking for the boundary.

12. **Prefer a concrete example to a general statement.** A runnable block teaches a flag faster
    than a paragraph about it.

13. **Say what it costs.** If a flag needs a browser, makes output uncommittable, or is Linux-only,
    say so where the reader meets it.

14. **Describe what the software does, not how it came to do it.** Leave out what the project used
    to do, what was tried and dropped, and numbers from a run someone did once. The reason a rule
    exists belongs beside the rule in [SPEC.md](SPEC.md); the investigation that found it belongs in
    the pull request.

15. **State the point first, then qualify it.** Opening with the qualifier makes the reader decode
    the sentence backwards. "Byte for byte, so a golden diff means a real change" names its subject
    last. Start with the output, and let the consequence follow it.

16. **Do not explain a design by contrast with a worse one.** "A directory, so a change reads as a
    diff rather than as one unreadable line" asks the reader to picture a format nobody proposed.
    Say what it is and what you get.

17. **A walkthrough is steps that work.** Put the reasons somewhere else. A reader working through
    one wants commands that run, not an account of which flag the exporter used to spell
    differently.

18. **Do not make the reader hold two halves of a sentence apart.** "What a shell printed may
    differ; what the model was asked may not" is a puzzle. Name the subject in each clause.

19. **Do not write in the register a model defaults to.** Untouched model output has a signature
    readers now recognise and discount. `cs-lint docs --explain` lists the words this house
    declines and what to write instead, so the table lives in one place rather than here. Two
    shapes matter as much as the words. Negative parallelism sets up a contrast nobody asked for.
    The rule of three is a rhythm rather than an argument, and a reader stops counting the third
    item as information.

These rules are about mechanics, and this project's voice is a strength: concrete, opinionated, and
free of padding. Where a rule fights the voice, the voice wins. Say so in the PR when it does.

Run the linter on its own while you write:

```bash
cs-lint docs              # check
cs-lint docs --stats      # per-file measurements
cs-lint docs --list       # which files are checked
cs-lint docs --explain    # what each rule wants, and the guidance behind it
```

Every knob lives in [`.cs-lint.yaml`](.cs-lint.yaml) at the repository root, one section per
linter. The `docs` section carries `glossary`, `skipExtra`, `lowercaseStarters` and `projectVerbs`.
When a real sentence trips the verb check, add the verb. When a report is noise, fix the config. A
linter that cries wolf gets ignored, and then it protects nothing.

A rule turned off for this repository is a waiver: a rule identifier and the reason it was traded
away, under `allow`. The reason is required, and it is printed with the finding, because a waiver
nobody can review is a rule deleted in private.

The linter is a project of its own, shared across this family. A fix to a check belongs there, and
reaches this repository the next time somebody installs it.

## Style

Match the file you are editing: dense, comment-light code with occasional long explanatory comments
where something is genuinely non-obvious. Keep those. Every one marks a place where the obvious
implementation is wrong.
