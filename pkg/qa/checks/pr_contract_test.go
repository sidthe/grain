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

package checks

import (
	"context"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/qa"
)

func TestCheckPRDescriptionContractAndText(t *testing.T) {
	contract := qa.PRContractDecl{
		Enabled:               true,
		Mode:                  "warn",
		MaxSubjectChars:       72,
		RequiredSections:      []string{"Summary", "Verification"},
		AuditLintSuppressions: true,
	}

	rawDiff := strings.Join([]string{
		"diff --git a/pkg/foo/bar.go b/pkg/foo/bar.go",
		"index 1111111..2222222 100644",
		"--- a/pkg/foo/bar.go",
		"+++ b/pkg/foo/bar.go",
		"@@ -1,2 +1,4 @@",
		" package foo",
		"+//nolint:errcheck",
		"+//nolint:errcheck // best-effort telemetry flush on shutdown",
		" func Bar() {}",
	}, "\n")
	pd := ParseUnifiedDiff(rawDiff)
	findings, err := CheckPRDescriptionContract(context.Background(), nil, pd, contract)
	if err != nil {
		t.Fatalf("CheckPRDescriptionContract: %v", err)
	}
	if len(findings) != 1 || findings[0].Line != 2 {
		t.Fatalf("expected 1 finding on line 2 for unannotated //nolint, got %+v", findings)
	}

	// Validate PR subject and required sections.
	longSubject := strings.Repeat("a", 80)
	textFindings := CheckPRDescriptionText(longSubject, "## Summary\nChanged x.", contract)
	if len(textFindings) != 2 {
		t.Fatalf("expected 2 findings (long subject + missing Verification), got %+v", textFindings)
	}

	cleanFindings := CheckPRDescriptionText("feat(qa): add v4 flow schema", "## Summary\nAdded v4.\n\n## Verification\ngo test ./pkg/qa/...", contract)
	if len(cleanFindings) != 0 {
		t.Fatalf("expected 0 findings on valid PR description, got %+v", cleanFindings)
	}
}
