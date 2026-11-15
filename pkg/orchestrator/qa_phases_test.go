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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func TestExecutePreCloneQAPhaseAskHumanHoldsWithoutCloning(t *testing.T) {
	store, ctx := openTestStore(t)

	prev := orchestrator.LiveQARuntime()
	t.Cleanup(func() { orchestrator.SetLiveQARuntime(prev) })

	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		RunIsolatedPrompt: func(_ context.Context, _ model.Task, runPrefix, _ string, _ int) (string, int64, int64, error) {
			if strings.HasSuffix(runPrefix, "-qa-s0") {
				return "status: needs_clarification\nquestion: Should expired sessions return 401 or redirect to /login?", 35, 20, nil
			}
			return "", 0, 0, nil
		},
	})

	askHumanSpec := &qa.FlowSpec{
		S0Intent:        true,
		IntentSkillText: "Check ambiguity",
		S0IntentConfig: qa.S0IntentDecl{
			Enabled:         true,
			Complexities:    []string{"low", "medium", "high"},
			MaxSeconds:      10,
			MaxTokens:       10000,
			OnClarification: "ask_human",
		},
	}

	taskHold := model.Task{ID: "s0-hold-1", Title: "Handle expired sessions", Body: "Update auth middleware behavior."}
	resHold := orchestrator.ExecutePreCloneQAPhase(ctx, store, taskHold, askHumanSpec, "exp-v4", "golden-v4", "sha256:v4", "base-prompt")
	if !resHold.NeedsClarification {
		t.Fatalf("expected NeedsClarification=true when OnClarification=ask_human, got %+v", resHold)
	}
	if !strings.Contains(resHold.Question, "Should expired sessions return 401 or redirect to /login?") {
		t.Fatalf("unexpected extracted question: %q", resHold.Question)
	}
	runsHold, err := store.ListQACheckRunsForTask(ctx, taskHold.ID)
	if err != nil || len(runsHold) != 1 || runsHold[0].Stage != "S0" || runsHold[0].Verdict != "hold" {
		t.Fatalf("expected 1 S0 check run with verdict=hold, got %+v (err=%v)", runsHold, err)
	}

	warnSpec := *askHumanSpec
	warnSpec.S0IntentConfig.OnClarification = "warn"
	taskWarn := model.Task{ID: "s0-warn-1", Title: "Handle expired sessions", Body: "Update auth middleware behavior."}
	resWarn := orchestrator.ExecutePreCloneQAPhase(ctx, store, taskWarn, &warnSpec, "exp-v4", "golden-v4", "sha256:v4", "base-prompt")
	if resWarn.NeedsClarification {
		t.Fatalf("expected NeedsClarification=false when OnClarification=warn, got %+v", resWarn)
	}
	if !strings.Contains(resWarn.Prompt, "## EARS Intent Checklist") {
		t.Fatalf("expected EARS checklist appended on warn, got %q", resWarn.Prompt)
	}
	runsWarn, err := store.ListQACheckRunsForTask(ctx, taskWarn.ID)
	if err != nil || len(runsWarn) != 1 || runsWarn[0].Verdict != "warn" {
		t.Fatalf("expected 1 S0 check run with verdict=warn, got %+v (err=%v)", runsWarn, err)
	}
}

