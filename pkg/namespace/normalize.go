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

package namespace

import "fmt"

const (
	defaultNamespace = "default"
	maxNamespaceLen  = 63
)

// Normalize converts ns to a canonical lowercase namespace label. Empty input
// defaults to "default"; non-empty input must be at most 63 characters long,
// contain only ASCII letters (lowercased to a-z), digits (0-9), and '-', and
// neither start nor end with '-'.
func Normalize(ns string) (string, error) {
	if ns == "" {
		return defaultNamespace, nil
	}
	if len(ns) > maxNamespaceLen {
		return "", fmt.Errorf("%w: namespace exceeds %d characters (%d)", ErrBadRequest, maxNamespaceLen, len(ns))
	}
	var lower []byte
	for i := 0; i < len(ns); i++ {
		c := ns[i]
		if c >= 'A' && c <= 'Z' {
			if lower == nil {
				lower = []byte(ns)
			}
			lower[i] = c + ('a' - 'A')
			continue
		}
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			continue
		}
		return "", fmt.Errorf("%w: namespace %q contains invalid character (allowed: a-z, 0-9, '-')", ErrBadRequest, ns)
	}
	if lower != nil {
		ns = string(lower)
	}
	if ns[0] == '-' || ns[len(ns)-1] == '-' {
		return "", fmt.Errorf("%w: namespace %q must not start or end with '-'", ErrBadRequest, ns)
	}
	return ns, nil
}
