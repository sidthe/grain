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

package resolve

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/qa"
)

// Resolution describes the effective QA arm and materialized FlowSpec for a task.
type Resolution struct {
	Source       string       `json:"source"`
	ExperimentID string       `json:"experimentId,omitempty"`
	ArmID        string       `json:"armId"`
	FlowID       string       `json:"flowId,omitempty"`
	FlowHash     string       `json:"flowHash,omitempty"`
	QAEngineRev  int          `json:"qaEngineRev,omitempty"`
	Spec         *qa.FlowSpec `json:"spec,omitempty"`
	Shadow       bool         `json:"shadow"`
	ExcludedWhy  string       `json:"excludedWhy,omitempty"`
}

// RegistryResolver resolves an already-enrolled work tree from qa_enrollment (read-only).
var RegistryResolver func(ctx context.Context, store *model.Store, task model.Task, rootOrigin string, qaCfg model.QAConfig) (*Resolution, error)

// RegistryDispatchResolver enrolls or resolves a work tree against a running qa_experiment at dispatch time.
var RegistryDispatchResolver func(ctx context.Context, store *model.Store, task model.Task, rootOrigin string, hasPriorRuns bool, qaCfg model.QAConfig, now time.Time) (*Resolution, error)

func init() {
	model.ActiveQAResolution = func(ctx context.Context, store *model.Store, taskID string) (string, error) {
		res, _, err := ActiveQAResolutionForTask(ctx, store, taskID)
		if err != nil {
			return "", err
		}
		if res != nil && res.IsEnforcedTreatment() {
			return model.QAArmTreatment, nil
		}
		return "", nil
	}
}

// IsEnforcedTreatment reports whether r requires treatment-arm staging and blocking gates.
func (r *Resolution) IsEnforcedTreatment() bool {
	if r == nil || r.Shadow {
		return false
	}
	switch r.ArmID {
	case "", "baseline", "excluded", model.QAArmControl:
		return false
	default:
		return r.Spec != nil
	}
}

func severityRank(s string) int {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "blocking":
		return 3
	case "warn":
		return 2
	case "shadow":
		return 1
	default:
		return 0
	}
}

func tighterSeverity(a, b string) string {
	if severityRank(b) > severityRank(a) {
		return strings.ToLower(strings.TrimSpace(b))
	}
	if strings.TrimSpace(a) == "" {
		return "blocking"
	}
	return strings.ToLower(strings.TrimSpace(a))
}

// ComposeTightenOnly enforces locked QA floors on spec (RuleTestIntegrityGuard and
// RuleStrictConfigDecoder always Enabled: true, Severity: "blocking", and
// StagingIsolation: true) and applies any overlays tighten-only so nothing can
// weaken an enabled gate or floor.
func ComposeTightenOnly(spec qa.FlowSpec, overlays ...qa.FlowSpec) qa.FlowSpec {
	out := spec
	out.StagingIsolation = true
	out.Rules = slices.Clone(spec.Rules)

	applyRuleFloor := func(ruleID, label, summary string) {
		for i := range out.Rules {
			if out.Rules[i].ID == ruleID {
				out.Rules[i].Enabled = true
				out.Rules[i].Severity = "blocking"
				if out.Rules[i].Stage == "" {
					out.Rules[i].Stage = "S3"
				}
				return
			}
		}
		out.Rules = append(out.Rules, qa.RuleSpec{
			ID:       ruleID,
			Label:    label,
			Stage:    "S3",
			Severity: "blocking",
			Summary:  summary,
			Enabled:  true,
		})
	}

	for _, ov := range overlays {
		if ov.StopNudge {
			out.StopNudge = true
		}
		if ov.EnableS4 {
			out.EnableS4 = true
		}
		if ov.S0Intent {
			out.S0Intent = true
		}
		if ov.S2PlanCritic {
			out.S2PlanCritic = true
		}
		if ov.Decompose.Enabled {
			out.Decompose.Enabled = true
		}
		if ov.Context.Enabled {
			out.Context.Enabled = true
		}
		if ov.PRContract.Enabled {
			out.PRContract.Enabled = true
		}
		for _, r := range ov.Rules {
			found := false
			for i := range out.Rules {
				if out.Rules[i].ID == r.ID {
					found = true
					if r.Enabled {
						out.Rules[i].Enabled = true
					}
					out.Rules[i].Severity = tighterSeverity(out.Rules[i].Severity, r.Severity)
					break
				}
			}
			if !found {
				out.Rules = append(out.Rules, r)
			}
		}
	}

	applyRuleFloor(
		qa.RuleTestIntegrityGuard,
		"Test integrity & weakened-assertion guard",
		"Blocks weakened assertions, deleted test cases without replacement, skipped tests, and tautological assertions.",
	)
	applyRuleFloor(
		qa.RuleStrictConfigDecoder,
		"Strict YAML/JSON config decoder guard",
		"Requires KnownFields(true) or DisallowUnknownFields() on config/declaration decoders.",
	)
	return out
}

