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
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/agent"
	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/orchestrator"
	"github.com/ai-on-gke/grain/pkg/qa"
)

func commitAndPushFile(t *testing.T, bareRepo, branch, relFile, content, msg string) string {
	t.Helper()
	work := filepath.Join(t.TempDir(), "clone")
	for _, args := range [][]string{
		{"-c", "safe.bareRepository=all", "clone", "-q", bareRepo, work},
	} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git clone: %v (%s)", err, out)
		}
	}
	if out, err := exec.Command("git", "-C", work, "checkout", "-q", "-B", branch).CombinedOutput(); err != nil {
		t.Fatalf("git checkout -B %s: %v (%s)", branch, err, out)
	}
	full := filepath.Join(work, relFile)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"-C", work, "config", "user.email", "agent@example.com"},
		{"-C", work, "config", "user.name", "agent"},
		{"-C", work, "add", "."},
		{"-C", work, "commit", "-q", "-m", msg},
		{"-C", work, "push", "-q", "-f", "origin", branch},
	} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	shaOut, err := exec.Command("git", "-C", work, "rev-parse", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	return strings.TrimSpace(string(shaOut))
}

func enableTestQA(t *testing.T, ctx context.Context, store *model.Store, rolloutPct int) {
	t.Helper()
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "safe.bareRepository")
	t.Setenv("GIT_CONFIG_VALUE_0", "all")
	cfg, err := store.GetConfig(ctx)
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	var next model.Config
	if cfg != nil {
		next = *cfg
	}
	next.QA = model.QAConfig{
		Enabled:         true,
		FlowID:          model.QAFlowGoldenV1Minimal,
		RolloutPct:      rolloutPct,
		ShadowOnControl: model.BoolPtr(true),
		Epoch:           1,
		RegimeID:        1,
	}
	if err := store.PutConfig(ctx, next); err != nil {
		t.Fatalf("PutConfig QA: %v", err)
	}
}

func TestQATreatmentT1StagingRefPromotesAndOpensPRCleanly(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}
	task := filedTask(t, ctx, store, "qat1", repo)

	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         model.ResolveQARootOrigin(task.WorkOrigin, task.ID),
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowGoldenV1Minimal,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}

	stageBranch := model.QAStageBranchName(task.ID)
	prBranch := task.BranchName()
	sha := commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/calc/sum.go",
		"package calc\nfunc Sum(a, b int) int { return a + b }\n",
		"Add Sum helper\n\nImplements integer addition.")

	// Before orchestrator.OpenPullRequestForTaskWithQA, the real PR branch does not exist on GitHub.
	if exists, _ := client.BranchExists(repo.Owner, repo.Name, prBranch); exists {
		t.Fatalf("expected PR branch %s not to exist before QA promotion", prBranch)
	}

	status, err := orchestrator.OpenPullRequestForTaskWithQA(ctx, store, client, task, orchestrator.QAOpenPROptions{})
	if err != nil {
		t.Fatalf("orchestrator.OpenPullRequestForTaskWithQA: %v", err)
	}
	if status.PullRequest.Number == 0 || len(sim.PullRequests) != 1 {
		t.Fatalf("expected 1 opened PR on T1 after promotion, got status=%+v prs=%+v", status, sim.PullRequests)
	}
	head, err := client.GetBranchHead(repo.Owner, repo.Name, prBranch)
	if err != nil || head == nil || head.SHA != sha {
		t.Fatalf("promoted PR branch head = %+v (err=%v), want SHA %s", head, err, sha)
	}
	if stageStillThere, _ := client.BranchExists(repo.Owner, repo.Name, stageBranch); stageStillThere {
		t.Fatalf("expected temporary staging branch %s to be deleted after promotion", stageBranch)
	}
}

