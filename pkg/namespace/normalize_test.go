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

	maxLenLower := strings.Repeat("a", 63)
	maxLenUpper := strings.Repeat("A", 63)
	maxLenMixed := "A" + strings.Repeat("-1b", 20) + "C9" // 1 + 60 + 2 = 63 chars
	if len(maxLenMixed) != 63 {
		t.Fatalf("test setup error: len(maxLenMixed) = %d, want 63", len(maxLenMixed))
	}

	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "empty defaults to default", in: "", want: "default"},
		{name: "default unchanged", in: "default", want: "default"},
		{name: "single letter", in: "a", want: "a"},
		{name: "single uppercase letter", in: "Z", want: "z"},
		{name: "single digit", in: "0", want: "0"},
		{name: "lowercase alphanumeric and hyphen", in: "kube-system-1", want: "kube-system-1"},
		{name: "consecutive hyphens in middle", in: "a--b", want: "a--b"},
		{name: "uppercase converted to lowercase", in: "DEFAULT", want: "default"},
		{name: "mixed case converted to lowercase", in: "Kube-System-42", want: "kube-system-42"},
		{name: "max length 63 lowercase", in: maxLenLower, want: maxLenLower},
		{name: "max length 63 uppercase", in: maxLenUpper, want: maxLenLower},
		{name: "max length 63 mixed", in: maxLenMixed, want: strings.ToLower(maxLenMixed)},

		// Boundary length errors
		{name: "64 chars lowercase rejected", in: strings.Repeat("a", 64), wantErr: true},
		{name: "64 chars uppercase rejected", in: strings.Repeat("A", 64), wantErr: true},
		{name: "huge input rejected", in: strings.Repeat("A", 1<<20), wantErr: true},

		// Hyphen start/end errors
		{name: "single hyphen rejected", in: "-", wantErr: true},
		{name: "double hyphen rejected", in: "--", wantErr: true},
		{name: "leading hyphen rejected", in: "-abc", wantErr: true},
		{name: "trailing hyphen rejected", in: "abc-", wantErr: true},
		{name: "leading and trailing hyphen rejected", in: "-abc-", wantErr: true},
		{name: "leading hyphen with uppercase rejected", in: "-ABC", wantErr: true},
		{name: "trailing hyphen with digit rejected", in: "0-", wantErr: true},

		// Invalid character errors
		{name: "single space rejected", in: " ", wantErr: true},
		{name: "whitespace only rejected", in: "   ", wantErr: true},
		{name: "leading space rejected", in: " default", wantErr: true},
		{name: "trailing space rejected", in: "default ", wantErr: true},
		{name: "internal space rejected", in: "my ns", wantErr: true},
		{name: "tab rejected", in: "a\tb", wantErr: true},
		{name: "newline rejected", in: "a\nb", wantErr: true},
		{name: "underscore rejected", in: "my_ns", wantErr: true},
		{name: "dot rejected", in: "my.ns", wantErr: true},
		{name: "slash rejected", in: "my/ns", wantErr: true},
		{name: "exclamation rejected", in: "ns!", wantErr: true},
		{name: "nul byte rejected", in: "a\x00b", wantErr: true},
		{name: "del byte rejected", in: "a\x7fb", wantErr: true},
		{name: "non-ascii accented rejected", in: "café", wantErr: true},
		{name: "kelvin sign rejected", in: "\u212a", wantErr: true},
		{name: "turkish dotted capital I rejected", in: "\u0130", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := Normalize(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Normalize(%q) = (%q, nil), want error", tc.in, got)
				}
				if got != "" {
					t.Errorf("Normalize(%q) returned non-empty value %q on error %v", tc.in, got, err)
				}
				if !errors.Is(err, ErrBadRequest) {
					t.Errorf("Normalize(%q) error = %v, want ErrBadRequest", tc.in, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Normalize(%q) unexpected error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
			// Idempotency check for normalized outputs.
			again, err := Normalize(got)
			if err != nil || again != got {
				t.Fatalf("Normalize(%q) not idempotent: got (%q, %v), want (%q, nil)", got, again, err, got)
			}
		})
	}

	t.Run("ascii character boundaries", func(t *testing.T) {
		t.Parallel()
		for c := byte(0); c < 128; c++ {
			in := "a" + string([]byte{c}) + "b"
			got, err := Normalize(in)
			valid := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-'
			if valid {
				if err != nil {
					t.Errorf("Normalize(%q) unexpected error: %v", in, err)
				}
				want := strings.ToLower(in)
				if got != want {
					t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
				}
			} else {
				if err == nil || got != "" {
					t.Errorf("Normalize(%q) = (%q, %v), want (\"\", error)", in, got, err)
				}
			}
		}
	})
}
