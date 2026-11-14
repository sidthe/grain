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

// ValidateCron validates expr as either one of the supported schedule macros
// (@hourly, @daily, @weekly, @monthly, @yearly) or a 5-part space-separated
// cron expression whose parts contain only '*', '0'-'9', '/', '-', and ','.
func ValidateCron(expr string) error {
	if expr == "" {
		return errors.New("cron expression cannot be empty")
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
		if i == len(expr) {
			break
		}
		parts++
		if parts > 5 {
			return errors.New("cron expression must have exactly 5 parts, got more than 5")
		}
		start := i
		for i < len(expr) && expr[i] != ' ' {
			i++
		}
		if err := validateCronPart(expr[start:i]); err != nil {
			return err
		}
	}
	if parts != 5 {
		return fmt.Errorf("cron expression must have exactly 5 parts, got %d", parts)
	}
	return nil
}

func validateCronPart(part string) error {
	for _, r := range part {
		if !isCronChar(r) {
			return fmt.Errorf("invalid character %q in cron expression", r)
		}
	}
	return nil
}

func isCronChar(r rune) bool {
	return (r >= '0' && r <= '9') || r == '*' || r == '/' || r == '-' || r == ','
}
