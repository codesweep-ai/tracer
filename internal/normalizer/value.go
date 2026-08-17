package normalizer

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

type obj = trajectory.Object

func get(o *obj, k string) any {
	if o == nil {
		return nil
	}
	v, _ := o.Get(k)
	return v
}
func object(v any) *obj { o, _ := v.(*obj); return o }
func array(v any) []any { a, _ := v.([]any); return a }
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func present(v any) bool { return v != nil && str(v) != "" }
func num(v any) float64 {
	n, err := parseJSONNumber(v)
	if err != nil {
		return 0
	}
	return n
}

var errNotNumber = errors.New("not a number")

// parseJSONNumber converts a decoded JSON number (json.Number, or a computed
// float/int) to float64. Strings and other types are not numbers, matching
// JS `typeof v === "number"`.
func parseJSONNumber(v any) (float64, error) {
	switch x := v.(type) {
	case json.Number:
		return x.Float64()
	case float64:
		return x, nil
	case int:
		return float64(x), nil
	case int64:
		return float64(x), nil
	}
	return 0, errNotNumber
}
func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case nil:
		return false
	case string:
		return x != ""
	case json.Number:
		return x != "0"
	}
	return true
}
func undef(v any) any {
	if v == nil {
		return trajectory.Undefined
	}
	if s, ok := v.(string); ok && s == "" {
		return trajectory.Undefined
	}
	return v
}

// tsOrUndef mirrors `typeof x === "string" ? x : undefined`: strings pass
// through verbatim (including ""), anything else is undefined.
func tsOrUndef(v any) any {
	if s, ok := v.(string); ok {
		return s
	}
	return trajectory.Undefined
}
func millis(a, b string) any {
	if a == "" || b == "" {
		return trajectory.Undefined
	}
	x, e := time.Parse(time.RFC3339Nano, a)
	if e != nil {
		return trajectory.Undefined
	}
	y, e := time.Parse(time.RFC3339Nano, b)
	if e != nil {
		return trajectory.Undefined
	}
	return y.Sub(x).Milliseconds()
}
func integer(v any) any {
	n := num(v)
	if n == float64(int64(n)) {
		return int64(n)
	}
	return n
}
