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

package orchestrator

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/qa"
)

func ExecutePreDispatchQAPhases(ctx context.Context, store *model.Store, task model.Task, spec *qa.FlowSpec, expID, armID, flowHash string, initialPrompt string) string {
	rt := LiveQARuntime()
	if rt == nil || rt.RunIsolatedPrompt == nil {
		return initialPrompt
	}

	comp := qa.AssessTaskComplexity(qa.ComplexityInput{
		Title:       task.Title,
		Body:        task.Body,
		ReadsCount:  len(task.Reads),
		WritesCount: len(task.Writes),
	}, nil)

	finalPrompt := initialPrompt

	if spec.S0Intent && !comp.HasDesignItem {
		if len(spec.S0IntentConfig.Complexities) == 0 || slices.Contains(spec.S0IntentConfig.Complexities, string(comp.Tier)) {
			timeout := time.Duration(spec.S0IntentConfig.MaxSeconds) * time.Second
			if timeout <= 0 || timeout > 30*time.Second {
				timeout = 30 * time.Second
			}
			runCtx, cancel := context.WithTimeout(ctx, timeout)

			start := time.Now()
			out, inTok, outTok, err := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s0", "Extract EARS checklist (WHEN ... SHALL) from task: "+task.Title+"\n"+task.Body, int(spec.S0IntentConfig.MaxTokens))
			duration := time.Since(start).Milliseconds()
			cancel()

			cr := model.QACheckRun{
				TaskID:         task.ID,
				RunID:          task.ID + "-qa-s0",
				Stage:          "S0",
				CheckID:        "qa:intent",
				Arm:            model.QAArmTreatment,
				Verdict:        "pass",
				DurationMS:     duration,
				TokensIn:       inTok,
				TokensOut:      outTok,
				ComplexityTier: string(comp.Tier),
				ExperimentID:   expID,
				ArmID:          armID,
				FlowHash:       flowHash,
				QAEngineRev:    qa.QAEngineRev,
			}
			if err != nil {
				cr.Verdict = "error"
			} else {
				checklist := strings.TrimSpace(out)
				if checklist != "" {
					finalPrompt += "\n\n## EARS Intent Checklist\n" + checklist
				}
			}
			_, _ = store.RecordQACheckRun(ctx, cr, nil)
		}
	}

	if spec.S2PlanCritic {
		if comp.Tier == qa.ComplexityHigh || slices.Contains(spec.S2PlanCriticConfig.Complexities, string(comp.Tier)) {
			timeout := time.Duration(spec.S2PlanCriticConfig.MaxSeconds) * time.Second
			if timeout <= 0 || timeout > 45*time.Second {
				timeout = 45 * time.Second
			}
			runCtx, cancel := context.WithTimeout(ctx, timeout)

			start := time.Now()
			out, inTok, outTok, err := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s2", "Provide concise caller/companion/scope critique points for task: "+task.Title+"\n"+task.Body, int(spec.S2PlanCriticConfig.MaxTokens))
			duration := time.Since(start).Milliseconds()
			cancel()

			cr := model.QACheckRun{
				TaskID:         task.ID,
				RunID:          task.ID + "-qa-s2",
				Stage:          "S2",
				CheckID:        "qa:plan-critic",
				Arm:            model.QAArmTreatment,
				Verdict:        "pass",
				DurationMS:     duration,
				TokensIn:       inTok,
				TokensOut:      outTok,
				ComplexityTier: string(comp.Tier),
				ExperimentID:   expID,
				ArmID:          armID,
				FlowHash:       flowHash,
				QAEngineRev:    qa.QAEngineRev,
			}
			if err != nil {
				cr.Verdict = "error"
			} else {
				critique := strings.TrimSpace(out)
				if critique != "" {
					finalPrompt += "\n\n## S2 Plan Critique\n" + critique
				}
			}
			_, _ = store.RecordQACheckRun(ctx, cr, nil)
		}
	}

	return finalPrompt
}