func resolveBoundQAFlow(ctx context.Context, store *model.Store, task model.Task) (*Resolution, error) {
	if store == nil {
		return nil, nil
	}
	taskRef := strings.TrimSpace(task.QAFlowRef)
	var repoRef string
	if task.Target != nil && *task.Target != (model.RepoRef{}) {
		repoCfg, err := store.RepoConfig(ctx, *task.Target)
		if err != nil {
			return nil, err
		}
		if repoCfg != nil {
			repoRef = strings.TrimSpace(repoCfg.QAFlowRef)
		}
	}
	if taskRef != "" {
		spec, hash, err := LookupFlowSpec(ctx, store, taskRef)
		if err != nil {
			return nil, err
		}
		if spec != nil {
			var overlays []qa.FlowSpec
			if repoRef != "" && repoRef != taskRef {
				if rSpec, _, rErr := LookupFlowSpec(ctx, store, repoRef); rErr == nil && rSpec != nil {
					overlays = append(overlays, *rSpec)
				}
			}
			enforced := ComposeTightenOnly(*spec, overlays...)
			return &Resolution{
				Source:      "process",
				ArmID:       model.QAArmTreatment,
				FlowID:      taskRef,
				FlowHash:    hash,
				QAEngineRev: qa.QAEngineRev,
				Spec:        &enforced,
				Shadow:      false,
			}, nil
		}
	}
	if repoRef != "" {
		spec, hash, err := LookupFlowSpec(ctx, store, repoRef)
		if err != nil {
			return nil, err
		}
		if spec != nil {
			enforced := ComposeTightenOnly(*spec)
			return &Resolution{
				Source:      "repo",
				ArmID:       model.QAArmTreatment,
				FlowID:      repoRef,
				FlowHash:    hash,
				QAEngineRev: qa.QAEngineRev,
				Spec:        &enforced,
				Shadow:      false,
			}, nil
		}
	}
	return nil, nil
}

// LookupFlowSpec resolves ref against built-in/registered v2/v3 flows, stored qa_flow_version rows, or v1 flows.
func LookupFlowSpec(ctx context.Context, store *model.Store, ref string) (*qa.FlowSpec, string, error) {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" || trimmed == "control" || trimmed == "baseline" {
		return nil, "", nil
	}
	if b, ok := qa.LookupBuiltInOrRegisteredVersion(trimmed); ok {
		sp := b.Resolved
		return &sp, b.Hash, nil
	}
	if store != nil {
		findFV := func(q string) (model.QAFlowVersion, bool) {
			if before, after, hasAt := strings.Cut(q, "@"); hasAt {
				if vNum, aErr := strconv.Atoi(after); aErr == nil && vNum > 0 {
					if fv, gErr := store.GetQAFlowVersionByKeyVersion(ctx, before, vNum); gErr == nil {
						return fv, true
					}
				}
			}
			if fv, gErr := store.GetQAFlowVersion(ctx, q); gErr == nil {
				return fv, true
			}
			if list, lErr := store.ListQAFlowVersions(ctx, q, 1); lErr == nil && len(list) > 0 {
				return list[0], true
			}
			return model.QAFlowVersion{}, false
		}

		var resolveParent qa.ParentLookupFunc
		seen := map[string]bool{}
		resolveParent = func(pRef string) (qa.FlowVersionBundle, bool) {
			if b, ok := qa.LookupBuiltInOrRegisteredVersion(pRef); ok {
				return b, true
			}
			if seen[pRef] {
				return qa.FlowVersionBundle{}, false
			}
			seen[pRef] = true
			pfv, ok := findFV(pRef)
			if !ok || strings.TrimSpace(pfv.SourceYAML) == "" {
				return qa.FlowVersionBundle{}, false
			}
			b, rErr := qa.ResolveAnyFlowDeclaration([]byte(pfv.SourceYAML), pfv.Version, resolveParent)
			if rErr != nil {
				return qa.FlowVersionBundle{}, false
			}
			b.Hash = pfv.Hash
			return b, true
		}

		if fv, ok := findFV(trimmed); ok {
			if strings.TrimSpace(fv.SourceYAML) != "" {
				if b, rErr := qa.ResolveAnyFlowDeclaration([]byte(fv.SourceYAML), fv.Version, resolveParent); rErr == nil {
					sp := b.Resolved
					return &sp, fv.Hash, nil
				}
			}
			var sp qa.FlowSpec
			if jErr := json.Unmarshal([]byte(fv.SpecJSON), &sp); jErr == nil {
				return &sp, fv.Hash, nil
			}
		}
	}
	if sp, ok := qa.LookupFlow(trimmed); ok {
		return &sp, "", nil
	}
	return nil, "", nil
}

