package normalizer

import (
	"testing"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// hostile scalars are excluded, never coerced — and the exclusion is
// counted so a warning can disclose it.
func TestSanitizeTokenValues(t *testing.T) {
	mk := func(tokens *obj, cost any) *obj {
		e := trajectory.NewObject("kind", "assistant")
		if tokens != nil {
			e.Set("tokens", tokens)
		}
		if cost != nil {
			e.Set("cost", cost)
		}
		return e
	}

	t.Run("string and negative values are deleted", func(t *testing.T) {
		e := mk(trajectory.NewObject("input", "many", "output", jsonNum("5"), "cacheRead", jsonNum("-3")), jsonNum("-1"))
		if n := sanitizeTokenValues([]*obj{e}); n != 3 {
			t.Fatalf("excluded %d, want 3", n)
		}
		tokens := object(get(e, "tokens"))
		if _, ok := tokens.Get("input"); ok {
			t.Fatal("string input kept")
		}
		if _, ok := tokens.Get("cacheRead"); ok {
			t.Fatal("negative cacheRead kept")
		}
		if v, _ := tokens.Get("output"); str(anyString(v)) != "5" {
			t.Fatalf("valid output = %v", v)
		}
		if _, ok := e.Get("cost"); ok {
			t.Fatal("negative cost kept")
		}
	})

	t.Run("a tokens object emptied by exclusion is deleted", func(t *testing.T) {
		e := mk(trajectory.NewObject("input", "hostile"), nil)
		if n := sanitizeTokenValues([]*obj{e}); n != 1 {
			t.Fatalf("excluded %d, want 1", n)
		}
		if _, ok := e.Get("tokens"); ok {
			t.Fatal("empty tokens object kept")
		}
	})

	t.Run("JSON null is left in place", func(t *testing.T) {
		// The reference's `value != null` check skips nulls: they are a
		// statement of absence, not a hostile scalar.
		e := mk(trajectory.NewObject("input", nil), nil)
		if n := sanitizeTokenValues([]*obj{e}); n != 0 {
			t.Fatalf("excluded %d, want 0", n)
		}
		if _, ok := object(get(e, "tokens")).Get("input"); !ok {
			t.Fatal("null input was deleted")
		}
	})
}

func TestBlockTextVariants(t *testing.T) {
	// The claude blockText coerces an object block's text the way String() does;
	// the shared blockText recurses through text ?? content ?? output. The two
	// differ on purpose — this pins that difference.
	t.Run("claude coerces text with String()", func(t *testing.T) {
		v := []any{mustDecode(t, `{"text":42}`), mustDecode(t, `{"content":["x","y"]}`)}
		if got := blockTextClaude(v); got != "42xy" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("common recurses into output", func(t *testing.T) {
		v := []any{mustDecode(t, `{"output":"result"}`)}
		if got := blockText(v); got != "result" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("common does not recurse a present text", func(t *testing.T) {
		// text ?? content ?? output: a present text wins even when it is an
		// object (blockText then JSON-stringifies it).
		v := []any{mustDecode(t, `{"text":{"nested":1},"content":"ignored"}`)}
		if got := blockText(v); got != `{"nested":1}` {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("null content is empty", func(t *testing.T) {
		if got := blockText(nil); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("non-string scalars stringify", func(t *testing.T) {
		if got := blockTextClaude(jsonNum("1.5")); got != "1.5" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestJSString(t *testing.T) {
	if got := jsString(mustDecode(t, `{"a":1}`)); got != "[object Object]" {
		t.Fatalf("object: got %q", got)
	}
	if got := jsString([]any{jsonNum("1"), jsonNum("2")}); got != "1,2" {
		t.Fatalf("array: got %q", got)
	}
	if got := jsString(nil); got != "null" {
		t.Fatalf("null: got %q", got)
	}
	if got := jsString(true); got != "true" {
		t.Fatalf("bool: got %q", got)
	}
}

func TestTplUndefinedVsNull(t *testing.T) {
	o := trajectory.NewObject("present", "x", "nullable", nil)
	if got := tpl(o, "missing"); got != "undefined" {
		t.Fatalf("absent key: got %q, want undefined", got)
	}
	if got := tpl(o, "nullable"); got != "null" {
		t.Fatalf("null key: got %q, want null", got)
	}
	if got := tpl(o, "present"); got != "x" {
		t.Fatalf("present key: got %q", got)
	}
}

func TestUTF16Slice(t *testing.T) {
	// JS slices by UTF-16 code units: an astral character counts as 2.
	s := "ab\U0001F600cd"
	// Cutting at 3 units splits the surrogate pair: "ab" plus a lone high
	// surrogate, which utf16.Decode renders as U+FFFD. The boundary is the
	// whole point of slicing in code units, so it is asserted rather than
	// described — this case carried the comment and no assertion.
	if got := utf16Slice(s, 3); got != "ab�" {
		t.Errorf("slicing mid-surrogate = %q, want %q", got, "ab�")
	}
	if got := utf16Slice(s, 4); got != "ab\U0001F600" {
		t.Fatalf("got %q", got)
	}
	if got := utf16Slice("hello world", 5); got != "hello" {
		t.Fatalf("got %q", got)
	}
	if got := utf16Slice("short", 200); got != "short" {
		t.Fatalf("got %q", got)
	}
}

func TestCodexOutputIsError(t *testing.T) {
	if !codexOutputIsError("Error: boom") {
		t.Fatal("leading Error not detected")
	}
	if !codexOutputIsError("line one\nerror: boom") {
		t.Fatal("error after newline not detected")
	}
	if codexOutputIsError("Script completed successfully\nError: ignored") {
		t.Fatal("Script completed suppresses the heuristic")
	}
	// The reference tests only the first 200 UTF-16 code units.
	pad := make([]byte, 0, 300)
	for len(pad) < 195 {
		pad = append(pad, 'x')
	}
	late := string(pad) + "\nError: too late"
	if codexOutputIsError(late) {
		t.Fatal("error past the 200-unit window must not count")
	}
	early := string(pad[:190]) + "\nError: inside"
	if !codexOutputIsError(early) {
		t.Fatal("error inside the 200-unit window must count")
	}
}

// jsonNum decodes a JSON literal to the decoder's number representation.
func jsonNum(s string) any {
	v, err := trajectory.Decode([]byte(s))
	if err != nil {
		panic(err)
	}
	return v
}

func anyString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if n, ok := v.(interface{ String() string }); ok {
		return n.String()
	}
	return ""
}