func TestExecutePostCloneWorkflowPhasesContextDecomposeCriticAndCodingGuidance(t *testing.T) {
	store, ctx := openTestStore(t)

	prev := orchestrator.LiveQARuntime()
	t.Cleanup(func() { orchestrator.SetLiveQARuntime(prev) })

	worktree := t.TempDir()
	if err := os.MkdirAll(filepath.Join(worktree, "pkg", "calc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(worktree, "pkg", "service"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "pkg", "calc", "math.go"), []byte("package calc\n\nfunc Add(a, b int) int { return a + b }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "pkg", "service", "runner.go"), []byte("package service\n\nimport \"github.com/acme/widgets/pkg/calc\"\n\nfunc Run() int { return calc.Add(1, 2) }\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var s2Prompts []string
	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		RunIsolatedPrompt: func(_ context.Context, _ model.Task, runPrefix, prompt string, _ int) (string, int64, int64, error) {
			if strings.Contains(runPrefix, "-qa-s2") {
				s2Prompts = append(s2Prompts, prompt)
				if len(s2Prompts) == 1 {
					return "REVISE_PLAN: also update caller in pkg/service/runner.go", 80, 30, nil
				}
				return "Plan verified: update pkg/calc/math.go and caller pkg/service/runner.go", 90, 25, nil
			}
			return "", 0, 0, nil
		},
	})

	spec := &qa.FlowSpec{
		Context: qa.ContextDiscoveryDecl{
			Enabled:        true,
			IncludeCallers: true,
			MaxTokens:      1500,
			ExtraPaths:     []string{"pkg/calc/math.go"},
		},
		Decompose: qa.DecomposeDecl{
			Enabled:         true,
			Mode:            "slice_plan",
			Complexities:    []string{"low", "medium", "high"},
			TargetDiffLines: 180,
			MaxSubtasks:     3,
		},
		RiskOverrides: []qa.RiskOverride{
			{Paths: []string{"pkg/calc/**"}, MinTier: "T2", Reason: "shared math library"},
		},
		S2PlanCritic:        true,
		PlanCriticSkillText: "Verify sibling importers.",
		S2PlanCriticConfig: qa.S2PlanCriticDecl{
			Enabled:      true,
			Complexities: []string{"high"},
			Tiers:        []string{"T2", "T3"},
			MaxSeconds:   15,
			MaxTokens:    20000,
			MaxBounces:   2,
		},
		ReadabilityPacks: []qa.ReadabilityPackDecl{
			{ID: "go-readability", Enabled: true, Globs: []string{"**/*.go"}, CustomText: "Use table-driven subtests."},
		},
		SkillSteps: []qa.SkillStepDecl{
			{ID: "step-coding", Label: "Caller Contract", Stage: "coding", Enabled: true, Text: "Keep exported signatures backward-compatible."},
		},
		PRContract: qa.PRContractDecl{
			Enabled:      true,
			GuidanceText: "Document any lint directive inline.",
		},
	}

	// Low-complexity task that touches pkg/calc/math.go (promoted to T2 via RiskOverrides),
	// verifying S2PlanCriticConfig.Tiers triggers S2 even when complexity is low.
	task := model.Task{
		ID:    "post-clone-1",
		Title: "Update Add in pkg/calc/math.go",
		Body:  "Support overflow check in pkg/calc/math.go.",
	}

	out := orchestrator.ExecutePostCloneWorkflowPhases(ctx, store, task, worktree, spec, "exp-v4", "golden-v4", "sha256:v4", "base-prompt")

	for _, want := range []string{
		"## Codebase & Caller Context",
		"<codebase-context>",
		"pkg/calc/math.go",
		"pkg/service",
		"## Subtask Decomposition (slice_plan)",
		"180 diff lines",
		"## S2 Plan Critique",
		"Plan verified: update pkg/calc/math.go and caller pkg/service/runner.go",
		"Use table-driven subtests.",
		"Keep exported signatures backward-compatible.",
		"Document any lint directive inline.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("post-clone prompt missing %q in:\n%s", want, out)
		}
	}

	// S2 must have received the discovered <codebase-context> and executed 1 initial pass + 1 bounce.
	if len(s2Prompts) != 2 {
		t.Fatalf("expected 2 S2 critic calls (initial + 1 REVISE_PLAN bounce), got %d", len(s2Prompts))
	}
	if !strings.Contains(s2Prompts[0], "<codebase-context>") || !strings.Contains(s2Prompts[0], "pkg/service") {
		t.Fatalf("expected S2 prompt to contain discovered <codebase-context> and sibling caller pkg/service, got:\n%s", s2Prompts[0])
	}

	runs, err := store.ListQACheckRunsForTask(ctx, task.ID)
	if err != nil {
		t.Fatalf("ListQACheckRunsForTask: %v", err)
	}
	stages := map[string]model.QACheckRun{}
	for _, r := range runs {
		stages[r.Stage] = r
	}
	if r, ok := stages["S1"]; !ok || r.CheckID != "qa:context-discovery" || r.Verdict != "pass" {
		t.Fatalf("expected S1 qa:context-discovery pass check run, got %+v", stages)
	}
	if r, ok := stages["S0b"]; !ok || r.CheckID != "step:goal-subtask-decomposer" || r.Verdict != "pass" {
		t.Fatalf("expected S0b decomposer pass check run, got %+v", stages)
	}
	if r, ok := stages["S2"]; !ok || r.CheckID != "qa:plan-critic" || r.Verdict != "pass" || r.TokensIn != 170 {
		t.Fatalf("expected S2 plan-critic pass check run with accumulated tokens, got %+v", stages["S2"])
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

	// 3. Control arm with ShadowOnControl=true must NEVER lose AutoMerge or receive LinkQATriageHold even when spec.Mode == "enforced".
	ctrlTask := model.Task{
		ID:        "t2-ctrl-shadow",
		Title:     "Control UI task under shadow scoring",
		Target:    &repo,
		AutoMerge: true,
	}
	if err := store.PutTask(ctx, ctrlTask); err != nil {
		t.Fatalf("PutTask ctrlTask: %v", err)
	}
	ctrlAssign := &resolve.Resolution{
		ArmID:       model.QAArmControl,
		Shadow:      true,
		FlowID:      "golden-v3-enforced",
		FlowHash:    assign.FlowHash,
		QAEngineRev: qa.QAEngineRev,
		Spec:        enforcedSpec,
	}
	orchestrator.EvaluateAndApplyQATriage(ctx, store, nil, ctrlTask, ctrlAssign, "3333333333333333", []string{"ui-ng/src/app/inbox/inbox-page.component.ts"}, true)
	gotCtrl, err := store.GetTask(ctx, ctrlTask.ID)
	if err != nil {
		t.Fatalf("GetTask ctrlTask: %v", err)
	}
	if !gotCtrl.AutoMerge {
		t.Fatalf("control task under ShadowOnControl unexpectedly lost AutoMerge")
	}
	for _, l := range gotCtrl.Links {
		if l.Kind == model.LinkQATriageHold {
			t.Fatalf("control task must never get LinkQATriageHold watermark")
		}
	}
}

