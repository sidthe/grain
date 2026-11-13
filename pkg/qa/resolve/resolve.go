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

// LookupFlowSpec resolves ref against built-in/registered v2 flows, stored qa_flow_version rows, or v1 flows.
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
		if fv, err := store.GetQAFlowVersion(ctx, trimmed); err == nil {
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
		if res != nil {
			return res, qaCfg, nil
		}
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
	if store == nil || !model.TaskEligibleForQAStaging(task) {
		return &Resolution{Source: "none", ArmID: "baseline"}, model.QAConfig{}, nil
	}

	qaCfg, err := store.ConfigQA(ctx)
	if err != nil {
		return nil, model.QAConfig{}, err
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
	if RegistryDispatchResolver != nil {
		res, err := RegistryDispatchResolver(ctx, store, task, root, hasPrior, qaCfg, now)
		if err != nil {
			return nil, qaCfg, err
		}
		if res != nil {
			return res, qaCfg, nil
		}
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
		created, err := qa.AssignOrLoadArm(ctx, store, root, "medium", qaCfg, now)
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
