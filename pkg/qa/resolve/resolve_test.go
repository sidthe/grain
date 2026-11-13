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

package resolve_test

import (
	"context"
	"fmt"
	mathrand "math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/model/sqlite"
	"github.com/ai-on-gke/grain/pkg/qa/resolve"
)

func openTestStore(t *testing.T) *model.Store {
	t.Helper()
	db, err := sqlite.Open(sqlite.DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := model.New(db)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("st.Init: %v", err)
	}
	return st
}

func setQAConfig(t *testing.T, st *model.Store, cfg model.QAConfig) {
	t.Helper()
	norm, err := model.NormalizeQAConfig(cfg)
	if err != nil {
		t.Fatalf("NormalizeQAConfig: %v", err)
	}
	if err := st.UpdateConfig(context.Background(), func(c *model.Config) error {
		c.QA = norm
		return nil
	}); err != nil {
		t.Fatalf("UpdateConfig QA: %v", err)
	}
}

func insertEligibleTask(t *testing.T, st *model.Store, id, originID string) model.Task {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	tk := model.Task{
		ID:         id,
		Title:      "Fix bug " + id,
		Target:     &model.RepoRef{Owner: "acme", Name: "svc"},
		WorkOrigin: model.TaskOrigin(originID),
		CreatedAt:  &now,
	}
	if err := st.PutTask(ctx, tk); err != nil {
		t.Fatalf("PutTask(%s): %v", id, err)
	}
	return tk
}

func TestZeroImpact(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	tk := insertEligibleTask(t, st, "101", "101")

	res, cfg, err := resolve.ActiveQAResolutionForTask(ctx, st, tk.ID)
	if err != nil {
		t.Fatalf("ActiveQAResolutionForTask: %v", err)
	}
	if cfg.Enabled || res != nil {
		t.Fatalf("expected nil resolution when QA disabled, got cfg.Enabled=%v res=%+v", cfg.Enabled, res)
	}

	dRes, _, err := resolve.EnsureQAResolutionAtDispatch(ctx, st, tk, "run-1", time.Now().UTC())
	if err != nil {
		t.Fatalf("EnsureQAResolutionAtDispatch: %v", err)
	}
	if dRes == nil || dRes.ArmID != "baseline" || dRes.IsEnforcedTreatment() {
		t.Fatalf("expected baseline resolution at dispatch when QA disabled, got %+v", dRes)
	}
	ear, err := st.EarliestQAAssignment(ctx, "task:101")
	if err != nil || ear != nil {
		t.Fatalf("expected zero assignment rows written when QA disabled, got %+v (err=%v)", ear, err)
	}
}

func TestLegacyEquivalenceAndEpochStickiness(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	shadow := true
	setQAConfig(t, st, model.QAConfig{
		Enabled:         true,
		FlowID:          model.DefaultQAFlowID,
		RolloutPct:      100,
		ShadowOnControl: &shadow,
		Epoch:           3,
		RegimeID:        1,
	})

	rootTask := insertEligibleTask(t, st, "200", "200")
	now := time.Now().UTC()
	dRes, _, err := resolve.EnsureQAResolutionAtDispatch(ctx, st, rootTask, "run-200", now)
	if err != nil {
		t.Fatalf("EnsureQAResolutionAtDispatch: %v", err)
	}
	if dRes == nil || dRes.ArmID != model.QAArmTreatment || !dRes.IsEnforcedTreatment() || dRes.Spec == nil {
		t.Fatalf("expected treatment arm with resolved spec, got %+v", dRes)
	}

	// Child task in the same work tree inherits the exact sticky arm via read-only resolution.
	childTask := insertEligibleTask(t, st, "201", "200")
	rRes, _, err := resolve.ActiveQAResolutionForTask(ctx, st, childTask.ID)
	if err != nil {
		t.Fatalf("ActiveQAResolutionForTask child: %v", err)
	}
	if rRes == nil || rRes.ArmID != model.QAArmTreatment || rRes.FlowID != model.DefaultQAFlowID {
		t.Fatalf("expected child to inherit treatment %s, got %+v", model.DefaultQAFlowID, rRes)
	}

	// Advancing epoch to 4 must NOT re-bucket origin task:200; it drops cleanly to baseline.
	setQAConfig(t, st, model.QAConfig{
		Enabled:         true,
		FlowID:          model.DefaultQAFlowID,
		RolloutPct:      100,
		ShadowOnControl: &shadow,
		Epoch:           4,
		RegimeID:        1,
	})
	afterEpoch, _, err := resolve.ActiveQAResolutionForTask(ctx, st, childTask.ID)
	if err != nil {
		t.Fatalf("ActiveQAResolutionForTask after epoch bump: %v", err)
	}
	if afterEpoch == nil || afterEpoch.ArmID != "baseline" || afterEpoch.IsEnforcedTreatment() {
		t.Fatalf("expected baseline after epoch change without re-bucketing, got %+v", afterEpoch)
	}
}

