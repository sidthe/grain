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

package staterepo_test

import (
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/staterepo"
)

func TestValidateStateVersionValid(t *testing.T) {
	cases := []struct {
		name    string
		version string
	}{
		{name: "typical", version: "v1.2.3"},
		{name: "all zeros", version: "v0.0.0"},
		{name: "leading zeros", version: "v01.02.03"},
		{name: "multi-digit", version: "v10.200.3000"},
		{name: "exact max length 20", version: "v123456.123456.12345"},
		{name: "exact max length 20 single long component", version: "v0.0.123456789012345"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := staterepo.ValidateStateVersion(tc.version); err != nil {
				t.Fatalf("ValidateStateVersion(%q) = %v, want nil", tc.version, err)
			}
		})
	}
}

func TestValidateStateVersionInvalid(t *testing.T) {
	cases := []struct {
		name          string
		version       string
		wantErrSubstr string
	}{
		{name: "empty", version: "", wantErrSubstr: "must start with"},
		{name: "missing v prefix", version: "1.2.3", wantErrSubstr: "must start with"},
		{name: "uppercase V prefix", version: "V1.2.3", wantErrSubstr: "must start with"},
		{name: "leading whitespace", version: " v1.2.3", wantErrSubstr: "must start with"},
		{name: "v only", version: "v", wantErrSubstr: "three dot-separated"},
		{name: "too few components one", version: "v1", wantErrSubstr: "three dot-separated"},
		{name: "too few components two", version: "v1.2", wantErrSubstr: "three dot-separated"},
		{name: "too many components four", version: "v1.2.3.4", wantErrSubstr: "three dot-separated"},
		{name: "trailing dot", version: "v1.2.3.", wantErrSubstr: "three dot-separated"},
		{name: "leading dot after v", version: "v.1.2.3", wantErrSubstr: "three dot-separated"},
		{name: "empty first component", version: "v.2.3", wantErrSubstr: "empty"},
		{name: "empty middle component", version: "v1..3", wantErrSubstr: "empty"},
		{name: "empty last component", version: "v1.2.", wantErrSubstr: "empty"},
		{name: "all empty components", version: "v..", wantErrSubstr: "empty"},
		{name: "negative major", version: "v-1.2.3", wantErrSubstr: "negative"},
		{name: "negative minor", version: "v1.-2.3", wantErrSubstr: "negative"},
		{name: "negative patch", version: "v1.2.-3", wantErrSubstr: "negative"},
		{name: "negative zero", version: "v-0.0.0", wantErrSubstr: "negative"},
		{name: "minus only", version: "v-.2.3", wantErrSubstr: "negative"},
		{name: "plus sign major", version: "v+1.2.3", wantErrSubstr: "non-numeric"},
		{name: "plus sign minor", version: "v1.+2.3", wantErrSubstr: "non-numeric"},
		{name: "alphabetic", version: "v1.2.a", wantErrSubstr: "non-numeric"},
		{name: "prerelease suffix", version: "v1.2.3-alpha", wantErrSubstr: "non-numeric"},
		{name: "build metadata suffix", version: "v1.2.3+build", wantErrSubstr: "non-numeric"},
		{name: "hex prefix", version: "v0x1.2.3", wantErrSubstr: "non-numeric"},
		{name: "underscore separator", version: "v1_0.2.3", wantErrSubstr: "non-numeric"},
		{name: "trailing space", version: "v1.2.3 ", wantErrSubstr: "non-numeric"},
		{name: "internal space", version: "v1. 2.3", wantErrSubstr: "non-numeric"},
		{name: "newline", version: "v1.2.3\n", wantErrSubstr: "non-numeric"},
		{name: "nul byte", version: "v1.2.3\x00", wantErrSubstr: "non-numeric"},
		{name: "unicode arabic digit", version: "v١.2.3", wantErrSubstr: "non-numeric"},
		{name: "exceeds max length 21", version: "v123456.123456.123456", wantErrSubstr: "exceeds max"},
		{name: "exceeds max length 21 single long", version: "v0.0.1234567890123456", wantErrSubstr: "exceeds max"},
		{name: "exceeds max byte length multibyte utf8", version: "v1.2." + strings.Repeat("é", 8), wantErrSubstr: "exceeds max"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := staterepo.ValidateStateVersion(tc.version)
			if err == nil {
				t.Fatalf("ValidateStateVersion(%q) = nil, want error containing %q", tc.version, tc.wantErrSubstr)
			}
			if !strings.Contains(err.Error(), tc.wantErrSubstr) {
				t.Fatalf("ValidateStateVersion(%q) error = %q, want substring %q", tc.version, err.Error(), tc.wantErrSubstr)
			}
		})
	}
}

func TestValidateStateVersionHugeInput(t *testing.T) {
	huge := "v1.2." + strings.Repeat("3", 1<<20)
	err := staterepo.ValidateStateVersion(huge)
	if err == nil {
		t.Fatal("ValidateStateVersion(huge) = nil, want error")
	}
	if !strings.Contains(err.Error(), "exceeds max") {
		t.Fatalf("ValidateStateVersion(huge) error = %q, want substring %q", err.Error(), "exceeds max")
	}
	if len(err.Error()) > 200 {
		t.Fatalf("ValidateStateVersion(huge) error too long (%d bytes); must not echo huge input", len(err.Error()))
	}
}
