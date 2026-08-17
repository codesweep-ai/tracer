package normalizer

import (
	"errors"
	"testing"
)

func TestDetectFormat(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  Source
		err   error
	}{
		{"empty", " \n", "", ErrEmptyInput},
		{"unrecognized", "not json", "", ErrNoKnownRecords},
		{"opencode", `{"info":{},"messages":[]}`, SourceOpenCode, nil},
		{"codex", `{"type":"session_meta","payload":{}}`, SourceCodex, nil},
		{"claude", `{"type":"user","uuid":"1"}`, SourceClaudeCode, nil},
		{"malformed line ignored", "bad\n{\"type\":\"user\",\"uuid\":\"1\"}", SourceClaudeCode, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DetectFormat([]byte(tc.input))
			if got != tc.want || !errors.Is(err, tc.err) {
				t.Fatalf("DetectFormat() = %q, %v; want %q, %v", got, err, tc.want, tc.err)
			}
		})
	}
}

// TS: a whole-document JSON value that is not an opencode doc still falls
// through to per-line JSONL detection (the two paths are sequential).
func TestDetectFormatWholeObjectFallsThrough(t *testing.T) {
	got, err := DetectFormat([]byte("{\"type\":\"session_meta\",\"payload\":{}}"))
	if err != nil || got != SourceCodex {
		t.Fatalf("got %q, %v; want codex", got, err)
	}
	// A JSON array is not an object for detection purposes; as a single line
	// it parses but carries no codex sentinel, so it is claude-code.
	got, err = DetectFormat([]byte("[1,2,3]"))
	if err != nil || got != SourceClaudeCode {
		t.Fatalf("got %q, %v; want claude-code", got, err)
	}
	// A bare scalar line still parses in JS and counts as a record; its .type
	// reads undefined, so it is claude-code, not an error.
	got, err = DetectFormat([]byte("5"))
	if err != nil || got != SourceClaudeCode {
		t.Fatalf("got %q, %v; want claude-code", got, err)
	}
	// CRLF input: the reference splits on /\r?\n/.
	got, err = DetectFormat([]byte("{\"type\":\"session_meta\",\"payload\":{}}\r\n{\"type\":\"response_item\",\"payload\":{}}\r\n"))
	if err != nil || got != SourceCodex {
		t.Fatalf("got %q, %v; want codex", got, err)
	}
}
