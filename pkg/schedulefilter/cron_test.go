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
	"strings"
	"testing"
)

func TestValidateCronValidExpressions(t *testing.T) {
	valid := []string{
		"* * * * *",
		"0 0 * * *",
		"15 10 * * *",
		"*/5 * * * *",
		"0 9-17 * * 1-5",
		"0,30 8,12,18 * * *",
		"0-59/2 0-23/3 1-31 1-12 0-6",
		"0123456789 * * * *",
		"  0 3 * * *  ",
		"0  3 * * *",
		"@hourly",
		"@daily",
		"@weekly",
		"@monthly",
		"@yearly",
	}
	for _, expr := range valid {
		if err := ValidateCron(expr); err != nil {
			t.Errorf("ValidateCron(%q) = %v, want nil", expr, err)
		}
	}
}

func TestValidateCronRejectsInvalidExpressions(t *testing.T) {
	cases := []struct {
		name    string
		expr    string
		wantSub string
	}{
		{name: "empty", expr: "", wantSub: "empty"},
		{name: "spaces only", expr: "     ", wantSub: "5 parts"},
		{name: "one part", expr: "*", wantSub: "5 parts"},
		{name: "four parts", expr: "* * * *", wantSub: "got 4"},
		{name: "four parts with trailing spaces", expr: "* * * *  ", wantSub: "got 4"},
		{name: "four parts with invalid char", expr: "* * * a", wantSub: "invalid character"},
		{name: "six parts", expr: "* * * * * *", wantSub: "more than 5"},
		{name: "seven parts", expr: "0 * * * * * *", wantSub: "more than 5"},
		{name: "letters in field", expr: "0 0 * * MON", wantSub: "invalid character"},
		{name: "lowercase letters", expr: "a * * * *", wantSub: "invalid character"},
		{name: "question mark", expr: "0 0 * * ?", wantSub: "invalid character"},
		{name: "semicolon", expr: "0 0 * * ;", wantSub: "invalid character"},
		{name: "tab separator", expr: "*\t*\t*\t*\t*", wantSub: "invalid character"},
		{name: "newline in field", expr: "* * * *\n*", wantSub: "invalid character"},
		{name: "trailing newline", expr: "* * * * *\n", wantSub: "invalid character"},
		{name: "non-ASCII rune", expr: "* * * * é", wantSub: "invalid character"},
		{name: "invalid UTF-8", expr: "* * * * \xff", wantSub: "invalid character"},
		{name: "macro with leading space", expr: " @daily", wantSub: "invalid character"},
		{name: "macro with trailing space", expr: "@daily ", wantSub: "invalid character"},
		{name: "macro uppercase", expr: "@DAILY", wantSub: "invalid character"},
		{name: "unsupported macro annually", expr: "@annually", wantSub: "invalid character"},
		{name: "unsupported macro midnight", expr: "@midnight", wantSub: "invalid character"},
		{name: "unsupported macro reboot", expr: "@reboot", wantSub: "invalid character"},
		{name: "macro plus fields", expr: "@hourly * * * *", wantSub: "invalid character"},
		{name: "huge spaces", expr: strings.Repeat(" ", 100000), wantSub: "got 0"},
		{name: "huge single part", expr: strings.Repeat("0", 100000), wantSub: "got 1"},
		{name: "huge part count", expr: strings.Repeat("* ", 100000), wantSub: "more than 5"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateCron(tc.expr)
			if err == nil {
				t.Fatalf("ValidateCron(%q) = nil, want error", tc.expr)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Errorf("ValidateCron(%q) error = %q, want substring %q", tc.expr, err.Error(), tc.wantSub)
			}
		})
	}
}
