// Package normalizer ports the trajectory normalizer to Go.
package normalizer

import (
	"bytes"
	"encoding/json"
	"errors"
)

type Source string

const (
	SourceClaudeCode Source = "claude-code"
	SourceCodex      Source = "codex"
	SourceOpenCode   Source = "opencode"
)

var (
	ErrEmptyInput     = errors.New("cannot detect format of an empty file")
	ErrNoKnownRecords = errors.New("file contains no recognizable records")
)

// DetectFormat implements the reference detector: whole OpenCode documents
// first, then JSONL Codex sentinel records, with Claude as the JSONL fallback.
func DetectFormat(input []byte) (Source, error) {
	text := bytes.TrimSpace(input)
	if len(text) == 0 {
		return "", ErrEmptyInput
	}
	var whole any
	if json.Unmarshal(text, &whole) == nil {
		if isOpenCode(whole) {
			return SourceOpenCode, nil
		}
	}
	// Per-line JSONL detection: every parseable line is a record, including
	// non-objects (their .type reads as undefined in JS — never a codex
	// sentinel, so they fall through to claude-code).
	records := make([]any, 0)
	for line := range bytes.SplitSeq(text, []byte{'\n'}) {
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var record any
		if json.Unmarshal(line, &record) == nil {
			records = append(records, record)
		}
	}
	if len(records) == 0 {
		return "", ErrNoKnownRecords
	}
	for _, record := range records {
		if m, ok := record.(map[string]any); ok {
			switch m["type"] {
			case "session_meta", "response_item", "event_msg":
				return SourceCodex, nil
			}
		}
	}
	return SourceClaudeCode, nil
}

func isOpenCode(value any) bool {
	doc, ok := value.(map[string]any)
	if !ok {
		return false
	}
	_, hasInfo := doc["info"]
	_, messages := doc["messages"].([]any)
	return hasInfo && messages
}
