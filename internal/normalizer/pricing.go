package normalizer

import (
	"sort"
	"strings"
	"sync"

	"github.com/codesweep-ai/tracer/internal/pricingdata"
	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// pricing.json is the only source of rates — there is deliberately no hard-coded fallback, so an
// absent table simply yields no estimates.

var (
	pricingOnce  sync.Once
	pricingTable *obj
)

// defaultPricing decodes the embedded pricing table once. Key order is
// preserved (decode is insertion-ordered) because selectEntry's longest-key
// sort is stable and ties resolve in document order, as V8's Array.sort does.
func defaultPricing() *obj {
	pricingOnce.Do(func() {
		v, err := trajectory.Decode(pricingdata.JSON)
		if err != nil {
			pricingTable = trajectory.NewObject("models", trajectory.NewObject())
			return
		}
		pricingTable = object(v)
	})
	return pricingTable
}

// rateValue returns the numeric rate for key, or (0, false) when the entry
// does not carry a number there — JS `typeof rate !== "number"`.
func rateValue(entry *obj, key string) (float64, bool) {
	if entry == nil {
		return 0, false
	}
	v, ok := entry.Get(key)
	if !ok || v == nil {
		return 0, false
	}
	f, err := parseJSONNumber(v)
	return f, err == nil
}

// selectEntry resolves the one entry that prices this document:
//  1. candidate keys are every table key that is a substring of the model name;
//  2. ONLY the longest candidate is considered — no fall-through to shorter;
//  3. a provider-bearing entry matches only a document naming that provider;
//     an entry without a provider key matches any document;
//  4. a provider match beats a provider-less one; otherwise NO estimate
//     (provider mismatch must lose to no-match).
func selectEntry(models *obj, model string, provider any) *obj {
	if models == nil {
		return nil
	}
	var keys []string
	for _, m := range models.Members() {
		if strings.Contains(model, m.Key) {
			keys = append(keys, m.Key)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	// Stable sort, longest first — JS Array.sort is stable, so equal-length
	// candidates keep pricing.json document order.
	sort.SliceStable(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	v, _ := models.Get(keys[0])
	var entries []*obj
	if a := array(v); a != nil {
		for _, e := range a {
			if o := object(e); o != nil {
				entries = append(entries, o)
			}
		}
	} else if o := object(v); o != nil {
		entries = append(entries, o)
	}
	providerStr, providerIsString := provider.(string)
	for _, e := range entries {
		p, ok := e.Get("provider")
		// JS: entry.provider !== undefined && entry.provider === provider.
		// A JSON null provider (decoded nil) is !== undefined and === nothing.
		if ok && p != nil {
			if ps, isStr := p.(string); isStr && providerIsString && ps == providerStr {
				return e
			}
		}
	}
	for _, e := range entries {
		if _, ok := e.Get("provider"); !ok {
			return e
		}
	}
	return nil
}

// selectRates picks the rate period covering the session date; from/through
// are inclusive and ISO dates compare correctly as strings. With no session
// date a single period is unambiguous; more than one is unknowable.
func selectRates(entry *obj, date string, hasDate bool) *obj {
	v, ok := entry.Get("rates")
	if !ok {
		return entry
	}
	periods := array(v)
	if !hasDate {
		if len(periods) == 1 {
			return object(periods[0])
		}
		return nil
	}
	for _, pv := range periods {
		p := object(pv)
		if p == nil {
			continue
		}
		if from, ok := p.Get("from"); ok {
			if s, isStr := from.(string); isStr && date < s {
				continue
			}
		}
		if through, ok := p.Get("through"); ok {
			if s, isStr := through.(string); isStr && date > s {
				continue
			}
		}
		return p
	}
	return nil
}

// estimateCost mutates doc in place: doc.totals.cost and doc.totals.costEstimated
// are appended.
func estimateCost(doc *obj, pricing *obj) {
	meta := object(get(doc, "meta"))
	totals := object(get(doc, "totals"))
	if meta == nil || totals == nil {
		return
	}
	if str(get(meta, "source")) == "opencode" {
		return
	}
	if c, ok := totals.Get("cost"); ok && isJSNumber(c) {
		return
	}
	entry := selectEntry(object(get(pricing, "models")), str(get(meta, "model")), get(meta, "provider"))
	if entry == nil {
		return
	}
	startedAt, hasDate := get(meta, "startedAt").(string)
	date := ""
	if hasDate {
		if len(startedAt) > 10 {
			date = startedAt[:10]
		} else {
			date = startedAt
		}
	}
	rates := selectRates(entry, date, hasDate)
	if rates == nil {
		return
	}
	// A recorded non-standard speed must name a mode, or we do not know the
	// price. A mode REPLACES the period's rates wholesale.
	if speed := str(get(meta, "speed")); speed != "" && speed != "standard" {
		modes := object(get(entry, "modes"))
		mode := object(get(modes, speed))
		if mode == nil {
			return
		}
		rates = mode
	}
	inRate, ok := rateValue(rates, "input")
	if !ok {
		return
	}
	outRate, ok := rateValue(rates, "output")
	if !ok {
		return
	}
	readRate, ok := rateValue(rates, "cacheRead")
	if !ok {
		return
	}
	writeRate, ok := rateValue(rates, "cacheWrite")
	if !ok {
		return
	}
	input := num(get(totals, "input"))
	output := num(get(totals, "output"))
	cacheRead := num(get(totals, "cacheRead"))
	cacheWrite := num(get(totals, "cacheWrite"))
	// cachedIncludedInInput null/absent = the host's cache accounting is
	// UNKNOWN. A session that used cache tokens cannot be priced without
	// guessing, so it gets NO estimate; a cache-free session estimates fine.
	cachedIncluded, hasCachedIncluded := entry.Get("cachedIncludedInInput")
	if (!hasCachedIncluded || cachedIncluded == nil) && (cacheRead > 0 || cacheWrite > 0) {
		return
	}
	var writeCost float64
	write5m, has5m := rateValue(totals, "cacheWrite5m")
	write1h, has1h := rateValue(totals, "cacheWrite1h")
	if has5m && has1h {
		// The adapter guarantees the split sums to cacheWrite; a mismatch means
		// the document is corrupt — refuse rather than bill an arbitrary subset.
		if write5m+write1h != cacheWrite {
			return
		}
		rate1h, ok1h := rateValue(rates, "cacheWrite1h")
		if write1h > 0 && !ok1h {
			// 1h writes cost 2x base input; falling back to the 5m rate would
			// under-bill by 60% while looking plausible — refuse instead.
			return
		}
		writeCost = write5m*writeRate + write1h*rate1h
	} else {
		writeCost = cacheWrite * writeRate
	}
	micros := input*inRate + output*outRate + cacheRead*readRate + writeCost
	// A recorded geo must name a declared multiplier, or we do not know the
	// price. Applied to the summed micro-dollar figure so float noise stays at
	// one place.
	if geo := str(get(meta, "inferenceGeo")); geo != "" {
		multiplier, ok := rateValue(object(get(entry, "geoMultipliers")), geo)
		if !ok {
			return
		}
		micros *= multiplier
	}
	totals.Set("cost", micros/1_000_000)
	totals.Set("costEstimated", true)
}

func estimateDefault(doc *obj) {
	estimateCost(doc, defaultPricing())
}

// isJSNumber reports whether v would satisfy JS `typeof v === "number"` after
// our decoding (decoder numbers arrive as json.Number).
func isJSNumber(v any) bool {
	switch v.(type) {
	case float64, int, int64:
		return true
	}
	_, err := parseJSONNumber(v)
	return err == nil
}
