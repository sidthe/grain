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

package ui_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/capability/grainci"
	"github.com/ai-on-gke/grain/pkg/ci"
	"github.com/ai-on-gke/grain/pkg/github"
	"github.com/ai-on-gke/grain/pkg/gitproxy"
	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/model/sqlite"
	"github.com/ai-on-gke/grain/pkg/namespace"
	_ "github.com/ai-on-gke/grain/pkg/qa/resolve"
	"github.com/ai-on-gke/grain/pkg/ui"
)

type recordingCIRunner struct {
	ci.Runner
	started []ci.Request
	runs    map[string]ci.Run
}

func (r *recordingCIRunner) Start(_ context.Context, req ci.Request) (ci.Run, error) {
	r.started = append(r.started, req)
	now := time.Now().UTC()
	id := "run-stage-1"
	if len(r.started) > 1 {
		id = "run-stage-2"
	}
	run := ci.Run{
		ID:         id,
		Repo:       req.Repo,
		Ref:        req.Ref,
		Commit:     "abc1234567890",
		Conclusion: ci.ConclusionSuccess,
		StartedAt:  &now,
		FinishedAt: &now,
		Jobs: []ci.JobRun{{
			Name:       "unit",
			JobID:      "unit",
			Conclusion: ci.ConclusionSuccess,
		}},
	}
	if r.runs == nil {
		r.runs = map[string]ci.Run{}
	}
	r.runs[id] = run
	return run, nil
}

func (r *recordingCIRunner) Get(id string) (ci.Run, bool) {
	run, ok := r.runs[id]
	return run, ok
}

func (r *recordingCIRunner) Find(filter ci.RunFilter, _ int) ci.RunPage {
	var out []ci.Run
	for _, run := range r.runs {
		if filter.Repo != "" && !strings.EqualFold(run.Repo, filter.Repo) {
			continue
		}
		if filter.Ref != "" && run.Ref != filter.Ref {
			continue
		}
		out = append(out, run)
	}
	return ci.RunPage{Runs: out}
}

func (r *recordingCIRunner) List() []ci.Run {
	var out []ci.Run
	for _, run := range r.runs {
		out = append(out, run)
	}
	return out
}

func (r *recordingCIRunner) Cancel(string, string, ci.CancelSource) bool { return false }

func (r *recordingCIRunner) ArtifactStats(context.Context) (ci.ArtifactStats, bool, error) {
	return ci.ArtifactStats{}, false, nil
}

type fakeBranchChecker struct {
	branches map[string]string
}

func (f *fakeBranchChecker) GetPullRequest(string, string, int) (github.PullRequestDetail, error) {
	return github.PullRequestDetail{}, nil
}

func (f *fakeBranchChecker) BranchExists(_, _, branch string) (bool, error) {
	_, ok := f.branches[branch]
	return ok, nil
}

func (f *fakeBranchChecker) GetBranchHead(_, _, branch string) (*github.BranchHead, error) {
	sha, ok := f.branches[branch]
	if !ok {
		return nil, nil
	}
	return &github.BranchHead{SHA: sha}, nil
}

type bypassPRMock struct {
	calls []struct {
		taskID     string
		bypassedBy string
		reason     string
	}
	store *model.Store
}

func (b *bypassPRMock) OpenForTask(context.Context, string) (ui.PullRequestStatus, error) {
	return ui.PullRequestStatus{Number: 1, URL: "https://github.com/acme/app/pull/1"}, nil
}

func (b *bypassPRMock) BypassS3ForTask(ctx context.Context, taskID, bypassedBy, reason string) (ui.PullRequestStatus, error) {
	b.calls = append(b.calls, struct {
		taskID     string
		bypassedBy string
		reason     string
	}{taskID: taskID, bypassedBy: bypassedBy, reason: reason})
	detail, _ := json.Marshal(map[string]string{"bypassedBy": bypassedBy, "reason": reason})
	_, err := b.store.RecordQACheckRun(ctx, model.QACheckRun{
		TaskID:     taskID,
		CommitSHA:  "deadbeef00000000000000000000000000000001",
		Stage:      "S3",
		CheckID:    model.QACheckIDS3OperatorBypass,
		Arm:        model.QAArmTreatment,
		Verdict:    "bypassed",
		DetailJSON: string(detail),
	}, nil)
	if err != nil {
		return ui.PullRequestStatus{}, err
	}
	return ui.PullRequestStatus{
		Repo:   "acme/app",
		Number: 42,
		URL:    "https://github.com/acme/app/pull/42",
	}, nil
}