// ActiveQAResolutionForTask performs a read-only resolution of taskID's QA exposure.
// It never mutates assignment or enrollment rows.
func ActiveQAResolutionForTask(ctx context.Context, store *model.Store, taskID string) (*Resolution, model.QAConfig, error) {
	if store == nil {
		return nil, model.QAConfig{}, nil
	}
	task, err := store.GetTask(ctx, taskID)
	if err != nil {
		return nil, model.QAConfig{}, err
	}
	if task == nil || !model.TaskEligibleForQAStaging(*task) {
		return nil, model.QAConfig{}, nil
	}

	qaCfg, err := store.ConfigQA(ctx)
	if err != nil {
		return nil, qaCfg, err
	}
	// Step 1: Master kill switch immediately disables QA enforcement across all sources.
	if !qaCfg.Enabled {
		return nil, qaCfg, nil
	}

	root := model.ResolveQARootOrigin(task.WorkOrigin, task.ID)

	// Step 2: Experiment registry enrollment takes precedence over legacy epoch assignments.
	if RegistryResolver != nil {
		res, err := RegistryResolver(ctx, store, *task, root, qaCfg)
		if err != nil {
			return nil, qaCfg, err
		}
		if res != nil && res.Source != "none" {
			return res, qaCfg, nil
		}
	}

	// Step 2.5: Operator-bound process (task/template/schedule/suite) or repository QA flow.
	if bound, err := resolveBoundQAFlow(ctx, store, *task); err != nil {
		return nil, qaCfg, err
	} else if bound != nil {
		return bound, qaCfg, nil
	}

	// Step 3: Sticky legacy assignment from task_qa_assignment.
	assign, err := store.EarliestQAAssignment(ctx, root)
	if err != nil {
		return nil, qaCfg, err
	}
	if assign == nil {
		return nil, qaCfg, nil
	}
	return resolveLegacyAssignment(ctx, store, *assign, qaCfg), qaCfg, nil
}

// EnsureQAResolutionAtDispatch resolves or assigns QA exposure when a run is about to start.
// It is the sole entry point allowed to write new QA assignments/enrollments.
func EnsureQAResolutionAtDispatch(ctx context.Context, store *model.Store, task model.Task, runID string, now time.Time) (*Resolution, model.QAConfig, error) {
	return EnsureQAResolutionAtDispatchWithConfig(ctx, store, task, runID, nil, now)
}

