# The cs-tracer specification

`cs-tracer` reads the session transcripts an AI coding CLI leaves on disk and writes a browsable
trace viewer. This document states what the output must be, byte for byte, and how the binary that
produces it is built. It is the contract between the normalizer, the viewer, and anything else that
reads a normalized document.

**How to read it.** Everything here is enforced by a gate unless it appears under
[Unspecified behaviour](#unspecified-behaviour). [CONTRIBUTING.md](CONTRIBUTING.md) covers running
those gates, and [MANUAL.md](MANUAL.md) covers using the tool.

**Normative language.** **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** carry their
RFC 2119 meanings. The numbered requirements (**R1**, **R2**, …) are the testable statements, and
the prose around them says why each one is there.

## Vocabulary

| Term | Meaning |
|---|---|
| **trajectory** | One agent session, normalized: its metadata, its totals, and its ordered events. The unit the format describes. |
| **event** | One step of a trajectory. A message, a tool call, a tool result, or a `meta` record the adapter could not classify. |
| **normalizer** | The package that turns one CLI's on-disk session format into a trajectory. One adapter per CLI family. |
| **adapter** | The part of the normalizer that reads a single CLI family: Claude Code, Codex or OpenCode. |
| **strip** | The row of cells the viewer draws for a trajectory, one cell per event, coloured by kind. |
| **lane** | One trajectory's row on the index page, indented under the trajectory that spawned it. |
| **shard** | One file of a normalized tree. The tree is sharded into an index, a summary per trajectory, and chunks of events. |
| **chunk** | A shard holding a bounded run of events, so a viewer loads a long trajectory in pieces. |
| **fixture** | A captured session under `fixtures/`, scrubbed of anything identifying, used as gate input. |
| **golden** | The committed expected output for one fixture, held under `oracle/`. |
| **oracle** | The whole tree of goldens. The specification expressed as expected bytes. |
| **parity** | The gate proving `--single` and `--split` render the same page from the same input. |
| **export** | The default action: a viewer written to disk, as one file or as a directory. |
| **manifest** | `.cs-tracer.json`, the bookkeeping file `--split` writes to record what it generated. |

## 0. How it is built

```
cs-tracer  (one static Go binary)
├── //go:embed  the viewer builds — single-file shell, and split shell + assets
├── //go:embed  MANUAL.md, so `cs-tracer manual` ships inside the binary
└── the normalizer: one adapter per CLI family, plus a shared ordered-JSON model
```

**R1.** The shipped artifact **MUST** be one statically linked binary that reads no asset from
disk, reads no configuration file, runs no build step, and opens no network connection.

**R2.** Both viewer builds and `MANUAL.md` **MUST** be embedded at compile time. *A user holding
only the executable still has the interface and the documentation.*

**R3.** Where the viewer sources resolve, the build **MUST** run both viewer builds and their
artifact assertions before compiling, with no stamp file short-circuiting them. *A stamp with no
prerequisites ships stale embedded assets in a binary that passes every other gate.*

**R4.** Where the sources do not resolve, the build **MUST** verify that the committed viewer
artifacts are present, and compile against those. *A clone cannot install a checkout it has no
access to, and failing there would leave the binary unbuildable for everyone else.*

**R5.** The version **MUST** come from the build information Go embeds, rather than a linker `-X`
stamp. *The Go linker silently ignores an `-X` naming a symbol that does not exist, so a plain
`go build` produces a working binary that reports its version as `dev`.*

The viewer is a React application built twice by Vite. One build inlines everything, the other
emits shared assets. Both write into the Go module tree, so `//go:embed` reaches them at compile
time. The artifacts are committed, so a clone with no Node toolchain still builds the binary.

## 1. Schema version

**R6.** Every index and every summary **MUST** declare `schemaVersion`. The current value is **3**.
Version 3 made `totals.cost` an object of figures kept apart by where they came from (§9). It also
replaced `meta.durationMs` with `totals.time`, which keeps elapsed, idle and working time apart
(R77).

**R7.** A consumer **MUST** refuse a document whose version it does not implement, rather than
rendering what it can. *A partial render produces blank panels and missing fields that read as data
problems and send whoever debugs it somewhere else.*

**R8.** The reduced index embedded in a split-mode trace page **MUST** declare it too. *Omitting it
there made the viewer reject documents it had just produced.*

**R9.** Every declaration of the version **MUST** agree. There are four: the `const` in
`schema/trajectory.v1.json`, the value `internal/normalizer` emits, `internal/cli.schemaVersion`,
and the viewer's `SUPPORTED_SCHEMA_VERSION`.

A test ties the schema file to what the normalizer emits. The other two are held by review, which
the open questions record.

## 2. Output layout

`cs-tracer normalize <dir> --out X` writes a shard tree:

```
X/
  index.json                      one entry per trajectory
  <trace-id>/summary.json         metadata, totals, parse stats, event strip
  <trace-id>/chunks/000.json      events, 1000 per chunk
  <trace-id>/chunks/001.json
```

**R10.** `normalize --out` **MUST** write `index.json`, one `summary.json` per trajectory, and the
trajectory's events under `chunks/`.

**R11.** `index.json` **MUST** be pretty-printed with a two-space indent.

**R12.** Every summary and every chunk **MUST** be compact, with no space and no newline inside.

**R13.** Every file **MUST** end with exactly one `\n`.

**R14.** Chunks **MUST** be numbered from `000`, zero-padded to three digits.

**R15.** A chunk **MUST** hold at most 1000 events, the count `normalizer.ChunkSize` carries. *The
`large-session` fixture holds 1,366 events, so it produces two chunks, and the second holds 366.*

## 3. JSON serialization: the byte-level rules

This format specifies **bytes**, not merely data. Two documents carrying identical information are
not interchangeable. Ordering keys differently, or rendering the same number with a different digit,
produces a different document and a non-conforming one.

Rules that would ordinarily be implementation detail are therefore specification, and they are why
several pieces of this code cannot be simplified.

**3.1 Object key order.**

**R16.** Object keys **MUST** serialize in first-declaration order, neither alphabetically nor in
assignment order.

**R17.** A key first declared with an `undefined` value **MUST** occupy its slot even though it
never serializes. *A later assignment to that key then emits it in the original position rather
than at the end.*

This is the subtlest rule in the format. It is why `internal/trajectory` exists as an ordered-object
model rather than a Go map, and why `internal/normalizer/value.go` is written the way it is.

**3.2 Number rendering.**

**R18.** A float **MUST** serialize as the shortest decimal string that parses back to the identical
value.

**3.3 Size accounting.**

**R19.** `strip.size` **MUST** be a byte length rather than a character count. The number covers
the UTF-8 encoding of the event's serialized form.

**3.4 Line and paragraph separators.**

**R20.** U+2028 and U+2029 **MUST** pass through raw. *They are legal in JSON strings, and a naive
decode and re-encode through Go's `encoding/json` escapes them and corrupts the bytes.*

**3.5 Data-block escaping.**

**R21.** A `<` inside an export data block **MUST** be escaped as `\u003c`. *The exported
page carries its data in `<script type="application/json">` blocks, so an unescaped `</script>` in
trace text would terminate the block and destroy the page.*

**R22.** That escaping **MUST** be a byte-level pass rather than a decode and re-encode. *A literal
`\u003c` already in the source text has to survive as `\\u003c`, and a naive string
replacement corrupts it.*

## 4. Invocation behaviour

Exit code, **stdout** and stderr are all part of the contract, not incidental. A *candidate file*
below is a `.json` or `.jsonl` file under the input path, excluding the `.meta.json` sidecars and a
normalized tree's own `index.json` and `summary.json`.

**R23.** A run that produces no documents **MUST** exit `0` and explain itself on stderr. *A session
with no events is a session with no events, not a failure.* The `empty-session` and `all-skipped`
fixtures cover this. Each carries a `RUN.txt` and no golden tree, because what they pin is the exit
code and the two streams.

**R24.** `normalize --out` **MUST** print `normalized <N> trajectory(s) to <path>` on stdout, with
`; skipped <N>` appended when any input file produced no trajectory.

**R25.** A bare `normalize` and an export **MUST NOT** print that line. *A bare `normalize` writes
its documents to stdout, and an export writes its own one-line report there instead.*

**R26.** A skip diagnostic **MUST** name the file relative to the working directory. *The wording is
part of the contract, because the goldens record it.*

**R27.** An input path holding no candidate file **MUST** exit `1`. *A directory whose candidates
all fail to normalize is the R23 case and exits `0`, so the two are distinguishable.*

Exit code and streams are checked by running the tool and comparing, never by treating them as files
in the output tree. The tool emits no record of its own invocation.
[CONTRIBUTING.md](CONTRIBUTING.md) describes how that expectation is stored.

## 5. Export

**R28.** `--single` **MUST** inline the viewer, its styles and every data block into one HTML file,
and that file **MUST** open from `file://` with React mounting and zero page errors.

**R29.** `--split` **MUST** emit `index.html`, a shared `assets/app.js` and `assets/app.css`, and
one page per trajectory under `traces/`. A trace page points at `../assets/`, never `./assets/`.

**R80.** Each `--split` page **MUST** declare its kind, index or trace, in its `#mode` block, and the
viewer **MUST** route from that declaration rather than from the URL. *The export directory's name
is the user's choice. Read from the path, an export written to a directory named `traces` took its
own index for a trace page, and every lane link led to a missing page.*

**R30.** The two modes **MUST** render identically: DOM digest, full-page pixels, and interaction
end-state. *Only the transport differs, and that equivalence is the product's central claim.*

**R31.** `--split` **MUST** write a manifest recording the tool, its version, the generation time,
and every path it created.

**R32.** The manifest **MUST** be excluded from determinism comparisons. *It carries a timestamp.*

**R33.** `--split` **MUST** refuse a non-empty destination that carries no manifest of ours, unless
`--force` is given.

**R34.** `--force` **MUST** delete only `index.html`, `traces/` and `assets/`. *A mistyped
destination then cannot destroy unrelated files.*

**R35.** An export above 25 MiB **MUST** warn on stderr and still succeed. *The threshold is
binary, `25 * 1024 * 1024`; browsers parse HTML fast enough that the warning sits well before the
point where first paint stalls.*

**R84.** The split `index.html` **MUST** carry every trajectory's summary and no chunk. Each trace
page carries its own. *The index renders only the strips, and shipping every trajectory's events
there as well doubled the size of the export.*

## 6. Determinism

**R36.** Two runs over the same input **MUST** produce byte-identical trees, excluding the manifest.

Two gates check it. One exports `fixtures/claude/v2.1/hazard-text` twice through `--single` and
compares the bytes. The other exports a synthetic set through `--split` and compares the tree with
the manifest excluded.

## 7. Unclassified input must be loud

Every input record is either mapped to an event, harvested into `meta`, or named in an explicit
ignore list. This is a rule about defaults rather than about any particular record type. A CLI that
adds a record type tomorrow has to surface it, so silence requires a deliberate entry in the ignore
list.

**R37.** Every input record **MUST** be mapped to an event, harvested into `meta`, or named in the
ignore list.

**R38.** A record matching none of those **MUST** become a visible `meta` event and raise a
`parse.warnings` entry.

**R39.** A record with no `type` **MUST** be skipped and counted as `"(no type)"`. *A non-object
JSON line reads as all-undefined, mirroring JavaScript property access on a primitive, and a
genuinely malformed line arrives as `__parseError` and is already reported.*

**R40.** A record with no `uuid` **MUST** be harvested into `meta` and then skipped from the event
stream. *Those records carry session state rather than steps.*

**R41.** `parse.skippedByType` **MUST** be an array of `{type, count}` sorted by type. *An object
would order its keys by whichever types appeared first, and this output is compared byte for byte
(§3.1).*

**R42.** Every summary **MUST** carry `parse.skippedByType` and `parse.unrecognized`. *The first
says which kinds of record produced no event, and the second counts the ones nothing classified.
Together they are what separates correctly ignored bookkeeping from silently lost data.*

**R56.** Input that is not JSON **MUST** be reported as damage, not as an unrecognized record type:
counted in `parse.unreadable`, never in `parse.unrecognized`, and carrying `rawType: "unreadable"`.
*The two call for opposite responses: restore the file, or teach the adapter. Rendered identically,
a reader cannot tell which they are looking at.*

**R57.** Consecutive unreadable lines **MUST** collapse into a single event naming the count and the
line range. *A captured session held 2,771 consecutive unreadable lines; drawn one cell each they
are wallpaper a reader scrolls past, which is the opposite of what §7 asks for.*

**R58.** Input in which no record parses **MUST** be reported as damaged rather than unrecognized
when its bytes are not valid text. *"No recognizable records" is also what a `links.json` beside a
session produces, so a damaged transcript disappeared behind an expected-looking line. It matters
most for opencode. Its transcript is a whole JSON document extracted from the CLI's SQL store. A
damaged extract parses as nothing at all, so unlike a JSONL session it cannot degrade into a partial
trajectory. The diagnostic is the only report there will be.*

**R67.** An input record reporting that a turn ended in failure **MUST** produce an event marked
as an error, never one that reads as a completed turn. *The codex adapter mapped `task_complete` to
a turn end whose text was always "turn complete" and never read the record's `error` field. In a
captured corpus of twenty codex trajectories, twenty three turns had died on a provider limit.
Every one of them normalized to that text, and no event in those trajectories was marked as an
error. A reader counting completed turns counted the failures among them.*

An event carries `isError` when it has no result of its own to report failure through. A tool call
keeps reporting failure through `result.isError`, and `stripEvent` reads either. The field is
additive and optional in `schema/trajectory.v1.json`, so `schemaVersion` is unchanged (R7).

**R68.** An agent that has stopped and is waiting **MUST** be reported as idle, consistently across
every adapter. A turn ends when the model returns a response with no tool call pending, and the
interval from that event to the moment work resumes is idle. Work resumes at a user instruction, an
assistant message, a thinking step or a tool call. Every other interval is work, including a long one
after a tool call, which is a slow tool.

*Nothing said what idle was, and no adapter reported it. The interval holds most of a session's
elapsed time: 97.9% of one captured session, and 88% and 55% in aggregate for the two unattended
adapters. A tool that cannot name it cannot say how long anything took.*

**R69.** An adapter **MUST NOT** report a turn ending that did not end a turn. *OpenCode emits
`step-finish` after every batch of tool calls, and the agent carries straight on. Only the step whose
reason reads `stop` leaves it waiting. Reported as turn ends they were 892 events across twelve
captured trajectories, 31% of every strip, against three real endings each. The rest are bookkeeping
and read as `meta`, keeping their reason, so a reader still sees what they were.*

A record carrying no work does not end the wait. Bookkeeping lands while the agent sits still, and
stopping at one of those reported two seconds of idle for a wait of hours (TRC-014). An adapter
reports a user instruction only for a message the agent is meant to act on. A CLI's echo of its own
local command is not one, and read as one it ended waits of hours (TRC-016).

Idle travels as `idleMs` on the event that ends the turn and on its strip entry, so the viewer never
subtracts timestamps across neighbours a filter removed. A turn end with nothing after it carries no
field rather than a zero, because waiting for nothing and waiting no time are different claims. Both
fields are additive and optional, so `schemaVersion` is unchanged (R7).

**R70.** Every thinking step, assistant message and tool call **MUST** report the time it accounts
for, consistently across every adapter. The interval runs from the end of the previous piece of work
to the end of this one. A tool call ends when its result arrives, and a turn end ends once its idle is
over. A record carrying no work is stepped over, as R68 steps over it.

*The interval looks backward because a record is written when its block is done, so the model's
latency before a reply is what produced that reply. Measured forward from each response, that latency
belonged to no event, since a tool call already reports its own run time. It came to 8% to 26% of
elapsed time across thirty captured trajectories, most of it sitting on bookkeeping records.*

The interval travels as `workMs` on the event and on its strip entry, for the reason `idleMs` does.
An event with no earlier work to measure from carries no field. A reply the CLI wrote without
calling a model carries `synthetic` and no `workMs`, and the interval runs past it. Tool calls
running at once overlap, so each is measured from its own timestamp, and the work after them from
the latest result. Both fields are additive and optional, so `schemaVersion` is unchanged (R7).

**R77.** A trajectory **MUST** report three separate figures: elapsed time, idle time, and the work
its events account for. Elapsed time runs from the earliest timestamp the trajectory records to the
latest, a tool result's included, since a result can land after every later event. Idle is the sum of R68's intervals, and work
is the union of R70's, so tool calls running at once count once. Any remainder belongs to neither,
and stays visible as the difference.

*A single duration from the first timestamp to the last said how long a session was left open. One
captured session reported 211 hours, of which 207 were idle and 4.4 were work.*

The figures travel as `totals.time`. The viewer shows working time first, with the time open beside
it.

**R78.** A duration a CLI reports **MUST** be kept as reported, with what it covers, and never in
place of tracer's own figures. This is the rule §9 sets for cost. *Claude Code reports its process's
wall time and its time on the model and on tools. They cover the session and its sub-agents, and the
wall time runs on while the session sits open with nothing written. One session reported 18.3 hours
against 8.9 hours of transcript.*

**R79.** Where a CLI records when the model began a step, the event **MUST** carry it as `startTs`.
Its strip entry **MUST** then carry the part of `workMs` spent generating, as `activeMs`. *The time R70
charges a step is the round trip to the model: the wait for it to begin, then its generation. In a
captured codex trajectory a thinking step carried 48.1 seconds, of which the reasoning ran 0.2.*

Codex records a start for reasoning items and messages, and OpenCode for reasoning and text parts.
Claude Code records only when a block finished, so its events carry neither field, and its model time
stays whole. Both fields are additive and optional, so `schemaVersion` is unchanged (R7).

**R82.** Where a CLI records the permission mode or approval policy behind a tool call, the call
**MUST** carry `approval`. Its value names who approves the call if the CLI asks: `person`,
`classifier` or `automatic`. The viewer **MUST** then say that the call's time may include that wait. *No CLI records the
approval itself, so a prompted call's time runs from the call to its result and takes in the person
deciding. In Claude Code's `default` mode an edit took a median 2.1 seconds, against 0.04 where edits
were approved unasked.*

Claude Code's adapter reads `permissionMode`, which can change mid-session, and knows which tools run
unasked in each mode. The codex adapter reads each turn's `approval_policy`, under which only a call
requesting escalated permissions can reach a person. OpenCode's adapter leaves the field absent,
because no captured OpenCode session holds a prompt to learn from. The field is additive and
optional, so `schemaVersion` is unchanged (R7).

`parse.unreadable` is additive and optional in `schema/trajectory.v1.json`: the current adapters
always emit it, and documents written before R56 omit it. `schemaVersion` is unchanged, because a
consumer that ignores the field still renders such a document correctly (R7).

## 8. The viewer

The index page draws one lane per trajectory, and a trace page draws one card per event. Beside
every lane sits the strip, which is the trajectory's shape at a glance. What a reader can tell from
it is a contract, so the rules below govern colour, error marking and filtering rather than layout.

**R43.** Every pair drawn from the kind colours and the error mark **MUST** stay perceptually
separable in both themes. *The gate measures all pairs and requires an OKLab distance of at
least 15.*

**R44.** Kind colours **MUST** be assigned per kind, rather than dealt from a palette in key order.
*Key order put assistant beside user, which is the distinction a reader most needs.*

**R45.** The dark set **MUST** be selected values rather than an inversion of the light set.

**R46.** `system`, `meta` and `turn_end` **MUST** render in muted ink rather than a categorical hue.
*Plumbing recedes, so the four content kinds carry the signal.*

**R47.** An error **MUST** be drawn as a mark over the cell's kind colour, never as a replacement
fill. *An errored tool call still has to read as a tool call.*

**R48.** Where the strip aggregates events into buckets, it **MUST** carry errors in a channel of
their own. *A bucket draws the kind it holds most of, and an error inside it cannot be what gets
dropped.*

**R49.** The kind chips, the errors-only flag and the text query **MUST** compose as an
intersection.

**R50.** A filter matching nothing **MUST** say why, and **MUST** offer the way back.

**R51.** A total omitting a trajectory **MUST** report how many it omitted, and an estimated cost
**MUST** be marked as an estimate. *A total that silently drops an unpriced lane presents an unknown
as a known.* Which figure a trajectory shows, and how a total counts a tree, is set out in §9.

**R52.** Content redacted at its source **MUST** be marked as redacted rather than rendered blank.

**R53.** `#ev-<n>` **MUST** select that event in both export modes, on a cold load.

**R81.** A cold load of `#ev-<n>` **MUST** scroll the event list until that event's card begins at
its top, unless the scroll reaches the end first. *Intersecting the list is not enough: a landing
judged on estimated row heights left the card cut partway down, or one card below, once the real
heights arrived.*

**R54.** A proven parent-child connector **MUST** render distinctly from a link hint. *A hint comes
from a `--links` file and is somebody's claim, and a connector comes from the session's own spawn
event.*

**R83.** Every trajectory **MUST** carry `meta.sourceDir`, the directory its file was read from,
relative to the directory the tool was given. When the top-level trajectories come from more than
one directory, the index page **MUST** group them under a heading naming each, with every child in
its parent's group. *A site built over one directory per agent showed rows titled almost alike, and
every agent reported the same working directory, so nothing told them apart.* Each group starts open
and folds away under its heading, and one control folds or opens them all. A site read from one
directory shows no headings.

**R59.** A child whose spawning event is present **MUST** carry that event's index as
`meta.parentEventIndex`. *The index page can derive it by scanning the parent's strip, because it
holds every summary. A split-mode trace page holds only its own, so without the stamp a child has no
route back to its fork point on a cold load.*

**R60.** A proven connector **MUST** name the event it points at, and the lane **MUST** offer a
route to it. *Ten pixels per event makes a long parent a scroller thousands of pixels wide, so the
spawn cell is usually off screen and the connector degrades to a stub. A stub that cannot point can
still say where.*

**R61.** Acting on a connector **MUST** reveal the spawn cell in the parent's strip without leaving
the index. *A reader is on the index to compare lanes, and sending them to the parent's own page to
learn where a fork happened throws that away.*

**R62.** A cell reached by navigation **MUST** be centred in the strip where there is room, and
**MUST** stop at an end rather than centre into blank space. *EventLanes scrolls a selection into
view minimally, parking it against the viewport edge with nothing after it visible, which is the
least useful place to arrive.*

**R63.** A tool input **MUST** render for reading by default, and the verbatim record **MUST** stay
one control away. *Almost every tool's payload is a multi-line string, and JSON escaping is what
turns one into a single line of `\n` and `\"`. In one captured corpus 3,159 of 3,432 calls were
shell commands, so the commonest case was the worst served.*

**R64.** The formatted view **MUST** render every key of the input. *It is a rendering, not a
summary. Switching to the record must reveal nothing that was withheld, because that is what lets
the formatted view be the default.*

**R65.** Input shape, never tool name, **MUST** select the rendering. *Names differ per CLI, and the
fixture scrubber rewrites them to prose, so a table keyed by name could not be exercised by the
corpus at all.*

**R85.** A tool output **MUST** render in the same bounded block as an input, whole and unaltered,
with one control that lifts the bound. Its shape, never the tool's name, **MUST** pick the grammar:
a document that parses as JSON, a patch, and otherwise plain text. *Outputs run far longer than
inputs. In four captured corpora between 13 and 42 per cent ran past 40 lines and the longest past
1,400. Drawn unbounded, one card grew taller than the list it sat in.*

**R55.** Viewer styling **MUST** go through the `@codesweep-ai/ui` design tokens rather than literal
values. *An eslint rule fails the build on a token it does not recognise, which is what lets both
themes work with no change to the app.*

The unit gates under `apps/viewer/src/test` check these, and they need npm. A clone with no Node
toolchain skips them, so run `make check` with npm installed before you push a viewer change.

## 9. Cost

A trajectory's cost has up to three sources. The CLI may state a figure for a span of work, and it
may state costs on single events. Tracer adds its own estimate from its price table. They live apart in
`totals.cost`, as `reported`, `reportedByEvents` and `estimated`. An adapter fills what its CLI
provides, and the estimate is made the same way for every adapter.

A reported figure is the CLI's own calculation from its own price table, not a bill. It still beats
the estimate, because the CLI knows what it called and at what rate.

**R71.** A cost a CLI reports **MUST** be kept, named as reported, and never merged with tracer's
estimate. *One field used to hold a reported figure for one adapter and an estimate for the others,
and the index added the two into one total.*

**R72.** A reported cost **MUST** say what it covers: the trajectory alone, or the trajectory and
its sub-agents. *Claude Code states one figure for a session and every sub-agent it ran, plus calls
it never writes to a transcript. OpenCode states one per session. Read as a session's own cost,
Claude Code's figure counted its sub-agents twice in any total.*

**R73.** A cost field **MUST NOT** stand in for another. An adapter leaves a field absent when its
CLI provides no source for it. *A figure of one kind in a field of another kind is how the two got
mixed.*

**R74.** A trajectory's reported figure and the sum of its events' costs may cover the same work and
differ by half a cent or more. Both **MUST** then be kept, and a `parse.warnings` entry raised. *The
two cover the same work only when every event carrying token usage carries a cost. OpenCode states
both, and its session figure used to replace the sum without a check.*

**R75.** A trajectory **MUST** show a reported figure covering it alone where there is one. Failing
that, it shows the sum of its events' costs where every event is priced, and failing that the
estimate, marked as one. A figure covering its sub-agents too is shown beside it and labelled so.

**R76.** A total **MUST** count each tree of trajectories once. A trajectory whose reported figure
covers its sub-agents stands for all of them, and otherwise it adds its own figure and each child is
taken the same way. *A figure covering a tree, added to the figures of its members, counts the
members twice.*

## Implementation

| Path | Role |
|---|---|
| `cmd/cs-tracer` | The entry point. It calls `internal/cli` and returns its exit code. |
| `internal/cli` | Flag parsing, export assembly, the embedded viewer, the manifest. |
| `internal/normalizer` | Session formats to trajectories, one adapter per CLI family. |
| `internal/trajectory` | The ordered-JSON model that makes output byte-reproducible. |
| `internal/pricingdata` | The model price table behind the cost estimate. |
| `internal/oracletest` | The tree comparison the golden gates share. |
| `apps/viewer` | The React viewer. Two Vite builds emit into `internal/cli/viewer`. |
| `schema/trajectory.v1.json` | The JSON schema fresh output is validated against. |
| `fixtures` | Input sessions, one directory per CLI, version and case. |
| `oracle` | Expected output for every fixture. |

Dependencies point one way. `internal/normalizer` knows nothing of the CLI surface, and
`internal/trajectory` knows nothing of either. The viewer reads only what a normalized document
declares, so a change to an adapter cannot reach it except through the schema.

The testing strategy has two halves that fail differently. The oracle tree catches any change in
output bytes, across every fixture at once, and says only that something moved. The unit tests
localize: serialization order, coercion rules, chunk boundaries, flag parsing and destination
semantics each have a test that names the bug rather than the tree.

## Testing

The gate list is here rather than in [CONTRIBUTING.md](CONTRIBUTING.md), because what a gate proves
is a property of the software. `make check` runs every one of them, and CONTRIBUTING says when to
run it.

### The gates, and what each one proves

| Gate | Proves | Skips when |
|---|---|---|
| gofmt | every tracked Go file is formatted | never |
| go vet | no vet findings, including a language-version mismatch between `go.mod` and the APIs in use | never |
| build | the binary links, and where the viewer sources resolve, both Vite builds emit and their artifact assertions hold | never |
| Go tests | the unit tier, plus the oracle, invocation and determinism gates | never |
| eslint | the viewer sources and its build scripts are clean | npm is not installed |
| viewer tests + schema conformance | the React app behaves, and output validates against the schema, both the committed goldens **and** output produced fresh by the current binary | as above |
| visual parity | `--single` and `--split` render identically: DOM digest, full-page pixels, interaction end-state across a chunk boundary | as above, or no browser |
| conventions | the ui pin agrees across every specifier, every lockfile entry (which must carry an `integrity`) and the install, and it is one exact version rather than a range; and a target that re-records committed files is named `record-*` | only the installed-copy rule skips, when nothing is installed |
| prose | the writing rules below, and that no sentence asserts a count the repo counts itself | never |
| open-source readiness | the licence, the document set, that no tracked file carries a home path, a mail address or a user name, and what a stranger's clone can do | never |
| docs against the binary | every documented command exists, the paths and spec sections the docs and the source cite resolve, and the manual the binary prints is the manual in the tree | never |
| fixture suite | the exported pages behave as recorded in a browser: structure, filters, clicks, keyboard, scrolling, layout and size, per `apps/viewer/fixtures/expectations.json` | npm is not installed, or no browser |

`make ci` runs the fixture suite and `make check` does not, because it takes about a minute and
`make check` is the loop kept beside you while working.

**The viewer gates skip rather than fail without npm.** `apps/viewer` resolves
`@codesweep-ai/ui` from the registry, pinned to one exact version, so no second checkout is
involved, but rebuilding it still needs a Node toolchain. The install runs through
`scripts/with-npmrevs.sh`, which puts cs-npmrevs in front of npmjs.com. `@codesweep-ai/ui`
publishes an image of every build, and a version that has not been released reaches npm only
that way. The tool is pinned in `go.mod`, the images are public, and every other package still
comes from npmjs.com. The compiled viewer assets are committed, so every Go gate above runs in any
clone and the binary builds with Go alone.

Rebuilding needs **Node 22.13 or newer**, the floor `@codesweep-ai/ui` sets. `make build` takes
that path whenever `npm` is on your PATH and a source under `apps/viewer` is newer than the
artifacts. It runs `npm ci` and
the Vite builds first, because `//go:embed` reads the artifacts at compile time; when nothing has
moved it skips both and embeds what is committed. A full `make check` needs npm for the viewer
gates, so install it before you push. `make build` after an edit is what keeps the committed
artifacts matching the sources.

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

### A golden is never regenerated to make a gate pass

**Never regenerate a golden to make a gate pass.**

`oracle/` is not test scaffolding. It is the specification, expressed as expected bytes. When a gate
fails, exactly one of two things is true:

1. **Your change is wrong.** Fix the code.
2. **The specification changed.** That is a deliberate act, and it deserves its own commit and its
   own review.

The failure this prevents is easy and quiet. A gate goes red, you regenerate, everything goes green,
and a real regression is now baked into the expected output where nobody will ever see it.

#### When output should change

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

### A gate is fixed, never loosened

A gate relaxed to pass is a gate that no longer tests anything. A guard that skips instead of
failing is the same thing more quietly.

### Code that is not as complicated as it looks

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

### Coverage

Every test target writes coverage into its own tier under `.coverage/`, so running several
aggregates rather than overwrites. `make coverage` merges what is there and prints the report.

`make coverage-check` runs inside `make check` and in CI. It fails when a package
`.coverage-baseline` lists stops being reached: presence, not a percentage. What it catches is a
suite that stopped running while the tests still report green. When a package is meant to lose its
coverage, rerun `make coverage-baseline` and commit the result.

## Conformance

An implementation conforms when it satisfies **R1**-**R55**. The gate list above is the reference,
and four of its gates carry the load:

1. Every fixture goes through the normalizer, and the tree is diffed against `oracle/`.
2. Fresh output is validated against `schema/trajectory.v1.json`.
3. Both export modes are put through the parity comparison.
4. The tool is run, and its exit code and its two streams are compared.

Four of those checks hold independently of the goldens, and they are the ones that survive a
regenerated oracle: the normalizer invariants, schema conformance against fresh output,
determinism, and parity.

## Unspecified behaviour

Places where the format genuinely does not say. **Do not infer intent from the current
implementation.** Each is tracked as an open record, so it can be closed rather than merely edited.

- **Invalid UTF-8 and lone surrogates** are unspecified, and no fixture exercises them, so no gate
  catches a divergence.
- **Float round-tripping** outside the corpus is unproven. R18 is demonstrated only for the values
  the fixtures contain.

Three flag behaviours are plausible readings of an under-specified requirement rather than
decisions:

- Link hints attach per-document on a bare `normalize`, because there is no index to hang them on.
- The size warning displays decimal MB against a binary threshold.
- A repeated `--links` is a hard error rather than last-wins or a merge.

## Open questions

1. **The gates do not cover everything they appear to.** Parity's interaction tier normalizes the
   values a scroll regression would perturb, and the viewer is a pinned fork with no
   re-sync policy.
2. **Captured fixtures are scrubbed, and what survives has been read once.** The scrubber
   rewrites every identifier and every path it can recognise in the capture. A read of the
   surviving structure found only generated tokens. Every path sits under `/home/user`, every
   command string is redacted, and no URL or repository reference appears anywhere in the corpus.
   A new capture needs the same read, and nothing enforces that.
3. **Section citations in source drift silently in meaning.** A comment citing `§6` still passes the
   gate after §6 comes to mean something else, because the check only asks whether the section
   exists.
4. **No requirement fixes the shard identifier.** A trajectory's directory name is its session id
   with every character outside `[A-Za-z0-9._-]` replaced, falling back to a literal when that
   leaves nothing. No requirement says so, and a collision between two ids is a hard error.
5. **Two of the four schema-version declarations are unchecked.** A test ties
   `schema/trajectory.v1.json` to what the normalizer emits. Nothing checks
   `internal/cli.schemaVersion` or the viewer's `SUPPORTED_SCHEMA_VERSION` against either of them.
6. **Determinism is gated for one fixture, not for the corpus.** R36 claims every input, and two
   gates cover one captured session and one synthetic set.
7. **Nothing gates what the strip draws.** The strip is painted onto a canvas, so the unit gates
   read its colours through `traceColors` and never through the pixels. R47 and R48 hold by
   construction in `StripCanvas.tsx`. Parity compares the two transports pixel for pixel, which
   catches a disagreement between them rather than a regression in both.
