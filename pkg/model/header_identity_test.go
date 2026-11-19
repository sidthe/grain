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

package model_test

import (
	"slices"
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
)

func TestHeaderColorAllowlistAndParsing(t *testing.T) {
	t.Parallel()
	want := []string{"", "ocean", "teal", "forest", "amber", "coral", "plum", "slate"}
	if got := model.HeaderColors(); !slices.Equal(got, want) {
		t.Fatalf("HeaderColors() = %v, want %v", got, want)
	}
	for _, c := range want {
		if !model.ValidHeaderColor(c) {
			t.Errorf("ValidHeaderColor(%q) = false, want true", c)
		}
		got, err := model.ParseHeaderColor("  " + c + "  ")
		if err != nil || got != c {
			t.Errorf("ParseHeaderColor(%q) = (%q, %v), want (%q, nil)", "  "+c+"  ", got, err, c)
		}
		if norm := model.NormalizeHeaderColor(c); norm != c {
			t.Errorf("NormalizeHeaderColor(%q) = %q, want %q", c, norm, c)
		}
	}
	for _, bad := range []string{"blue", "OCEAN", "#0b57d0", "ocean;color:red", "url(x)", "neutral"} {
		if model.ValidHeaderColor(bad) {
			t.Errorf("ValidHeaderColor(%q) = true, want false", bad)
		}
		if _, err := model.ParseHeaderColor(bad); err == nil {
			t.Errorf("ParseHeaderColor(%q) = nil, want error", bad)
		}
		if norm := model.NormalizeHeaderColor(bad); norm != "" {
			t.Errorf("NormalizeHeaderColor(%q) = %q, want empty", bad, norm)
		}
	}
}

func TestHeaderPatternAllowlistAndParsing(t *testing.T) {
	t.Parallel()
	want := []string{"", "dots", "diagonal", "grid", "waves"}
	if got := model.HeaderPatterns(); !slices.Equal(got, want) {
		t.Fatalf("HeaderPatterns() = %v, want %v", got, want)
	}
	for _, p := range want {
		if !model.ValidHeaderPattern(p) {
			t.Errorf("ValidHeaderPattern(%q) = false, want true", p)
		}
		got, err := model.ParseHeaderPattern(" " + p + " ")
		if err != nil || got != p {
			t.Errorf("ParseHeaderPattern(%q) = (%q, %v), want (%q, nil)", " "+p+" ", got, err, p)
		}
		if norm := model.NormalizeHeaderPattern(p); norm != p {
			t.Errorf("NormalizeHeaderPattern(%q) = %q, want %q", p, norm, p)
		}
	}
	for _, bad := range []string{"stripes", "solid", "DOTS", "waves;opacity:1", "url(data:...)"} {
		if model.ValidHeaderPattern(bad) {
			t.Errorf("ValidHeaderPattern(%q) = true, want false", bad)
		}
		if _, err := model.ParseHeaderPattern(bad); err == nil {
			t.Errorf("ParseHeaderPattern(%q) = nil, want error", bad)
		}
		if norm := model.NormalizeHeaderPattern(bad); norm != "" {
			t.Errorf("NormalizeHeaderPattern(%q) = %q, want empty", bad, norm)
		}
	}
}

func TestHeaderTuningParametersRecognized(t *testing.T) {
	t.Parallel()
	for _, param := range []string{"header_color", "header-color", "header_pattern", "header-pattern"} {
		if !model.IsRecognizedTuningParameter(param) {
			t.Errorf("IsRecognizedTuningParameter(%q) = false, want true", param)
		}
	}
}
