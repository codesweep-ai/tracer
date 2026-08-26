// Package tracer exposes assets embedded at build time.
//
// It exists so files at the repository root can be embedded: //go:embed cannot
// reference a parent directory, and the manual belongs at the root where a
// reader finds it, not buried in internal/.
package tracer

import _ "embed"

// ManualMD is the user-facing manual, embedded so `cs-tracer manual` carries it
// inside the binary. A user who has only the executable still has the
// documentation.
//
// Embedded as a FILE rather than a Go string literal on purpose: the same bytes
// are reviewable as markdown in the repository and shipped in the binary, so the
// two cannot drift. A `cs-lint surface` gate asserts the manual names every
// flag the parser accepts, and that the copy the binary prints is this file.
//
// Named MANUAL.md, not AGENTS.md: this documents USING the tool, while AGENTS.md
// conventionally means "how to work in this repo". Repo-working guidance lives in
// CONTRIBUTING.md. (Leaving the name unused also keeps it clear of cs-ledger,
// whose upgrade verb writes its own AGENTS.md into repos it manages.)
//
//go:embed MANUAL.md
var ManualMD string
