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
	t.Parallel()

	large := strings.Repeat("x", 1<<20)
	tests := []struct {
		name string
		tag  string
		want string
	}{
		{name: "empty", tag: "", want: "<none>"},
		{name: "single char", tag: "a", want: "<a>"},
		{name: "semver", tag: "v1.2.3", want: "<v1.2.3>"},
		{name: "whitespace only", tag: " ", want: "< >"},
		{name: "tabs and newlines", tag: "\t\n", want: "<\t\n>"},
		{name: "literal none", tag: "none", want: "<none>"},
		{name: "already bracketed", tag: "<tag>", want: "<<tag>>"},
		{name: "utf8", tag: "release-🚀", want: "<release-🚀>"},
		{name: "large input", tag: large, want: "<" + large + ">"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := metrics.FormatTag(tc.tag); got != tc.want {
				t.Errorf("FormatTag(%q) = %q, want %q", tc.tag, got, tc.want)
			}
		})
	}
}
