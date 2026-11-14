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

package designdoc_test

import (
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/designdoc"
)

func TestValidateTemplateValid(t *testing.T) {
	tests := []struct {
		name     string
		template string
	}{
		{name: "single placeholder", template: "{{name}}"},
		{name: "placeholder in prose", template: "Hello, {{name}}!"},
		{name: "empty delimiters", template: "{{}}"},
		{name: "multiple placeholders", template: "Plan {{group}} on {{branch}} ({{from_sha}}..{{to_sha}})"},
		{name: "multiline", template: "line 1: {{a}}\nline 2: {{b\nc}}"},
		{name: "nested delimiters", template: "{{outer {{inner}} end}}"},
		{name: "deeply nested delimiters", template: "{{ {{ {{x}} }} }}"},
		{name: "single braces mixed with template", template: "### Heading {#D-7}\n{\"key\": {{val}}}"},
		{name: "utf8 content", template: "café {{naïve}} 🚀"},
		{name: "large valid template", template: strings.Repeat("a", 1<<20) + "{{ok}}" + strings.Repeat("b", 1<<16)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := designdoc.ValidateTemplate(tc.template); err != nil {
				t.Errorf("ValidateTemplate(%s) = %v, want nil", tc.name, err)
			}
		})
	}
}

func TestValidateTemplateInvalid(t *testing.T) {
	tests := []struct {
		name        string
		template    string
		wantContain string
	}{
		{name: "empty", template: "", wantContain: "empty"},
		{name: "whitespace only", template: "   \n\t  ", wantContain: "both {{ and }}"},
		{name: "no delimiters", template: "plain text", wantContain: "both {{ and }}"},
		{name: "single braces only", template: "{name}", wantContain: "both {{ and }}"},
		{name: "missing closing delimiter", template: "hello {{name", wantContain: "both {{ and }}"},
		{name: "missing opening delimiter", template: "hello name}}", wantContain: "before matching {{"},
		{name: "only opening delimiter", template: "{{", wantContain: "both {{ and }}"},
		{name: "only closing delimiter", template: "}}", wantContain: "before matching {{"},
		{name: "close before open", template: "}} {{", wantContain: "before matching {{"},
		{name: "close before open with text", template: "a }} b {{c}}", wantContain: "before matching {{"},
		{name: "trailing extra close", template: "{{a}} }}", wantContain: "before matching {{"},
		{name: "middle extra close", template: "{{a}} }} {{b}}", wantContain: "before matching {{"},
		{name: "trailing extra open", template: "{{a}} {{", wantContain: "unmatched {{"},
		{name: "nested unmatched open", template: "{{a {{b}}", wantContain: "unmatched {{"},
		{name: "adjacent extra close", template: "{{a}} {{b}}}}", wantContain: "before matching {{"},
		{name: "four opens two closes", template: "{{{{}}", wantContain: "unmatched {{"},
		{name: "two opens four closes", template: "{{}}}}", wantContain: "before matching {{"},
		{name: "single open then triple close", template: "{}}}", wantContain: "before matching {{"},
		{name: "triple open then single close", template: "{{{}", wantContain: "both {{ and }}"},
		{name: "large unclosed template", template: "{{ok}}" + strings.Repeat("x", 1<<20) + "{{dangling", wantContain: "unmatched {{"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := designdoc.ValidateTemplate(tc.template)
			if err == nil {
				t.Fatalf("ValidateTemplate(%s) = nil, want error containing %q", tc.name, tc.wantContain)
			}
			if !strings.Contains(err.Error(), tc.wantContain) {
				t.Errorf("ValidateTemplate(%s) error = %q, want substring %q", tc.name, err.Error(), tc.wantContain)
			}
		})
	}
}
