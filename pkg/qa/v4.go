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
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// FlowSchemaV4 identifies the v4 declarative 8-stage QA workflow package format.
const FlowSchemaV4 = "grain.dev/qa-flow/v4"

// MaxActiveCodingGuidanceBytes caps the combined coding + readability + skill steps + PR contract prompt.
const MaxActiveCodingGuidanceBytes = 8192

// DecomposeDecl configures Stage 1 (s0-decompose) task decomposition and slicing.
type DecomposeDecl struct {
	Enabled         bool     `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	Mode            string   `json:"mode,omitempty" yaml:"mode,omitempty"`
	Complexities    []string `json:"complexities,omitempty" yaml:"complexities,omitempty"`
	MaxSubtasks     int      `json:"maxSubtasks,omitempty" yaml:"max-subtasks,omitempty"`
	TargetDiffLines int      `json:"targetDiffLines,omitempty" yaml:"target-diff-lines,omitempty"`
}

// ContextDiscoveryDecl configures Stage 2 (s1-context) caller and memory context discovery.
type ContextDiscoveryDecl struct {
	Enabled        bool     `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	IncludeCallers bool     `json:"includeCallers,omitempty" yaml:"include-callers,omitempty"`
	IncludeMemory  bool     `json:"includeMemory,omitempty" yaml:"include-memory,omitempty"`
	MaxTokens      int      `json:"maxTokens,omitempty" yaml:"max-tokens,omitempty"`
	ExtraPaths     []string `json:"extraPaths,omitempty" yaml:"extra-paths,omitempty"`
}

// ReadabilityPackDecl configures a portable language readability pack in Stage 4 (s2-coding).
type ReadabilityPackDecl struct {
	ID         string   `json:"id" yaml:"id"`
	Enabled    bool     `json:"enabled" yaml:"enabled"`
	Activation string   `json:"activation,omitempty" yaml:"activation,omitempty"`
	Globs      []string `json:"globs,omitempty" yaml:"globs,omitempty"`
	CustomText string   `json:"customText,omitempty" yaml:"custom-text,omitempty"`
}

// SkillStepDecl configures a modular stage-scoped skill instruction step in a V4 workflow.
type SkillStepDecl struct {
	ID       string   `json:"id" yaml:"id"`
	Label    string   `json:"label,omitempty" yaml:"label,omitempty"`
	Stage    string   `json:"stage" yaml:"stage"`
	Enabled  bool     `json:"enabled" yaml:"enabled"`
	Globs    []string `json:"globs,omitempty" yaml:"globs,omitempty"`
	MaxBytes int      `json:"maxBytes,omitempty" yaml:"max-bytes,omitempty"`
	Text     string   `json:"text,omitempty" yaml:"text,omitempty"`
}

