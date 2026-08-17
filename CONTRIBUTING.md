# Contributing

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
runs, so the two lists cannot drift apart. Since that script covers `make docs` and `make oss`, the
prose linter and the publication linter both run before you push rather than in review.

**`make test` runs Go tests only**, and it is not the suite, despite the name. Read the summary
`make check` prints, not just its exit code. A gate that cannot run here reports **SKIP** and still
exits `0`, so a run reporting skips has not verified everything.

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
| doclint | the docs name only real paths, assert no countable numbers, cite only real spec sections, and the embedded manual matches the file | node is not installed |
| prose | the writing rules below, over every document in the set | never |
| open-source readiness | the licence, the document set, what must never reach a public commit, and what a stranger's clone can do | never |
| leakcheck | no tracked file carries a home path, a mail address or a user name | node is not installed, and CI still runs it |

**The viewer gates skip rather than fail without npm.** `apps/viewer` resolves
`@codesweep-ai/ui` from `vendor/`, so no second checkout is involved, but rebuilding it still needs
a Node toolchain. The compiled viewer assets are committed, so every Go gate above runs in any
clone and the binary builds with Go alone.

Rebuilding needs **Node 20 or newer**, and `make build` takes that path whenever `npm` is on your
PATH. It runs `npm ci` and the Vite builds first, because `//go:embed` reads the artifacts at
compile time. A full `make check` needs npm for the viewer gates, and node for doclint and
leakcheck, so install both before you push. Re-run `make build` after you edit `apps/viewer`, which
is what keeps the committed artifacts matching the sources.

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

A gate relaxed to pass is a gate that no longer tests anything. Coverage disappeared here once
because a guard referenced deleted code: the oracle tests skipped, and every test command reported
green.

## Code you should not "simplify"

Three places look more complicated than necessary and are not. Each replaces an obvious
implementation that is wrong, and each carries a comment explaining why:

- `internal/trajectory` — the ordered-object model. Go maps cannot reproduce insertion-order
  semantics, including keys first declared with `undefined` that still occupy their slot.
- `internal/normalizer/value.go` — coercion rules mirroring JavaScript property access on
  primitives.
- `internal/cli/assemble.go` — the byte-level escaping pass. A decode and re-encode corrupts raw
  U+2028/U+2029 and a literal `<` in source text. `fixtures/claude/v2.1/hazard-text` is the
  fixture that catches you.

The gates will catch you, but they report "bytes differ" across a whole tree, which is an expensive
way to rediscover a documented reason.

## Tests are part of the change

The gates compare whole trees: they tell you **that** something differs, never **where**. Unit tests
exist to localise. The useful question is not "what percentage is covered" but *"if this breaks,
will a test name the bug in seconds?"*

Concentrate coverage where a byte diff cannot help. Serialization order, encoding edge cases, chunk
boundaries, re-run merging, flag parsing and destination semantics all qualify. An assertion that
holds independently of the goldens is worth more than one that does not.

**When you add a user-facing surface, add the test that keeps it documented.** A flag, a command or
an output format each has somewhere it must be described, and prose describing code drifts the
moment nobody is looking. Assert the link instead of remembering it. Three such assertions already
exist, and they are all the same shape. `--help` must name every flag, the usage strings must list
every command, and doclint requires [MANUAL.md](MANUAL.md) to document every flag. `manual` was
added to the full help and missed in the short usage precisely because that third assertion did not
exist yet.

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

## Commits

Keep one idea per commit. If a change will not fit that shape, it is doing more than one thing, so
split it.

**Subject** — always. Under 60 characters, imperative, no trailing period, completing *"If applied,
this commit will …"*. Say what the change does.

**Body** — only when the subject leaves a real question. Use bullets, one line each, under 60
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
agent's session or transcript — private to whoever ran it, dead to everyone else.

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
prints it. Do not move or rename it. doclint compares the copy inside `bin/cs-tracer` against the
file, so run `make build` after editing it. Without that, the gate reports a mismatch you did not
cause.

`AGENTS.md` carries nothing of its own. It is the filename agent harnesses discover by themselves,
so it routes to the documents above and holds no knowledge that could go stale against them.

A comment or a document citing a spec section by number, as `§3.1`, is checked by doclint against
the numbered sections of [SPEC.md](SPEC.md). Renumbering one breaks every citation into it at once.

## Writing

The docs drift into a style that reads as terse and knowing rather than clear. These rules push
back. `scripts/lint-docs.py` enforces the mechanical ones, and `make check` runs it.

1. **Write to the reader, in second person.** "Run `make check` before you push", not "the check
   should be run before pushing".

2. **Introduce a term where you first use it.** A reader meeting *trajectory*, *shard* or *golden*
   for the first time needs it introduced. Give a definition on the spot, an entry in a glossary
   table, or a link to the page that defines it.

3. **One em-dash per paragraph at most.** Two or three read as a writer who will not commit to a
   sentence. A colon or a full stop nearly always works better.

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

Run the linter on its own while you write:

```bash
python3 scripts/lint-docs.py            # check
python3 scripts/lint-docs.py --stats    # per-file measurements
python3 scripts/lint-docs.py --list     # which files are checked
```

The knobs live beside it in `scripts/lint-docs.config.py`: `GLOSSARY`, `SKIP_EXTRA`,
`LOWERCASE_STARTERS` and `PROJECT_VERBS`. When a real sentence trips the verb check, add the verb.
When a report is noise, fix the check. A linter that cries wolf gets ignored, and then it protects
nothing.

The linter itself is vendored and stays byte-identical across projects. A fix to a check belongs in
the shared copy, and comes back here the next time it is copied out.

`scripts/lint-oss.py` is its sibling, and `make oss` runs it. It checks what this repository has to
satisfy as a published project, and `--explain` lists every rule it applies. Its knobs live beside
it in `scripts/lint-oss.config.py`.

## Style

Match the file you are editing: dense, comment-light code with occasional long explanatory comments
where something is genuinely non-obvious. Keep those. Every one marks a place where the obvious
implementation is wrong.
