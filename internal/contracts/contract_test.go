package contracts_test

import (
	"encoding/json"
	"testing"

	"github.com/2233admin/agx/internal/contracts"
	"github.com/2233admin/agx/internal/domain"
)

func TestDocumentRoundTrips(t *testing.T) {
	want := contracts.Document{
		SchemaVersion: contracts.SchemaVersionV1,
		Contract: domain.InstallationContract{
			Desired: domain.DesiredState{InstallationID: "install-001"},
		},
	}

	encoded, err := contracts.Encode(want)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	got, err := contracts.Decode(encoded)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if string(gotJSON) != string(encoded) {
		t.Fatalf("round trip JSON = %s, want %s", gotJSON, encoded)
	}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	_, err := contracts.Decode([]byte(`{
  "schema_version": "agx/contracts/v1",
  "contract": {},
  "credential": "must-not-survive"
}`))
	if err == nil {
		t.Fatal("Decode() error = nil, want unknown field rejection")
	}
}

func TestDecodeRejectsUnknownNestedFields(t *testing.T) {
	_, err := contracts.Decode([]byte(`{
  "schema_version": "agx/contracts/v1",
  "contract": {
    "desired": {
      "installation_id": "install-001",
      "credential": "must-not-survive"
    }
  }
}`))
	if err == nil {
		t.Fatal("Decode() error = nil, want nested unknown field rejection")
	}
}
