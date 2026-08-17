package trajectory

import "testing"

func TestObjectInsertionAndUndefinedSemantics(t *testing.T) {
	o := NewObject("kind", Undefined, "ts", "now", "text", "hello")
	o.Set("kind", "assistant")
	got, err := Marshal(o, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"kind":"assistant","ts":"now","text":"hello"}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestObjectOmitsUndefined(t *testing.T) {
	o := NewObject("a", 1, "missing", Undefined, "b", "<tag>&")
	got, err := Marshal(o, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":1,"b":"<tag>&"}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestMarshalHTMLEscaping(t *testing.T) {
	o := NewObject("text", "a<b&c")
	got, err := Marshal(o, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"text":"a\u003cb\u0026c"}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestLineSeparatorsStayLiteralLikeJSONStringify(t *testing.T) {
	// Go's encoder escapes U+2028/U+2029 even with SetEscapeHTML(false);
	// JSON.stringify emits them literally. The oracle carries them (the
	// hazard-text fixture), so Marshal must undo exactly the encoder's
	// escapes.
	o := NewObject("text", "a\u2028b\u2029c")
	got, err := Marshal(o, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\"text\":\"a\u2028b\u2029c\"}"; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	// With HTML escaping on (the export path), they stay escaped — and so
	// does the angle bracket.
	o = NewObject("text", "<\u2028")
	got, err = Marshal(o, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\"text\":\"\\u003c\\u2028\"}"; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLiteralBackslashU2028IsNotCorrupted(t *testing.T) {
	// ...without touching a user's literal six-character \u2028 sequence —
	// the hazard-text fixture carries a literal \u003c for the same reason.
	o := NewObject("text", "literal \\u2028 sequence")
	got, err := Marshal(o, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"text":"literal \\u2028 sequence"}`; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	// And a backslash followed by a REAL separator: the encoder emits an
	// escaped backslash and an escaped separator; only the separator escape
	// is undone.
	o = NewObject("text", "\\"+" ")
	got, err = Marshal(o, false)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"text\":\"\\\\" + " " + "\"}"
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestDeleteThenReassignAppends(t *testing.T) {
	// JS delete removes the slot entirely; re-adding appends at the end.
	o := NewObject("a", 1, "b", 2, "c", 3)
	o.Delete("b")
	o.Set("b", 4)
	got, err := Marshal(o, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":1,"c":3,"b":4}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestNumbersKeepSourceSpelling(t *testing.T) {
	// The opencode oracle carries 0.30168359999999994 — a real shortest-
	// round-trip value that must pass through untouched.
	v, err := Decode([]byte(`{"cost":0.30168359999999994,"n":1000,"f":1.0}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Marshal(v, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"cost":0.30168359999999994,"n":1000,"f":1.0}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestDuplicateKeysKeepFirstSlotWithLastValue(t *testing.T) {
	// JSON.parse semantics: first insertion position, last value.
	v, err := Decode([]byte(`{"a":1,"b":2,"a":3}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Marshal(v, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":3,"b":2}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
