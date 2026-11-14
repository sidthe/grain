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

package schedulefilter

import (
	"errors"
	"fmt"
)

// ValidateCron reports whether expr is a supported cron expression: either an
// exact match for @hourly, @daily, @weekly, @monthly, or @yearly, or five
// space-separated parts whose characters are limited to '*', '0'-'9', '/',
// '-', and ','.
func ValidateCron(expr string) error {
	if expr == "" {
		return errors.New("cron expression must not be empty")
	}
	switch expr {
	case "@hourly", "@daily", "@weekly", "@monthly", "@yearly":
		return nil
	}

	parts := 0
	for i := 0; i < len(expr); {
		for i < len(expr) && expr[i] == ' ' {
			i++
		}
		if i >= len(expr) {
			break
		}
		parts++
		if parts > 5 {
			return errors.New("cron expression must have exactly 5 parts")
		}
		start := i
		for i < len(expr) && expr[i] != ' ' {
			i++
		}
		for _, r := range expr[start:i] {
			if !isValidCronRune(r) {
				return fmt.Errorf("cron expression part %d contains invalid character %q", parts, r)
			}
		}
	}
	if parts != 5 {
		return fmt.Errorf("cron expression must have exactly 5 parts, got %d", parts)
	}
	return nil
}

func isValidCronRune(r rune) bool {
	return (r >= '0' && r <= '9') || r == '*' || r == '/' || r == '-' || r == ','
}
