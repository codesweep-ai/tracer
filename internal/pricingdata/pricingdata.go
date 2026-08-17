// Package pricingdata embeds the pricing table (pricing.json at the repository
// root) so the normalizer prices sessions identically no matter what directory
// the binary runs from. Embedding is what keeps cs-tracer a single file with no
// data dependency to locate at runtime.
package pricingdata

import _ "embed"

//go:embed pricing.json
var JSON []byte