// PRContractDecl configures Stage 6 (s3-pr) pull request authoring and lint-suppression auditing.
type PRContractDecl struct {
	Enabled               bool     `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	Mode                  string   `json:"mode,omitempty" yaml:"mode,omitempty"`
	MaxSubjectChars       int      `json:"maxSubjectChars,omitempty" yaml:"max-subject-chars,omitempty"`
	RequiredSections      []string `json:"requiredSections,omitempty" yaml:"required-sections,omitempty"`
	AuditLintSuppressions bool     `json:"auditLintSuppressions,omitempty" yaml:"audit-lint-suppressions,omitempty"`
	GuidanceText          string   `json:"guidanceText,omitempty" yaml:"guidance-text,omitempty"`
}

// FlowDeclarationV4 is the declarative grain.dev/qa-flow/v4 specification.
type FlowDeclarationV4 struct {
	Schema           string                `json:"schema" yaml:"schema"`
	Key              string                `json:"key" yaml:"key"`
	Extends          string                `json:"extends,omitempty" yaml:"extends,omitempty"`
	Label            string                `json:"label,omitempty" yaml:"label,omitempty"`
	Summary          string                `json:"summary,omitempty" yaml:"summary,omitempty"`
	StopNudge        *bool                 `json:"stopNudge,omitempty" yaml:"stop-nudge,omitempty"`
	StagingIsolation *bool                 `json:"stagingIsolation,omitempty" yaml:"staging-isolation,omitempty"`
	Decompose        DecomposeDecl         `json:"decompose,omitempty" yaml:"decompose,omitempty"`
	Context          ContextDiscoveryDecl  `json:"context,omitempty" yaml:"context,omitempty"`
	Skills           V3SkillsDecl          `json:"skills,omitempty" yaml:"skills,omitempty"`
	ReadabilityPacks []ReadabilityPackDecl `json:"readabilityPacks,omitempty" yaml:"readability-packs,omitempty"`
	SkillSteps       []SkillStepDecl       `json:"skillSteps,omitempty" yaml:"skill-steps,omitempty"`
	Stages           V3StagesDecl          `json:"stages,omitempty" yaml:"stages,omitempty"`
	PRContract       PRContractDecl        `json:"prContract,omitempty" yaml:"pr-contract,omitempty"`
	Checks           map[string]CheckDecl  `json:"checks,omitempty" yaml:"checks,omitempty"`
	CustomChecks     []CustomCheckDecl     `json:"custom-checks,omitempty" yaml:"custom-checks,omitempty"`
	Verifier         VerifierDecl          `json:"verifier,omitempty" yaml:"verifier,omitempty"`
}

// WorkflowStageView represents one of the 8 canonical lifecycle stages in the QA workflow projection.
type WorkflowStageView struct {
	ID       string             `json:"id"`
	Index    int                `json:"index"`
	Label    string             `json:"label"`
	Boundary string             `json:"boundary"`
	Enabled  bool               `json:"enabled"`
	Mode     string             `json:"mode"`
	Summary  string             `json:"summary"`
	Steps    []WorkflowStepView `json:"steps"`
}

// WorkflowStepView represents an individual rule, skill, readability pack, or gate inside a WorkflowStageView.
type WorkflowStepView struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Kind        string `json:"kind"`
	StageID     string `json:"stageId"`
	Enabled     bool   `json:"enabled"`
	Mode        string `json:"mode,omitempty"`
	Scope       string `json:"scope,omitempty"`
	LockedFloor bool   `json:"lockedFloor,omitempty"`
	Summary     string `json:"summary,omitempty"`
	Text        string `json:"text,omitempty"`
	Bytes       int    `json:"bytes,omitempty"`
}

const engineeringWorkflowV4YAML = `schema: grain.dev/qa-flow/v4
key: engineering-workflow-v4
extends: golden-v3@1
label: engineering workflow v4 (8-stage lifecycle + readability + PR contract)
summary: >
  End-to-end 8-stage software engineering workflow combining goal decomposition,
  caller & memory context discovery, fresh plan critique, portable language readability packs
  (Go, TypeScript/Angular, Python, C++), deterministic pre-PR gates, PR description & lint-suppression
  contract, orthogonal S4 verification, and ComposeTightenOnly S5 merge triage.

decompose:
  enabled: true
  mode: slice_plan
  complexities: [high]
  max-subtasks: 5
  target-diff-lines: 400

context:
  enabled: true
  include-callers: true
  include-memory: true
  max-tokens: 12000
  extra-paths: ["pkg/**", "ui-ng/src/**"]

readability-packs:
  - id: go
    enabled: true
    activation: auto
  - id: ts-angular
    enabled: true
    activation: auto
  - id: python
    enabled: true
    activation: auto
  - id: cpp
    enabled: true
    activation: auto

skill-steps:
  - id: step:caller-sweep
    label: Sibling caller & route registration sweep
    stage: coding
    enabled: true
    max-bytes: 600
    text: |
      Before finalizing edits to exported types, functions, or routes, verify all sibling-package
      callers by import path and keep route/schema tables synchronized.
  - id: step:pr-self-review
    label: Pre-PR diff & test self-audit
    stage: pr
    enabled: true
    max-bytes: 600
    text: |
      Review git diff against base before opening a pull request: remove stray debug output,
      justify any lint suppression inline, and verify tests fail without the fix.

stages:
  s0-intent:
    enabled: true
    complexities: [medium, high]
    max-seconds: 30
    max-tokens: 15000
    on-clarification: warn
  s2-plan-critic:
    enabled: true
    complexities: [medium, high]
    tiers: [T2, T3]
    max-seconds: 45
    max-tokens: 25000
    max-bounces: 1
  s5-merge-triage:
    mode: shadow
    auto-merge-tiers: [T0, T1]
    require-human-tiers: [T2, T3]

pr-contract:
  enabled: true
  mode: warn
  max-subject-chars: 72
  required-sections: ["Summary", "Verification"]
  audit-lint-suppressions: true
  guidance-text: |
    Write a concise Conventional Commit subject (<= 72 chars) and structure the PR body with
    explicit Summary and Verification sections. Never add unannotated lint suppressions.

checks:
  golden:test-integrity-guard: {}
  golden:strict-config-decoder: {}
  golden:sibling-export-hazard: {severity: warn, params: {resolve: import-path}}
  golden:ui-budget-and-spec-floor: {enabled: true}
  golden:exported-surface-delta: {severity: warn}
  golden:test-hygiene: {severity: warn}
  golden:mutation-hardening: {severity: warn, params: {mutants: 25, max-seconds: 60}}
  golden:boundary-fuzz: {severity: warn, params: {max-seconds: 15}}
  golden:pr-description-contract: {enabled: true, severity: warn}
`

// BuiltInReadabilityPackIDs returns the ordered list of built-in readability pack identifiers.
func BuiltInReadabilityPackIDs() []string {
	return []string{"go", "ts-angular", "python", "cpp"}
}

// BuiltInReadabilityPackText returns the portable, public-safe engineering readability rules for id.
func BuiltInReadabilityPackText(id string) string {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "go":
		return `Go readability rules (pack: go):
- Return errors with actionable context (fmt.Errorf("pkg: operation: %w", err)); never ignore returned errors silently.
- Accept interfaces at consumer boundaries and return concrete types; keep package names short, lowercase, single-word nouns without stutter.
- Thread context.Context as the first parameter on I/O and blocking calls; guard shared state with explicit synchronization and ensure goroutines exit on cancellation.
- Prefer table-driven subtests (t.Run) with deterministic assertions and zero time.Sleep synchronization.`
	case "ts-angular":
		return `TypeScript & Angular readability rules (pack: ts-angular):
- Build standalone Angular components with ChangeDetectionStrategy.OnPush, signal()/computed() state, and native @if/@for template control flow.
- Keep templates declarative without side effects; enforce strict TypeScript types and avoid any or unsafe non-null assertions.
- Clean up subscriptions with takeUntilDestroyed(); keep component styles within budget and provide ARIA labels and keyboard navigation on interactive elements.`
	case "python":
		return `Python readability rules (pack: python):
- Annotate public functions, methods, and data structures (dataclass or TypedDict) with explicit PEP 484 type hints.
- Never use mutable default arguments (use None and initialize inside the function); catch specific exception subclasses rather than bare except.
- Manage files, locks, and network sessions with context managers (with); prefer pathlib.Path and clear generator/comprehension expressions.`
	case "cpp":
		return `C++ readability rules (pack: cpp):
- Manage resource lifetime deterministically via RAII (std::unique_ptr, scoped locks/handles); avoid raw owning new and delete.
- Pass read-only non-primitive arguments by const reference, std::string_view, or std::span<const T>; mark single-argument constructors explicit.
- Validate container bounds and integer overflow/wraparound before indexing or arithmetic; keep headers self-contained with minimal transitive includes.`
	default:
		return ""
	}
}

func readabilityPackLabel(id string) string {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "go":
		return "Go Readability Pack"
	case "ts-angular":
		return "TypeScript & Angular Readability Pack"
	case "python":
		return "Python Readability Pack"
	case "cpp":
		return "C++ Readability Pack"
	default:
		return "Readability Pack (" + id + ")"
	}
}

// ParseFlowDeclarationV4 strictly decodes YAML or JSON into a FlowDeclarationV4 (KnownFields(true)).
func ParseFlowDeclarationV4(raw []byte) (FlowDeclarationV4, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return FlowDeclarationV4{}, fmt.Errorf("qa: empty flow declaration")
	}
	normalized, err := normalizeFlowDeclarationInput(trimmed)
	if err != nil {
		return FlowDeclarationV4{}, err
	}
	var decl FlowDeclarationV4
	dec := yaml.NewDecoder(bytes.NewReader(normalized))
	dec.KnownFields(true)
	if err := dec.Decode(&decl); err != nil {
		return FlowDeclarationV4{}, fmt.Errorf("qa: parsing flow declaration v4: %w", err)
	}
	if decl.Schema == "" {
		decl.Schema = FlowSchemaV4
	}
	if decl.Schema != FlowSchemaV4 {
		return FlowDeclarationV4{}, fmt.Errorf("qa: unsupported flow schema %q (want %q)", decl.Schema, FlowSchemaV4)
	}
	if strings.TrimSpace(decl.Key) == "" {
		return FlowDeclarationV4{}, fmt.Errorf("qa: flow key is required")
	}
	return decl, nil
}

// ResolveFlowDeclarationV4 resolves inheritance, validates V4 stage/readability/PR-contract fields,
// materializes defaults, and computes the canonical SHA-256 hash.
func ResolveFlowDeclarationV4(decl FlowDeclarationV4, version int, sourceYAML string, explicitParentHash string, builtIn bool, lookup ParentLookupFunc) (FlowVersionBundle, error) {
	if decl.Schema == "" {
		decl.Schema = FlowSchemaV4
	}
	if decl.Schema != FlowSchemaV4 {
		return FlowVersionBundle{}, fmt.Errorf("qa: unsupported schema %q (want %q)", decl.Schema, FlowSchemaV4)
	}
	if strings.TrimSpace(decl.Key) == "" {
		return FlowVersionBundle{}, fmt.Errorf("qa: flow key is required")
	}

	effectiveLookup := func(ref string) (FlowVersionBundle, bool) {
		if lookup != nil {
			if b, ok := lookup(ref); ok {
				return b, true
			}
		}
		return LookupBuiltInOrRegisteredVersion(ref)
	}

	// Inherit V4 fields when extending a V4 parent.
	if ext := strings.TrimSpace(decl.Extends); ext != "" {
		if parent, ok := effectiveLookup(ext); ok && parent.DeclarationV4 != nil {
			pv4 := parent.DeclarationV4
			if !decl.Decompose.Enabled && decl.Decompose.Mode == "" && len(decl.Decompose.Complexities) == 0 && decl.Decompose.MaxSubtasks == 0 && decl.Decompose.TargetDiffLines == 0 {
				decl.Decompose = pv4.Decompose
				decl.Decompose.Complexities = slices.Clone(pv4.Decompose.Complexities)
			}
			if !decl.Context.Enabled && !decl.Context.IncludeCallers && !decl.Context.IncludeMemory && decl.Context.MaxTokens == 0 && len(decl.Context.ExtraPaths) == 0 {
				decl.Context = pv4.Context
				decl.Context.ExtraPaths = slices.Clone(pv4.Context.ExtraPaths)
			}
			if len(decl.ReadabilityPacks) == 0 && len(pv4.ReadabilityPacks) > 0 {
				decl.ReadabilityPacks = make([]ReadabilityPackDecl, len(pv4.ReadabilityPacks))
				for i, p := range pv4.ReadabilityPacks {
					p.Globs = slices.Clone(p.Globs)
					decl.ReadabilityPacks[i] = p
				}
			}
			if len(decl.SkillSteps) == 0 && len(pv4.SkillSteps) > 0 {
				decl.SkillSteps = make([]SkillStepDecl, len(pv4.SkillSteps))
				for i, s := range pv4.SkillSteps {
					s.Globs = slices.Clone(s.Globs)
					decl.SkillSteps[i] = s
				}
			}
			if !decl.PRContract.Enabled && decl.PRContract.Mode == "" && decl.PRContract.MaxSubjectChars == 0 && len(decl.PRContract.RequiredSections) == 0 && !decl.PRContract.AuditLintSuppressions && decl.PRContract.GuidanceText == "" {
				decl.PRContract = pv4.PRContract
				decl.PRContract.RequiredSections = slices.Clone(pv4.PRContract.RequiredSections)
			} else if decl.PRContract.Enabled || (decl.PRContract.Mode != "" && decl.PRContract.Mode != "off") {
				if decl.PRContract.MaxSubjectChars == 0 {
					decl.PRContract.MaxSubjectChars = pv4.PRContract.MaxSubjectChars
				}
				if len(decl.PRContract.RequiredSections) == 0 {
					decl.PRContract.RequiredSections = slices.Clone(pv4.PRContract.RequiredSections)
				}
				if decl.PRContract.GuidanceText == "" {
					decl.PRContract.GuidanceText = pv4.PRContract.GuidanceText
				}
			}
		}
	}

	// Validate DecomposeDecl.
	if dm := strings.TrimSpace(decl.Decompose.Mode); dm != "" && dm != "off" && dm != "slice_plan" && dm != "propose_dag" {
		return FlowVersionBundle{}, fmt.Errorf("qa: invalid decompose.mode %q (want off, slice_plan, or propose_dag)", dm)
	}
	if decl.Decompose.Enabled && strings.TrimSpace(decl.Decompose.Mode) == "" {
		decl.Decompose.Mode = "slice_plan"
	}
	if decl.Decompose.MaxSubtasks < 0 || decl.Decompose.MaxSubtasks > 32 {
		return FlowVersionBundle{}, fmt.Errorf("qa: decompose.max-subtasks %d out of range [0,32]", decl.Decompose.MaxSubtasks)
	}
	if decl.Decompose.TargetDiffLines < 0 || decl.Decompose.TargetDiffLines > 20000 {
		return FlowVersionBundle{}, fmt.Errorf("qa: decompose.target-diff-lines %d out of range [0,20000]", decl.Decompose.TargetDiffLines)
	}

	// Validate ContextDiscoveryDecl.
	if decl.Context.MaxTokens < 0 || decl.Context.MaxTokens > MaxVerifierTokensCap {
		return FlowVersionBundle{}, fmt.Errorf("qa: context.max-tokens %d out of range [0,%d]", decl.Context.MaxTokens, MaxVerifierTokensCap)
	}

	// Validate ReadabilityPacks.
	for i := range decl.ReadabilityPacks {
		rp := &decl.ReadabilityPacks[i]
		rp.ID = strings.TrimSpace(rp.ID)
		if rp.ID == "" {
			return FlowVersionBundle{}, fmt.Errorf("qa: readability-packs[%d].id is required", i)
		}
		rp.CustomText = normalizeSkillText(rp.CustomText)
		if BuiltInReadabilityPackText(rp.ID) == "" && rp.CustomText == "" {
			return FlowVersionBundle{}, fmt.Errorf("qa: unknown readability pack %q without custom-text", rp.ID)
		}
		act := strings.TrimSpace(rp.Activation)
		if act == "" {
			act = "auto"
		}
		if act != "auto" && act != "always" && act != "glob" {
			return FlowVersionBundle{}, fmt.Errorf("qa: readability pack %q has invalid activation %q (want auto, always, or glob)", rp.ID, act)
		}
		if act == "glob" && rp.Enabled && len(rp.Globs) == 0 {
			return FlowVersionBundle{}, fmt.Errorf("qa: readability pack %q with activation=glob requires non-empty globs", rp.ID)
		}
		rp.Activation = act
	}

	// Validate SkillSteps.
	for i := range decl.SkillSteps {
		st := &decl.SkillSteps[i]
		st.ID = strings.TrimSpace(st.ID)
		if st.ID == "" {
			return FlowVersionBundle{}, fmt.Errorf("qa: skill-steps[%d].id is required", i)
		}
		stg := strings.TrimSpace(st.Stage)
		if stg != "s0" && stg != "s2" && stg != "coding" && stg != "pr" && stg != "s4" {
			return FlowVersionBundle{}, fmt.Errorf("qa: skill-step %q has invalid stage %q (want s0, s2, coding, pr, or s4)", st.ID, stg)
		}
		st.Stage = stg
		st.Text = normalizeSkillText(st.Text)
		capB := st.MaxBytes
		if capB <= 0 {
			capB = MaxSkillBytesCap
		}
		if capB > MaxSkillBytesCap {
			return FlowVersionBundle{}, fmt.Errorf("qa: skill-step %q max-bytes %d exceeds maximum %d", st.ID, capB, MaxSkillBytesCap)
		}
		if len(st.Text) > capB {
			return FlowVersionBundle{}, fmt.Errorf("qa: skill-step %q text (%d bytes) exceeds max-bytes %d", st.ID, len(st.Text), capB)
		}
	}

	// Validate PRContractDecl.
	prm := strings.TrimSpace(decl.PRContract.Mode)
	if prm != "" && prm != "off" && prm != "warn" && prm != "blocking" {
		return FlowVersionBundle{}, fmt.Errorf("qa: invalid pr-contract.mode %q (want off, warn, or blocking)", prm)
	}
	if decl.PRContract.Enabled && prm == "" {
		prm = "warn"
	}
	decl.PRContract.Mode = prm
	if decl.PRContract.MaxSubjectChars < 0 || decl.PRContract.MaxSubjectChars > 500 {
		return FlowVersionBundle{}, fmt.Errorf("qa: pr-contract.max-subject-chars %d out of range [0,500]", decl.PRContract.MaxSubjectChars)
	}
	if decl.PRContract.Enabled && decl.PRContract.MaxSubjectChars == 0 {
		decl.PRContract.MaxSubjectChars = 72
	}
	decl.PRContract.GuidanceText = normalizeSkillText(decl.PRContract.GuidanceText)

	// Ensure golden:pr-description-contract check mirrors PRContract when enabled and not explicitly overridden.
	if decl.PRContract.Enabled && decl.PRContract.Mode != "off" {
		if decl.Checks == nil {
			decl.Checks = make(map[string]CheckDecl)
		}
		if _, exists := decl.Checks[RulePRDescriptionContract]; !exists {
			sev := decl.PRContract.Mode
			if sev != "blocking" && sev != "warn" {
				sev = "warn"
			}
			decl.Checks[RulePRDescriptionContract] = CheckDecl{
				Enabled:  boolPtr(true),
				Severity: sev,
			}
		}
	}

	v3Decl := FlowDeclarationV3{
		Schema:       FlowSchemaV3,
		Key:          decl.Key,
		Extends:      decl.Extends,
		Label:        decl.Label,
		Summary:      decl.Summary,
		Skills:       decl.Skills,
		Stages:       decl.Stages,
		Checks:       decl.Checks,
		CustomChecks: decl.CustomChecks,
		Verifier:     decl.Verifier,
	}

	b, err := ResolveFlowDeclarationV3(v3Decl, version, sourceYAML, explicitParentHash, builtIn, effectiveLookup)
	if err != nil {
		return FlowVersionBundle{}, err
	}

	if decl.StopNudge != nil {
		b.Declaration.StopNudge = boolPtr(*decl.StopNudge)
		b.Resolved.StopNudge = *decl.StopNudge
	}
	if decl.StagingIsolation != nil {
		if !*decl.StagingIsolation {
			for _, c := range b.Declaration.Checks {
				if c.Enabled != nil && *c.Enabled && c.Severity == "blocking" {
					return FlowVersionBundle{}, fmt.Errorf("qa: staging-isolation cannot be false when blocking checks are enabled")
				}
			}
		}
		b.Declaration.StagingIsolation = boolPtr(*decl.StagingIsolation)
		b.Resolved.StagingIsolation = *decl.StagingIsolation
	}

	matV4 := FlowDeclarationV4{
		Schema:           FlowSchemaV4,
		Key:              b.Key,
		Extends:          b.Declaration.Extends,
		Label:            b.Label,
		Summary:          b.Summary,
		StopNudge:        b.Declaration.StopNudge,
		StagingIsolation: b.Declaration.StagingIsolation,
		Decompose:        decl.Decompose,
		Context:          decl.Context,
		Skills:           b.DeclarationV3.Skills,
		ReadabilityPacks: decl.ReadabilityPacks,
		SkillSteps:       decl.SkillSteps,
		Stages:           b.DeclarationV3.Stages,
		PRContract:       decl.PRContract,
		Checks:           b.Declaration.Checks,
		CustomChecks:     b.DeclarationV3.CustomChecks,
		Verifier:         b.Declaration.Verifier,
	}

	b.SchemaVer = FlowSchemaV4
	b.DeclarationV4 = &matV4

	b.Resolved.SchemaVer = FlowSchemaV4
	b.Resolved.Decompose = decl.Decompose
	b.Resolved.Context = decl.Context
	b.Resolved.ReadabilityPacks = slices.Clone(decl.ReadabilityPacks)
	b.Resolved.SkillSteps = slices.Clone(decl.SkillSteps)
	b.Resolved.PRContract = decl.PRContract

	specBytes, hash, err := CanonicalAnyJSONAndHash(matV4)
	if err != nil {
		return FlowVersionBundle{}, err
	}
	b.SpecJSON = string(specBytes)
	b.Hash = hash

	return b, nil
}

// ActiveCodingGuidance returns the combined coding prompt for f across SkillPrompt(),
// matching enabled ReadabilityPacks, enabled "coding"/"pr" SkillSteps, and PRContract guidance,
// capped at MaxActiveCodingGuidanceBytes (8192 bytes).
func (f FlowSpec) ActiveCodingGuidance(targetPaths []string) string {
	var sections []string
	if base := f.SkillPrompt(); base != "" {
		sections = append(sections, base)
	}

	for _, pack := range f.ReadabilityPacks {
		if !pack.Enabled {
			continue
		}
		if !matchesReadabilityPack(pack, targetPaths) {
			continue
		}
		packText := BuiltInReadabilityPackText(pack.ID)
		if custom := strings.TrimSpace(pack.CustomText); custom != "" {
			if packText != "" {
				packText = packText + "\n" + custom
			} else {
				packText = custom
			}
		}
		if packText != "" {
			sections = append(sections, packText)
		}
	}

	for _, step := range f.SkillSteps {
		if !step.Enabled {
			continue
		}
		if step.Stage != "coding" && step.Stage != "pr" {
			continue
		}
		if len(step.Globs) > 0 && len(targetPaths) > 0 && !matchesAnyPathGlob(targetPaths, step.Globs) {
			continue
		}
		if txt := strings.TrimSpace(step.Text); txt != "" {
			sections = append(sections, txt)
		}
	}

	if f.PRContract.Enabled && f.PRContract.Mode != "off" {
		var prLines []string
		if g := strings.TrimSpace(f.PRContract.GuidanceText); g != "" {
			prLines = append(prLines, g)
		}
		maxSubj := f.PRContract.MaxSubjectChars
		if maxSubj <= 0 {
			maxSubj = 72
		}
		prLines = append(prLines, fmt.Sprintf("PR subject max length: %d characters.", maxSubj))
		if len(f.PRContract.RequiredSections) > 0 {
			prLines = append(prLines, fmt.Sprintf("Required PR description sections: %s.", strings.Join(f.PRContract.RequiredSections, ", ")))
		}
		if f.PRContract.AuditLintSuppressions {
			prLines = append(prLines, "Audit lint suppressions: do not add unannotated lint-suppression directives.")
		}
		sections = append(sections, strings.Join(prLines, "\n"))
	}

	combined := strings.TrimSpace(strings.Join(sections, "\n\n"))
	if len(combined) > MaxActiveCodingGuidanceBytes {
		combined = strings.TrimSpace(combined[:MaxActiveCodingGuidanceBytes])
	}
	return combined
}

func matchesReadabilityPack(pack ReadabilityPackDecl, targetPaths []string) bool {
	act := strings.TrimSpace(pack.Activation)
	if act == "" {
		act = "auto"
	}
	switch act {
	case "always":
		return true
	case "glob":
		if len(targetPaths) == 0 {
			return false
		}
		return matchesAnyPathGlob(targetPaths, pack.Globs)
	default: // "auto"
		id := strings.ToLower(strings.TrimSpace(pack.ID))
		if len(targetPaths) == 0 {
			return id == "go" || id == "ts-angular"
		}
		if len(pack.Globs) > 0 && matchesAnyPathGlob(targetPaths, pack.Globs) {
			return true
		}
		for _, rawPath := range targetPaths {
			p := strings.ToLower(strings.TrimSpace(rawPath))
			ext := filepath.Ext(p)
			switch id {
			case "go":
				if ext == ".go" || strings.HasSuffix(p, "go.mod") || strings.HasSuffix(p, "go.sum") {
					return true
				}
			case "ts-angular":
				if ext == ".ts" || ext == ".html" || ext == ".css" || ext == ".scss" || ext == ".js" || ext == ".mjs" {
					return true
				}
			case "python":
				if ext == ".py" {
					return true
				}
			case "cpp":
				if ext == ".cc" || ext == ".cpp" || ext == ".cxx" || ext == ".c" || ext == ".h" || ext == ".hpp" || ext == ".hh" {
					return true
				}
			}
		}
		return false
	}
}

func matchesAnyPathGlob(targetPaths []string, globs []string) bool {
	for _, p := range targetPaths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		for _, g := range globs {
			if matchedGlob(strings.TrimSpace(g), p) {
				return true
			}
		}
	}
	return false
}

// BuildWorkflowStagesView projects any v1, v2, v3, or v4 FlowVersionBundle onto the 8 canonical lifecycle stages.
func BuildWorkflowStagesView(b FlowVersionBundle) []WorkflowStageView {
	sp := b.Resolved

	// Stage 1: s0-decompose
	var s0Steps []WorkflowStepView
	s0IntentMode := "off"
	if sp.S0Intent {
		s0IntentMode = sp.S0IntentConfig.OnClarification
		if s0IntentMode == "" {
			s0IntentMode = "enforced"
		}
	}
	s0Steps = append(s0Steps, WorkflowStepView{
		ID:      "s0:intent",
		Label:   "Intent & Acceptance Criteria Extraction",
		Kind:    "llm_gate",
		StageID: "s0-decompose",
		Enabled: sp.S0Intent,
		Mode:    s0IntentMode,
		Scope:   strings.Join(sp.S0IntentConfig.Complexities, ", "),
		Summary: "Extracts testable WHEN/SHALL acceptance criteria and explicit non-goals before planning.",
		Text:    sp.IntentSkillText,
		Bytes:   len(sp.IntentSkillText),
	})
	decompMode := sp.Decompose.Mode
	if !sp.Decompose.Enabled || decompMode == "" {
		decompMode = "off"
	}
	s0Steps = append(s0Steps, WorkflowStepView{
		ID:      "s0:decompose",
		Label:   "Subtask & Slice Decomposition",
		Kind:    "decomposition",
		StageID: "s0-decompose",
		Enabled: sp.Decompose.Enabled,
		Mode:    decompMode,
		Scope:   strings.Join(sp.Decompose.Complexities, ", "),
		Summary: fmt.Sprintf("Breaks high-complexity work into bounded slices (maxSubtasks=%d, targetDiffLines=%d).", sp.Decompose.MaxSubtasks, sp.Decompose.TargetDiffLines),
	})
	for _, st := range sp.SkillSteps {
		if st.Stage == "s0" {
			s0Steps = append(s0Steps, skillStepToView(st, "s0-decompose"))
		}
	}
	s0Enabled := sp.S0Intent || sp.Decompose.Enabled || hasEnabledStep(s0Steps)
	s0StageMode := "off"
	if sp.Decompose.Enabled {
		s0StageMode = decompMode
	} else if sp.S0Intent {
		s0StageMode = s0IntentMode
	}

	// Stage 2: s1-context
	var s1Steps []WorkflowStepView
	s1Steps = append(s1Steps, WorkflowStepView{
		ID:          "s1:blast-radius",
		Label:       "0..100 Blast-Radius Classifier (T0–T3)",
		Kind:        "classifier",
		StageID:     "s1-context",
		Enabled:     true,
		Mode:        "enforced",
		LockedFloor: true,
		Summary:     "Classifies diff blast radius across T0–T3 from touched packages, sibling caller fan-in, and trust boundaries.",
	})
	if len(sp.RiskOverrides) > 0 {
		var paths []string
		for _, ro := range sp.RiskOverrides {
			paths = append(paths, ro.Paths...)
		}
		s1Steps = append(s1Steps, WorkflowStepView{
			ID:      "s1:risk-overrides",
			Label:   "Tighten-Only Path Tier Overrides",
			Kind:    "risk_override",
			StageID: "s1-context",
			Enabled: true,
			Mode:    "tighten_only",
			Scope:   strings.Join(paths, ", "),
			Summary: fmt.Sprintf("%d tighten-only path tier override rule(s).", len(sp.RiskOverrides)),
		})
	}
	ctxMode := "off"
	if sp.Context.Enabled {
		ctxMode = "auto"
	}
	s1Steps = append(s1Steps, WorkflowStepView{
		ID:      "s1:context-discovery",
		Label:   "Caller & Memory Context Discovery",
		Kind:    "context_discovery",
		StageID: "s1-context",
		Enabled: sp.Context.Enabled,
		Mode:    ctxMode,
		Scope:   strings.Join(sp.Context.ExtraPaths, ", "),
		Summary: fmt.Sprintf("Pre-populates sibling callers (%v) and repository memory (%v) up to %d tokens.", sp.Context.IncludeCallers, sp.Context.IncludeMemory, sp.Context.MaxTokens),
	})
	s1StageMode := "blast_radius"
	if sp.Context.Enabled {
		s1StageMode = "context+blast"
	}

	// Stage 3: s2-plan
	var s2PlanSteps []WorkflowStepView
	planMode := "off"
	if sp.S2PlanCritic {
		planMode = "enforced"
	}
	s2PlanSteps = append(s2PlanSteps, WorkflowStepView{
		ID:      "s2:plan-critic",
		Label:   "Fresh-Context Plan Critic",
		Kind:    "llm_critic",
		StageID: "s2-plan",
		Enabled: sp.S2PlanCritic,
		Mode:    planMode,
		Scope:   strings.Join(append(slices.Clone(sp.S2PlanCriticConfig.Complexities), sp.S2PlanCriticConfig.Tiers...), ", "),
		Summary: "Critiques the proposed file plan and sibling caller coverage in an isolated context before coding.",
		Text:    sp.PlanCriticSkillText,
		Bytes:   len(sp.PlanCriticSkillText),
	})
	for _, st := range sp.SkillSteps {
		if st.Stage == "s2" {
			s2PlanSteps = append(s2PlanSteps, skillStepToView(st, "s2-plan"))
		}
	}
	for _, cs := range sp.CustomStages {
		if cs.InsertAfter == "s2" {
			s2PlanSteps = append(s2PlanSteps, customStageToView(cs, "s2-plan"))
		}
	}
	s2PlanEnabled := sp.S2PlanCritic || hasEnabledStep(s2PlanSteps)

	// Stage 4: s2-coding
	var s2CodingSteps []WorkflowStepView
	baseSkillText := sp.SkillPrompt()
	codingSkillMode := b.Declaration.Skill.Mode
	if codingSkillMode == "" {
		codingSkillMode = "replace"
	}
	if !sp.InjectSkill {
		codingSkillMode = "off"
	}
	s2CodingSteps = append(s2CodingSteps, WorkflowStepView{
		ID:      "coding:base-skill",
		Label:   "Core Coding Contract",
		Kind:    "skill",
		StageID: "s2-coding",
		Enabled: sp.InjectSkill,
		Mode:    codingSkillMode,
		Summary: "Primary coding-time engineering contract injected into the sandbox session.",
		Text:    baseSkillText,
		Bytes:   len(baseSkillText),
	})
	for _, rp := range sp.ReadabilityPacks {
		txt := BuiltInReadabilityPackText(rp.ID)
		if strings.TrimSpace(rp.CustomText) != "" {
			if txt != "" {
				txt = txt + "\n" + strings.TrimSpace(rp.CustomText)
			} else {
				txt = strings.TrimSpace(rp.CustomText)
			}
		}
		act := rp.Activation
		if act == "" {
			act = "auto"
		}
		s2CodingSteps = append(s2CodingSteps, WorkflowStepView{
			ID:      "readability:" + rp.ID,
			Label:   readabilityPackLabel(rp.ID),
			Kind:    "readability_pack",
			StageID: "s2-coding",
			Enabled: rp.Enabled,
			Mode:    act,
			Scope:   strings.Join(rp.Globs, ", "),
			Summary: fmt.Sprintf("Portable %s readability guidance (%s activation).", rp.ID, act),
			Text:    txt,
			Bytes:   len(txt),
		})
	}
	for _, st := range sp.SkillSteps {
		if st.Stage == "coding" {
			s2CodingSteps = append(s2CodingSteps, skillStepToView(st, "s2-coding"))
		}
	}
	s2CodingEnabled := hasEnabledStep(s2CodingSteps)
	s2CodingStageMode := "off"
	if s2CodingEnabled {
		s2CodingStageMode = "active"
	}

	// Stage 5: s3-checks
	var s3CheckSteps []WorkflowStepView
	for _, r := range sp.Rules {
		if r.ID == RuleS4OrthogonalVerifier || r.ID == RulePRDescriptionContract {
			continue
		}
		isFloor := r.ID == RuleTestIntegrityGuard || r.ID == RuleStrictConfigDecoder
		s3CheckSteps = append(s3CheckSteps, WorkflowStepView{
			ID:          r.ID,
			Label:       r.Label,
			Kind:        "deterministic_check",
			StageID:     "s3-checks",
			Enabled:     r.Enabled,
			Mode:        r.Severity,
			Scope:       strings.Join(r.TargetPaths, ", "),
			LockedFloor: isFloor,
			Summary:     r.Summary,
		})
	}
	for _, cc := range sp.CustomChecks {
		kind := cc.Kind
		if kind == "" {
			kind = cc.Engine
		}
		s3CheckSteps = append(s3CheckSteps, WorkflowStepView{
			ID:      cc.ID,
			Label:   cc.Label,
			Kind:    "custom_check:" + kind,
			StageID: "s3-checks",
			Enabled: true,
			Mode:    cc.Severity,
			Scope:   strings.Join(append(slices.Clone(cc.Paths), cc.WhenChanged...), ", "),
			Summary: cc.Message,
		})
	}
	for _, cs := range sp.CustomStages {
		if cs.InsertAfter == "s3" {
			s3CheckSteps = append(s3CheckSteps, customStageToView(cs, "s3-checks"))
		}
	}
	s3StageMode := "direct"
	if sp.StagingIsolation {
		s3StageMode = "staging_isolated"
	}

	// Stage 6: s3-pr
	var s3PRSteps []WorkflowStepView
	nudgeMode := "off"
	if sp.StopNudge {
		nudgeMode = "enforced"
	}
	s3PRSteps = append(s3PRSteps, WorkflowStepView{
		ID:      "pr:stop-nudge",
		Label:   "Pre-PR Self-Review Stop Nudge",
		Kind:    "nudge",
		StageID: "s3-pr",
		Enabled: sp.StopNudge,
		Mode:    nudgeMode,
		Summary: "Prompts the agent to verify build, vet, and tests on final HEAD before opening a pull request.",
	})
	prContractMode := sp.PRContract.Mode
	if !sp.PRContract.Enabled || prContractMode == "" {
		prContractMode = "off"
	}
	s3PRSteps = append(s3PRSteps, WorkflowStepView{
		ID:      "pr:contract",
		Label:   "PR Subject, Sections & Lint-Suppression Contract",
		Kind:    "pr_contract",
		StageID: "s3-pr",
		Enabled: sp.PRContract.Enabled,
		Mode:    prContractMode,
		Scope:   strings.Join(sp.PRContract.RequiredSections, ", "),
		Summary: fmt.Sprintf("Subject <= %d chars, required sections (%s), auditLintSuppressions=%v.", sp.PRContract.MaxSubjectChars, strings.Join(sp.PRContract.RequiredSections, ", "), sp.PRContract.AuditLintSuppressions),
		Text:    sp.PRContract.GuidanceText,
		Bytes:   len(sp.PRContract.GuidanceText),
	})
	if prRule, ok := sp.Rule(RulePRDescriptionContract); ok {
		s3PRSteps = append(s3PRSteps, WorkflowStepView{
			ID:      prRule.ID,
			Label:   prRule.Label,
			Kind:    "deterministic_check",
			StageID: "s3-pr",
			Enabled: prRule.Enabled,
			Mode:    prRule.Severity,
			Scope:   strings.Join(prRule.TargetPaths, ", "),
			Summary: prRule.Summary,
		})
	}
	for _, st := range sp.SkillSteps {
		if st.Stage == "pr" {
			s3PRSteps = append(s3PRSteps, skillStepToView(st, "s3-pr"))
		}
	}
	s3PREnabled := hasEnabledStep(s3PRSteps)
	s3PRStageMode := "off"
	if sp.PRContract.Enabled && sp.PRContract.Mode != "" {
		s3PRStageMode = sp.PRContract.Mode
	} else if s3PREnabled {
		s3PRStageMode = "warn"
	}

	// Stage 7: s4-verify
	var s4Steps []WorkflowStepView
	s4Text := sp.VerifierSkillText
	if s4Text == "" && sp.VerifierChecklist == ChecklistEscapeClassesV1 {
		s4Text = EscapeClassesV1ChecklistText
	}
	s4Mode := "off"
	if sp.EnableS4 {
		s4Mode = "blocking"
	}
	s4Steps = append(s4Steps, WorkflowStepView{
		ID:      RuleS4OrthogonalVerifier,
		Label:   "Fresh-Context Orthogonal Verifier + 6-Filter Inquisitor",
		Kind:    "llm_verifier",
		StageID: "s4-verify",
		Enabled: sp.EnableS4,
		Mode:    s4Mode,
		Scope:   strings.Join(sp.VerifierTiers, ", "),
		Summary: fmt.Sprintf("Fresh-context semantic verifier (maxRepairRounds=%d, maxSeconds=%d, checklist=%s).", sp.MaxS4RepairRounds, sp.MaxS4Seconds, sp.VerifierChecklist),
		Text:    s4Text,
		Bytes:   len(s4Text),
	})
	if sp.SecuritySkillText != "" {
		s4Steps = append(s4Steps, WorkflowStepView{
			ID:      "s4:security-skill",
			Label:   "Security Review Guidance",
			Kind:    "skill",
			StageID: "s4-verify",
			Enabled: true,
			Mode:    "blocking",
			Text:    sp.SecuritySkillText,
			Bytes:   len(sp.SecuritySkillText),
		})
	}
	for _, st := range sp.SkillSteps {
		if st.Stage == "s4" {
			s4Steps = append(s4Steps, skillStepToView(st, "s4-verify"))
		}
	}
	for _, cs := range sp.CustomStages {
		if cs.InsertAfter == "s4" {
			s4Steps = append(s4Steps, customStageToView(cs, "s4-verify"))
		}
	}
	s4Enabled := sp.EnableS4 || hasEnabledStep(s4Steps)

	// Stage 8: s5-triage
	triageMode := strings.TrimSpace(sp.S5MergeTriage.Mode)
	if triageMode == "" {
		triageMode = "off"
	}
	triageEnabled := triageMode != "off"
	s5Steps := []WorkflowStepView{
		{
			ID:      "s5:merge-triage",
			Label:   "ComposeTightenOnly S5 Merge Triage",
			Kind:    "merge_triage",
			StageID: "s5-triage",
			Enabled: triageEnabled,
			Mode:    triageMode,
			Scope:   fmt.Sprintf("autoMerge=[%s] humanReview=[%s]", strings.Join(sp.S5MergeTriage.AutoMergeTiers, ","), strings.Join(sp.S5MergeTriage.RequireHumanTiers, ",")),
			Summary: "Combines blast-radius score, check verdicts, and tighten-only tier routing to decide auto-merge vs human review.",
		},
	}

	return []WorkflowStageView{
		{
			ID:       "s0-decompose",
			Index:    1,
			Label:    "1 · Goal & Subtask Breakdown",
			Boundary: "Pre-Dispatch",
			Enabled:  s0Enabled,
			Mode:     s0StageMode,
			Summary:  "Extracts testable acceptance criteria and decomposes high-complexity work before coding starts.",
			Steps:    s0Steps,
		},
		{
			ID:       "s1-context",
			Index:    2,
			Label:    "2 · Context & Blast Radius",
			Boundary: "Pre-Dispatch / Diff Risk",
			Enabled:  true,
			Mode:     s1StageMode,
			Summary:  "Discovers sibling callers and repository memory while scoring 0..100 diff blast radius (T0–T3).",
			Steps:    s1Steps,
		},
		{
			ID:       "s2-plan",
			Index:    3,
			Label:    "3 · Plan & Fresh Critique",
			Boundary: "Pre-Coding",
			Enabled:  s2PlanEnabled,
			Mode:     planMode,
			Summary:  "Reviews the proposed file plan and caller sweep in an isolated critic context.",
			Steps:    s2PlanSteps,
		},
		{
			ID:       "s2-coding",
			Index:    4,
			Label:    "4 · Coding & Readability Rules",
			Boundary: "In-Sandbox Authoring",
			Enabled:  s2CodingEnabled,
			Mode:     s2CodingStageMode,
			Summary:  "Injects core coding contract, portable language readability packs, and stage skill steps.",
			Steps:    s2CodingSteps,
		},
		{
			ID:       "s3-checks",
			Index:    5,
			Label:    "5 · Pre-PR Deterministic Gates",
			Boundary: "Pre-PR Staging Ref",
			Enabled:  true,
			Mode:     s3StageMode,
			Summary:  "Runs sub-second AST/diff integrity floors, sibling caller checks, mutation/fuzz gates, and custom checks.",
			Steps:    s3CheckSteps,
		},
		{
			ID:       "s3-pr",
			Index:    6,
			Label:    "6 · PR Authoring & Self-Review",
			Boundary: "Pull Request Open",
			Enabled:  s3PREnabled,
			Mode:     s3PRStageMode,
			Summary:  "Enforces pull request subject/section contract, lint-suppression audit, and pre-PR self-review.",
			Steps:    s3PRSteps,
		},
		{
			ID:       "s4-verify",
			Index:    7,
			Label:    "7 · Adversarial Verification",
			Boundary: "Fresh-Context Verifier",
			Enabled:  s4Enabled,
			Mode:     s4Mode,
			Summary:  "Executes fresh-context orthogonal diff verification with 6-filter Inquisitor grounding.",
			Steps:    s4Steps,
		},
		{
			ID:       "s5-triage",
			Index:    8,
			Label:    "8 · Scorecard & Merge Triage",
			Boundary: "Post-Checks Merge Routing",
			Enabled:  triageEnabled,
			Mode:     triageMode,
			Summary:  "Routes green low-blast changes to auto-merge and high-blast T2/T3 changes to human review.",
			Steps:    s5Steps,
		},
	}
}

func skillStepToView(st SkillStepDecl, stageID string) WorkflowStepView {
	lbl := strings.TrimSpace(st.Label)
	if lbl == "" {
		lbl = st.ID
	}
	return WorkflowStepView{
		ID:      st.ID,
		Label:   lbl,
		Kind:    "skill_step",
		StageID: stageID,
		Enabled: st.Enabled,
		Mode:    st.Stage,
		Scope:   strings.Join(st.Globs, ", "),
		Text:    st.Text,
		Bytes:   len(st.Text),
	}
}

func customStageToView(cs CustomStageDecl, stageID string) WorkflowStepView {
	lbl := strings.TrimSpace(cs.Label)
	if lbl == "" {
		lbl = cs.ID
	}
	return WorkflowStepView{
		ID:      cs.ID,
		Label:   lbl,
		Kind:    "custom_stage",
		StageID: stageID,
		Enabled: true,
		Mode:    cs.Kind,
		Scope:   strings.Join(cs.WhenPaths, ", "),
		Summary: fmt.Sprintf("insert-after=%s minTier=%s checks=%s", cs.InsertAfter, cs.MinTier, strings.Join(cs.CheckIDs, ",")),
	}
}

func hasEnabledStep(steps []WorkflowStepView) bool {
	for _, s := range steps {
		if s.Enabled {
			return true
		}
	}
	return false
}

// jsonCamelToYAMLKebab maps exact camelCase JSON struct tag keys on FlowDeclarationV2/V3/V4
// to their canonical kebab-case YAML struct tag equivalents when a raw JSON object is parsed.
var jsonCamelToYAMLKebab = map[string]string{
	"stopNudge":             "stop-nudge",
	"stagingIsolation":      "staging-isolation",
	"maxBytes":              "max-bytes",
	"maxRepairRounds":       "max-repair-rounds",
	"maxSeconds":            "max-seconds",
	"maxTokens":             "max-tokens",
	"planCritic":            "plan-critic",
	"s0Intent":              "s0-intent",
	"s1Risk":                "s1-risk",
	"s2PlanCritic":          "s2-plan-critic",
	"s5MergeTriage":         "s5-merge-triage",
	"onClarification":       "on-clarification",
	"maxBounces":            "max-bounces",
	"minTier":               "min-tier",
	"insertAfter":           "insert-after",
	"whenPaths":             "when-paths",
	"timeoutSeconds":        "timeout-seconds",
	"checkIds":              "check-ids",
	"skillRef":              "skill-ref",
	"autoMergeTiers":        "auto-merge-tiers",
	"requireHumanTiers":     "require-human-tiers",
	"customChecks":          "custom-checks",
	"forbidAdded":           "forbid-added",
	"requireAdded":          "require-added",
	"maxChangedLines":       "max-changed-lines",
	"maxFiles":              "max-files",
	"whenChanged":           "when-changed",
	"requireChanged":        "require-changed",
	"allowWaiver":           "allow-waiver",
	"schemaJson":            "schema-json",
	"addedLines":            "added-lines",
	"changedFiles":          "changed-files",
	"readabilityPacks":      "readability-packs",
	"skillSteps":            "skill-steps",
	"prContract":            "pr-contract",
	"maxSubtasks":           "max-subtasks",
	"targetDiffLines":       "target-diff-lines",
	"includeCallers":        "include-callers",
	"includeMemory":         "include-memory",
	"extraPaths":            "extra-paths",
	"customText":            "custom-text",
	"maxSubjectChars":       "max-subject-chars",
	"requiredSections":      "required-sections",
	"auditLintSuppressions": "audit-lint-suppressions",
	"guidanceText":          "guidance-text",
}

func normalizeFlowDeclarationInput(trimmed []byte) ([]byte, error) {
	if len(trimmed) == 0 || string(trimmed) == "null" || string(trimmed) == "~" {
		return nil, fmt.Errorf("qa: empty or null flow declaration")
	}
	if trimmed[0] != '{' {
		return trimmed, nil
	}
	var root any
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return trimmed, nil
	}
	m, ok := root.(map[string]any)
	if !ok || m == nil {
		return nil, fmt.Errorf("qa: flow declaration must be a JSON object")
	}
	if rawKey, hasKey := m["key"]; !hasKey || rawKey == nil {
		return nil, fmt.Errorf("qa: flow key is required and cannot be null")
	}
	if rawSchema, hasSchema := m["schema"]; hasSchema && rawSchema == nil {
		return nil, fmt.Errorf("qa: flow schema cannot be null")
	}
	converted := convertJSONKeysToYAML(m, false)
	out, err := json.Marshal(converted)
	if err != nil {
		return trimmed, nil
	}
	return out, nil
}

func convertJSONKeysToYAML(v any, preserveKeys bool) any {
	switch val := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, child := range val {
			nk := k
			if !preserveKeys {
				if mapped, ok := jsonCamelToYAMLKebab[k]; ok {
					nk = mapped
				}
			}
			// Preserve raw user keys inside schema-json or params maps.
			childPreserve := preserveKeys || nk == "schema-json" || nk == "params"
			out[nk] = convertJSONKeysToYAML(child, childPreserve)
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, elem := range val {
			out[i] = convertJSONKeysToYAML(elem, preserveKeys)
		}
		return out
	default:
		return v
	}
}
