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

func TestValidateCronValid(t *testing.T) {
	valid := []string{
		"* * * * *",
		"0 * * * *",
		"0 0 * * *",
		"*/5 * * * *",
		"0 9-17 * * 1-5",
		"0,15,30,45 * 1-15/2 1,6,12 0-6",
		"  11 2 * * *  ",
		"0  0 * * *",
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

func TestValidateCronInvalid(t *testing.T) {
	cases := []struct {
		name    string
		expr    string
		wantSub string
	}{
		{name: "empty", expr: "", wantSub: "empty"},
		{name: "single space", expr: " ", wantSub: "5 parts"},
		{name: "four spaces", expr: "    ", wantSub: "5 parts"},
		{name: "one part", expr: "*", wantSub: "5 parts"},
		{name: "two parts", expr: "* *", wantSub: "5 parts"},
		{name: "three parts", expr: "* * *", wantSub: "5 parts"},
		{name: "four parts", expr: "* * * *", wantSub: "5 parts"},
		{name: "six parts", expr: "* * * * * *", wantSub: "5 parts"},
		{name: "seven parts", expr: "0 0 * * * * *", wantSub: "5 parts"},
		{name: "invalid letter", expr: "* * * * a", wantSub: "invalid character"},
		{name: "weekday name", expr: "0 0 * * MON", wantSub: "invalid character"},
		{name: "month name", expr: "0 0 * JAN *", wantSub: "invalid character"},
		{name: "question mark", expr: "* * * * ?", wantSub: "invalid character"},
		{name: "plus sign", expr: "* * * * 1+2", wantSub: "invalid character"},
		{name: "dollar sign", expr: "* * * * $", wantSub: "invalid character"},
		{name: "tab separator", expr: "*\t*\t*\t*\t*", wantSub: "invalid character"},
		{name: "newline in part", expr: "* * * *\n*", wantSub: "invalid character"},
		{name: "non-ascii digit", expr: "* * * * ١", wantSub: "invalid character"},
		{name: "invalid utf8", expr: "\xff * * * *", wantSub: "invalid character"},
		{name: "unsupported macro annually", expr: "@annually", wantSub: "invalid character"},
		{name: "unsupported macro midnight", expr: "@midnight", wantSub: "invalid character"},
		{name: "unsupported macro reboot", expr: "@reboot", wantSub: "invalid character"},
		{name: "uppercase macro", expr: "@DAILY", wantSub: "invalid character"},
		{name: "leading space macro", expr: " @daily", wantSub: "invalid character"},
		{name: "trailing space macro", expr: "@daily ", wantSub: "invalid character"},
		{name: "macro with extra fields", expr: "@hourly * * * *", wantSub: "invalid character"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateCron(tc.expr)
			if err == nil {
				t.Fatalf("ValidateCron(%q) = nil, want error containing %q", tc.expr, tc.wantSub)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("ValidateCron(%q) error = %q, want substring %q", tc.expr, err.Error(), tc.wantSub)
			}
		})
	}
}

func TestValidateCronHugeInputs(t *testing.T) {
	if err := ValidateCron(strings.Repeat(" ", 1<<20)); err == nil {
		t.Fatal("ValidateCron(1 MiB spaces) = nil, want error")
	}
	if err := ValidateCron(strings.Repeat("* ", 1<<18)); err == nil {
		t.Fatal("ValidateCron(many parts) = nil, want error")
	}
	hugeValid := strings.Repeat("0", 1<<16) + " * * * *"
	if err := ValidateCron(hugeValid); err != nil {
		t.Fatalf("ValidateCron(huge valid field) = %v, want nil", err)
	}
	hugeInvalid := strings.Repeat("0", 1<<16) + "a * * * *"
	if err := ValidateCron(hugeInvalid); err == nil {
		t.Fatal("ValidateCron(huge invalid field) = nil, want error")
	}
}
