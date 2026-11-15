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
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestBuiltInEngineeringWorkflowV4AndUnchangedExistingHashes(t *testing.T) {
	wantBuiltInHashes := map[string]string{
		"golden-v1-minimal@1":     fmt.Sprintf("builtin:golden-v1-minimal@1#%d", QAEngineRev),
		"golden-v2@1":             fmt.Sprintf("builtin:golden-v2@1#%d", QAEngineRev),
		"golden-v2-checks-only@1": fmt.Sprintf("builtin:golden-v2-checks-only@1#%d", QAEngineRev),
		"golden-v2-skill-only@1":  fmt.Sprintf("builtin:golden-v2-skill-only@1#%d", QAEngineRev),
		"golden-v3@1":             fmt.Sprintf("builtin:golden-v3@1#%d", QAEngineRev),
	}
	for ref, wantHash := range wantBuiltInHashes {
		b, ok := LookupBuiltInOrRegisteredVersion(ref)
		if !ok {
			t.Fatalf("LookupBuiltInOrRegisteredVersion(%q) not found", ref)
		}
		if b.Hash != wantHash {
			t.Fatalf("%s hash = %q, want %q", ref, b.Hash, wantHash)
		}
		prRule, hasRule := b.Resolved.Rule(RulePRDescriptionContract)
		if !hasRule {
			t.Fatalf("%s missing %s in Resolved.Rules", ref, RulePRDescriptionContract)
		}
		if prRule.Enabled || prRule.Severity != "warn" {
			t.Fatalf("%s %s = (enabled=%v, severity=%q), want (false, warn)", ref, RulePRDescriptionContract, prRule.Enabled, prRule.Severity)
		}
	}

	s3Defaults := defaultS3Rules()
	foundDefaultPRRule := false
	for _, r := range s3Defaults {
		if r.ID == RulePRDescriptionContract {
			foundDefaultPRRule = true
			if r.Enabled || r.Severity != "warn" {
				t.Fatalf("defaultS3Rules %s = (enabled=%v, severity=%q), want (false, warn)", RulePRDescriptionContract, r.Enabled, r.Severity)
			}
		}
	}
	if !foundDefaultPRRule {
		t.Fatalf("defaultS3Rules() missing %s", RulePRDescriptionContract)
	}

	v4, ok := LookupBuiltInOrRegisteredVersion("engineering-workflow-v4@1")
	if !ok {
		t.Fatal("LookupBuiltInOrRegisteredVersion(engineering-workflow-v4@1) not found")
	}
	if v4.SchemaVer != FlowSchemaV4 || v4.DeclarationV4 == nil {
		t.Fatalf("engineering-workflow-v4@1 SchemaVer=%q DeclarationV4=%v", v4.SchemaVer, v4.DeclarationV4)
	}
	if !v4.Resolved.HasRule(RulePRDescriptionContract) {
		t.Fatalf("engineering-workflow-v4@1 should enable %s", RulePRDescriptionContract)
	}
	prRule, _ := v4.Resolved.Rule(RulePRDescriptionContract)
	if prRule.Severity != "warn" {
		t.Fatalf("engineering-workflow-v4@1 %s severity = %q, want warn", RulePRDescriptionContract, prRule.Severity)
	}
	if !v4.Resolved.Decompose.Enabled || v4.Resolved.Decompose.Mode != "slice_plan" {
		t.Fatalf("unexpected Decompose on engineering-workflow-v4@1: %+v", v4.Resolved.Decompose)
	}
	if !v4.Resolved.Context.Enabled || !v4.Resolved.Context.IncludeCallers || !v4.Resolved.Context.IncludeMemory {
		t.Fatalf("unexpected Context on engineering-workflow-v4@1: %+v", v4.Resolved.Context)
	}
	if len(v4.Resolved.ReadabilityPacks) != 4 {
		t.Fatalf("len(ReadabilityPacks) = %d, want 4", len(v4.Resolved.ReadabilityPacks))
	}
	if !v4.Resolved.PRContract.Enabled || v4.Resolved.PRContract.MaxSubjectChars != 72 || !v4.Resolved.PRContract.AuditLintSuppressions {
		t.Fatalf("unexpected PRContract on engineering-workflow-v4@1: %+v", v4.Resolved.PRContract)
	}
	if !slices.Equal(v4.Resolved.PRContract.RequiredSections, []string{"Summary", "Verification"}) {
		t.Fatalf("RequiredSections = %v, want [Summary Verification]", v4.Resolved.PRContract.RequiredSections)
	}
	if v4.Resolved.S5MergeTriage.Mode != "shadow" {
		t.Fatalf("S5MergeTriage.Mode = %q, want shadow", v4.Resolved.S5MergeTriage.Mode)
	}
}