func TestStagingIsolationCIWaitTargetsStageRefAndFallsBackAfterPromotion(t *testing.T) {
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
	if err := store.PutConfig(ctx, model.Config{
		QA: model.QAConfig{
			Enabled:    true,
			FlowID:     model.QAFlowStandard,
			RolloutPct: 100,
			Epoch:      1,
			RegimeID:   1,
		},
	}); err != nil {
		t.Fatalf("PutConfig: %v", err)
	}

	repo := model.RepoRef{Owner: "acme", Name: "app"}
	if err := store.PutRepoConfig(ctx, model.RepoConfig{
		Repo:   repo,
		CIMode: model.CIModeGrain,
	}); err != nil {
		t.Fatalf("PutRepoConfig: %v", err)
	}
	task := model.Task{
		ID:         "10",
		Title:      "Add feature",
		Body:       "Implement feature",
		Target:     &repo,
		Branch:     "grain/ee5afe06/task-10-add-feature",
		WorkOrigin: "task:10",
		Grants:     []model.Grant{{Capability: grainci.Grant}},
	}
	if err := store.PutTask(ctx, task); err != nil {
		t.Fatalf("PutTask: %v", err)
	}
	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         "task:10",
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowStandard,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}

	stageBranch := model.QAStageBranchName(task.ID)
	branches := &fakeBranchChecker{
		branches: map[string]string{
			stageBranch: "1111111111111111111111111111111111111111",
		},
	}
	runner := &recordingCIRunner{}
	client := ui.NewClient(ui.Config{
		CI:                 runner,
		GitHubPullRequests: branches,
	}, store)

	// 1. While stagingIsolation is active and grain-qa-stage/10 exists (and task.Branch does not),
	// StartTaskCIRunOpt (used by `grain ci wait` and `grain ci retrigger`) targets grain-qa-stage/10.
	run1, err := client.StartTaskCIRunOpt(ctx, task.ID, ui.TaskCIRunOptions{})
	if err != nil {
		t.Fatalf("StartTaskCIRunOpt (staged): %v", err)
	}
	if run1.Ref != stageBranch {
		t.Fatalf("CI run ref = %q, want staging branch %q", run1.Ref, stageBranch)
	}

	// 2. SandboxNamespaceScope exposes TaskStageBranch so gitproxy `grain ci wait --resume <id>`
	// and `grain ci retrigger` accept runs on grain-qa-stage/10.
	if err := store.StartRun(ctx, model.Run{
		ID:      "run-1",
		TaskID:  task.ID,
		Attempt: 1,
		Sandbox: "sb-10",
	}, model.Limits{Workers: 10}); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	nsScope, live, err := store.SandboxNamespaceScope(ctx, "sb-10")
	if err != nil || !live {
		t.Fatalf("SandboxNamespaceScope = (%+v, %v, %v), want live=true", nsScope, live, err)
	}
	if nsScope.TaskStageBranch != stageBranch {
		t.Fatalf("NamespaceScope.TaskStageBranch = %q, want %q", nsScope.TaskStageBranch, stageBranch)
	}
	proxyScope := namespace.Scope{
		TaskIDStr:       task.ID,
		TaskRepo:        repo.String(),
		TaskBranch:      task.BranchName(),
		TaskStageBranch: nsScope.TaskStageBranch,
		MayReadCI:       true,
	}
	if !proxyScope.MatchesTaskBranch(stageBranch) || !proxyScope.MatchesTaskBranch(task.BranchName()) {
		t.Fatalf("Scope.MatchesTaskBranch failed for stage=%q or task=%q", stageBranch, task.BranchName())
	}

	// Verify SandboxCLIActions.StartTaskCI starts on grain-qa-stage/10 as well.
	actions := ui.SandboxCLIActions{Client: client}
	cliRun, err := actions.StartTaskCI(ctx, task.ID, gitproxy.CIStartRequest{})
	if err != nil {
		t.Fatalf("SandboxCLIActions.StartTaskCI: %v", err)
	}
	if cliRun.Ref != stageBranch {
		t.Fatalf("SandboxCLIActions.StartTaskCI ref = %q, want %q", cliRun.Ref, stageBranch)
	}

	// 3. Once S3 promotes and deletes grain-qa-stage/10 onto task.Branch, CI seamlessly targets task.Branch.
	delete(branches.branches, stageBranch)
	branches.branches[task.BranchName()] = "1111111111111111111111111111111111111111"
	run2, err := client.StartTaskCIRunOpt(ctx, task.ID, ui.TaskCIRunOptions{})
	if err != nil {
		t.Fatalf("StartTaskCIRunOpt (promoted): %v", err)
	}
	if run2.Ref != task.BranchName() {
		t.Fatalf("CI run ref after promotion = %q, want %q", run2.Ref, task.BranchName())
	}
}

