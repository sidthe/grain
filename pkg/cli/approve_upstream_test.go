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

package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/ui"
)

func TestApproveUpstreamAndWorkstreamFlags(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	client := ui.NewClient(ui.Config{Actor: ui.DefaultActor("tester"), Capabilities: ui.OfferedCapabilities()}, store)

	// Task 1: standalone upstream proposal
	t1, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Standalone upstream", NoRepo: true,
	})
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	// Task 2: already-queued intermediate task depending on t1
	t2, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Queued bridge", NoRepo: true, Approved: true, DependsOn: []string{t1.ID},
	})
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}
	// Task 3: workstream root (approved)
	t3, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Submitted workstream", NoRepo: true, Approved: true,
	})
	if err != nil {
		t.Fatalf("create t3: %v", err)
	}
	// Task 4: wave 1 child proposed in workstream t3, depending on t2 (-> t1)
	t4, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Wave 1 child", NoRepo: true, WorkOrigin: "task:" + t3.ID, DependsOn: []string{t2.ID},
	})
	if err != nil {
		t.Fatalf("create t4: %v", err)
	}
	// Task 5: wave 2 child proposed in workstream t3, depending on t4
	t5, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Wave 2 child", NoRepo: true, WorkOrigin: "task:" + t3.ID, DependsOn: []string{t4.ID},
	})
	if err != nil {
		t.Fatalf("create t5: %v", err)
	}
	// Task 6: sibling child in workstream t3 (no deps)
	t6, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Parallel sibling", NoRepo: true, WorkOrigin: "task:" + t3.ID,
	})
	if err != nil {
		t.Fatalf("create t6: %v", err)
	}
	// Task 7: unrelated standalone proposal (must stay proposed)
	t7, err := client.CreateTask(ctx, ui.CreateTaskRequest{
		Title: "Unrelated proposal", NoRepo: true,
	})
	if err != nil {
		t.Fatalf("create t7: %v", err)
	}

	var approvedOrder []string
	inner := accessCodeServer(client)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/tasks/") && strings.HasSuffix(r.URL.Path, "/approve") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/tasks/"), "/approve")
			approvedOrder = append(approvedOrder, id)
		}
		inner.ServeHTTP(w, r)
	}))
	defer srv.Close()

	// 1. `grain approve -upstream <t5>` approves t1 -> t4 -> t5 in upstream-first order,
	// leaving sibling t6 and unrelated t7 proposed.
	out := captureStdout(t, func() {
		if err := runCLIWithAccessCode([]string{"-server", srv.URL, "-json", "approve", "-upstream", t5.ID}); err != nil {
			t.Fatalf("grain approve -upstream %s: %v", t5.ID, err)
		}
	})
	var upstreamTasks []ui.Task
	if err := json.Unmarshal([]byte(out), &upstreamTasks); err != nil {
		t.Fatalf("parse -upstream json %q: %v", out, err)
	}
	if want := []string{t1.ID, t4.ID, t5.ID}; !slices.Equal(approvedOrder, want) {
		t.Fatalf("-upstream approval order = %v, want %v", approvedOrder, want)
	}
	if len(upstreamTasks) != 3 {
		t.Fatalf("-upstream returned %d tasks, want 3", len(upstreamTasks))
	}
	for _, id := range []string{t6.ID, t7.ID} {
		got, gerr := client.Task(ctx, id)
		if gerr != nil {
			t.Fatalf("read task %s: %v", id, gerr)
		}
		if got.State != model.StateProposed {
			t.Fatalf("task %s state = %s, want proposed", id, got.State)
		}
	}

	// Withdraw approvals on t1, t4, t5 so we can test `-workstream` from a fresh slate.
	for _, id := range []string{t5.ID, t4.ID, t1.ID} {
		if err := client.WithdrawApproval(ctx, id); err != nil {
			t.Fatalf("withdraw %s: %v", id, err)
		}
	}
	approvedOrder = nil

	// 2. `grain approve -workstream <t3>` approves the entire workstream + upstream set
	// (t1, t6 -> t4 -> t5) in upstream-first order, leaving unrelated t7 untouched.
	wsOut := captureStdout(t, func() {
		if err := runCLIWithAccessCode([]string{"-server", srv.URL, "-json", "approve", "-workstream", t3.ID}); err != nil {
			t.Fatalf("grain approve -workstream %s: %v", t3.ID, err)
		}
	})
	var wsTasks []ui.Task
	if err := json.Unmarshal([]byte(wsOut), &wsTasks); err != nil {
		t.Fatalf("parse -workstream json %q: %v", wsOut, err)
	}
	if want := []string{t1.ID, t6.ID, t4.ID, t5.ID}; !slices.Equal(approvedOrder, want) {
		t.Fatalf("-workstream approval order = %v, want %v", approvedOrder, want)
	}
	if len(wsTasks) != 4 {
		t.Fatalf("-workstream returned %d tasks, want 4", len(wsTasks))
	}
	got7, err := client.Task(ctx, t7.ID)
	if err != nil {
		t.Fatalf("read unrelated task %s: %v", t7.ID, err)
	}
	if got7.State != model.StateProposed {
		t.Fatalf("unrelated task %s state = %s, want proposed", t7.ID, got7.State)
	}

	// 3. Re-running `-workstream` when nothing needs approval prints a clean note / empty JSON array.
	emptyJSON := captureStdout(t, func() {
		if err := runCLIWithAccessCode([]string{"-server", srv.URL, "-json", "approve", "-workstream", t3.ID}); err != nil {
			t.Fatalf("grain approve -workstream (idempotent): %v", err)
		}
	})
	if strings.TrimSpace(emptyJSON) != "[]" {
		t.Fatalf("idempotent -workstream -json = %q, want []", emptyJSON)
	}
}

