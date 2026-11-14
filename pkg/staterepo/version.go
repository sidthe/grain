// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package staterepo

import (
	"fmt"
	"strings"
)

const maxStateVersionLen = 20

// ValidateStateVersion validates that version starts with "v", has length at
// most 20 bytes, and has exactly three non-empty dot-separated base-10
// non-negative integers after "v" (e.g., "v1.2.3").
func ValidateStateVersion(version string) error {
	if len(version) > maxStateVersionLen {
		return fmt.Errorf("staterepo: invalid state version: length %d exceeds max %d", len(version), maxStateVersionLen)
	}
	rest, ok := strings.CutPrefix(version, "v")
	if !ok {
		return fmt.Errorf("staterepo: invalid state version %q: must start with 'v'", version)
	}
	parts := strings.Split(rest, ".")
	if len(parts) != 3 {
		return fmt.Errorf("staterepo: invalid state version %q: must have three dot-separated integers", version)
	}
	for _, part := range parts {
		if part == "" {
			return fmt.Errorf("staterepo: invalid state version %q: empty version component", version)
		}
		if strings.HasPrefix(part, "-") {
			return fmt.Errorf("staterepo: invalid state version %q: negative component %q", version, part)
		}
		if !isBase10Digits(part) {
			return fmt.Errorf("staterepo: invalid state version %q: non-numeric component %q", version, part)
		}
	}
	return nil
}

// isBase10Digits reports whether s is a non-empty string of ASCII digits '0'-'9'.
func isBase10Digits(s string) bool {
	if len(s) == 0 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
