package normalizer

import (
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// These tests pin the pricing refusal paths the fixture corpus never
// exercises (CONTRIBUTING.md: "the corpus exercises 3 of 43 models — rates[]
// date periods, modes, geoMultipliers, and the refusal paths are untested").

func pricingDoc(t *testing.T, model string, totals map[string]any, metaExtra map[string]any) *obj {
	t.Helper()
	meta := trajectory.NewObject("source", "claude-code", "model", model)
	for k, v := range metaExtra {
		meta.Set(k, v)
	}
	tot := trajectory.NewObject("events", 1, "toolCalls", 0, "toolErrors", 0, "input", 0, "output", 0, "cacheRead", 0, "cacheWrite", 0, "reasoning", 0)
	for k, v := range totals {
		tot.Set(k, v)
	}
	return trajectory.NewObject("schemaVersion", 1, "meta", meta, "totals", tot, "events", []*obj{}, "parse", trajectory.NewObject())
}

func costOf(t *testing.T, doc *obj) (any, bool) {
	t.Helper()
	return object(get(doc, "totals")).Get("cost")
}

func TestEstimateCostBareEntry(t *testing.T) {
	pricing := mustDecode(t, `{"models":{"claude-test":{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5,"cachedIncludedInInput":false}}}`)
	doc := pricingDoc(t, "claude-test-20260101", map[string]any{"input": 1000000, "output": 100000}, nil)
	estimateCost(doc, pricing)
	cost, ok := costOf(t, doc)
	if !ok {
		t.Fatal("no cost estimated")
	}
	// 1e6*2 + 1e5*10 = 3e6 micros = 3.0 dollars.
	if cost != float64(3) && cost != 3 {
		t.Fatalf("cost = %#v, want 3", cost)
	}
	ce, _ := object(get(doc, "totals")).Get("costEstimated")
	if ce != true {
		t.Fatalf("costEstimated = %#v", ce)
	}
}

func TestSelectEntryLongestKeyOnly(t *testing.T) {
	// Both keys match; only the longest may be used, with no fall-through to
	// the shorter one even when the longer entry cannot price the document.
	pricing := mustDecode(t, `{"models":{`+
		`"model-x":{"provider":"other-host","input":1,"output":1,"cacheRead":1,"cacheWrite":1},`+
		`"model":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1}`+
		`}}`)
	doc := pricingDoc(t, "model-x", map[string]any{"input": 1}, nil)
	estimateCost(doc, pricing)
	if _, ok := costOf(t, doc); ok {
		t.Fatal("provider-mismatched longest entry must not fall through to the shorter key")
	}
}

func TestSelectEntryProviderMatchBeatsProviderless(t *testing.T) {
	pricing := mustDecode(t, `{"models":{"m":[{"input":9,"output":9,"cacheRead":9,"cacheWrite":9},{"provider":"p","input":1,"output":1,"cacheRead":1,"cacheWrite":1}]}}`)
	doc := pricingDoc(t, "m", map[string]any{"input": 1000000}, map[string]any{"provider": "p"})
	estimateCost(doc, pricing)
	cost, ok := costOf(t, doc)
	if !ok || num(cost) != 1 {
		t.Fatalf("cost = %#v (ok=%v), want 1 from the provider-matching entry", cost, ok)
	}
}

func TestSelectRatesPeriodsAndAmbiguity(t *testing.T) {
	pricing := mustDecode(t, `{"models":{"m":{"rates":[`+
		`{"through":"2026-08-31","input":1,"output":1,"cacheRead":1,"cacheWrite":1},`+
		`{"from":"2026-09-01","input":2,"output":2,"cacheRead":2,"cacheWrite":2}`+
		`]}}}`)
	before := pricingDoc(t, "m", map[string]any{"input": 1000000}, map[string]any{"startedAt": "2026-08-13T12:00:00.000Z"})
	estimateCost(before, pricing)
	if cost, ok := costOf(t, before); !ok || num(cost) != 1 {
		t.Fatalf("before period: cost=%#v ok=%v, want 1", cost, ok)
	}
	after := pricingDoc(t, "m", map[string]any{"input": 1000000}, map[string]any{"startedAt": "2026-10-01T00:00:00.000Z"})
	estimateCost(after, pricing)
	if cost, ok := costOf(t, after); !ok || num(cost) != 2 {
		t.Fatalf("after period: cost=%#v ok=%v, want 2", cost, ok)
	}
	// No session date + multiple periods = unknowable = no estimate.
	undated := pricingDoc(t, "m", map[string]any{"input": 1000000}, nil)
	estimateCost(undated, pricing)
	if _, ok := costOf(t, undated); ok {
		t.Fatal("multiple periods with no session date must yield no estimate")
	}
}

func TestEstimateCostRefusals(t *testing.T) {
	with := func(modes, geo string) string {
		return `{"models":{"m":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1,"cachedIncludedInInput":false` + modes + geo + `}}}`
	}

	t.Run("speed without a named mode refuses", func(t *testing.T) {
		p := mustDecode(t, with(``, ``))
		doc := pricingDoc(t, "m", map[string]any{"input": 1}, map[string]any{"speed": "fast"})
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); ok {
			t.Fatal("non-standard speed without a modes entry must not estimate")
		}
	})
	t.Run("mode replaces period rates wholesale", func(t *testing.T) {
		p := mustDecode(t, with(`,"modes":{"fast":{"input":10,"output":10,"cacheRead":10,"cacheWrite":10}}`, ``))
		doc := pricingDoc(t, "m", map[string]any{"input": 1000000}, map[string]any{"speed": "fast"})
		estimateCost(doc, p)
		if cost, ok := costOf(t, doc); !ok || num(cost) != 10 {
			t.Fatalf("cost=%#v ok=%v, want 10 (mode rates)", cost, ok)
		}
	})
	t.Run("standard speed needs no mode", func(t *testing.T) {
		p := mustDecode(t, with(``, ``))
		doc := pricingDoc(t, "m", map[string]any{"input": 1000000}, map[string]any{"speed": "standard"})
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); !ok {
			t.Fatal("standard speed must use base rates")
		}
	})
	t.Run("unknown geo refuses", func(t *testing.T) {
		p := mustDecode(t, with(``, `,"geoMultipliers":{"us":1.1}`))
		doc := pricingDoc(t, "m", map[string]any{"input": 1}, map[string]any{"inferenceGeo": "eu"})
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); ok {
			t.Fatal("a geo with no declared multiplier must not estimate")
		}
	})
	t.Run("geo multiplies the summed micros", func(t *testing.T) {
		p := mustDecode(t, with(``, `,"geoMultipliers":{"us":1.1}`))
		doc := pricingDoc(t, "m", map[string]any{"input": 1000000}, map[string]any{"inferenceGeo": "us"})
		estimateCost(doc, p)
		if cost, ok := costOf(t, doc); !ok || num(cost) != 1.1 {
			t.Fatalf("cost=%#v ok=%v, want 1.1", cost, ok)
		}
	})
	t.Run("unknown cache accounting refuses when cache tokens exist", func(t *testing.T) {
		p := mustDecode(t, `{"models":{"m":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1,"cachedIncludedInInput":null}}}`)
		doc := pricingDoc(t, "m", map[string]any{"input": 1, "cacheRead": 5}, nil)
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); ok {
			t.Fatal("cachedIncludedInInput null + cache tokens must refuse")
		}
	})
	t.Run("unknown cache accounting estimates cache-free sessions", func(t *testing.T) {
		p := mustDecode(t, `{"models":{"m":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1,"cachedIncludedInInput":null}}}`)
		doc := pricingDoc(t, "m", map[string]any{"input": 1000000}, nil)
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); !ok {
			t.Fatal("cache-free session needs no cache accounting model")
		}
	})
	t.Run("split must sum to cacheWrite", func(t *testing.T) {
		p := mustDecode(t, with(``, ``))
		doc := pricingDoc(t, "m", map[string]any{"cacheWrite": 100, "cacheWrite5m": 60, "cacheWrite1h": 30}, nil)
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); ok {
			t.Fatal("5m+1h != cacheWrite means a corrupt document — refuse")
		}
	})
	t.Run("1h writes without a 1h rate refuse", func(t *testing.T) {
		p := mustDecode(t, with(``, ``))
		doc := pricingDoc(t, "m", map[string]any{"cacheWrite": 100, "cacheWrite5m": 40, "cacheWrite1h": 60}, nil)
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); ok {
			t.Fatal("cacheWrite1h > 0 without a 1h rate would under-bill 60% — refuse")
		}
	})
	t.Run("split prices each TTL at its own rate", func(t *testing.T) {
		p := mustDecode(t, `{"models":{"m":{"input":0,"output":0,"cacheRead":0,"cacheWrite":2,"cacheWrite1h":4,"cachedIncludedInInput":false}}}`)
		doc := pricingDoc(t, "m", map[string]any{"cacheWrite": 100, "cacheWrite5m": 40, "cacheWrite1h": 60}, nil)
		estimateCost(doc, p)
		if cost, ok := costOf(t, doc); !ok || num(cost) != 0.00032 {
			t.Fatalf("cost=%#v ok=%v, want 0.00032 (40*2 + 60*4 micros)", cost, ok)
		}
	})
	t.Run("opencode never estimates", func(t *testing.T) {
		p := mustDecode(t, with(``, ``))
		doc := pricingDoc(t, "m", map[string]any{"input": 1000000}, nil)
		object(get(doc, "meta")).Set("source", "opencode")
		estimateCost(doc, p)
		if _, ok := costOf(t, doc); ok {
			t.Fatal("opencode documents carry authored costs — never estimate")
		}
	})
	t.Run("existing cost is left alone", func(t *testing.T) {
		p := mustDecode(t, with(``, ``))
		doc := pricingDoc(t, "m", map[string]any{"input": 1000000, "cost": 42}, nil)
		estimateCost(doc, p)
		cost, ok := costOf(t, doc)
		if !ok || num(cost) != 42 {
			t.Fatalf("cost=%#v ok=%v, want authored 42 untouched", cost, ok)
		}
		if ce, _ := object(get(doc, "totals")).Get("costEstimated"); ce != nil {
			t.Fatal("costEstimated must not be set on an authored cost")
		}
	})
}

func TestDefaultPricingEmbeddedTable(t *testing.T) {
	// The embedded table prices a fixture-known model; the oracle proves the
	// number (claude simple is sonnet-4-6 dated 2026-08 with a cache split).
	doc, err := NormalizeFile("../../fixtures/claude/v2.1/simple/session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	cost, ok := object(get(doc, "totals")).Get("cost")
	if !ok {
		t.Fatal("expected an estimate for the simple fixture's model")
	}
	if num(cost) <= 0 {
		t.Fatalf("cost = %v, want positive", cost)
	}
}

func mustDecode(t *testing.T, s string) *obj {
	t.Helper()
	v, err := trajectory.Decode([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	o := object(v)
	if o == nil {
		t.Fatalf("not an object: %s", s)
	}
	return o
}