func TestBuiltInReadabilityPacksAndActiveCodingGuidance(t *testing.T) {
	for _, id := range []string{"go", "ts-angular", "python", "cpp"} {
		txt := BuiltInReadabilityPackText(id)
		if strings.TrimSpace(txt) == "" {
			t.Fatalf("BuiltInReadabilityPackText(%q) returned empty string", id)
		}
	}
	if got := BuiltInReadabilityPackText("unknown-lang"); got != "" {
		t.Fatalf("BuiltInReadabilityPackText(unknown-lang) = %q, want empty", got)
	}

	v4, ok := LookupBuiltInOrRegisteredVersion("engineering-workflow-v4@1")
	if !ok {
		t.Fatal("engineering-workflow-v4@1 not found")
	}
	spec := v4.Resolved

	goGuidance := spec.ActiveCodingGuidance([]string{"pkg/qa/v4.go"})
	if !strings.Contains(goGuidance, "pack: go") {
		t.Errorf("expected Go pack in guidance for .go file, got:\n%s", goGuidance)
	}
	if strings.Contains(goGuidance, "pack: python") || strings.Contains(goGuidance, "pack: cpp") || strings.Contains(goGuidance, "pack: ts-angular") {
		t.Errorf("unexpected non-Go auto packs in guidance for .go file:\n%s", goGuidance)
	}
	if !strings.Contains(goGuidance, "Summary, Verification") {
		t.Errorf("expected PRContract required sections in guidance:\n%s", goGuidance)
	}

	tsGuidance := spec.ActiveCodingGuidance([]string{"ui-ng/src/app/processes/qa.component.ts", "ui-ng/src/app/processes/qa.component.html"})
	if !strings.Contains(tsGuidance, "pack: ts-angular") || strings.Contains(tsGuidance, "pack: go") {
		t.Errorf("expected only ts-angular pack for .ts/.html paths:\n%s", tsGuidance)
	}

	pyGuidance := spec.ActiveCodingGuidance([]string{"scripts/eval.py"})
	if !strings.Contains(pyGuidance, "pack: python") || strings.Contains(pyGuidance, "pack: go") {
		t.Errorf("expected only python pack for .py path:\n%s", pyGuidance)
	}

	cppGuidance := spec.ActiveCodingGuidance([]string{"native/ring.cc", "native/ring.hpp"})
	if !strings.Contains(cppGuidance, "pack: cpp") || strings.Contains(cppGuidance, "pack: go") {
		t.Errorf("expected only cpp pack for .cc/.hpp paths:\n%s", cppGuidance)
	}

	emptyPathsGuidance := spec.ActiveCodingGuidance(nil)
	if !strings.Contains(emptyPathsGuidance, "pack: go") || !strings.Contains(emptyPathsGuidance, "pack: ts-angular") {
		t.Errorf("expected go and ts-angular packs when targetPaths is empty:\n%s", emptyPathsGuidance)
	}

	// Verify glob activation and 8192-byte hard cap.
	hugeCustom := strings.Repeat("Rule line for cap enforcement. ", 350)
	cappedSpec := spec
	cappedSpec.ReadabilityPacks = []ReadabilityPackDecl{
		{ID: "go", Enabled: true, Activation: "always", CustomText: hugeCustom},
		{ID: "python", Enabled: true, Activation: "glob", Globs: []string{"ml/**/*.py"}, CustomText: "Use strict tensor shape checks."},
	}
	matchedGlobGuidance := cappedSpec.ActiveCodingGuidance([]string{"ml/train/model.py"})
	if len(matchedGlobGuidance) > MaxActiveCodingGuidanceBytes {
		t.Fatalf("ActiveCodingGuidance length = %d, exceeds cap %d", len(matchedGlobGuidance), MaxActiveCodingGuidanceBytes)
	}
	unmatchedGlobSpec := spec
	unmatchedGlobSpec.ReadabilityPacks = []ReadabilityPackDecl{
		{ID: "python", Enabled: true, Activation: "glob", Globs: []string{"ml/**/*.py"}},
	}
	if strings.Contains(unmatchedGlobSpec.ActiveCodingGuidance([]string{"pkg/foo/bar.go"}), "pack: python") {
		t.Fatal("glob pack should not activate on non-matching target path")
	}
}

