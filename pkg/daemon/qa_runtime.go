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

package daemon

import (
	"context"
	"strings"
	"time"

	"github.com/ai-on-gke/grain/pkg/agent"
	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/orchestrator"
	"github.com/ai-on-gke/grain/pkg/secrets"
)

// resolveQAStageAgentChoices chooses the AgentChoice for lightweight isolated QA stages (S0/S2/S4).
// When the deployment explicitly configures Config.JudgementModel, QA stages route through it first
// (falling back to the task's own model/framework if unavailable) so slow-starting ambient coding
// CLIs can be bypassed by a configured judgement model. Priority is set because the parent task
// already holds its dispatch slot during pre/post-clone QA stages.
func resolveQAStageAgentChoices(
	ctx context.Context,
	store *model.Store,
	live Config,
	task model.Task,
) (primary orchestrator.AgentChoice, fallback *orchestrator.AgentChoice) {
	taskChoice := orchestrator.AgentChoice{
		Framework: strings.TrimSpace(task.AgentFramework),
		BackendID: strings.TrimSpace(task.AgentBackendID),
		Model:     strings.TrimSpace(task.Model),
		Priority:  true,
	}
	if store != nil {
		if stored, err := store.GetConfig(ctx); err == nil && stored != nil {
			if rawJM := strings.TrimSpace(stored.JudgementModel); rawJM != "" {
				jm := rawJM
				if model.IsJudgementModel(jm) {
					if resolved, ok := model.ResolveJudgementModel(*stored, live.AgentBackends); ok {
						jm = resolved
					} else {
						jm = ""
					}
				}
				if jm != "" {
					return orchestrator.AgentChoice{
						Model:    jm,
						Priority: true,
					}, &taskChoice
				}
			}
		}
	}
	return taskChoice, nil
}

func buildQAStageFramework(
	ctx context.Context,
	store *model.Store,
	cfg Config,
	buildFramework func(context.Context, orchestrator.AgentChoice) (agent.Framework, error),
	task model.Task,
) (agent.Framework, error) {
	live := DispatchConfig(ctx, store, cfg)
	primary, fallback := resolveQAStageAgentChoices(ctx, store, live, task)
	fw, err := buildFramework(ctx, primary)
	if (err != nil || fw == nil) && fallback != nil {
		if fb, fbErr := buildFramework(ctx, *fallback); fbErr == nil && fb != nil {
			return fb, nil
		}
	}
	return fw, err
}

func qaStageStartupOverhead(ctx context.Context, store *model.Store, cfg Config, task model.Task) time.Duration {
	live := DispatchConfig(ctx, store, cfg)
	primary, _ := resolveQAStageAgentChoices(ctx, store, live, task)

	fwName := strings.TrimSpace(primary.Framework)
	if fwName == "" && primary.BackendID != "" {
		if b := findBackendByID(live.AgentBackends, primary.BackendID); b != nil {
			fwName = b.Framework
		}
	}
	if fwName == "" && primary.Model != "" {
		fwName = model.ModelFramework(live.AgentBackends, model.DefaultTeamID, primary.Model)
	}
	if fwName == "" && store != nil {
		if stored, err := store.GetConfig(ctx); err == nil && stored != nil {
			if models := stored.DefaultModels(); len(models) > 0 {
				fwName = model.ModelFramework(live.AgentBackends, model.DefaultTeamID, models[0])
			}
			if fwName == "" && strings.TrimSpace(stored.AgentFramework) != "" {
				fwName = stored.AgentFramework
			}
		}
	}
	if fwName == "" {
		fwName = live.DefaultAgentFramework()
	}
	return orchestrator.CLIStartupOverheadForFramework(model.NormalizeAgentFramework(fwName))
}

// qaStageErrorRedactor redacts stored secrets and credential shapes from QA stage
// failure diagnostics before they are persisted into task_qa_check_run.detail_json.
// Like dispatchConditionRedactor, it fails closed when the secret store cannot be read.
func qaStageErrorRedactor(secretsDir string, secretStore *secrets.Store) func(string) string {
	return func(text string) string {
		if text == "" {
			return ""
		}
		redactor := grainLogRedactorFor(secretsDir, secretStore)
		if redactor == nil {
			return "(withheld: the redaction list could not be read -- the error is in the daemon's journal)"
		}
		out, _ := redactor.Text(text)
		return out
	}
}