func TestPreStartExclusion(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	tk := insertEligibleTask(t, st, "300", "300")
	now := time.Now().UTC()

	// Record a prior run while QA is still disabled.
	if err := st.StartRun(ctx, model.Run{
		ID:        "prior-run-300",
		TaskID:    tk.ID,
		Attempt:   1,
		StartedAt: now.Add(-5 * time.Minute),
	}, model.Limits{}); err != nil {
		t.Fatalf("StartRun: %v", err)
	}

	// Enable 100% QA rollout afterwards; task:300 already started before rollout and must be excluded.
	setQAConfig(t, st, model.QAConfig{
		Enabled:    true,
		FlowID:     model.DefaultQAFlowID,
		RolloutPct: 100,
		Epoch:      1,
		RegimeID:   1,
	})

	dRes, _, err := resolve.EnsureQAResolutionAtDispatch(ctx, st, tk, "second-run-300", now)
	if err != nil {
		t.Fatalf("EnsureQAResolutionAtDispatch: %v", err)
	}
	if dRes == nil || dRes.ArmID != "excluded" || dRes.IsEnforcedTreatment() {
		t.Fatalf("expected pre-existing origin with prior run to be excluded, got %+v", dRes)
	}
}

func TestRandomInterleavingPropertyTest(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	rng := mathrand.New(mathrand.NewPCG(20261113, 1))
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)

	enabled := true
	epoch := 1
	rollout := 50
	setQAConfig(t, st, model.QAConfig{
		Enabled:    enabled,
		FlowID:     model.DefaultQAFlowID,
		RolloutPct: rollout,
		Epoch:      epoch,
		RegimeID:   1,
	})

	type originExpectation struct {
		epoch int
		arm   string
	}
	assigned := map[string]originExpectation{}
	var tasks []model.Task

	for step := range 120 {
		now = now.Add(time.Second)
		switch rng.IntN(5) {
		case 0:
			id := fmt.Sprintf("t-%d", step)
			originID := id
			if len(tasks) > 0 && rng.IntN(2) == 0 {
				parent := tasks[rng.IntN(len(tasks))]
				originID = strings.TrimPrefix(string(parent.WorkOrigin), "task:")
			}
			tasks = append(tasks, insertEligibleTask(t, st, id, originID))
		case 1:
			if len(tasks) == 0 {
				continue
			}
			tk := tasks[rng.IntN(len(tasks))]
			runID := fmt.Sprintf("run-%d", step)
			res, _, err := resolve.EnsureQAResolutionAtDispatch(ctx, st, tk, runID, now)
			if err != nil {
				t.Fatalf("step %d EnsureQAResolutionAtDispatch: %v", step, err)
			}
			_ = st.StartRun(ctx, model.Run{
				ID:        runID,
				TaskID:    tk.ID,
				Attempt:   step + 1,
				StartedAt: now,
			}, model.Limits{})
			if !enabled {
				if res.IsEnforcedTreatment() {
					t.Fatalf("step %d: enforced treatment while disabled: %+v", step, res)
				}
				continue
			}
			originRef := string(tk.WorkOrigin)
			if prev, ok := assigned[originRef]; ok {
				if prev.epoch == epoch && res.ArmID != prev.arm {
					t.Fatalf("step %d: origin %s flipped arm within epoch %d: want %s, got %s", step, originRef, epoch, prev.arm, res.ArmID)
				}
				if prev.epoch != epoch && res.ArmID != "baseline" {
					t.Fatalf("step %d: origin %s from epoch %d did not drop to baseline in epoch %d: got %s", step, originRef, prev.epoch, epoch, res.ArmID)
				}
			} else if res.ArmID == model.QAArmTreatment || res.ArmID == model.QAArmControl {
				assigned[originRef] = originExpectation{epoch: epoch, arm: res.ArmID}
			}
		case 2:
			if len(tasks) == 0 {
				continue
			}
			tk := tasks[rng.IntN(len(tasks))]
			res, _, err := resolve.ActiveQAResolutionForTask(ctx, st, tk.ID)
			if err != nil {
				t.Fatalf("step %d ActiveQAResolutionForTask: %v", step, err)
			}
			if !enabled && res != nil {
				t.Fatalf("step %d: expected nil when disabled, got %+v", step, res)
			}
			if enabled {
				if prev, ok := assigned[string(tk.WorkOrigin)]; ok {
					want := "baseline"
					if prev.epoch == epoch {
						want = prev.arm
					}
					if res == nil || res.ArmID != want {
						t.Fatalf("step %d: read-only mismatch for %s: want %s, got %+v", step, tk.WorkOrigin, want, res)
					}
				}
			}
		case 3:
			enabled = !enabled
			setQAConfig(t, st, model.QAConfig{
				Enabled:    enabled,
				FlowID:     model.DefaultQAFlowID,
				RolloutPct: rollout,
				Epoch:      epoch,
				RegimeID:   1,
			})
		case 4:
			epoch++
			rollout = 25 + rng.IntN(76)
			setQAConfig(t, st, model.QAConfig{
				Enabled:    enabled,
				FlowID:     model.DefaultQAFlowID,
				RolloutPct: rollout,
				Epoch:      epoch,
				RegimeID:   1,
			})
		}
	}
}
