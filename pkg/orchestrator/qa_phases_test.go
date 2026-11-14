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

package orchestrator_test

import (
	"context"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/orchestrator"
	"github.com/ai-on-gke/grain/pkg/qa"
	"github.com/ai-on-gke/grain/pkg/staterepo"
)

func TestExecutePreDispatchQAPhases(t *testing.T) {
	cfg := staterepo.MemoryConfig()
	store, _ := staterepo.Open(cfg)

	task := model.Task{ID: "task-1", Title: "Fix", Body: "Fix"}
	spec := &qa.FlowSpec{
		S0Intent: true,
		S0IntentConfig: qa.S0IntentDecl{MaxTokens: 100, MaxSeconds: 10},
		S2PlanCritic: true,
		S2PlanCriticConfig: qa.S2PlanCriticDecl{Complexities: []string{"low", "medium"}},
	}
	
	s0, s2 := false, false
	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		RunIsolatedPrompt: func(ctx context.Context, task model.Task, runPrefix, prompt string, maxTokens int) (string, int64, int64, error) {
			if strings.HasSuffix(runPrefix, "-qa-s0") { s0 = true; return "S0", 1, 1, nil }
			if strings.HasSuffix(runPrefix, "-qa-s2") { s2 = true; return "S2", 1, 1, nil }
			return "", 0, 0, nil
		},
	})
	
	orchestrator.ExecutePreDispatchQAPhases(context.Background(), store, task, spec, "exp", "arm", "hash", "prompt")
	if !s0 || !s2 {
		t.Errorf("Failed to call s0 or s2")
	}
}
