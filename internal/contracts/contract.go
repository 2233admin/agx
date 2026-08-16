package contracts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/2233admin/agx/internal/domain"
)

const SchemaVersionV1 = "agx/contracts/v1"

type Document struct {
	SchemaVersion string                      `json:"schema_version"`
	Contract      domain.InstallationContract `json:"contract"`
}

func Encode(document Document) ([]byte, error) {
	if document.SchemaVersion != SchemaVersionV1 {
		return nil, fmt.Errorf("unsupported schema version %q", document.SchemaVersion)
	}
	return json.Marshal(document)
}

func Decode(data []byte) (Document, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()

	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("decode installation contract: %w", err)
	}
	if err := ensureEndOfInput(decoder); err != nil {
		return Document{}, err
	}
	if document.SchemaVersion != SchemaVersionV1 {
		return Document{}, fmt.Errorf("unsupported schema version %q", document.SchemaVersion)
	}
	return document, nil
}

func ensureEndOfInput(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == io.EOF {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode installation contract: %w", err)
	}
	return fmt.Errorf("decode installation contract: trailing JSON value")
}
