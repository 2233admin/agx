// Package strictjson provides JSON decoding checks the standard library's
// encoding/json does not offer directly, for validating persisted AGX
// artifacts (initialization receipts, Deployment Profiles) that must round
// trip byte-for-byte predictably and must never silently accept an object
// with a duplicated key.
package strictjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// maxDepth bounds JSON nesting so a crafted or corrupted file with
// thousands of nested delimiters cannot exhaust the goroutine stack; a Go
// stack-overflow is a fatal, unrecoverable runtime error, not a panic
// RejectDuplicateKeys' caller could recover from.
const maxDepth = 64

// RejectDuplicateKeys walks data as JSON and returns an error if any JSON
// object in it repeats a key. encoding/json's Decoder silently keeps only
// the last occurrence of a duplicated key, which would let a crafted or
// corrupted file smuggle a second, effectively hidden value past every
// struct-field validation that only inspects the decoded Go value.
func RejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var walk func(depth int) error
	walk = func(depth int) error {
		if depth > maxDepth {
			return fmt.Errorf("JSON nesting exceeds %d levels", maxDepth)
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			keys := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("invalid object key")
				}
				if _, duplicate := keys[key]; duplicate {
					return fmt.Errorf("duplicate object key %q", key)
				}
				keys[key] = struct{}{}
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter")
		}
		_, err = decoder.Token()
		return err
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return nil
}
