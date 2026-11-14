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
	"github.com/ai-on-gke/grain/pkg/model/sqlite"
	"github.com/ai-on-gke/grain/pkg/orchestrator"
	"github.com/ai-on-gke/grain/pkg/qa"
	"github.com/ai-on-gke/grain/pkg/qa/resolve"
)

func openTestStore(t *testing.T) (*model.Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	db, err := sqlite.Open(sqlite.DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := model.New(db)
	if err := store.Init(ctx); err != nil {
		t.Fatalf("store.Init: %v", err)
	}
	return store, ctx
}

func TestExecutePreDispatchQAPhasesAndControlIsolation(t *testing.T) {
	store, ctx := openTestStore(t)

	prev := orchestrator.LiveQARuntime()
	t.Cleanup(func() { orchestrator.SetLiveQARuntime(prev) })

	s0Calls, s2Calls := 0, 0
	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		RunIsolatedPrompt: func(_ context.Context, _ model.Task, runPrefix, _ string, _ int) (string, int64, int64, error) {
			if strings.HasSuffix(runPrefix, "-qa-s0") {
				s0Calls++
				return "- WHEN input is empty SHALL return ErrInvalid", 42, 18, nil
			}
			if strings.HasSuffix(runPrefix, "-qa-s2") {
				s2Calls++
				return "- Update callers in pkg/ui/server.go", 65, 24, nil
			}
			return "", 0, 0, nil
		},
	})

	spec := &qa.FlowSpec{
		S0Intent:            true,
		IntentSkillText:     "Extract EARS criteria",
		S0IntentConfig:      qa.S0IntentDecl{MaxTokens: 15000, MaxSeconds: 10},
		S2PlanCritic:        true,
		PlanCriticSkillText: "Critique sibling callers",
		S2PlanCriticConfig:  qa.S2PlanCriticDecl{Complexities: []string{"low", "medium", "high"}, MaxTokens: 25000, MaxSeconds: 15},
	}

	task := model.Task{ID: "task-v3-1", Title: "Refactor auth handler", Body: "Tighten validation across packages"}

	// Control arm must NEVER invoke S0 or S2 even when a flow spec is present for shadow S3.
	ctrlOut := orchestrator.ExecutePreDispatchQAPhases(ctx, store, task, spec, "exp-1", model.QAArmControl, "sha256:v3", "base-skill")
	if ctrlOut != "base-skill" || s0Calls != 0 || s2Calls != 0 {
		t.Fatalf("control arm leaked S0/S2: out=%q s0=%d s2=%d", ctrlOut, s0Calls, s2Calls)
	}

	// Design-Item tasks must skip S0 while still allowing S2 when configured.
	designTask := model.Task{ID: "task-v3-design", Title: "Add endpoint", Body: "Design-Item: DI-42\nImplement route"}
	_ = orchestrator.ExecutePreDispatchQAPhases(ctx, store, designTask, spec, "exp-1", "golden-v3", "sha256:v3", "base-skill")
	if s0Calls != 0 || s2Calls != 1 {
		t.Fatalf("Design-Item gating mismatch: s0=%d (want 0), s2=%d (want 1)", s0Calls, s2Calls)
	}

	// Enforced treatment arm runs S0 + S2 and records telemetry rows.
	treatOut := orchestrator.ExecutePreDispatchQAPhases(ctx, store, task, spec, "exp-1", "golden-v3", "sha256:v3", "base-skill")
	if !strings.Contains(treatOut, "## EARS Intent Checklist") || !strings.Contains(treatOut, "## S2 Plan Critique") {
		t.Fatalf("expected S0 and S2 sections in prompt, got: %s", treatOut)
	}
	runs, err := store.ListQACheckRunsForTask(ctx, task.ID)
	if err != nil || len(runs) != 2 {
		t.Fatalf("expected 2 recorded check runs (S0, S2), got %d (err=%v)", len(runs), err)
	}
}

func TestEvaluateAndApplyQATriageEnforcesHoldOnT2AndPreservesT1AutoMerge(t *testing.T) {
	store, ctx := openTestStore(t)
	repo := model.RepoRef{Owner: "acme", Name: "grain"}

	enforcedSpec := &qa.FlowSpec{
		ID: "golden-v3-enforced",
		S5MergeTriage: qa.TriageConfig{
			Mode:              "enforced",
			AutoMergeTiers:    []string{"T0", "T1"},
			RequireHumanTiers: []string{"T2", "T3"},
		},
	}
	assign := &resolve.Resolution{
		ExperimentID: "exp-m16",
		ArmID:        "golden-v3",
		FlowHash:     "sha256:v3enforced",
		Spec:         enforcedSpec,
		QAEngineRev:  qa.QAEngineRev,
	}

	// 1. Clean T1 leaf Go change keeps AutoMerge=true and sets no LinkQATriageHold.
	t1 := model.Task{
		ID:        "t1-leaf",
		Title:     "Add string helper",
		Target:    &repo,
		AutoMerge: true,
	}
	if err := store.PutTask(ctx, t1); err != nil {
		t.Fatalf("PutTask t1: %v", err)
	}
	orchestrator.EvaluateAndApplyQATriage(ctx, store, nil, t1, assign, "1111111111111111", []string{"pkg/util/str.go", "pkg/util/str_test.go"}, true)
	gotT1, err := store.GetTask(ctx, t1.ID)
	if err != nil {
		t.Fatalf("GetTask t1: %v", err)
	}
	if !gotT1.AutoMerge {
		t.Fatalf("expected T1 task AutoMerge=true, got false")
	}

	// 2. T2 UI change under enforced S5 withdraws AutoMerge, sets LinkQATriageHold, and blocks agent release.
	t2 := model.Task{
		ID:        "t2-ui",
		Title:     "Update inbox toolbar",
		Target:    &repo,
		AutoMerge: true,
	}
	if err := store.PutTask(ctx, t2); err != nil {
		t.Fatalf("PutTask t2: %v", err)
	}
	orchestrator.EvaluateAndApplyQATriage(ctx, store, nil, t2, assign, "2222222222222222", []string{"ui-ng/src/app/inbox/inbox-page.component.ts"}, true)
	gotT2, err := store.GetTask(ctx, t2.ID)
	if err != nil {
		t.Fatalf("GetTask t2: %v", err)
	}
	if gotT2.AutoMerge {
		t.Fatalf("expected T2 task AutoMerge withdrawn (false), got true")
	}
	hasHold := false
	for _, l := range gotT2.Links {
		if l.Kind == model.LinkQATriageHold {
			hasHold = true
		}
	}
	if !hasHold {
		t.Fatalf("expected LinkQATriageHold on T2 task, links=%+v", gotT2.Links)
	}

	// Agent cannot release human review hold; human operator can.
	if _, err := store.ReleaseHumanReviewHold(ctx, t2.ID, model.Principal{Kind: model.PrincipalAgent, ID: "agent-1"}, "ship"); err == nil {
		t.Fatalf("expected PrincipalAgent ReleaseHumanReviewHold to be rejected")
	}
	if _, err := store.ReleaseHumanReviewHold(ctx, t2.ID, model.Principal{Kind: model.PrincipalHuman, ID: "alice@example.com"}, "reviewed"); err != nil {
		t.Fatalf("expected PrincipalHuman ReleaseHumanReviewHold to succeed, got %v", err)
	}
}
