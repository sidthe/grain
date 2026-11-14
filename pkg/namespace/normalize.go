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

const maxNamespaceLength = 63

// Normalize validates and normalizes a namespace name.
//
// An empty string normalizes to "default". Non-empty values are lowercased and
// must contain only ASCII characters in [a-z0-9-], must not start or end with
// '-', and must be at most 63 characters long.
func Normalize(ns string) (string, error) {
	if ns == "" {
		return "default", nil
	}
	if len(ns) > maxNamespaceLength {
		return "", fmt.Errorf("%w: namespace length %d exceeds %d characters", ErrBadRequest, len(ns), maxNamespaceLength)
	}
	if ns[0] == '-' || ns[len(ns)-1] == '-' {
		return "", fmt.Errorf("%w: namespace %q must not start or end with '-'", ErrBadRequest, ns)
	}
	var b []byte
	for i := 0; i < len(ns); i++ {
		c := ns[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-':
		case c >= 'A' && c <= 'Z':
			if b == nil {
				b = []byte(ns)
			}
			b[i] = c + ('a' - 'A')
		default:
			return "", fmt.Errorf("%w: namespace %q must contain only a-z, 0-9, and '-'", ErrBadRequest, ns)
		}
	}
	if b != nil {
		return string(b), nil
	}
	return ns, nil
}
