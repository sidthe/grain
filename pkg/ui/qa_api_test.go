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
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/model/sqlite"
	"github.com/ai-on-gke/grain/pkg/qa"
	"github.com/ai-on-gke/grain/pkg/ui"
)

func TestQAFlowsTaskQAAndFeedbackEndpoints(t *testing.T) {
	t.Parallel()
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
			FlowID:     model.QAFlowGoldenV1Minimal,
			RolloutPct: 50,
			Epoch:      1,
			RegimeID:   1,
		},
	}); err != nil {
		t.Fatalf("PutConfig: %v", err)
	}

	repo := model.RepoRef{Owner: "acme", Name: "kernel"}
	if err := store.PutTask(ctx, model.Task{
		ID:         "101",
		Title:      "Implement scheduler",
		Body:       "Round-robin scheduler",
		Target:     &repo,
		WorkOrigin: "ws-sched",
	}); err != nil {
		t.Fatalf("PutTask 101: %v", err)
	}
	if err := store.PutTask(ctx, model.Task{
		ID:         "102",
		Title:      "Other task",
		Body:       "Unrelated",
		Target:     &repo,
		WorkOrigin: "ws-other",
	}); err != nil {
		t.Fatalf("PutTask 102: %v", err)
	}

	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         "ws-sched",
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmTreatment,
		FlowID:             model.QAFlowGoldenV1Minimal,
		RolloutPctAtAssign: 50,
		ComplexityTier:     model.QAComplexityMedium,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment: %v", err)
	}

	const tok = "test-qa-api-token"
	srv := ui.NewServer(ui.Config{LocalAPIToken: tok}, store)
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)

	client := ui.NewHTTPClient(ts.URL)
	client.Token = tok

	// 1. GET /api/qa/flows returns all 3 built-in flows with rules.
	flowsResp, err := client.QAFlows(ctx)
	if err != nil {
		t.Fatalf("QAFlows: %v", err)
	}
	if len(flowsResp.Flows) != 3 || len(flowsResp.Flows[0].Rules) < 4 {
		t.Fatalf("unexpected QAFlows response: %+v", flowsResp)
	}

	// 2. POST /api/tasks/101/qa/check-runs persists S3 check runs + findings.
	if err := client.RecordTaskQACheckRuns(ctx, "101", []ui.RecordQACheckRunEntry{
		{
			Run: model.QACheckRun{
				CommitSHA:  "abc123456789",
				Stage:      "S3",
				CheckID:    qa.RuleStrictConfigDecoder,
				Arm:        model.QAArmTreatment,
				Verdict:    "fail",
				DurationMS: 18,
				AllocBytes: 4096,
			},
			Findings: []model.QAFinding{
				{
					Stage:    "S3",
					RuleID:   qa.RuleStrictConfigDecoder,
					Severity: "blocking",
					FilePath: "pkg/cfg/load.go",
					Line:     24,
					Summary:  "yaml.NewDecoder omits dec.KnownFields(true)",
				},
			},
		},
	}); err != nil {
		t.Fatalf("RecordTaskQACheckRuns: %v", err)
	}

	// 3. GET /api/tasks/101/qa reads assignment, checkRuns, and findings.
	taskQA, err := client.TaskQA(ctx, "101")
	if err != nil {
		t.Fatalf("TaskQA(101): %v", err)
	}
	if !taskQA.Enabled || taskQA.Assignment == nil || taskQA.Assignment.Arm != model.QAArmTreatment {
		t.Fatalf("unexpected taskQA assignment: %+v", taskQA)
	}
	if len(taskQA.CheckRuns) != 1 || len(taskQA.Findings) != 1 {
		t.Fatalf("expected 1 checkRun and 1 finding, got %+v", taskQA)
	}
	findingID := taskQA.Findings[0].ID

	// 4. Cross-task IDOR attempt (voting task 101's finding under task 102) MUST return 404.
	if _, err := client.VoteTaskQAFinding(ctx, "102", findingID, 1); err == nil {
		t.Fatal("expected cross-task VoteTaskQAFinding to fail with 404")
	}

	// 5. Valid helpful (+1) vote on task 101 updates the finding record.
	voteResp, err := client.VoteTaskQAFinding(ctx, "101", findingID, -1)
	if err != nil {
		t.Fatalf("VoteTaskQAFinding(-1): %v", err)
	}
	if voteResp.Vote != -1 {
		t.Fatalf("voteResp = %+v, want Vote=-1", voteResp)
	}
	afterQA, err := client.TaskQA(ctx, "101")
	if err != nil || len(afterQA.Findings) != 1 || afterQA.Findings[0].HumanVote != -1 {
		t.Fatalf("expected persisted HumanVote=-1, got %+v (err=%v)", afterQA, err)
	}

	// 6. Invalid vote out of range (-2) returns 400.
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/api/tasks/101/qa/findings/1/feedback", strings.NewReader(`{"vote":-2}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	rawResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer rawResp.Body.Close()
	if rawResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status on invalid vote = %d, want 400", rawResp.StatusCode)
	}

	// 7. Issue-tree WorkOrigin ("acme/kernel#12") inherits root QA assignment, while closed unassigned tasks return Enabled=false.
	if _, err := store.EnsureQAAssignment(ctx, model.QAAssignment{
		RootOrigin:         "acme/kernel#12",
		Epoch:              1,
		RegimeID:           1,
		Arm:                model.QAArmControl,
		FlowID:             model.QAFlowGoldenV1Minimal,
		RolloutPctAtAssign: 50,
	}); err != nil {
		t.Fatalf("EnsureQAAssignment(acme/kernel#12): %v", err)
	}
	if err := store.PutTask(ctx, model.Task{
		ID:         "103",
		Title:      "Child of issue tree",
		Body:       "Subtask",
		Target:     &repo,
		WorkOrigin: "acme/kernel#12",
	}); err != nil {
		t.Fatalf("PutTask 103: %v", err)
	}
	childQA, err := client.TaskQA(ctx, "103")
	if err != nil || childQA.Assignment == nil || childQA.Assignment.RootOrigin != "acme/kernel#12" {
		t.Fatalf("expected child 103 to inherit acme/kernel#12 assignment, got %+v (err=%v)", childQA, err)
	}

	closeReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/api/tasks/102/close", strings.NewReader(`{"reason":"done"}`))
	closeReq.Header.Set("Authorization", "Bearer "+tok)
	closeReq.Header.Set("Content-Type", "application/json")
	closeResp, err := http.DefaultClient.Do(closeReq)
	if err != nil || closeResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/tasks/102/close = (%v, %v)", closeResp, err)
	}
	_ = closeResp.Body.Close()

	closedQA, err := client.TaskQA(ctx, "102")
	if err != nil {
		t.Fatalf("TaskQA(102): %v", err)
	}
	if closedQA.Enabled {
		t.Fatalf("expected closed unassigned task 102 to report Enabled=false, got %+v", closedQA)
	}
}
