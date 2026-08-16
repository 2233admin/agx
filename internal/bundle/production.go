package bundle

import _ "embed"

// productionData is the immutable production Bundle shipped with this AGX binary.
//
//go:embed production-v2.json
var productionData []byte

// Production returns an isolated copy of the production Bundle manifest embedded
// in this AGX binary.
func Production() []byte {
	return append([]byte(nil), productionData...)
}