func TestBypassS3APIAuthAndStateTransition(t *testing.T) {
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
	if err := store.PutConfig(ctx, model.Config{
		QA: model.QAConfig{
			Enabled:    true,
			FlowID:     model.QAFlowStandard,
			RolloutPct: 100,
			Epoch:      1,
			RegimeID:   1,
		},
	}); err != nil {
		t.Fatalf("PutConfig: %v", err)
	}

	repo := model.RepoRef{Owner: "acme", Name: "app"}
	task := model.Task{
		ID:         "22",
		Title:      "Blocked task",
		Body:       "Task blocked at S3",
		Target:     &repo,
		WorkOrigin: "task:22",
	}
	if err := store.PutTask(ctx, task); err != nil {
		t.Fatalf("PutTask: %v", err)
	}
	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         "task:22",
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowStandard,
		RolloutPctAtAssign: 100,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}
	if _, err := store.RecordQACheckRun(ctx, model.QACheckRun{
		TaskID:    "22",
		CommitSHA: "deadbeef00000000000000000000000000000001",
		Stage:     "S3",
		CheckID:   "golden:test-integrity-guard",
		Arm:       model.QAArmTreatment,
		Verdict:   "fail",
	}, []model.QAFinding{{
		TaskID:   "22",
		Stage:    "S3",
		RuleID:   "golden:test-integrity-guard",
		Severity: "blocking",
		Summary:  "false positive test check",
	}}); err != nil {
		t.Fatalf("RecordQACheckRun: %v", err)
	}

	mockPRs := &bypassPRMock{store: store}
	srv := ui.NewServer(ui.Config{PullRequests: mockPRs}, store)

	// 1. GET /api/tasks/22/qa reports s3Blocked=true and stageBranch=grain-qa-stage/22.
	req := httptest.NewRequest(http.MethodGet, "/api/tasks/22/qa", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/tasks/22/qa status = %d: %s", rec.Code, rec.Body.String())
	}
	var qaBefore ui.TaskQAResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &qaBefore); err != nil {
		t.Fatalf("decode qaBefore: %v", err)
	}
	if !qaBefore.S3Blocked {
		t.Fatalf("expected s3Blocked=true before bypass, got %+v", qaBefore)
	}
	if qaBefore.StageBranch != model.QAStageBranchName("22") {
		t.Fatalf("stageBranch = %q, want %q", qaBefore.StageBranch, model.QAStageBranchName("22"))
	}

	// 2. Agent principal is strictly forbidden from calling POST /api/tasks/22/qa/bypass-s3.
	agentCtx := ui.WithPrincipal(ctx, model.Principal{Kind: model.PrincipalAgent, ID: "agent-run-1"})
	agentReq := httptest.NewRequest(http.MethodPost, "/api/tasks/22/qa/bypass-s3", bytes.NewBufferString(`{"reason":"self bypass"}`)).WithContext(agentCtx)
	agentRec := httptest.NewRecorder()
	srv.ServeHTTP(agentRec, agentReq)
	if agentRec.Code != http.StatusForbidden {
		t.Fatalf("agent bypass status = %d, want 403: %s", agentRec.Code, agentRec.Body.String())
	}
	if len(mockPRs.calls) != 0 {
		t.Fatalf("agent bypass must not invoke PullRequestsWithS3Bypass")
	}

	// 3. Human operator succeeds, opens PR, and clears s3Blocked.
	opReq := httptest.NewRequest(http.MethodPost, "/api/tasks/22/qa/bypass-s3", bytes.NewBufferString(`{"reason":"verified false positive"}`))
	opRec := httptest.NewRecorder()
	srv.ServeHTTP(opRec, opReq)
	if opRec.Code != http.StatusOK {
		t.Fatalf("operator bypass status = %d, want 200: %s", opRec.Code, opRec.Body.String())
	}
	var prStatus ui.PullRequestStatus
	if err := json.Unmarshal(opRec.Body.Bytes(), &prStatus); err != nil {
		t.Fatalf("decode prStatus: %v", err)
	}
	if prStatus.Number != 42 || len(mockPRs.calls) != 1 || mockPRs.calls[0].reason != "verified false positive" {
		t.Fatalf("unexpected bypass result: status=%+v calls=%+v", prStatus, mockPRs.calls)
	}

	// 4. Subsequent GET /api/tasks/22/qa reports s3Blocked=false.
	recAfter := httptest.NewRecorder()
	srv.ServeHTTP(recAfter, httptest.NewRequest(http.MethodGet, "/api/tasks/22/qa", nil))
	var qaAfter ui.TaskQAResponse
	if err := json.Unmarshal(recAfter.Body.Bytes(), &qaAfter); err != nil {
		t.Fatalf("decode qaAfter: %v", err)
	}
	if qaAfter.S3Blocked {
		t.Fatalf("expected s3Blocked=false after bypass, got %+v", qaAfter)
	}
}
