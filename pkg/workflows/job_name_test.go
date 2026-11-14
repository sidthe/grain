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

package workflows

import (
	"strings"
	"testing"
)

func TestIsSafeJobName(t *testing.T) {
	t.Parallel()

	cases := []struct {
		desc string
		name string
		want bool
	}{
		// Valid cases
		{desc: "single_char", name: "a", want: true},
		{desc: "single_underscore", name: "_", want: true},
		{desc: "typical_job_id", name: "unit-tests", want: true},
		{desc: "alphanumeric_underscore", name: "go_test_1", want: true},
		{desc: "display_name_with_spaces_and_parens", name: "Go Unit Tests (linux/amd64)", want: true},
		{desc: "trailing_hyphen", name: "job-", want: true},
		{desc: "leading_space_before_hyphen", name: " -job", want: true},
		{desc: "safe_punctuation", name: `job:1/2.3+4=5@6#7%8^9*0!~'"\[](),?`, want: true},
		{desc: "exact_128_ascii_bytes", name: strings.Repeat("a", 128), want: true},
		{desc: "exact_128_bytes_with_hyphens", name: "a" + strings.Repeat("-", 127), want: true},
		{desc: "exact_128_multibyte_utf8_bytes", name: strings.Repeat("é", 64), want: true},
		{desc: "invalid_utf8_without_unsafe_chars", name: "job\xffname", want: true},

		// Rule 1: empty
		{desc: "empty", name: "", want: false},

		// Rule 2: longer than 128 bytes
		{desc: "129_ascii_bytes", name: strings.Repeat("a", 129), want: false},
		{desc: "129_bytes_ascii_plus_multibyte", name: strings.Repeat("a", 127) + "é", want: false},
		{desc: "130_bytes_65_multibyte_runes", name: strings.Repeat("é", 65), want: false},
		{desc: "129_bytes_3byte_runes", name: strings.Repeat("世", 43), want: false},
		{desc: "129_bytes_starting_with_hyphen", name: "-" + strings.Repeat("a", 128), want: false},

		// Rule 3: forbidden characters $, {, }, ;, &, |, <, >
		{desc: "dollar_only", name: "$", want: false},
		{desc: "dollar_middle", name: "job$name", want: false},
		{desc: "dollar_end", name: "job$", want: false},
		{desc: "lbrace_only", name: "{", want: false},
		{desc: "lbrace_middle", name: "job{name", want: false},
		{desc: "rbrace_only", name: "}", want: false},
		{desc: "rbrace_middle", name: "job}name", want: false},
		{desc: "semicolon_only", name: ";", want: false},
		{desc: "semicolon_middle", name: "job;name", want: false},
		{desc: "ampersand_only", name: "&", want: false},
		{desc: "ampersand_middle", name: "job&name", want: false},
		{desc: "pipe_only", name: "|", want: false},
		{desc: "pipe_middle", name: "job|name", want: false},
		{desc: "lt_only", name: "<", want: false},
		{desc: "lt_middle", name: "job<name", want: false},
		{desc: "gt_only", name: ">", want: false},
		{desc: "gt_middle", name: "job>name", want: false},
		{desc: "shell_subshell", name: "$(whoami)", want: false},
		{desc: "shell_var_braces", name: "${PATH}", want: false},
		{desc: "github_expression", name: "${{ github.event }}", want: false},
		{desc: "shell_command_chain", name: "build;rm -rf /", want: false},
		{desc: "shell_and_chain", name: "build&&echo", want: false},
		{desc: "shell_or_chain", name: "build||true", want: false},
		{desc: "shell_redirect", name: "build>out<in", want: false},
		{desc: "unsafe_char_after_invalid_utf8", name: "a\xff$", want: false},

		// Rule 4: starts with '-'
		{desc: "hyphen_only", name: "-", want: false},
		{desc: "leading_hyphen", name: "-job", want: false},
		{desc: "leading_double_hyphen", name: "--help", want: false},
		{desc: "leading_hyphen_and_unsafe", name: "-$", want: false},
	}

	for _, tc := range cases {
		t.Run(tc.desc, func(t *testing.T) {
			t.Parallel()
			if got := IsSafeJobName(tc.name); got != tc.want {
				t.Errorf("IsSafeJobName(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

func TestIsSafeJobNameHugeInputs(t *testing.T) {
	t.Parallel()

	huge := []struct {
		desc string
		name string
	}{
		{desc: "1mb_ascii", name: strings.Repeat("a", 1<<20)},
		{desc: "1mb_trailing_unsafe", name: strings.Repeat("a", (1<<20)-1) + "$"},
		{desc: "1mb_leading_hyphen", name: "-" + strings.Repeat("a", 1<<20)},
		{desc: "multibyte_512kb", name: strings.Repeat("é", 1<<18)},
	}
	for _, tc := range huge {
		t.Run(tc.desc, func(t *testing.T) {
			t.Parallel()
			if IsSafeJobName(tc.name) {
				t.Errorf("IsSafeJobName(len=%d) = true, want false", len(tc.name))
			}
		})
	}
}
