// Package bundle decodes immutable Bundle metadata for AGX planning.
package bundle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const SchemaVersionV1 = "agx.bundle/v1"

type Mode string

const (
	ModeProduction  Mode = "production"
	ModeDevelopment Mode = "development"
)

type Provenance string

const (
	ProvenanceGitHubRelease Provenance = "github_release"
	ProvenanceSynthetic     Provenance = "synthetic_test_only"
)

type Document struct {
	SchemaVersion       string        `json:"schema_version"`
	BundleID            string        `json:"bundle_id"`
	Mode                Mode          `json:"mode"`
	Provenance          Provenance    `json:"provenance"`
	DevelopmentOverride bool          `json:"development_override"`
	Compatibility       Compatibility `json:"compatibility"`
	Artifacts           Artifacts     `json:"artifacts"`
}

type Compatibility struct {
	AGX        string `json:"agx"`
	MulticaCLI string `json:"multica_cli"`
}

type Artifacts struct {
	AgentControl Artifact `json:"agent_control"`
	AgentPlugins Artifact `json:"agent_plugins"`
}

type Artifact struct {
	Repository    string `json:"repository"`
	ReleaseTag    string `json:"release_tag"`
	CommitSHA     string `json:"commit_sha"`
	AssetName     string `json:"asset_name"`
	DownloadURL   string `json:"download_url"`
	AssetSHA256   string `json:"asset_sha256"`
	ContentSHA256 string `json:"content_sha256"`
}

var (
	bundleIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,127}$`)
	commitPattern   = regexp.MustCompile(`^[a-f0-9]{40}$`)
	sha256Pattern   = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// Decode strictly decodes and validates a Bundle v1 document. It has no I/O.
func Decode(data []byte) (Document, error) {
	if err := rejectDuplicateKeys(data); err != nil {
		return Document{}, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()

	var raw rawDocument
	if err := decoder.Decode(&raw); err != nil {
		return Document{}, decodeError("invalid JSON document: %v", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return Document{}, decodeError("trailing JSON value")
	} else if err.Error() != "EOF" {
		return Document{}, decodeError("invalid trailing JSON: %v", err)
	}
	if raw.SchemaVersion != SchemaVersionV1 {
		return Document{}, schemaError("unsupported schema version %q", raw.SchemaVersion)
	}
	if raw.DevelopmentOverride == nil {
		return Document{}, validationError("development_override is required")
	}

	document := Document{
		SchemaVersion:       raw.SchemaVersion,
		BundleID:            raw.BundleID,
		Mode:                raw.Mode,
		Provenance:          raw.Provenance,
		DevelopmentOverride: *raw.DevelopmentOverride,
		Compatibility:       raw.Compatibility,
		Artifacts:           raw.Artifacts,
	}
	if err := document.validate(); err != nil {
		return Document{}, err
	}
	return document, nil
}

type rawDocument struct {
	SchemaVersion       string        `json:"schema_version"`
	BundleID            string        `json:"bundle_id"`
	Mode                Mode          `json:"mode"`
	Provenance          Provenance    `json:"provenance"`
	DevelopmentOverride *bool         `json:"development_override"`
	Compatibility       Compatibility `json:"compatibility"`
	Artifacts           Artifacts     `json:"artifacts"`
}

func (document Document) validate() error {
	if document.SchemaVersion != SchemaVersionV1 {
		return schemaError("unsupported schema version %q", document.SchemaVersion)
	}
	if !bundleIDPattern.MatchString(document.BundleID) {
		return validationError("bundle_id must match %s", bundleIDPattern.String())
	}
	if strings.TrimSpace(document.Compatibility.AGX) == "" || strings.TrimSpace(document.Compatibility.MulticaCLI) == "" {
		return validationError("compatibility.agx and compatibility.multica_cli are required")
	}

	switch document.Mode {
	case ModeProduction:
		if document.Provenance != ProvenanceGitHubRelease || document.DevelopmentOverride {
			return provenanceError("production requires github_release provenance and development_override=false")
		}
	case ModeDevelopment:
		if document.Provenance != ProvenanceSynthetic || !document.DevelopmentOverride {
			return provenanceError("development requires synthetic_test_only provenance and development_override=true")
		}
	default:
		return validationError("unsupported mode %q", document.Mode)
	}

	if err := validateArtifact(document.Artifacts.AgentControl, "2233admin/agent-control", document.Mode); err != nil {
		return err
	}
	if err := validateArtifact(document.Artifacts.AgentPlugins, "2233admin/agent-plugins", document.Mode); err != nil {
		return err
	}
	return nil
}

func validateArtifact(artifact Artifact, repository string, mode Mode) error {
	if artifact.Repository != repository {
		return provenanceError("artifact repository must be %q", repository)
	}
	if strings.TrimSpace(artifact.ReleaseTag) == "" || strings.TrimSpace(artifact.AssetName) == "" || strings.Contains(artifact.AssetName, "/") {
		return validationError("artifact release_tag and simple asset_name are required")
	}
	if !commitPattern.MatchString(artifact.CommitSHA) {
		return validationError("artifact commit_sha must be a lowercase 40-character SHA-1")
	}
	if !sha256Pattern.MatchString(artifact.AssetSHA256) || !sha256Pattern.MatchString(artifact.ContentSHA256) {
		return validationError("artifact SHA-256 digests must be lowercase 64-character values")
	}
	if !strings.HasPrefix(artifact.DownloadURL, "https://") {
		return provenanceError("artifact download_url must use HTTPS")
	}
	if mode == ModeProduction {
		expected := "https://github.com/" + repository + "/releases/download/" + artifact.ReleaseTag + "/" + artifact.AssetName
		if artifact.DownloadURL != expected || !strings.HasSuffix(artifact.AssetName, ".tar.gz") {
			return provenanceError("production artifact must use its pinned GitHub Release tarball URL")
		}
	}
	return nil
}

func rejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := checkJSONValue(decoder); err != nil {
		return decodeError("invalid JSON document: %v", err)
	}
	if _, err := decoder.Token(); err == nil {
		return decodeError("trailing JSON value")
	} else if err.Error() != "EOF" {
		return decodeError("invalid trailing JSON: %v", err)
	}
	return nil
}

func checkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate field %q", key)
			}
			seen[key] = struct{}{}
			if err := checkJSONValue(decoder); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	case '[':
		for decoder.More() {
			if err := checkJSONValue(decoder); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	default:
		return fmt.Errorf("unexpected delimiter %q", delimiter)
	}
}

func decodeError(format string, args ...any) error {
	return fmt.Errorf("AGX-BUNDLE-DECODE: "+format, args...)
}

func schemaError(format string, args ...any) error {
	return fmt.Errorf("AGX-BUNDLE-SCHEMA: "+format, args...)
}

func validationError(format string, args ...any) error {
	return fmt.Errorf("AGX-BUNDLE-VALIDATION: "+format, args...)
}

func provenanceError(format string, args ...any) error {
	return fmt.Errorf("AGX-BUNDLE-PROVENANCE: "+format, args...)
}
