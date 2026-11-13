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

package qa

import (
	"fmt"
	"path"
	"strings"

	"github.com/ai-on-gke/grain/pkg/trustboundary"
)

// BlastTier classifies the deterministic blast radius of a proposed diff at S1/S3.
type BlastTier string

const (
	BlastT0 BlastTier = "T0"
	BlastT1 BlastTier = "T1"
	BlastT2 BlastTier = "T2"
	BlastT3 BlastTier = "T3"
)

// RequiresS4 reports whether tier warrants the 1-round fresh-context S4 verifier on flows with EnableS4.
func (t BlastTier) RequiresS4() bool {
	return t == BlastT2 || t == BlastT3
}

// DiffStats summarizes the deterministic structural footprint of a branch diff.
type DiffStats struct {
	Files                 []string
	NonTestAdded          int
	NonTestDeleted        int
	SiblingCallerPackages int
}

// ClassifyDiffBlast deterministically assigns T0..T3 from touched paths, non-test LOC delta,
// and exported-symbol sibling fan-in without invoking any model.
func ClassifyDiffBlast(stats DiffStats) (BlastTier, []string) {
	if len(stats.Files) == 0 {
		return BlastT0, []string{"empty diff"}
	}

	var normalized []string
	allDocsOrTests := true
	touchesT2Surface := false
	var t2Reasons []string

	for _, raw := range stats.Files {
		f := strings.TrimPrefix(path.Clean(strings.TrimSpace(raw)), "./")
		if f == "" || f == "." {
			continue
		}
		normalized = append(normalized, f)

		if !isDocOrTestFile(f) {
			allDocsOrTests = false
		}
		switch {
		case strings.HasPrefix(f, "pkg/qa/"), f == "pkg/qa":
			return BlastT3, []string{fmt.Sprintf("touches quality control engine (%s)", f)}
		case strings.HasPrefix(f, "pkg/staterepo/"),
			strings.HasPrefix(f, "pkg/declschema/"),
			f == "pkg/model/schema.go",
			f == "pkg/model/migrations.go":
			if !touchesT2Surface {
				touchesT2Surface = true
				t2Reasons = append(t2Reasons, fmt.Sprintf("schema/config surface (%s)", f))
			}
		case strings.HasPrefix(f, "ui/"), strings.HasPrefix(f, "ui-ng/"):
			if !isTestFile(f) && !touchesT2Surface {
				touchesT2Surface = true
				t2Reasons = append(t2Reasons, fmt.Sprintf("UI surface (%s)", f))
			}
		}
	}

	if tbMatches := trustboundary.Classify(normalized); len(tbMatches) > 0 {
		reasons := make([]string, 0, len(tbMatches))
		for _, m := range tbMatches {
			reasons = append(reasons, fmt.Sprintf("trust boundary (%s)", m.Category.ID))
		}
		return BlastT3, reasons
	}

	if stats.SiblingCallerPackages >= 2 {
		touchesT2Surface = true
		t2Reasons = append(t2Reasons, fmt.Sprintf("modified export referenced by %d sibling packages", stats.SiblingCallerPackages))
	}
	nonTestChurn := stats.NonTestAdded + stats.NonTestDeleted
	if nonTestChurn > 250 {
		touchesT2Surface = true
		t2Reasons = append(t2Reasons, fmt.Sprintf("%d non-test lines changed (>250)", nonTestChurn))
	}
	if touchesT2Surface {
		return BlastT2, t2Reasons
	}
	if allDocsOrTests && nonTestChurn == 0 {
		return BlastT0, []string{"docs/tests only"}
	}
	return BlastT1, []string{"single-subsystem change"}
}

func isTestFile(p string) bool {
	return strings.HasSuffix(p, "_test.go") ||
		strings.HasSuffix(p, ".spec.ts") ||
		strings.HasSuffix(p, ".spec.js") ||
		strings.HasSuffix(p, ".test.ts") ||
		strings.HasSuffix(p, ".test.js")
}

func isDocOrTestFile(p string) bool {
	if isTestFile(p) {
		return true
	}
	lower := strings.ToLower(p)
	return strings.HasSuffix(lower, ".md") ||
		strings.HasPrefix(lower, "docs/") ||
		strings.HasPrefix(lower, "design/")
}
