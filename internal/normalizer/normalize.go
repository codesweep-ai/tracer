package normalizer

import (
	"bytes"
	"os"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/codesweep-ai/tracer/internal/trajectory"
)

// JS \s is White_Space plus U+FEFF — slightly wider than Go's regexp \s.
const jsSpaceChars = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var (
	jsWhitespaceRun     = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
	jsTrailingWordBreak = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+[^\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*$`)
)

// NormalizeBytes detects and normalizes one transcript.
func NormalizeBytes(data []byte) (*obj, error) {
	source, err := DetectFormat(data)
	if err != nil {
		return nil, err
	}
	if source == SourceOpenCode {
		v, e := trajectory.Decode(data)
		if e != nil {
			return nil, e
		}
		doc := NormalizeOpenCode(object(v))
		deriveAutoTitle(doc)
		return doc, nil
	}
	var records []*obj
	// The reference splits on /\r?\n/ without trimming first; blank lines are
	// skipped, unparseable lines become __parseError records carrying the
	// first 200 UTF-16 code units and their 1-based line number.
	for n, line := range bytes.Split(data, []byte{'\n'}) {
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		v, err := trajectory.Decode(line)
		if err != nil {
			records = append(records, trajectory.NewObject("__parseError", true, "__line", n+1, "__raw", utf16Slice(string(line), 200)))
			continue
		}
		o, ok := v.(*trajectory.Object)
		if !ok {
			// A valid JSON line that is not an object (array, string, number):
			// JS property access on it yields undefined for every key the
			// adapters read, which an empty object reproduces exactly.
			o = trajectory.NewObject()
		}
		records = append(records, o)
	}
	var doc *obj
	if source == SourceCodex {
		doc = NormalizeCodex(records)
	} else {
		doc = NormalizeClaude(records)
	}
	estimateDefault(doc)
	deriveAutoTitle(doc)
	return doc, nil
}

func NormalizeFile(path string) (*obj, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	return NormalizeBytes(b)
}

// deriveAutoTitle derives the fallback display title: the first non-empty user
// message (skipping codex harness boilerplate), whitespace-collapsed and
// word-boundary-truncated at 60 UTF-16 code units. meta.title stays
// authored-only; consumers render title ?? autoTitle ?? sessionId.
func deriveAutoTitle(doc *obj) {
	events, _ := get(doc, "events").([]*obj)
	for _, e := range events {
		if str(get(e, "kind")) != "user" {
			continue
		}
		text, ok := get(e, "text").(string)
		if !ok {
			continue
		}
		if strings.Trim(text, jsSpaceChars) == "" || strings.HasPrefix(strings.TrimLeft(text, jsSpaceChars), "<environment_context>") {
			continue
		}
		collapsed := strings.Trim(jsWhitespaceRun.ReplaceAllString(text, " "), jsSpaceChars)
		title := collapsed
		if len(utf16.Encode([]rune(collapsed))) > 60 {
			cut := utf16Slice(collapsed, 60)
			cut = jsTrailingWordBreak.ReplaceAllString(cut, "")
			title = cut + "…"
		}
		object(get(doc, "meta")).Set("autoTitle", title)
		return
	}
}
