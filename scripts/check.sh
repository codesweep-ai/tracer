#!/usr/bin/env bash
# Every gate, one command. Exits non-zero on the first that fails.
#
# Deliberately provider-agnostic: CI calls this script rather than reimplementing
# the gate list, so the gates cannot drift between "what CI runs" and "what a
# developer runs".
#
# `make test` runs Go tests ONLY. It is not the suite. This is.
set -euo pipefail
cd "$(dirname "$0")/.."

# say heads each gate, so a long run reads as a list rather than as a wall.
# Bold where a terminal is reading it and plain where a pipe is, so
# `make check > check.log` leaves a log somebody can read. The Makefiles in
# this family carry the same shape.
say() {
  if [ -t 1 ]; then
    printf '\n\033[1m==> %s\033[0m\n' "$1"
  else
    printf '\n==> %s\n' "$1"
  fi
}

run() { # run <name> <command...>
  say "$1"; shift
  "$@"
}

# A gate whose toolchain is absent says so and the run continues. That is not
# the same as passing, and it is why the line is loud: a run reporting a skip
# has not verified everything.
skip_gate() { # skip_gate <name> <why>
  say "$1"
  printf '    SKIP %s\n' "$2"
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
# Through `make test` rather than a bare `go test`, so this suite writes its
# coverage tier like every other entry point does. A bare invocation here would
# leave the gate below judging whatever the last local run happened to leave.
run "go tests"                             make test
run "coverage (aggregate + no lost suite)" make coverage-check

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

# The prose rules from CONTRIBUTING.md: how the documents are written, and the
# counts a sentence must not assert, which drifted three times in one session
# before anything checked them.
run "prose (cs-lint prose)" make prose

# Everything the documents point at, resolved against the tree: a path, a spec
# section a comment cites, an issue identifier, a document the router owes a
# line. It asks for no binary, so it answers before the build.
run "references (cs-lint refs)" make refs

# The rules a repository has to satisfy to be published: the licence, the
# document set, the release path, and what a stranger's clone can do with it.
#
# It also carries the leak scan, which is why this gate is the one that must
# never be skipped. Fixtures are captured from real sessions, goldens derive
# from them, and issue records quote paths and findings, all of it checked in.
# A manual scrub needed six passes to get clean.
run "open-source readiness (cs-lint oss)" make oss

# The documented interface against the binary built above: every command they
# name, every command it carries, the settings the code reads, and every sample
# output re-run now.
run "docs against the binary (cs-lint surface)" make surface

# The issue ledger validates with its own tool, which is a separate install.
if command -v cs-ledger >/dev/null 2>&1; then
  run "ledger" cs-ledger check ledger
else
  skip_gate "ledger" \
    "cs-ledger is not installed: go install github.com/codesweep-ai/ledger/cmd/cs-ledger@latest"
fi
