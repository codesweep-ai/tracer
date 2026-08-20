# Fixture corpus

Input sessions for the gates. Organised as `fixtures/<cli>/<version>/<case>/`, so
a new CLI version means a new directory beside the old one rather than edits to
the existing cases.

Each fixture has a matching expected-output tree under `oracle/`. Adding one is
described in `CONTRIBUTING.md`.

## On-disk forms

The adapters read what each CLI actually writes:

| CLI | Layout |
|---|---|
| Claude Code | `<uuid>.jsonl`, sub-agents at `<uuid>/subagents/agent-<id>.jsonl` + `.meta.json` |
| Codex | `rollout-<timestamp>-<uuid>.jsonl`, one file per thread |
| OpenCode | one whole-file JSON export per session: `info` + `messages` |

## What each case exercises

### `claude/v2.1/`

| Case | Exercises |
|---|---|
| `simple` | The baseline. Tool results arrive inside pseudo-`user` records paired by `tool_use_id`; thinking parts carry API `signature` blobs that must not leak into event text; one API message repeats its `usage` per block, so tokens must be deduped by `message.id`. Also carries most of the uuid-less sidecar record types the adapter must classify rather than drop. |
| `tool-heavy` | A session dominated by tool calls — Bash/Write/Read/Edit cycles. |
| `subagent-run` | The sub-agent join. The spawning tool is named `Agent`, not `Task` — version drift the adapter must accept — and children are joined by `toolUseResult.agentId`, with a `.meta.json` sidecar per child. |
| `subagent-depth2` | A true depth-2 chain whose storage is **flat**: both agent files sit in the root's `subagents/` directory and their records carry the root session id. Parentage must come from each `.meta.json`'s `toolUseId`, never from layout. |
| `multi-chunk` | The only case that crosses a chunk boundary (`chunkCount: 2`). Without it, any chunk size above the largest single-chunk fixture would pass. |
| `hazard-text` | The byte-level hazards: a literal `</script>`, raw U+2028/U+2029, a literal `<` sequence, astral characters and an RTL override. If escaping breaks, this is what catches it. |
| `malformed` | A bad JSON line, an unknown record type and a blank line — the `parse.warnings` path. |
| `empty-session` | Zero events. Exits 0 and emits skip messages; it has no documents to diff, so its expectation is the invocation itself. |
| `all-skipped` | Every file skipped. Same shape as above, for the exit-0-when-nothing-normalizes rule. |
| `large-session` | A large real capture, multi-chunk — messier and longer than any authored case. |
| `large-multi-agent` | A large real capture with sub-agents. |

### `codex/v0.146/`

| Case | Exercises |
|---|---|
| `multi-agent-run` | The root-thread trap: in child rollouts `session_meta.session_id` is the **root** thread, so keying on it makes every child its own parent. Children must be keyed by `payload.id` / `forked_from_id` / `parent_thread_id`. Child files also re-embed the root's `session_meta`, which must be deduped. Carries `custom_tool_call`, `function_call` pairs, cumulative `token_count` (use `last_token_usage`, not the running total), and the `event_msg` envelopes the adapter deliberately ignores. |
| `simple` | A single-thread rollout. |
| `tool-heavy` | A stepwise build-and-test rollout. |
| `subagent-depth2` | A depth-2 chain carrying explicit `thread_spawn.parent_thread_id` and `depth`, so it normalizes with no special-casing. |

### `opencode/v1.18/`

| Case | Exercises |
|---|---|
| `multi-agent-run` | Parent/child linking through `info.parentID`, with `task` tool parts doing the spawning. Per-step tokens and cost come from `step-finish` parts and must not be double-counted against message rollups. OpenCode reports real `cost`, so it is authoritative rather than estimated. |
| `simple` | A single-session export. |
| `tool-heavy` | A stepwise build-and-test export. |

Depth beyond 1 is not reachable in OpenCode's default configuration: spawned
sub-agents get no `task` tool.

### `synthetic/`

`generate.mjs` produces a seeded, deterministic Claude-Code-format session tree
sized to a scale budget. Same seed and arguments give byte-identical output. The
multi-MB result is gitignored; the generator is committed.

It is also the publication-safe fallback: its content is generated rather than
captured, with `/home/user/synth-project` paths throughout.

## These are scrubbed captures

Real sessions, run against throwaway tasks, then put through
`scripts/scrub-fixtures.mjs`, which rewrites host paths, usernames, e-mail
addresses, session identifiers and conversation prose. The readiness gate in
`make check` refuses to let host-identifying data reach a commit.

**Scrubbing preserves hazards.** Some cases exist to pin byte sequences that live
*inside* prose — raw U+2028/U+2029, a literal `<`, a raw `</script>`, emoji.
Redaction carries every such sequence into its replacement, so the property under
test survives. This is generic: a new hazard case is protected without touching
the scrubber.

**Scrubbing invalidates the goldens.** Regenerate with `scripts/gen-goldens.sh`
and review the diff.

## Look-alikes that must not be "cleaned"

Three patterns look like secrets and are load-bearing format features. Removing
them would break what the fixture tests:

- `thinking`-part `signature` fields — long base64, API-generated.
- `response_item.payload.id` object ids and a git SHA in `world_state` — long hex.
- Codex `reasoning` records carry `payload.encrypted_content`; its base64 can
  coincidentally match key-shaped patterns. A hit confined to that field is a
  known false positive. A hit anywhere else is not.
