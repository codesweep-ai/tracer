// Package trajectory contains the language-neutral trajectory representation.
package trajectory

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Undefined is the Go representation of a JavaScript property whose value is
// undefined. JSON.stringify omits such a property, but the property continues
// to occupy its original insertion slot if it is assigned a value later.
type undefined struct{}

var Undefined = undefined{}

// Member is one key/value pair of an Object, in insertion order.
type Member struct {
	Key   string
	Value any
}

// Decode parses JSON while preserving object member order at every depth.
func Decode(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	v, err := decodeValue(d)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		if err == nil {
			return nil, errors.New("extra JSON value")
		}
		return nil, err
	}
	return v, nil
}

func decodeValue(d *json.Decoder) (any, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	if x, ok := t.(json.Delim); ok {
		switch x {
		case '{':
			o := NewObject()
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return nil, err
				}
				v, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				o.Set(k.(string), v)
			}
			_, err = d.Token()
			return o, err
		case '[':
			a := []any{}
			for d.More() {
				v, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			_, err = d.Token()
			return a, err
		}
	}
	return t, nil
}

// Object is an insertion-ordered JSON object. Set replaces a value in place;
// it never changes the key's original insertion position.
type Object struct {
	members []Member
	index   map[string]int
}

// NewObject constructs an object from alternating key/value arguments.
func NewObject(fields ...any) *Object {
	if len(fields)%2 != 0 {
		panic("trajectory.NewObject: fields must be key/value pairs")
	}
	o := &Object{index: make(map[string]int, len(fields)/2)}
	for i := 0; i < len(fields); i += 2 {
		key, ok := fields[i].(string)
		if !ok {
			panic("trajectory.NewObject: key is not a string")
		}
		o.Set(key, fields[i+1])
	}
	return o
}

// Set assigns value while preserving the first insertion position of key.
func (o *Object) Set(key string, value any) *Object {
	if o.index == nil {
		o.index = make(map[string]int)
	}
	if i, ok := o.index[key]; ok {
		o.members[i].Value = value
		return o
	}
	o.index[key] = len(o.members)
	o.members = append(o.members, Member{Key: key, Value: value})
	return o
}

// Get returns a property, including Undefined properties.
func (o *Object) Get(key string) (any, bool) {
	i, ok := o.index[key]
	if !ok {
		return nil, false
	}
	return o.members[i].Value, true
}

// Members returns the object's members in insertion order. The result is a
// copy; mutating it does not affect the object.
func (o *Object) Members() []Member {
	out := make([]Member, len(o.members))
	copy(out, o.members)
	return out
}

// Delete removes a property, matching JavaScript delete. A later Set appends it.
func (o *Object) Delete(key string) {
	i, ok := o.index[key]
	if !ok {
		return
	}
	o.members = append(o.members[:i], o.members[i+1:]...)
	delete(o.index, key)
	for n := i; n < len(o.members); n++ {
		o.index[o.members[n].Key] = n
	}
}

// MarshalJSON emits members in insertion order and omits Undefined values.
func (o *Object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	written := false
	for _, m := range o.members {
		if _, omit := m.Value.(undefined); omit {
			continue
		}
		key, err := json.Marshal(m.Key)
		if err != nil {
			return nil, err
		}
		value, err := Marshal(m.Value, false)
		if err != nil {
			return nil, fmt.Errorf("marshal property %q: %w", m.Key, err)
		}
		if written {
			b.WriteByte(',')
		}
		written = true
		b.Write(key)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Marshal uses Go's JSON encoder with explicit HTML-escaping control. Ordered
// Objects retain their custom member order through the encoder.
func Marshal(value any, escapeHTML bool) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(escapeHTML)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	out := bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
	if !escapeHTML {
		out = unescapeLineSeparators(out)
	}
	return out, nil
}

// JSON.stringify leaves U+2028/U+2029 literal. Replace only encoder-produced
// escapes (an even number of preceding slashes), not a user's literal \u2028.
func unescapeLineSeparators(in []byte) []byte {
	var out bytes.Buffer
	for i := 0; i < len(in); {
		matched := i+6 <= len(in) && (string(in[i:i+6]) == `\u2028` || string(in[i:i+6]) == `\u2029`)
		slashes := 0
		for j := i - 1; j >= 0 && in[j] == '\\'; j-- {
			slashes++
		}
		if matched && slashes%2 == 0 {
			if in[i+5] == '8' {
				out.WriteRune('\u2028')
			} else {
				out.WriteRune('\u2029')
			}
			i += 6
		} else {
			out.WriteByte(in[i])
			i++
		}
	}
	return out.Bytes()
}