// EnsureQAResolutionAtDispatchWithConfig resolves or assigns QA exposure at dispatch using an optional
// in-memory QAConfig override when non-nil.
func EnsureQAResolutionAtDispatchWithConfig(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	runID string,
	qaCfgOverride *model.QAConfig,
	now time.Time,
) (*Resolution, model.QAConfig, error) {
	if store == nil {
		return &Resolution{Source: "none", ArmID: "baseline"}, model.QAConfig{}, nil
	}
	if task.Target != nil && !model.TaskEligibleForQAStaging(task) {
		return &Resolution{Source: "none", ArmID: "baseline"}, model.QAConfig{}, nil
	}
	if task.Target == nil && qaCfgOverride == nil {
		return &Resolution{Source: "none", ArmID: "baseline"}, model.QAConfig{}, nil
	}

	var qaCfg model.QAConfig
	var err error
	if qaCfgOverride != nil {
		qaCfg = *qaCfgOverride
	} else {
		qaCfg, err = store.ConfigQA(ctx)
		if err != nil {
			return nil, model.QAConfig{}, err
		}
	}
	if !qaCfg.Enabled {
		return &Resolution{Source: "none", ArmID: "baseline"}, qaCfg, nil
	}

	root := model.ResolveQARootOrigin(task.WorkOrigin, task.ID)
	hasPrior, err := store.OriginHasPriorRuns(ctx, root, runID)
	if err != nil {
		return nil, qaCfg, err
	}

	// Step 1: Running or previously enrolled qa_experiment takes precedence over legacy rollout.
	var expNone *Resolution
	if RegistryDispatchResolver != nil {
		res, err := RegistryDispatchResolver(ctx, store, task, root, hasPrior, qaCfg, now)
		if err != nil {
			return nil, qaCfg, err
		}
		if res != nil {
			if res.Source != "none" {
				return res, qaCfg, nil
			}
			expNone = res
		}
	}

	// Step 1.5: Operator-bound process (task/template/schedule/suite) or repository QA flow.
	if bound, err := resolveBoundQAFlow(ctx, store, task); err != nil {
		return nil, qaCfg, err
	} else if bound != nil {
		return bound, qaCfg, nil
	}
	if expNone != nil {
		return expNone, qaCfg, nil
	}

	// Step 2: Sticky legacy assignment; pre-existing work trees with prior runs are excluded from new rollout.
	assign, err := store.EarliestQAAssignment(ctx, root)
	if err != nil {
		return nil, qaCfg, err
	}
	if assign == nil {
		if hasPrior {
			return &Resolution{
				Source:      "none",
				ArmID:       "excluded",
				ExcludedWhy: "origin had runs before rollout epoch started",
			}, qaCfg, nil
		}
		if qaCfg.RolloutPct <= 0 {
			return &Resolution{Source: "none", ArmID: "baseline"}, qaCfg, nil
		}
		tier := qa.ClassifyTaskComplexity(task.Title, task.Body)
		created, err := qa.AssignOrLoadArm(ctx, store, root, tier, qaCfg, now)
		if err != nil {
			return nil, qaCfg, err
		}
		assign = &created
	}

	return resolveLegacyAssignment(ctx, store, *assign, qaCfg), qaCfg, nil
}

func resolveLegacyAssignment(ctx context.Context, store *model.Store, assign model.QAAssignment, qaCfg model.QAConfig) *Resolution {
	//Epoch stickiness: if the deployment's epoch moved past the origin's assigned epoch,
	// do not re-bucket mid-work-tree; treat the origin as baseline.
	if assign.Epoch != qaCfg.EpochOrDefault() {
		return &Resolution{
			Source: "legacy",
			ArmID:  "baseline",
		}
	}

	flowID := strings.TrimSpace(assign.FlowID)
	if flowID == "" {
		flowID = strings.TrimSpace(qaCfg.FlowID)
	}
	if flowID == "" {
		flowID = model.DefaultQAFlowID
	}

	if assign.Arm == model.QAArmTreatment {
		spec, hash, _ := LookupFlowSpec(ctx, store, flowID)
		return &Resolution{
			Source:      "legacy",
			ArmID:       model.QAArmTreatment,
			Spec:        spec,
			FlowID:      flowID,
			FlowHash:    hash,
			QAEngineRev: qa.QAEngineRev,
			Shadow:      false,
		}
	}

	if assign.Arm == model.QAArmControl {
		shadow := qaCfg.ShadowOnControl != nil && *qaCfg.ShadowOnControl
		var spec *qa.FlowSpec
		var hash string
		if shadow {
			spec, hash, _ = LookupFlowSpec(ctx, store, flowID)
		}
		return &Resolution{
			Source:      "legacy",
			ArmID:       model.QAArmControl,
			FlowID:      flowID,
			FlowHash:    hash,
			QAEngineRev: qa.QAEngineRev,
			Spec:        spec,
			Shadow:      shadow,
		}
	}

	return &Resolution{
		Source: "legacy",
		ArmID:  assign.Arm,
	}
}
