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

package workflows_test

import (
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/workflows"
)

func TestIsSafeJobName(t *testing.T) {
	cases := []struct {
		desc string
		name string
		want bool
	}{
		// Valid names.
		{desc: "single_char", name: "a", want: true},
		{desc: "simple", name: "build", want: true},
		{desc: "hyphen_middle", name: "build-and-test", want: true},
		{desc: "hyphen_trailing", name: "build-", want: true},
		{desc: "underscore_and_digits", name: "job_123", want: true},
		{desc: "spaces_and_parens", name: "test (linux/amd64)", want: true},
		{desc: "leading_space_before_hyphen", name: " -build", want: true},
		{desc: "colon_slash_dot_plus", name: "lint:go/1.26+race", want: true},
		{desc: "utf8_under_limit", name: "tâche", want: true},
		{desc: "invalid_utf8_without_forbidden_chars", name: "\xffjob", want: true},

		// Rule 1: empty.
		{desc: "empty", name: "", want: false},

		// Rule 2: longer than 128 bytes.
		{desc: "exactly_127_bytes", name: strings.Repeat("a", 127), want: true},
		{desc: "exactly_128_bytes", name: strings.Repeat("a", 128), want: true},
		{desc: "exactly_129_bytes", name: strings.Repeat("a", 129), want: false},
		{desc: "multibyte_128_bytes_64_runes", name: strings.Repeat("é", 64), want: true},
		{desc: "multibyte_129_bytes_65_runes", name: "a" + strings.Repeat("é", 64), want: false},
		{desc: "multibyte_130_bytes_65_runes", name: strings.Repeat("é", 65), want: false},
		{desc: "huge_input", name: strings.Repeat("a", 1<<20), want: false},
		{desc: "huge_input_leading_hyphen", name: "-" + strings.Repeat("a", 1<<20), want: false},

		// Rule 3: forbidden characters ($ { } ; & | < >).
		{desc: "dollar_only", name: "$", want: false},
		{desc: "dollar_prefix", name: "$HOME", want: false},
		{desc: "dollar_middle", name: "job$1", want: false},
		{desc: "dollar_suffix", name: "job$", want: false},
		{desc: "lbrace_only", name: "{", want: false},
		{desc: "lbrace_middle", name: "job{1", want: false},
		{desc: "rbrace_only", name: "}", want: false},
		{desc: "rbrace_middle", name: "job}1", want: false},
		{desc: "braces_expr", name: "${{ matrix.os }}", want: false},
		{desc: "semicolon_only", name: ";", want: false},
		{desc: "semicolon_middle", name: "build;rm", want: false},
		{desc: "ampersand_only", name: "&", want: false},
		{desc: "ampersand_middle", name: "build&test", want: false},
		{desc: "pipe_only", name: "|", want: false},
		{desc: "pipe_middle", name: "build|cat", want: false},
		{desc: "lt_only", name: "<", want: false},
		{desc: "lt_middle", name: "build<in", want: false},
		{desc: "gt_only", name: ">", want: false},
		{desc: "gt_middle", name: "build>out", want: false},
		{desc: "invalid_utf8_with_dollar", name: "\xff$job", want: false},

		// Rule 4: starts with '-'.
		{desc: "single_hyphen", name: "-", want: false},
		{desc: "double_hyphen", name: "--help", want: false},
		{desc: "leading_hyphen", name: "-build", want: false},
		{desc: "leading_hyphen_at_128_bytes", name: "-" + strings.Repeat("a", 127), want: false},
	}

	for _, tc := range cases {
		t.Run(tc.desc, func(t *testing.T) {
			if got := workflows.IsSafeJobName(tc.name); got != tc.want {
				t.Errorf("IsSafeJobName(%q) [len=%d] = %v, want %v", tc.name, len(tc.name), got, tc.want)
			}
		})
	}
}