func TestFlowDeclarationV4StrictDecodeRoundTripAndValidation(t *testing.T) {
	v4, ok := LookupBuiltInOrRegisteredVersion("engineering-workflow-v4@1")
	if !ok || v4.DeclarationV4 == nil {
		t.Fatal("engineering-workflow-v4@1 DeclarationV4 missing")
	}

	// YAML marshal -> ParseFlowDeclarationV4 round-trip.
	yamlBytes, err := yaml.Marshal(v4.DeclarationV4)
	if err != nil {
		t.Fatalf("yaml.Marshal(DeclarationV4): %v", err)
	}
	roundTripYAML, err := ParseFlowDeclarationV4(yamlBytes)
	if err != nil {
		t.Fatalf("ParseFlowDeclarationV4(yamlBytes): %v", err)
	}
	bunFromYAML, err := ResolveFlowDeclarationV4(roundTripYAML, 1, string(yamlBytes), "", false, nil)
	if err != nil {
		t.Fatalf("ResolveFlowDeclarationV4(roundTripYAML): %v", err)
	}

	// JSON marshal -> ResolveAnyFlowDeclaration round-trip.
	jsonBytes, err := json.Marshal(v4.DeclarationV4)
	if err != nil {
		t.Fatalf("json.Marshal(DeclarationV4): %v", err)
	}
	bunFromJSON, err := ResolveAnyFlowDeclaration(jsonBytes, 1, nil)
	if err != nil {
		t.Fatalf("ResolveAnyFlowDeclaration(jsonBytes): %v", err)
	}
	if bunFromYAML.Hash != bunFromJSON.Hash {
		t.Fatalf("YAML vs JSON canonical hash mismatch: %s vs %s", bunFromYAML.Hash, bunFromJSON.Hash)
	}

	// Child V4 flow extending engineering-workflow-v4@1 and ComputeDeclarationDiff vs golden-v3@1.
	childYAML := `schema: grain.dev/qa-flow/v4
key: eng-v4-strict-pr
extends: engineering-workflow-v4@1
stages:
  s0-intent:
    enabled: true
    complexities: [medium, high]
    on-clarification: ask_human
pr-contract:
  enabled: true
  mode: blocking
  max-subject-chars: 68
`
	childBun, err := ResolveAnyFlowDeclaration([]byte(childYAML), 1, nil)
	if err != nil {
		t.Fatalf("ResolveAnyFlowDeclaration(childYAML): %v", err)
	}
	if childBun.Resolved.S0IntentConfig.OnClarification != "ask_human" {
		t.Fatalf("OnClarification = %q, want ask_human", childBun.Resolved.S0IntentConfig.OnClarification)
	}
	if childBun.Resolved.PRContract.Mode != "blocking" || childBun.Resolved.PRContract.MaxSubjectChars != 68 {
		t.Fatalf("unexpected child PRContract: %+v", childBun.Resolved.PRContract)
	}
	if len(childBun.Resolved.ReadabilityPacks) != 4 {
		t.Fatalf("expected child to inherit 4 readability packs, got %d", len(childBun.Resolved.ReadabilityPacks))
	}

	v3, _ := LookupBuiltInOrRegisteredVersion("golden-v3@1")
	diff := ComputeDeclarationDiff(&v3, &v4)
	for _, wantStage := range []string{"s0-decompose", "s1-context", "s3-pr"} {
		if !slices.Contains(diff.AddedStages, wantStage) {
			t.Errorf("ComputeDeclarationDiff(v3, v4) AddedStages=%v, missing %q", diff.AddedStages, wantStage)
		}
	}
	if !slices.Contains(diff.ChangedChecks, RulePRDescriptionContract) {
		t.Errorf("ComputeDeclarationDiff(v3, v4) ChangedChecks=%v, missing %q", diff.ChangedChecks, RulePRDescriptionContract)
	}

	// Invalid V4 declarations must be rejected.
	badCases := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "unknown yaml field",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\nunexpected-field: true\n",
			want: "field unexpected-field not found",
		},
		{
			name: "wrong key case in json",
			raw:  `{"schema":"grain.dev/qa-flow/v4","key":"bad","ReadabilityPacks":[]}`,
			want: "field ReadabilityPacks not found",
		},
		{
			name: "null key in json",
			raw:  `{"schema":"grain.dev/qa-flow/v4","key":null}`,
			want: "key is required",
		},
		{
			name: "invalid on-clarification",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\nstages:\n  s0-intent:\n    enabled: true\n    on-clarification: halt_forever\n",
			want: "invalid s0-intent on-clarification",
		},
		{
			name: "invalid decompose mode",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\ndecompose:\n  enabled: true\n  mode: random_split\n",
			want: "invalid decompose.mode",
		},
		{
			name: "invalid readability activation",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\nreadability-packs:\n  - id: go\n    enabled: true\n    activation: magic\n",
			want: "invalid activation",
		},
		{
			name: "glob activation without globs",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\nreadability-packs:\n  - id: go\n    enabled: true\n    activation: glob\n",
			want: "requires non-empty globs",
		},
		{
			name: "invalid skill-step stage",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\nskill-steps:\n  - id: s1\n    stage: s99\n    enabled: true\n    text: hi\n",
			want: "invalid stage",
		},
		{
			name: "invalid pr-contract mode",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\npr-contract:\n  enabled: true\n  mode: invalid\n",
			want: "invalid pr-contract.mode",
		},
		{
			name: "decompose max-subtasks overflow",
			raw:  "schema: grain.dev/qa-flow/v4\nkey: bad\ndecompose:\n  enabled: true\n  max-subtasks: 100\n",
			want: "out of range",
		},
	}
	for _, tc := range badCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ResolveAnyFlowDeclaration([]byte(tc.raw), 1, nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ResolveAnyFlowDeclaration(%s) err = %v, want substring %q", tc.name, err, tc.want)
			}
		})
	}
}

