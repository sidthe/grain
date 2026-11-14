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

package designdoc

import (
	"errors"
	"fmt"
	"strings"
)

// ValidateTemplate checks that template is non-empty, contains at least one
// `{{` and `}}` delimiter pair, never closes `}}` before a matching `{{`, and
// has no unmatched `{{` or `}}` delimiters.
func ValidateTemplate(template string) error {
	if template == "" {
		return errors.New("designdoc: template must not be empty")
	}
	hasOpen := false
	hasClose := false
	depth := 0
	for i := 0; i < len(template); {
		switch {
		case strings.HasPrefix(template[i:], "{{"):
			hasOpen = true
			depth++
			i += 2
		case strings.HasPrefix(template[i:], "}}"):
			hasClose = true
			if depth == 0 {
				return fmt.Errorf("designdoc: unexpected }} at offset %d before matching {{", i)
			}
			depth--
			i += 2
		default:
			i++
		}
	}
	if !hasOpen || !hasClose {
		return errors.New("designdoc: template must contain both {{ and }}")
	}
	if depth != 0 {
		return fmt.Errorf("designdoc: template has %d unmatched {{ delimiter(s)", depth)
	}
	return nil
}