func TestEvaluateAndApplyQATriageSafetyFloorsMergeRulesTriggersAndCI(t *testing.T) {
	store, ctx := openTestStore(t)
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

	enforcedSpec := &qa.FlowSpec{
		ID: "golden-v4-enforced",
		S5MergeTriage: qa.TriageConfig{
			Mode:              "enforced",
			AutoMergeTiers:    []string{"T0", "T1"},
			RequireHumanTiers: []string{"T2", "T3"},
		},
	}
	assign := &resolve.Resolution{
		ExperimentID: "exp-v4",
		ArmID:        "golden-v4",
		FlowHash:     "sha256:v4enforced",
		Spec:         enforcedSpec,
		QAEngineRev:  qa.QAEngineRev,
	}

	assertRequireHumanDecision := func(t *testing.T, taskID string) {
		t.Helper()
		runs, err := store.ListQACheckRunsForTask(ctx, taskID)
		if err != nil || len(runs) == 0 {
			t.Fatalf("expected S5 check run for %s, got %+v (err=%v)", taskID, runs, err)
		}
		found := false
		for _, r := range runs {
			if r.Stage == "S5" {
				found = true
				if r.TriageDecision != string(qa.TriageRequireHuman) {
					t.Fatalf("task %s S5 TriageDecision = %q, want %q", taskID, r.TriageDecision, qa.TriageRequireHuman)
				}
			}
		}
		if !found {
			t.Fatalf("no S5 check run found for %s", taskID)
		}
	}

	// 1. MergeRulesRequireHuman floor: repo .grain/merge-rules.yml with auto_merge: never on pkg/util/**.
	repoMerge := model.RepoRef{Owner: "acme", Name: "mergerules-repo"}
	if _, err := store.SyncRepoDeclarations(ctx, repoMerge, "base111", model.RepoDeclarations{
		MergeRules: &model.MergeRules{
			Path:   ".grain/merge-rules.yml",
			Commit: "base111",
			Rules: []model.MergeRule{{
				ID:          "util-manual",
				Paths:       []string{"pkg/util/**"},
				MergePolicy: model.MergePolicy{AutoMerge: model.AutoMergeNever},
			}},
		},
	}, now, time.UTC); err != nil {
		t.Fatalf("SyncRepoDeclarations merge-rules: %v", err)
	}
	tMerge := model.Task{ID: "floor-mr", Title: "Leaf helper", Target: &repoMerge, AutoMerge: true}
	if err := store.PutTask(ctx, tMerge); err != nil {
		t.Fatal(err)
	}
	orchestrator.EvaluateAndApplyQATriage(ctx, store, nil, tMerge, assign, "aaaa1111", []string{"pkg/util/str.go"}, true)
	assertRequireHumanDecision(t, tMerge.ID)

	// 2. GateTriggerMatched floor: repo .grain/triggers/*.yml with Gate: true matching pkg/util/**.
	repoTrig := model.RepoRef{Owner: "acme", Name: "trigger-repo"}
	if _, err := store.SyncRepoDeclarations(ctx, repoTrig, "base222", model.RepoDeclarations{
		Triggers: []model.PathTrigger{{
			Name:     "util-gate",
			Path:     ".grain/triggers/util-gate.yml",
			On:       model.TriggerOnPullRequest,
			Paths:    []string{"pkg/util/**"},
			Template: "review",
			Gate:     true,
		}},
	}, now, time.UTC); err != nil {
		t.Fatalf("SyncRepoDeclarations triggers: %v", err)
	}
	tTrig := model.Task{ID: "floor-trig", Title: "Leaf helper", Target: &repoTrig, AutoMerge: true}
	if err := store.PutTask(ctx, tTrig); err != nil {
		t.Fatal(err)
	}
	orchestrator.EvaluateAndApplyQATriage(ctx, store, nil, tTrig, assign, "bbbb2222", []string{"pkg/util/str.go"}, true)
	assertRequireHumanDecision(t, tTrig.ID)

	// 3. CIRedOrPending floor: failing GitHub CI job on the task's branch prevents auto_merge verdict.
	repoCI := model.RepoRef{Owner: "acme", Name: "ci-repo"}
	tCI := model.Task{ID: "floor-ci", Title: "Leaf helper", Target: &repoCI, Branch: "grain/task-floor-ci", AutoMerge: true}
	if err := store.PutTask(ctx, tCI); err != nil {
		t.Fatal(err)
	}
	if err := store.PutGitHubCIJob(ctx, model.GitHubCIJob{
		Repo:        repoCI.String(),
		CheckRunID:  9001,
		Source:      model.GitHubCISource,
		App:         model.GitHubActionsApp,
		Ref:         tCI.BranchName(),
		Commit:      "cccc3333",
		JobName:     "unit-tests",
		Conclusion:  "failure",
		CompletedAt: &now,
		RecordedAt:  now,
	}); err != nil {
		t.Fatalf("PutGitHubCIJob: %v", err)
	}
	orchestrator.EvaluateAndApplyQATriage(ctx, store, nil, tCI, assign, "cccc3333", []string{"pkg/util/str.go"}, true)
	assertRequireHumanDecision(t, tCI.ID)
}

func TestNoUberProxyInOrchestratorRunGo(t *testing.T) {
	raw, err := os.ReadFile("run.go")
	if err != nil {
		t.Fatalf("ReadFile run.go: %v", err)
	}
	content := string(raw)
	if strings.Contains(content, "UberProxy") {
		t.Fatalf("pkg/orchestrator/run.go still contains internal proxy product name 'UberProxy'")
	}
	if !strings.Contains(content, "an authenticating reverse proxy") {
		t.Fatalf("pkg/orchestrator/run.go missing 'an authenticating reverse proxy'")
	}
}