func TestQATreatmentT2AlreadyOpenPRNeverLeaksUnverifiedStageAndRunsBoundedS4(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}
	task := filedTask(t, ctx, store, "qat2", repo)

	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         model.ResolveQARootOrigin(task.WorkOrigin, task.ID),
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowGoldenV1Minimal,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}

	dataDir := t.TempDir()
	s4Calls := 0
	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		DataDir:  dataDir,
		Profiler: qa.NewProfiler(filepath.Join(dataDir, "perf", "qa.jsonl")),
		ResolveRemote: func(_ context.Context, _ model.RepoRef) (string, string, error) {
			return sim.BareRepo, "", nil
		},
		VerifyS4: func(_ context.Context, _ model.Task, _ string) (string, int64, int64, error) {
			s4Calls++
			// Emit 1 valid grounded defect on line 4 of pkg/staterepo/loader.go + 1 theater nit.
			return `[
				{
					"file": "pkg/staterepo/loader.go",
					"line": 4,
					"category": "logic_bug",
					"trigger_scenario": "When input slice is empty, ` + "`LoadItems`" + ` panics with index 0 out of range.",
					"fix_hint": "Guard ` + "`len(items) == 0`" + ` before indexing ` + "`items[0]`" + `."
				},
				{
					"file": "pkg/staterepo/loader.go",
					"line": 2,
					"category": "nit",
					"theater_tag": "PEDANTIC_ESCALATION",
					"trigger_scenario": "Style suggestion that Inquisitor must filter out.",
					"fix_hint": "Ignore."
				}
			]`, 320, 95, nil
		},
	})
	t.Cleanup(func() { orchestrator.SetLiveQARuntime(nil) })

	// Suppose PR #1 is already open on prBranch at sha1.
	prBranch := task.BranchName()
	sha1 := commitAndPushFile(t, sim.BareRepo, prBranch, "pkg/staterepo/loader.go",
		"package staterepo\nfunc LoadItems(items []string) string { return \"ok\" }\n",
		"Initial loader\n\nSafe baseline.")
	initialPR, err := orchestrator.OpenPullRequestForTask(ctx, store, client, task)
	if err != nil || initialPR.PullRequest.Number == 0 {
		t.Fatalf("initial OpenPullRequestForTask: %v", err)
	}

	// Turn 2 pushes unverified T2 commit sha2 to grain-qa-stage/qat2 and calls orchestrator.OpenPullRequestForTaskWithQA.
	stageBranch := model.QAStageBranchName(task.ID)
	sha2 := commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/staterepo/loader.go",
		"package staterepo\nfunc LoadItems(items []string) string {\n\tfirst := items[0]\n\treturn first\n}\n",
		"Update loader\n\nReads first element.")

	_ = sha2
	deferredStatus, err := orchestrator.OpenPullRequestForTaskWithQA(ctx, store, client, task, orchestrator.QAOpenPROptions{})
	if err != nil {
		t.Fatalf("orchestrator.OpenPullRequestForTaskWithQA T2 defer: %v", err)
	}
	if deferredStatus.PullRequest.Number != 0 || !strings.Contains(deferredStatus.Note, "S4 verification") {
		t.Fatalf("expected deferred S4 note without promoting PR branch, got %+v", deferredStatus)
	}
	// Live PR branch on GitHub MUST still point at sha1 (zero unverified commit leakage!).
	liveHead, _ := client.GetBranchHead(repo.Owner, repo.Name, prBranch)
	if liveHead == nil || liveHead.SHA != sha1 {
		t.Fatalf("live PR branch leaked unverified commit: got %+v, want %s", liveHead, sha1)
	}

	// Now finish/salvage runs after coding turn ends -> runs S3 + 1-round S4 + Inquisitor -> requeues 1 repair!
	now := time.Date(2026, 11, 12, 21, 0, 0, 0, time.UTC)
	salvaged, err := orchestrator.SalvagePushedBranch(ctx, store, client, task, now)
	if err != nil || !salvaged {
		t.Fatalf("SalvagePushedBranch(round 1) = (%v, %v), want (true, nil)", salvaged, err)
	}
	if s4Calls != 1 {
		t.Fatalf("s4Calls = %d, want 1", s4Calls)
	}
	// Live PR branch STILL stays at sha1 while repair is queued!
	liveHeadAfterS4, _ := client.GetBranchHead(repo.Owner, repo.Name, prBranch)
	if liveHeadAfterS4 == nil || liveHeadAfterS4.SHA != sha1 {
		t.Fatalf("live PR branch moved despite S4 defect finding: got %+v, want %s", liveHeadAfterS4, sha1)
	}
	obs, _ := store.GetObservation(ctx, task.ID)
	if obs == nil || obs.RetryRequestedAt == nil || obs.CompletedAt != nil {
		t.Fatalf("expected task queued for 1 bounded repair turn, got obs=%+v", obs)
	}

	// Repair turn pushes fixed sha3 to stageBranch and finishes: S4 does NOT run a second time (s4Calls stays 1)
	// and sha3 promotes cleanly to prBranch!
	sha3 := commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/staterepo/loader.go",
		"package staterepo\nfunc LoadItems(items []string) string {\n\tif len(items) == 0 { return \"\" }\n\treturn items[0]\n}\n",
		"Fix empty slice check\n\nGuards empty slice.")
	salvaged2, err := orchestrator.SalvagePushedBranch(ctx, store, client, task, now.Add(time.Minute))
	if err != nil || !salvaged2 {
		t.Fatalf("SalvagePushedBranch(round 2) = (%v, %v), want (true, nil)", salvaged2, err)
	}
	if s4Calls != 1 {
		t.Fatalf("expected hard 1-round S4 cap (s4Calls=1), got %d", s4Calls)
	}
	promotedHead, _ := client.GetBranchHead(repo.Owner, repo.Name, prBranch)
	if promotedHead == nil || promotedHead.SHA != sha3 {
		t.Fatalf("expected promoted PR branch at %s, got %+v", sha3, promotedHead)
	}
}

