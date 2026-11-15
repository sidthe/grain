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
	"fmt"
	"strings"

	"github.com/ai-on-gke/grain/pkg/qa"
)

var lintSuppressionTokens = []string{
	"//nolint",
	"// nolint",
	"eslint-disable",
	"# noqa",
	"// NOLINT",
}

// CheckPRDescriptionContract audits newly added lint-suppression directives in pd
// when RulePRDescriptionContract is enabled.
func CheckPRDescriptionContract(_ context.Context, _ WorkspaceReader, pd ParsedDiff, contract qa.PRContractDecl) ([]Finding, error) {
	var findings []Finding
	auditLint := contract.AuditLintSuppressions || !contract.Enabled
	if !auditLint {
		return nil, nil
	}
	sev := contract.Mode
	if sev != "blocking" && sev != "warn" && sev != "shadow" {
		sev = "warn"
	}

	for _, df := range pd.Files {
		if df.IsDeleted {
			continue
		}
		p := df.EffectivePath()
		if isTestPath(p) {
			continue
		}
		for _, al := range df.AddedLines {
			trimmed := strings.TrimSpace(al.Text)
			for _, tok := range lintSuppressionTokens {
				pos := strings.Index(trimmed, tok)
				if pos < 0 {
					continue
				}
				after := strings.TrimSpace(trimmed[pos+len(tok):])
				// Require an inline justification comment or reason after the suppression directive.
				if !hasLintSuppressionReason(after) {
					findings = append(findings, Finding{
						RuleID:   qa.RulePRDescriptionContract,
						Stage:    "S3",
						Severity: sev,
						FilePath: p,
						Line:     al.Line,
						Summary:  fmt.Sprintf("Unannotated lint suppression %q added without inline justification.", tok),
						Evidence: trimmed,
					})
				}
				break
			}
		}
	}
	return findings, nil
}

func hasLintSuppressionReason(after string) bool {
	if after == "" {
		return false
	}
	// Accept reasons introduced by "//", "--", or a descriptive text after ":".
	if strings.Contains(after, "//") || strings.Contains(after, "--") {
		return true
	}
	if strings.HasPrefix(after, ":") {
		rest := strings.TrimSpace(strings.TrimPrefix(after, ":"))
		if strings.Contains(rest, " ") && len(rest) >= 8 {
			return true
		}
	}
	return false
}

// CheckPRDescriptionText validates a pull request subject and body against a PRContractDecl.
func CheckPRDescriptionText(subject, body string, contract qa.PRContractDecl) []Finding {
	if !contract.Enabled || contract.Mode == "off" {
		return nil
	}
	sev := contract.Mode
	if sev != "blocking" && sev != "warn" && sev != "shadow" {
		sev = "warn"
	}
	var findings []Finding
	subj := strings.TrimSpace(subject)
	maxChars := contract.MaxSubjectChars
	if maxChars <= 0 {
		maxChars = 72
	}
	if len(subj) > maxChars {
		findings = append(findings, Finding{
			RuleID:   qa.RulePRDescriptionContract,
			Stage:    "S3",
			Severity: sev,
			Summary:  fmt.Sprintf("PR subject is %d characters, exceeding max-subject-chars %d.", len(subj), maxChars),
			Evidence: subj,
		})
	}
	lowerBody := strings.ToLower(body)
	for _, sec := range contract.RequiredSections {
		secTrimmed := strings.TrimSpace(sec)
		if secTrimmed == "" {
			continue
		}
		target := strings.ToLower(secTrimmed)
		if !strings.Contains(lowerBody, "## "+target) &&
			!strings.Contains(lowerBody, "### "+target) &&
			!strings.Contains(lowerBody, target+":") &&
			!strings.Contains(lowerBody, "**"+target+"**") {
			findings = append(findings, Finding{
				RuleID:   qa.RulePRDescriptionContract,
				Stage:    "S3",
				Severity: sev,
				Summary:  fmt.Sprintf("PR description is missing required section %q.", secTrimmed),
			})
		}
	}
	return findings
}
