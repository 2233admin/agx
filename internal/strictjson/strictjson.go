// Package strictjson provides JSON decoding checks the standard library's
// encoding/json does not offer directly, for validating persisted AGX
// artifacts (initialization receipts, Deployment Profiles) that must round
// trip byte-for-byte predictably and must never silently accept an object
// with a duplicated key.
package strictjson

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// RejectDuplicateKeys walks data as JSON and returns an error if any JSON
// object in it repeats a key. encoding/json's Decoder silently keeps only
// the last occurrence of a duplicated key, which would let a crafted or
// corrupted file smuggle a second, effectively hidden value past every
// struct-field validation that only inspects the decoded Go value.
func RejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	var walk func() error
	walk = func() error {
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
				if err := walk(); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter")
		}
		_, err = decoder.Token()
		return err
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return nil
}
