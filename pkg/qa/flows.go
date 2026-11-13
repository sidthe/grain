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
	"bytes"
	"fmt"
	"slices"
	"strings"

	"github.com/ai-on-gke/grain/pkg/model"
	v1 "github.com/ai-on-gke/grain/pkg/qa/golden/v1"
	"gopkg.in/yaml.v3"
)

// Built-in deterministic pre-PR S3 rule identifiers.
const (
	RuleTestIntegrityGuard   = "golden:test-integrity-guard"
	RuleStrictConfigDecoder  = "golden:strict-config-decoder"
	RuleSiblingExportHazard  = "golden:sibling-export-hazard"
	RuleUIBudgetAndSpecFloor = "golden:ui-budget-and-spec-floor"
	RuleS4OrthogonalVerifier = "golden:s4-orthogonal-verifier"
)

// RepoFlowCandidatePaths lists the in-tree YAML paths consulted when flowId is "repo-custom".
var RepoFlowCandidatePaths = []string{
	".grain/qa-flow.yml",
	".grain/qa/flow.yml",
}

// RuleSpec describes one deterministic (S3) or fresh-context semantic (S4) rule in a QA flow.
type RuleSpec struct {
	ID          string   `json:"id" yaml:"id"`
	Label       string   `json:"label" yaml:"label"`
	Stage       string   `json:"stage" yaml:"stage"`
	Severity    string   `json:"severity" yaml:"severity"`
	Summary     string   `json:"summary" yaml:"summary"`
	TargetPaths []string `json:"targetPaths" yaml:"target-paths"`
	Enabled     bool     `json:"enabled" yaml:"enabled"`
}

// FlowSpec describes a quality control flow package executable by the Grain QA engine.
type FlowSpec struct {
	ID                 string     `json:"id" yaml:"id"`
	Label              string     `json:"label" yaml:"label"`
	Summary            string     `json:"summary" yaml:"summary"`
	InjectSkill        bool       `json:"injectSkill" yaml:"inject-skill"`
	SkillBytes         int        `json:"skillBytes" yaml:"-"`
	StopNudge          bool       `json:"stopNudge" yaml:"stop-nudge"`
	StagingIsolation   bool       `json:"stagingIsolation" yaml:"staging-isolation"`
	EnableS4           bool       `json:"enableS4" yaml:"enable-s4"`
	MaxS4RepairRounds  int        `json:"maxS4RepairRounds" yaml:"max-s4-repair-rounds"`
	StrictDecoderPaths []string   `json:"strictDecoderPaths,omitempty" yaml:"strict-decoder-paths,omitempty"`
	Rules              []RuleSpec `json:"rules" yaml:"rules"`
}

// SkillPrompt returns the embedded coding-time skill text when InjectSkill is true.
func (f FlowSpec) SkillPrompt() string {
	if !f.InjectSkill {
		return ""
	}
	return strings.TrimSpace(v1.SkillMarkdown)
}

// HasRule reports whether ruleID is enabled in f.
func (f FlowSpec) HasRule(ruleID string) bool {
	for _, r := range f.Rules {
		if r.ID == ruleID {
			return r.Enabled
		}
	}
	return false
}

func defaultS3Rules() []RuleSpec {
	return []RuleSpec{
		{
			ID:          RuleTestIntegrityGuard,
			Label:       "Test integrity & non-tautological assertion guard",
			Stage:       "S3",
			Severity:    "blocking",
			Summary:     "Blocks net test file deletion, unannotated skips or focused tests, net test-case drops alongside production edits, and newly added tests with zero failure or assertion calls across recursive subtests and helpers.",
			TargetPaths: []string{"**/*_test.go", "**/*.spec.ts", "**/*.spec.js"},
			Enabled:     true,
		},
		{
			ID:          RuleStrictConfigDecoder,
			Label:       "Strict YAML/JSON configuration decoder",
			Stage:       "S3",
			Severity:    "blocking",
			Summary:     "Requires KnownFields(true) or DisallowUnknownFields() on YAML/JSON config and declaration decoders so misspelled or unknown keys never drop silently.",
			TargetPaths: []string{"pkg/**/*.go", "internal/**/*.go", "cmd/**/*.go"},
			Enabled:     true,
		},
		{
			ID:          RuleSiblingExportHazard,
			Label:       "Sibling-package caller sweep hazard check",
			Stage:       "S3",
			Severity:    "blocking",
			Summary:     "Detects modified exported Go/TypeScript signatures and struct fields referenced by untouched sibling packages, surfacing exact file:line call sites once before PR creation unless updated or explained via caller_notes.",
			TargetPaths: []string{"**/*.go", "**/*.ts"},
			Enabled:     true,
		},
		{
			ID:          RuleUIBudgetAndSpecFloor,
			Label:       "UI style ratchet, lazy-route & spec floor",
			Stage:       "S3",
			Severity:    "blocking",
			Summary:     "Enforces angular.json component style budgets via a non-regressing size ratchet, blocks new eager feature imports in app.component.ts, and requires unit spec files for newly added Angular components.",
			TargetPaths: []string{"ui/**", "ui-ng/**"},
			Enabled:     true,
		},
	}
}

func s4Rule(enabled bool) RuleSpec {
	return RuleSpec{
		ID:          RuleS4OrthogonalVerifier,
		Label:       "Fresh-context orthogonal diff verifier + 6-filter Inquisitor",
		Stage:       "S4",
		Severity:    "blocking",
		Summary:     "Runs at most 1 fresh-context read-only verification pass on T2/T3 cross-package, schema, UI, or trust-boundary diffs with zero author CoT, filtering findings through deterministic diff-hunk grounding and 6 anti-theater rules.",
		TargetPaths: []string{"T2/T3 high-blast diffs"},
		Enabled:     enabled,
	}
}

