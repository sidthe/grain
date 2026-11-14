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

package metrics_test

import (
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/metrics"
)

func TestFormatTag(t *testing.T) {
	large := strings.Repeat("x", 1<<16)
	tests := []struct {
		name string
		tag  string
		want string
	}{
		{name: "empty", tag: "", want: "<none>"},
		{name: "simple", tag: "go", want: "<go>"},
		{name: "semver", tag: "v1.2.3-rc.1", want: "<v1.2.3-rc.1>"},
		{name: "whitespace preserved", tag: " ", want: "< >"},
		{name: "tabs and newlines", tag: "\t\n", want: "<\t\n>"},
		{name: "angle brackets", tag: "<inner>", want: "<<inner>>"},
		{name: "unicode", tag: "タグ", want: "<タグ>"},
		{name: "none literal", tag: "none", want: "<none>"},
		{name: "large", tag: large, want: "<" + large + ">"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := metrics.FormatTag(tc.tag); got != tc.want {
				t.Errorf("FormatTag(%q) = %q, want %q", tc.tag, got, tc.want)
			}
		})
	}
}