func TestOrderProposedIDsUpstreamFirstHandlesCycles(t *testing.T) {
	byID := map[string]ui.Task{
		"10": {ID: "10", State: model.StateProposed, DependsOn: []string{"11"}},
		"11": {ID: "11", State: model.StateProposed, DependsOn: []string{"10"}},
		"12": {ID: "12", State: model.StateProposed, DependsOn: []string{"11"}},
	}
	selected := map[string]bool{"10": true, "11": true, "12": true}
	got := orderProposedIDsUpstreamFirst(selected, byID)
	want := []string{"10", "11", "12"}
	if !slices.Equal(got, want) {
		t.Fatalf("orderProposedIDsUpstreamFirst = %v, want %v", got, want)
	}
}

// A failed read of an upstream task must abort the batch before anything
// downstream is approved; only a 404 (deleted task) is skipped.
func TestApproveUpstreamFetchErrorsAbortNon404AndSkip404(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		wantErr bool
	}{
		{name: "403 aborts", status: http.StatusForbidden, wantErr: true},
		{name: "500 aborts", status: http.StatusInternalServerError, wantErr: true},
		{name: "404 is skipped", status: http.StatusNotFound, wantErr: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := testStore(t)
			ctx := context.Background()
			client := ui.NewClient(ui.Config{Actor: ui.DefaultActor("tester"), Capabilities: ui.OfferedCapabilities()}, store)
			upstream, err := client.CreateTask(ctx, ui.CreateTaskRequest{Title: "Upstream dep", NoRepo: true})
			if err != nil {
				t.Fatalf("create upstream: %v", err)
			}
			downstream, err := client.CreateTask(ctx, ui.CreateTaskRequest{
				Title: "Downstream task", NoRepo: true, DependsOn: []string{upstream.ID},
			})
			if err != nil {
				t.Fatalf("create downstream: %v", err)
			}

			var approved []string
			inner := accessCodeServer(client)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Hide upstream from the list so approveBatch must read it on its own.
				if r.Method == http.MethodGet && r.URL.Path == "/api/tasks" {
					req := r.Clone(r.Context())
					req.Header = r.Header.Clone()
					req.Header.Del("Accept-Encoding")
					rec := httptest.NewRecorder()
					inner.ServeHTTP(rec, req)
					var tasks []ui.Task
					if err := json.Unmarshal(rec.Body.Bytes(), &tasks); err != nil {
						http.Error(w, "decode tasks: "+err.Error(), http.StatusInternalServerError)
						return
					}
					filtered := make([]ui.Task, 0, len(tasks))
					for _, task := range tasks {
						if task.ID != upstream.ID {
							filtered = append(filtered, task)
						}
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(filtered)
					return
				}
				if r.Method == http.MethodGet && r.URL.Path == "/api/tasks/"+upstream.ID {
					http.Error(w, "simulated upstream read failure", tc.status)
					return
				}
				if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/approve") {
					approved = append(approved, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/tasks/"), "/approve"))
				}
				inner.ServeHTTP(w, r)
			}))
			defer srv.Close()

			var runErr error
			_ = captureStdout(t, func() {
				runErr = runCLIWithAccessCode([]string{"-server", srv.URL, "-json", "approve", "-upstream", downstream.ID})
			})
			wantState := model.StateQueued
			if tc.wantErr {
				wantState = model.StateProposed
				if runErr == nil || !strings.Contains(runErr.Error(), "#"+upstream.ID) {
					t.Fatalf("err = %v, want an error naming #%s", runErr, upstream.ID)
				}
				if len(approved) != 0 {
					t.Fatalf("approved = %v, want none", approved)
				}
			} else {
				if runErr != nil {
					t.Fatalf("unexpected error: %v", runErr)
				}
				if want := []string{downstream.ID}; !slices.Equal(approved, want) {
					t.Fatalf("approved = %v, want %v", approved, want)
				}
			}
			got, err := client.Task(ctx, downstream.ID)
			if err != nil {
				t.Fatalf("read downstream: %v", err)
			}
			if got.State != wantState {
				t.Fatalf("downstream state = %s, want %s", got.State, wantState)
			}
		})
	}
}
