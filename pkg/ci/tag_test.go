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

package ci_test

import (
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/ci"
	"github.com/ai-on-gke/grain/pkg/metrics"
)

func TestWrapTag(t *testing.T) {
	t.Parallel()

	large := strings.Repeat("y", 1<<20)
	tests := []struct {
		name string
		tag  string
		want string
	}{
		{name: "empty", tag: "", want: "CI: <none>"},
		{name: "single char", tag: "a", want: "CI: <a>"},
		{name: "simple tag", tag: "go-multi", want: "CI: <go-multi>"},
		{name: "whitespace only", tag: " ", want: "CI: < >"},
		{name: "tabs and newlines", tag: "\t\n", want: "CI: <\t\n>"},
		{name: "literal none", tag: "none", want: "CI: <none>"},
		{name: "already bracketed", tag: "<tag>", want: "CI: <<tag>>"},
		{name: "ci prefix in tag", tag: "CI: test", want: "CI: <CI: test>"},
		{name: "utf8", tag: "build-✓", want: "CI: <build-✓>"},
		{name: "large input", tag: large, want: "CI: <" + large + ">"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ci.WrapTag(tc.tag)
			if got != tc.want {
				t.Errorf("WrapTag(%q) = %q, want %q", tc.tag, got, tc.want)
			}
			if wantFromMetrics := "CI: " + metrics.FormatTag(tc.tag); got != wantFromMetrics {
				t.Errorf("WrapTag(%q) = %q, want %q (from metrics.FormatTag)", tc.tag, got, wantFromMetrics)
			}
		})
	}
}