func TestQASalvageS3FailureRequeuesOnceThenHoldsWithGateQA(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}
	task := filedTask(t, ctx, store, "qahold", repo)
	if err := store.UpdateTask(ctx, task.ID, func(tk *model.Task) error {
		tk.AutoMerge = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         model.ResolveQARootOrigin(task.WorkOrigin, task.ID),
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowDeterministicS3Only,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatal(err)
	}

	dataDir := t.TempDir()
	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		DataDir:  dataDir,
		Profiler: qa.NewProfiler(filepath.Join(dataDir, "perf", "qa.jsonl")),
		ResolveRemote: func(_ context.Context, _ model.RepoRef) (string, string, error) {
			return sim.BareRepo, "", nil
		},
	})
	t.Cleanup(func() { orchestrator.SetLiveQARuntime(nil) })

	stageBranch := model.QAStageBranchName(task.ID)
	badDecoder := "package config\nimport (\n\t\"bytes\"\n\t\"gopkg.in/yaml.v3\"\n)\ntype Config struct{ Name string }\nfunc Parse(b []byte) error {\n\tvar v Config\n\treturn yaml.NewDecoder(bytes.NewReader(b)).Decode(&v)\n}\n"
	commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/config/parse.go", badDecoder, "Add config parser\n\nBody.")

	now := time.Date(2026, 11, 12, 21, 10, 0, 0, time.UTC)
	// First exit without open_pull_request: requeues 1 repair without opening a GitHub PR.
	if _, err := orchestrator.SalvagePushedBranch(ctx, store, client, task, now); err != nil {
		t.Fatalf("SalvagePushedBranch 1: %v", err)
	}
	if len(sim.PullRequests) != 0 {
		t.Fatalf("expected 0 PRs opened before repair retry, got %+v", sim.PullRequests)
	}

	// Second exit still failing S3: retry cap reached -> opens PR held by GateQA with AutoMerge=false!
	commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/config/parse.go", badDecoder+"\n// still missing KnownFields\n", "Second attempt\n\nBody.")
	if _, err := orchestrator.SalvagePushedBranch(ctx, store, client, task, now.Add(time.Minute)); err != nil {
		t.Fatalf("SalvagePushedBranch 2: %v", err)
	}
	if len(sim.PullRequests) != 1 {
		t.Fatalf("expected 1 held PR after retry cap, got %+v", sim.PullRequests)
	}
	reloaded, err := store.GetTask(ctx, task.ID)
	if err != nil || reloaded == nil {
		t.Fatalf("GetTask: %v", err)
	}
	if reloaded.AutoMerge {
		t.Fatal("expected AutoMerge withdrawn on unresolved GateQA hold")
	}
	obs, _ := store.GetObservation(ctx, task.ID)
	gates := model.ComputeMergeGates(*reloaded, obs, nil)
	foundQAGate := false
	for _, g := range gates {
		if g.ID == model.GateQA && g.State == model.GateStateFindings {
			foundQAGate = true
		}
	}
	if !foundQAGate {
		t.Fatalf("expected GateQA in GateStateFindings, got gates=%+v", gates)
	}
}