func TestBuildWorkflowStagesViewAcrossV1ToV4(t *testing.T) {
	wantStages := []struct {
		id    string
		index int
		label string
	}{
		{"s0-decompose", 1, "1 · Goal & Subtask Breakdown"},
		{"s1-context", 2, "2 · Context & Blast Radius"},
		{"s2-plan", 3, "3 · Plan & Fresh Critique"},
		{"s2-coding", 4, "4 · Coding & Readability Rules"},
		{"s3-checks", 5, "5 · Pre-PR Deterministic Gates"},
		{"s3-pr", 6, "6 · PR Authoring & Self-Review"},
		{"s4-verify", 7, "7 · Adversarial Verification"},
		{"s5-triage", 8, "8 · Scorecard & Merge Triage"},
	}

	for _, ref := range []string{"golden-v1-minimal@1", "golden-v2@1", "golden-v3@1", "engineering-workflow-v4@1"} {
		b, ok := LookupBuiltInOrRegisteredVersion(ref)
		if !ok {
			t.Fatalf("LookupBuiltInOrRegisteredVersion(%q) not found", ref)
		}
		stages := BuildWorkflowStagesView(b)
		if len(stages) != 8 {
			t.Fatalf("%s len(stages) = %d, want 8", ref, len(stages))
		}
		for i, want := range wantStages {
			got := stages[i]
			if got.ID != want.id || got.Index != want.index || got.Label != want.label {
				t.Fatalf("%s stage[%d] = (%q, %d, %q), want (%q, %d, %q)",
					ref, i, got.ID, got.Index, got.Label, want.id, want.index, want.label)
			}
			if len(got.Steps) == 0 {
				t.Fatalf("%s stage %s expected non-empty steps", ref, got.ID)
			}
		}
		if ref == "engineering-workflow-v4@1" {
			for _, stg := range stages {
				if !stg.Enabled {
					t.Errorf("engineering-workflow-v4@1 expected stage %d (%s) to be enabled", stg.Index, stg.ID)
				}
			}
		}
	}
}
