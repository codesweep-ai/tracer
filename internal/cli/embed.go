package cli

import _ "embed"

// The two viewer build artifacts: the single-file shell with JS and CSS
// inlined, and the split shell with shared, relatively-referenced assets.
//
// They are COMMITTED, which is what lets a clone build the binary with no Node
// toolchain and no second checkout. `make viewer-build` refreshes them from
// apps/viewer, and `make build` orders that strictly before compiling so an
// integrated branch embeds what it just built.
//
//go:embed viewer/single/index.html
var singleShell string

//go:embed viewer/split/index.html
var splitShell string

//go:embed viewer/split/assets/app.js
var splitJS []byte

//go:embed viewer/split/assets/app.css
var splitCSS []byte