func TestQARunCyclePromptAndCheckoutUseStagingBranchOnTreatment(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}

	remoteBase := t.TempDir()
	dst := filepath.Join(remoteBase, repo.Owner, repo.Name+".git")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sim.BareRepo, dst); err != nil {
		t.Fatal(err)
	}

	task := filedTask(t, ctx, store, "qacycle", repo)
	stageBranch := model.QAStageBranchName(task.ID)

	var sawPrompt string
	var sawRequireOpenPR bool
	fw := openingFramework{agentFunc(func(_ context.Context, cfg agent.RunConfig) (*agent.Result, error) {
		sawPrompt = cfg.Prompt
		sawRequireOpenPR = cfg.RequireOpenPullRequest
		wd := filepath.Join(cfg.SandboxRoot, "work")
		if err := os.WriteFile(filepath.Join(wd, "hello.txt"), []byte("clean\n"), 0o644); err != nil {
			return nil, err
		}
		for _, args := range [][]string{
			{"-C", wd, "config", "user.email", "agent@example.com"},
			{"-C", wd, "config", "user.name", "agent"},
			{"-C", wd, "add", "hello.txt"},
			{"-C", wd, "commit", "-q", "-m", "Add hello\n\nBody."},
			{"-C", wd, "push", "-q", "origin", task.BranchName() + ":" + stageBranch},
		} {
			if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
				return nil, fmt.Errorf("git %v: %v (%s)", args, err, out)
			}
		}
		return &agent.Result{ToolCalls: []agent.ToolCall{
			{Name: "open_pull_request"},
		}}, nil
	})}

	deps := orchestrator.Deps{
		Store:     store,
		Client:    client,
		Sandboxes: orchestrator.NewHostSandboxes(t.TempDir()),
		Config: orchestrator.Config{
			GitRemoteBase: remoteBase,
			QAProfiler:    qa.NewProfiler(filepath.Join(t.TempDir(), "qa.jsonl")),
		},
		Framework:  orchestrator.StaticFramework(fw),
		MaxWorkers: 1,
	}
	if err := orchestrator.RunCycle(ctx, deps, baseTime); err != nil {
		t.Fatalf("RunCycle: %v", err)
	}
	if !strings.Contains(sawPrompt, stageBranch) || !strings.Contains(sawPrompt, "## Pre-PR Quality Contract") {
		t.Fatalf("expected treatment prompt to name %s and include SKILL.md, got prompt excerpt: %.400s", stageBranch, sawPrompt)
	}
	if !sawRequireOpenPR {
		t.Fatal("expected RunConfig.RequireOpenPullRequest = true on treatment run")
	}
	if len(sim.PullRequests) != 1 || sim.PullRequests[0].Head != task.BranchName() {
		t.Fatalf("expected promoted PR on %s, got %+v", task.BranchName(), sim.PullRequests)
	}
}

func TestQATreatmentS3RetryCapHoldsPRAndPreservesOwnerRepoWorkOrigin(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	if got := model.ResolveQARootOrigin("acme/widgets#12", "task-99"); got != "acme/widgets#12" {
		t.Fatalf("ResolveQARootOrigin(owner/repo#N) = %q, want %q", got, "acme/widgets#12")
	}

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}
	task := filedTask(t, ctx, store, "qacap", repo)
	if err := store.UpdateTask(ctx, task.ID, func(tk *model.Task) error {
		tk.AutoMerge = true
		tk.WorkOrigin = "acme/widgets#12"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fresh, _ := store.GetTask(ctx, task.ID)
	task = *fresh

	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         "acme/widgets#12",
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowDeterministicS3Only,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatal(err)
	}

	dataDir := t.TempDir()
	orchestrator.SetLiveQARuntime(&orchestrator.QARuntime{
		DataDir:  dataDir,
		Profiler: qa.NewProfiler(filepath.Join(dataDir, "perf", "qa.jsonl")),
		ResolveRemote: func(_ context.Context, _ model.RepoRef) (string, string, error) {
			return sim.BareRepo, "", nil
		},
	})
	t.Cleanup(func() { orchestrator.SetLiveQARuntime(nil) })

	stageBranch := model.QAStageBranchName(task.ID)
	badDecoder := "package config\nimport \"gopkg.in/yaml.v3\"\ntype Config struct{ Name string }\nfunc Parse(b []byte) error {\n\tvar v Config\n\treturn yaml.Unmarshal(b, &v)\n}\n"
	commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/config/parse.go", badDecoder, "Add config parser\n\nBody.")

	// Attempt < 3 (AllowHoldAfterS3Cap=false) must refuse PR creation and leave stage unpromoted.
	if _, err := orchestrator.OpenPullRequestForTaskWithQA(ctx, store, client, task, orchestrator.QAOpenPROptions{
		AllowHoldAfterS3Cap: false,
	}); err == nil {
		t.Fatal("expected orchestrator.OpenPullRequestForTaskWithQA to fail before S3 retry cap")
	}
	if len(sim.PullRequests) != 0 {
		t.Fatalf("expected 0 PRs before S3 retry cap, got %+v", sim.PullRequests)
	}

	// Attempt >= 3 (AllowHoldAfterS3Cap=true) promotes onto a held PR with AutoMerge stripped and GateQA findings.
	status, err := orchestrator.OpenPullRequestForTaskWithQA(ctx, store, client, task, orchestrator.QAOpenPROptions{
		AllowHoldAfterS3Cap: true,
	})
	if err != nil || status.PullRequest.Number == 0 {
		t.Fatalf("orchestrator.OpenPullRequestForTaskWithQA(AllowHoldAfterS3Cap=true) = (%+v, %v)", status, err)
	}
	reloaded, _ := store.GetTask(ctx, task.ID)
	if reloaded.AutoMerge {
		t.Fatal("expected AutoMerge withdrawn when PR opened under S3 retry cap")
	}
	obs, _ := store.GetObservation(ctx, task.ID)
	gates := model.ComputeMergeGates(*reloaded, obs, nil)
	foundQA := false
	for _, g := range gates {
		if g.ID == model.GateQA && g.State == model.GateStateFindings {
			foundQA = true
		}
	}
	if !foundQA {
		t.Fatalf("expected GateQA in GateStateFindings on held PR, got %+v", gates)
	}
}