// BuiltInFlows returns the canonical quality control flow packages shipped with Grain.
func BuiltInFlows() []FlowSpec {
	skillLen := len(strings.TrimSpace(v1.SkillMarkdown))
	goldenRules := append(defaultS3Rules(), s4Rule(true))
	s3OnlyRules := append(defaultS3Rules(), s4Rule(false))
	customRules := append(defaultS3Rules(), s4Rule(true))

	return []FlowSpec{
		{
			ID:                model.QAFlowGoldenV1Minimal,
			Label:             "golden-v1-minimal (Recommended)",
			Summary:           "270-token coding contract, staging-ref isolation, 4 sub-second deterministic AST/diff gates (S3), and 1-round fresh-context T2/T3 verifier (S4).",
			InjectSkill:       true,
			SkillBytes:        skillLen,
			StopNudge:         true,
			StagingIsolation:  true,
			EnableS4:          true,
			MaxS4RepairRounds: 1,
			Rules:             goldenRules,
		},
		{
			ID:                model.QAFlowDeterministicS3Only,
			Label:             "deterministic-s3-only (Zero-LLM Ablation)",
			Summary:           "Runs only the 4 pure-Go deterministic S3 AST/diff checks and staging-ref isolation with zero prompt injection and zero LLM verifier tokens.",
			InjectSkill:       false,
			SkillBytes:        0,
			StopNudge:         true,
			StagingIsolation:  true,
			EnableS4:          false,
			MaxS4RepairRounds: 0,
			Rules:             s3OnlyRules,
		},
		{
			ID:                model.QAFlowRepoCustom,
			Label:             "repo-custom (.grain/qa-flow.yml)",
			Summary:           "Applies tighten-only repository overrides from .grain/qa-flow.yml on top of golden-v1-minimal without weakening trust-boundary floors.",
			InjectSkill:       true,
			SkillBytes:        skillLen,
			StopNudge:         true,
			StagingIsolation:  true,
			EnableS4:          true,
			MaxS4RepairRounds: 1,
			Rules:             customRules,
		},
	}
}

// LookupFlow returns the FlowSpec for id, falling back to golden-v1-minimal when id is empty.
func LookupFlow(id string) (FlowSpec, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		id = model.DefaultQAFlowID
	}
	for _, f := range BuiltInFlows() {
		if f.ID == id {
			return f, true
		}
	}
	return FlowSpec{}, false
}

// repoFlowOverlay is the strict YAML schema accepted in .grain/qa-flow.yml.
// Overlay rules are tighten-only on mandatory S3 integrity gates and T3 trust boundaries.
type repoFlowOverlay struct {
	Base               string   `yaml:"base"`
	InjectSkill        *bool    `yaml:"inject-skill"`
	EnableS4           *bool    `yaml:"enable-s4"`
	StrictDecoderPaths []string `yaml:"strict-decoder-paths"`
	DisableRules       []string `yaml:"disable-rules"`
}

// ParseRepoFlowYAML parses a repository .grain/qa-flow.yml overlay strictly (KnownFields(true)),
// rejecting unknown keys and refusing to disable core test-integrity or strict-decoder floors.
func ParseRepoFlowYAML(raw []byte) (FlowSpec, error) {
	base, _ := LookupFlow(model.QAFlowGoldenV1Minimal)
	base.ID = model.QAFlowRepoCustom
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return base, nil
	}

	var overlay repoFlowOverlay
	dec := yaml.NewDecoder(bytes.NewReader(trimmed))
	dec.KnownFields(true)
	if err := dec.Decode(&overlay); err != nil {
		return FlowSpec{}, fmt.Errorf("qa: parsing .grain/qa-flow.yml: %w", err)
	}
	if b := strings.TrimSpace(overlay.Base); b != "" && b != model.QAFlowGoldenV1Minimal {
		return FlowSpec{}, fmt.Errorf("qa: unsupported or weaker base flow %q in .grain/qa-flow.yml (only %q allowed)", b, model.QAFlowGoldenV1Minimal)
	}
	if overlay.InjectSkill != nil {
		base.InjectSkill = *overlay.InjectSkill
		if !base.InjectSkill {
			base.SkillBytes = 0
		}
	}
	if overlay.EnableS4 != nil {
		if !*overlay.EnableS4 {
			return FlowSpec{}, fmt.Errorf("qa: enable-s4 cannot be disabled in .grain/qa-flow.yml (tighten-only floor)")
		}
		base.EnableS4 = true
		if base.MaxS4RepairRounds < 1 {
			base.MaxS4RepairRounds = 1
		}
	}
	for _, p := range overlay.StrictDecoderPaths {
		p = strings.TrimSpace(p)
		if p != "" && !slices.Contains(base.StrictDecoderPaths, p) {
			base.StrictDecoderPaths = append(base.StrictDecoderPaths, p)
		}
	}
	for _, dis := range overlay.DisableRules {
		dis = strings.TrimSpace(dis)
		if dis == RuleTestIntegrityGuard || dis == RuleStrictConfigDecoder {
			return FlowSpec{}, fmt.Errorf("qa: rule %q is a mandatory floor and cannot be disabled in .grain/qa-flow.yml", dis)
		}
		for i := range base.Rules {
			if base.Rules[i].ID == dis {
				base.Rules[i].Enabled = false
			}
		}
	}
	return base, nil
}
