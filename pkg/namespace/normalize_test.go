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

package namespace

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	t.Parallel()

	maxLower := strings.Repeat("a", 63)
	maxUpper := strings.Repeat("A", 63)
	maxMixed := "A" + strings.Repeat("-b", 30) + "-C"
	maxMixedWant := "a" + strings.Repeat("-b", 30) + "-c"
	if len(maxMixed) != 63 {
		t.Fatalf("test setup error: maxMixed len = %d, want 63", len(maxMixed))
	}

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "empty defaults to default", input: "", want: "default"},
		{name: "already default", input: "default", want: "default"},
		{name: "uppercase default", input: "DEFAULT", want: "default"},
		{name: "single letter lower", input: "a", want: "a"},
		{name: "single letter upper", input: "Z", want: "z"},
		{name: "single digit", input: "0", want: "0"},
		{name: "digits only", input: "1234567890", want: "1234567890"},
		{name: "mixed case and hyphens", input: "My-Namespace-01", want: "my-namespace-01"},
		{name: "consecutive interior hyphens", input: "a--b", want: "a--b"},
		{name: "all uppercase letters", input: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", want: "abcdefghijklmnopqrstuvwxyz"},
		{name: "max length 63 lowercase", input: maxLower, want: maxLower},
		{name: "max length 63 uppercase", input: maxUpper, want: maxLower},
		{name: "max length 63 mixed with hyphens", input: maxMixed, want: maxMixedWant},

		{name: "over 63 chars lowercase", input: strings.Repeat("a", 64), wantErr: true},
		{name: "over 63 chars uppercase", input: strings.Repeat("A", 64), wantErr: true},
		{name: "huge valid-alphabet input", input: strings.Repeat("a", 1<<20), wantErr: true},
		{name: "huge invalid-alphabet input", input: strings.Repeat("!", 1<<20), wantErr: true},

		{name: "single hyphen", input: "-", wantErr: true},
		{name: "double hyphen", input: "--", wantErr: true},
		{name: "leading hyphen", input: "-abc", wantErr: true},
		{name: "trailing hyphen", input: "abc-", wantErr: true},
		{name: "leading and trailing hyphen", input: "-abc-", wantErr: true},
		{name: "leading hyphen uppercase", input: "-ABC", wantErr: true},
		{name: "trailing hyphen uppercase", input: "ABC-", wantErr: true},

		{name: "single space", input: " ", wantErr: true},
		{name: "spaces only", input: "   ", wantErr: true},
		{name: "leading space", input: " default", wantErr: true},
		{name: "trailing space", input: "default ", wantErr: true},
		{name: "interior space", input: "my ns", wantErr: true},
		{name: "tab", input: "my\tns", wantErr: true},
		{name: "newline", input: "my\nns", wantErr: true},
		{name: "underscore", input: "my_ns", wantErr: true},
		{name: "dot", input: "my.ns", wantErr: true},
		{name: "slash", input: "my/ns", wantErr: true},
		{name: "colon", input: "my:ns", wantErr: true},
		{name: "at sign", input: "my@ns", wantErr: true},
		{name: "nul byte", input: "my\x00ns", wantErr: true},
		{name: "del byte", input: "my\x7fns", wantErr: true},
		{name: "non-ascii accented", input: "café", wantErr: true},
		{name: "non-ascii greek", input: "ns-α", wantErr: true},
		{name: "emoji", input: "ns-🚀", wantErr: true},
		{name: "kelvin sign lookalike", input: "\u212aube", wantErr: true},
		{name: "turkish dotted capital i", input: "\u0130ns", wantErr: true},
		{name: "invalid utf8", input: "ns-\xff", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := Normalize(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Normalize(%q) = %q, nil; want error", tc.input, got)
				}
				if got != "" {
					t.Fatalf("Normalize(%q) returned non-empty value %q alongside error %v", tc.input, got, err)
				}
				if !errors.Is(err, ErrBadRequest) {
					t.Fatalf("Normalize(%q) error = %v; want errors.Is(err, ErrBadRequest)", tc.input, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Normalize(%q) unexpected error: %v", tc.input, err)
			}
			if got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.input, got, tc.want)
			}
			again, err := Normalize(got)
			if err != nil || again != got {
				t.Fatalf("Normalize is not idempotent on %q: second call = (%q, %v)", got, again, err)
			}
		})
	}
}