func TestQAStageBranchLeakIsEliminated(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}
	task := filedTask(t, ctx, store, "qatleak", repo)
	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         model.ResolveQARootOrigin(task.WorkOrigin, task.ID),
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowGoldenV1Minimal,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}
	
	stageBranch := model.QAStageBranchName(task.ID)
	// Simulate the agent pushing to the staging branch.
	commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/config/parse.go", "package config\n", "fix the thing")
	
	// Set the history.PushBranch which the agent would have set.
	
	
	// Promote and open PR.
	status, err := orchestrator.OpenPullRequestForTaskWithQA(ctx, store, client, task, orchestrator.QAOpenPROptions{})
	if err != nil {
		t.Fatalf("orchestrator.OpenPullRequestForTaskWithQA: %v", err)
	}
	if status.PullRequest.Number == 0 {
		t.Fatalf("expected PR to be opened")
	}
	
	if len(sim.PullRequests) == 0 {
		t.Fatalf("expected PR in sim")
	}
	pr := sim.PullRequests[0]
	if strings.Contains(pr.Head, "grain-qa-stage") {
		t.Fatalf("PR head leaks grain-qa-stage: %s", pr.Head)
	}
	if strings.Contains(pr.Title, "grain-qa-stage") || strings.Contains(pr.Body, "grain-qa-stage") {
		t.Fatalf("PR metadata leaks grain-qa-stage: title=%q, body=%q", pr.Title, pr.Body)
	}
	
	// Also ensure no commits in the PR have grain-qa-stage.
	commits, err := client.ListPullRequestCommits(repo.Owner, repo.Name, pr.Number)
	if err != nil {
		t.Fatalf("ListPullRequestCommits: %v", err)
	}
	for _, c := range commits {
		if strings.Contains(c.Message, "grain-qa-stage") {
			t.Fatalf("Commit message leaks grain-qa-stage: %q", c.Message)
		}
	}
}

func TestQASalvagePromotesDisabledQA(t *testing.T) {
	store, ctx := openStore(t)
	enableTestQA(t, ctx, store, 100)

	sim, client := newSim(t, "acme", "widgets", "main")
	repo := model.RepoRef{Owner: "acme", Name: "widgets"}
	task := filedTask(t, ctx, store, "qatsalvage", repo)

	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         model.ResolveQARootOrigin(task.WorkOrigin, task.ID),
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowGoldenV1Minimal,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}

	stageBranch := model.QAStageBranchName(task.ID)
	commitAndPushFile(t, sim.BareRepo, stageBranch, "pkg/config/parse.go", "package config\n", "fix the thing")

	// Disable QA
	enableTestQA(t, ctx, store, 0)

	handled, err := orchestrator.SalvageQAStageIfPresent(ctx, store, client, task, time.Now())
	if err != nil {
		t.Fatalf("salvageQAStageIfPresent: %v", err)
	}
	if handled {
		t.Fatalf("expected handled=false, got true")
	}

	// Verify it was promoted.
	promotedHead, err := client.GetBranchHead(repo.Owner, repo.Name, task.BranchName())
	if err != nil || promotedHead == nil {
		t.Fatalf("expected promoted PR branch at %s, got error %v", task.BranchName(), err)
	}
}
