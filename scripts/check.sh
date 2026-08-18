#!/usr/bin/env bash
# Every gate, one command. Exits non-zero if any gate fails.
#
# Deliberately provider-agnostic: CI calls this script rather than reimplementing
# the gate list, so the gates cannot drift between "what CI runs" and "what a
# developer runs".
#
# `make test` runs Go tests ONLY. It is not the suite. This is.
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0 fail=0 skip=0
failed=()

run() { # run <name> <command...>
  local name="$1"; shift
  printf '\n\033[1m==> %s\033[0m\n' "$name"
  if "$@"; then
    printf '    \033[32mPASS\033[0m %s\n' "$name"; pass=$((pass + 1))
  else
    printf '    \033[31mFAIL\033[0m %s\n' "$name"; fail=$((fail + 1)); failed+=("$name")
  fi
}

skip_gate() { # skip_gate <name> <why>
  printf '\n\033[1m==> %s\033[0m\n    \033[33mSKIP\033[0m %s\n' "$1" "$2"
  skip=$((skip + 1))
}

# --- what this checkout can check --------------------------------------------
# The binary builds from the viewer artifacts committed under internal/cli/viewer,
# so every Go gate below runs in any clone, with no Node and no second checkout.
#
# Rebuilding the viewer additionally needs Node. apps/viewer resolves
# @codesweep-ai/ui through file:../../vendor/codesweep-ui, which is in the tree,
# so no second checkout is involved — but a machine with no npm still runs every
# gate above. Where npm is absent the viewer gates skip loudly rather than
# failing, because a gate that fails for a reason unrelated to the change
# teaches contributors to ignore the gate.
VIEWER_SOURCES=0
if [ -d apps/viewer ] && command -v npm >/dev/null 2>&1; then
  VIEWER_SOURCES=1
fi

# doclint and leakcheck are node scripts and need nothing else, so they are
# tracked separately from the viewer build. Without node they SKIP rather than
# fail, for the same reason: a red gate a contributor cannot turn green teaches
# them to stop reading the summary. CI installs node, so both always run there,
# and leakcheck blocks a merge even when nobody ran it locally.
HAVE_NODE=0
if command -v node >/dev/null 2>&1; then
  HAVE_NODE=1
fi

# --- gates -------------------------------------------------------------------
# Formatting and vet run FIRST: they are the cheapest gates, and a vet failure
# usually means a language-version mismatch that makes everything after it
# confusing. Both live here rather than only in the Makefile so CI, which calls
# this script directly, cannot skip them.
run "gofmt"                                make fmt-check
run "go vet"                               make vet
# The Go linters, beside gofmt and vet rather than behind an availability
# check: both are one `go install` away on a machine that already has Go, and
# a gate that quietly skips is one nobody notices has stopped running.
run "golangci-lint"                        make lint
run "deadcode (whole-program)"             make deadcode
run "build (viewer + embed + binary)"      make build
run "version stamp == git describe"        make check-version
run "go tests"                             go test ./... -count=1

if [ "$VIEWER_SOURCES" = 1 ]; then
  run "eslint (viewer src + scripts)"      npm run lint
  run "viewer tests + schema conformance"  npm test
else
  skip_gate "eslint (viewer src + scripts)" \
    "npm is not installed; the viewer sources cannot be built here"
  skip_gate "viewer tests + schema conformance" \
    "npm is not installed; the viewer sources cannot be built here"
fi

# Oracle tree + invocation behaviour + determinism are enforced by the Go gate
# tests above (TestNormalizeTreeMatchesOracle, TestInvocationBehaviourMatchesOracle,
# TestExportEndToEndDeterminism). They are listed here so the coverage is legible.

# Visual parity needs a browser AND the viewer sources. There is no Playwright
# browser cache in a fresh checkout, so this degrades to a skip rather than a
# spurious failure.
if [ "$VIEWER_SOURCES" = 1 ] && { [ -n "${CS_TRACER_CHROMIUM:-}" ] || [ -x /usr/bin/chromium-browser ]; }; then
  run "visual parity (DOM + pixel + interaction)" npm run parity --workspace apps/viewer
elif [ "$VIEWER_SOURCES" = 1 ]; then
  skip_gate "visual parity" "no browser: set CS_TRACER_CHROMIUM=/path/to/chrome"
else
  skip_gate "visual parity" "npm is not installed"
fi

# NOTE: there is deliberately no separate "goldens reproduce" gate. Regenerating
# and diffing was measurably redundant with the Go gate tests above, which
# normalize every fixture and compare against oracle/ — a hand-edited golden
# fails there already.

# Docs rot silently: nothing fails when a path stops existing or a count drifts.
# Both have happened here repeatedly, so they are checked mechanically.
if [ "$HAVE_NODE" = 1 ]; then
  run "doclint" node scripts/doclint.mjs
else
  skip_gate "doclint" "node is not installed"
fi

# The prose rules from CONTRIBUTING.md. doclint above checks that the docs are
# TRUE; this checks that they are readable, which nothing else does.
run "prose (lint-docs)" make docs

# The rules a repository has to satisfy to be published: the licence, the
# document set, what must never reach a public commit, the release path, and
# what a stranger's clone can do with it.
run "open-source readiness (lint-oss)" make oss

# The claims the documents make, against the binary built above: every command
# they name, every command it carries, the settings the code reads, and every
# sample output re-run now.
run "docs against the binary (lint-walkthrough)" python3 scripts/lint-walkthrough.py

# Host-identifying data must never reach a commit. Fixtures are captured from
# real sessions, goldens derive from them, and issue records quote paths and
# findings — all of it checked in. A manual scrub needed six passes to get clean.
if [ "$HAVE_NODE" = 1 ]; then
  run "leakcheck" node scripts/leakcheck.mjs
else
  skip_gate "leakcheck" "node is not installed — CI runs it, and it blocks the merge"
fi

# The issue ledger validates with its own tool, which is a separate install.
if command -v cs-ledger >/dev/null 2>&1; then
  run "ledger" cs-ledger check ledger
else
  skip_gate "ledger" \
    "cs-ledger is not installed: go install github.com/codesweep-ai/ledger/cmd/cs-ledger@latest"
fi

# --- summary -----------------------------------------------------------------
printf '\n\033[1m─── summary ───\033[0m\n'
printf '  passed: %d   failed: %d   skipped: %d\n' "$pass" "$fail" "$skip"
if [ "$fail" -gt 0 ]; then
  printf '\n  failed gates:\n'
  printf '    - %s\n' "${failed[@]}"
  exit 1
fi
printf '\n  \033[32mall gates green\033[0m\n'
