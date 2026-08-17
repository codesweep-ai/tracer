package pricingdata

import (
	"os"
	"testing"
)

// The embedded copy must never drift from the audited table at the repository
// root (CONTRIBUTING.md lists pricing.json as the pricing source of truth).
func TestEmbeddedCopyMatchesRepoRoot(t *testing.T) {
	root, err := os.ReadFile("../../pricing.json")
	if err != nil {
		t.Fatalf("read repo-root pricing.json: %v", err)
	}
	if string(root) != string(JSON) {
		t.Fatal("internal/pricingdata/pricing.json differs from repo-root pricing.json — refresh the copy")
	}
}
