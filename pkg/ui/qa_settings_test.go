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
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/qa/resolve"
	"github.com/ai-on-gke/grain/pkg/ui"
)

func TestQASettingsShipOffPlanCleanlyAndBumpRegimeOnRolloutChange(t *testing.T) {
	t.Parallel()
	c, _, ctx := testClient(t)
	if _, err := c.UpdateSettings(ctx, firstSettings()); err != nil {
		t.Fatal(err)
	}

	initial, err := c.GetSettings(ctx)
	if err != nil {
		t.Fatalf("GetSettings initial: %v", err)
	}
	if initial.QAEnabled || initial.QARolloutPct != 0 || initial.QAFlowID != model.DefaultQAFlowID || !initial.QAShadowOnControl {
		t.Fatalf("unexpected initial QA settings: enabled=%v rollout=%d flow=%q shadow=%v",
			initial.QAEnabled, initial.QARolloutPct, initial.QAFlowID, initial.QAShadowOnControl)
	}

	enable := true
	rollout30 := 30
	flow := model.QAFlowGoldenV1Minimal
	shadow := true
	req30 := ui.UpdateSettingsRequest{
		QAEnabled:         &enable,
		QAFlowID:          &flow,
		QARolloutPct:      &rollout30,
		QAShadowOnControl: &shadow,
	}

	planned30, err := c.PlanSettings(ctx, req30)
	if err != nil {
		t.Fatalf("PlanSettings 30%%: %v", err)
	}
	if !planned30.QAEnabled || planned30.QARolloutPct != 30 || planned30.QARegimeID != 1 {
		t.Fatalf("unexpected planned 30%%: enabled=%v rollout=%d regime=%d",
			planned30.QAEnabled, planned30.QARolloutPct, planned30.QARegimeID)
	}

	// PlanSettings must not write to store.
	stillOff, err := c.GetSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stillOff.QAEnabled {
		t.Fatalf("PlanSettings mutated stored QAEnabled=true")
	}

	saved30, err := c.UpdateSettings(ctx, req30)
	if err != nil {
		t.Fatalf("UpdateSettings 30%%: %v", err)
	}
	if !reflect.DeepEqual(planned30, saved30) {
		t.Fatalf("planned and saved QA settings differ:\n planned=%+v\n   saved=%+v", planned30, saved30)
	}

	// Raising rollout to 50% bumps qaRegimeId to 2 while preserving qaEpoch=1.
	rollout50 := 50
	saved50, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{QARolloutPct: &rollout50})
	if err != nil {
		t.Fatalf("UpdateSettings 50%%: %v", err)
	}
	if saved50.QARolloutPct != 50 || saved50.QARegimeID != 2 || saved50.QAEpoch != 1 {
		t.Fatalf("expected 50%% in regime 2 / epoch 1, got rollout=%d regime=%d epoch=%d",
			saved50.QARolloutPct, saved50.QARegimeID, saved50.QAEpoch)
	}

	// Validation rejects out-of-bounds rollout percentage and unknown flow IDs.
	badPct := 125
	if _, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{QARolloutPct: &badPct}); err == nil || !strings.Contains(err.Error(), "rolloutPct") {
		t.Fatalf("expected rolloutPct validation error, got %v", err)
	}
	badFlow := "nonexistent-flow"
	if _, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{QAFlowID: &badFlow}); err == nil || !strings.Contains(err.Error(), "flowId") {
		t.Fatalf("expected flowId validation error, got %v", err)
	}
	epoch3 := 3
	if _, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{QAEpoch: &epoch3}); err != nil {
		t.Fatalf("UpdateSettings qaEpoch=3: %v", err)
	}
	epoch1 := 1
	if _, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{QAEpoch: &epoch1}); err == nil || !strings.Contains(err.Error(), "epoch cannot decrease") {
		t.Fatalf("expected epoch downgrade rejection, got %v", err)
	}
}

func TestQASettingsAcceptV4VersionedAndStoredCustomFlowsAndRejectRetired(t *testing.T) {
	t.Parallel()
	c, st, ctx := testClient(t)
	if _, err := c.UpdateSettings(ctx, firstSettings()); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	spec, _, err := resolve.LookupFlowSpec(ctx, st, model.DefaultQAFlowID)
	if err != nil || spec == nil {
		t.Fatalf("resolve.LookupFlowSpec(%q): %v", model.DefaultQAFlowID, err)
	}
	baseSpec := *spec
	baseSpec.ID = "custom-team-flow@1"
	specBytes, err := json.Marshal(baseSpec)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	if err := st.InsertQAFlowVersion(ctx, model.QAFlowVersion{
		Hash:      "sha256:custom-team-flow-v1",
		Key:       "custom-team-flow",
		Version:   1,
		Label:     "Custom Team Flow",
		SpecJSON:  string(specBytes),
		CreatedAt: now,
		CreatedBy: "operator",
	}); err != nil {
		t.Fatalf("InsertQAFlowVersion active: %v", err)
	}
	// Duplicate version under the same key to verify QAFlowIDs deduplication.
	if err := st.InsertQAFlowVersion(ctx, model.QAFlowVersion{
		Hash:      "sha256:custom-team-flow-v2",
		Key:       "custom-team-flow",
		Version:   2,
		Label:     "Custom Team Flow v2",
		SpecJSON:  string(specBytes),
		CreatedAt: now.Add(time.Minute),
		CreatedBy: "operator",
	}); err != nil {
		t.Fatalf("InsertQAFlowVersion v2: %v", err)
	}

	retiredAt := now.Add(2 * time.Minute)
	if err := st.InsertQAFlowVersion(ctx, model.QAFlowVersion{
		Hash:      "sha256:retired-custom-flow-v1",
		Key:       "retired-custom-flow",
		Version:   1,
		Label:     "Retired Custom Flow",
		SpecJSON:  string(specBytes),
		CreatedAt: now,
		RetiredAt: &retiredAt,
		CreatedBy: "operator",
	}); err != nil {
		t.Fatalf("InsertQAFlowVersion retired: %v", err)
	}

	cur, err := c.GetSettings(ctx)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if cur.QAFlowIDs[0] != model.QAFlowGoldenV1Minimal {
		t.Fatalf("QAFlowIDs[0] = %q, want %q", cur.QAFlowIDs[0], model.QAFlowGoldenV1Minimal)
	}
	customCount := 0
	for _, id := range cur.QAFlowIDs {
		if id == "custom-team-flow" {
			customCount++
		}
		if id == "retired-custom-flow" {
			t.Fatalf("retired custom flow leaked into QAFlowIDs: %v", cur.QAFlowIDs)
		}
	}
	if customCount != 1 {
		t.Fatalf("expected custom-team-flow once in QAFlowIDs, got %d (%v)", customCount, cur.QAFlowIDs)
	}
	if !slices.Contains(cur.QAFlowIDs, model.QAFlowEngineeringWorkflowV4) {
		t.Fatalf("expected %q in QAFlowIDs, got %v", model.QAFlowEngineeringWorkflowV4, cur.QAFlowIDs)
	}

	enable := true
	for _, validFlow := range []string{
		model.QAFlowEngineeringWorkflowV4,
		model.QAFlowGoldenV3 + "@1",
		"custom-team-flow",
		"custom-team-flow@1",
	} {
		flow := validFlow
		t.Run("accept_"+flow, func(t *testing.T) {
			planned, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{
				QAEnabled: &enable,
				QAFlowID:  &flow,
			})
			if err != nil {
				t.Fatalf("PlanSettings(%q): %v", flow, err)
			}
			if planned.QAFlowID != flow {
				t.Fatalf("PlanSettings QAFlowID = %q, want %q", planned.QAFlowID, flow)
			}
			saved, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{
				QAEnabled: &enable,
				QAFlowID:  &flow,
			})
			if err != nil {
				t.Fatalf("UpdateSettings(%q): %v", flow, err)
			}
			if saved.QAFlowID != flow {
				t.Fatalf("UpdateSettings QAFlowID = %q, want %q", saved.QAFlowID, flow)
			}
			fetched, err := c.GetSettings(ctx)
			if err != nil || fetched.QAFlowID != flow {
				t.Fatalf("GetSettings after saving %q = (%q, %v)", flow, fetched.QAFlowID, err)
			}
		})
	}

	// Retire custom-team-flow@2 and verify bare custom-team-flow and custom-team-flow@2 are rejected
	// while custom-team-flow@1 appears in QAFlowIDs and remains valid.
	if err := st.RetireQAFlowVersion(ctx, "sha256:custom-team-flow-v2", now.Add(3*time.Minute)); err != nil {
		t.Fatalf("RetireQAFlowVersion: %v", err)
	}
	afterV2Retire, err := c.GetSettings(ctx)
	if err != nil {
		t.Fatalf("GetSettings after retiring v2: %v", err)
	}
	if slices.Contains(afterV2Retire.QAFlowIDs, "custom-team-flow") {
		t.Fatalf("bare custom-team-flow must not appear in QAFlowIDs after head @2 is retired: %v", afterV2Retire.QAFlowIDs)
	}
	if !slices.Contains(afterV2Retire.QAFlowIDs, "custom-team-flow@1") {
		t.Fatalf("expected active custom-team-flow@1 in QAFlowIDs after head @2 is retired, got %v", afterV2Retire.QAFlowIDs)
	}
	for _, badFlow := range []string{
		"nonexistent-flow",
		"retired-custom-flow",
		"retired-custom-flow@1",
		"sha256:retired-custom-flow-v1",
		"custom-team-flow",
		"custom-team-flow@2",
	} {
		flow := badFlow
		t.Run("reject_"+flow, func(t *testing.T) {
			if _, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{QAFlowID: &flow}); err == nil || !strings.Contains(err.Error(), "flowId") {
				t.Fatalf("PlanSettings(%q) expected flowId error, got %v", flow, err)
			}
			if _, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{QAFlowID: &flow}); err == nil || !strings.Contains(err.Error(), "flowId") {
				t.Fatalf("UpdateSettings(%q) expected flowId error, got %v", flow, err)
			}
		})
	}

	// Enable custom-team-flow@1 at 10% rollout while it is still active, then retire it to exercise
	// kill-switch safety and ramp/epoch guards.
	activeFlow := "custom-team-flow@1"
	rollout10 := 10
	if plannedActive, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{
		QAEnabled:    &enable,
		QAFlowID:     &activeFlow,
		QARolloutPct: &rollout10,
	}); err != nil || plannedActive.QAFlowID != activeFlow {
		t.Fatalf("PlanSettings(%q) after retiring v2 = (%+v, %v)", activeFlow, plannedActive, err)
	}
	if _, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{
		QAEnabled:    &enable,
		QAFlowID:     &activeFlow,
		QARolloutPct: &rollout10,
	}); err != nil {
		t.Fatalf("UpdateSettings enable custom-team-flow@1 at 10%%: %v", err)
	}
	if err := st.RetireQAFlowVersion(ctx, "sha256:custom-team-flow-v1", now.Add(4*time.Minute)); err != nil {
		t.Fatalf("RetireQAFlowVersion v1: %v", err)
	}

	srv := ui.NewServerWithClient(c)

	// Partial PUT /api/settings attempting to ramp rollout or bump epoch on an enabled retired flow
	// must fail with 400 validation error.
	rollout100 := 100
	if _, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{QARolloutPct: &rollout100}); err == nil || !strings.Contains(err.Error(), "flowId") {
		t.Fatalf("PlanSettings ramp rollout on retired flow expected flowId error, got %v", err)
	}
	recRamp := do(t, srv, http.MethodPut, "/api/settings", `{"qaRolloutPct":100}`)
	if recRamp.Code != http.StatusBadRequest || !strings.Contains(recRamp.Body.String(), "flowId") {
		t.Fatalf("PUT /api/settings ramp rollout on retired flow = %d (%s), want 400 flowId error",
			recRamp.Code, recRamp.Body.String())
	}

	epoch2 := 2
	if _, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{QAEpoch: &epoch2}); err == nil || !strings.Contains(err.Error(), "flowId") {
		t.Fatalf("PlanSettings bump epoch on retired flow expected flowId error, got %v", err)
	}
	recEpoch := do(t, srv, http.MethodPut, "/api/settings", `{"qaEpoch":2}`)
	if recEpoch.Code != http.StatusBadRequest || !strings.Contains(recEpoch.Body.String(), "flowId") {
		t.Fatalf("PUT /api/settings bump epoch on retired flow = %d (%s), want 400 flowId error",
			recEpoch.Code, recEpoch.Body.String())
	}

	// Lowering rollout to 0% on the enabled-at-10% retired flow succeeds.
	recLower := do(t, srv, http.MethodPut, "/api/settings", `{"qaRolloutPct":0}`)
	if recLower.Code != http.StatusOK {
		t.Fatalf("PUT /api/settings lower rollout on retired flow = %d (%s), want 200",
			recLower.Code, recLower.Body.String())
	}
	lowered := decode[ui.Settings](t, recLower)
	if !lowered.QAEnabled || lowered.QARolloutPct != 0 || lowered.QAFlowID != activeFlow {
		t.Fatalf("unexpected lowered settings: enabled=%v rollout=%d flow=%q",
			lowered.QAEnabled, lowered.QARolloutPct, lowered.QAFlowID)
	}

	// Full-form PUT /api/settings turning QA off while echoing the unchanged retired qaFlowId succeeds.
	disable := false
	if plannedOff, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{
		QAEnabled: &disable,
		QAFlowID:  &activeFlow,
	}); err != nil || plannedOff.QAEnabled || plannedOff.QAFlowID != activeFlow {
		t.Fatalf("PlanSettings full-form disable with retired flow = (%+v, %v)", plannedOff, err)
	}
	recOff := do(t, srv, http.MethodPut, "/api/settings",
		`{"qaEnabled":false,"qaFlowId":"custom-team-flow@1","qaRolloutPct":0,"qaShadowOnControl":true}`)
	if recOff.Code != http.StatusOK {
		t.Fatalf("PUT /api/settings full-form disable with unchanged retired flow = %d (%s), want 200",
			recOff.Code, recOff.Body.String())
	}
	disabled := decode[ui.Settings](t, recOff)
	if disabled.QAEnabled || disabled.QAFlowID != activeFlow {
		t.Fatalf("expected QA disabled with preserved flowId, got enabled=%v flow=%q",
			disabled.QAEnabled, disabled.QAFlowID)
	}

	if _, err := c.PlanSettings(ctx, ui.UpdateSettingsRequest{QAEnabled: &enable}); err == nil || !strings.Contains(err.Error(), "flowId") {
		t.Fatalf("PlanSettings re-enable with retired flow expected flowId error, got %v", err)
	}
	if _, err := c.UpdateSettings(ctx, ui.UpdateSettingsRequest{QAEnabled: &enable}); err == nil || !strings.Contains(err.Error(), "flowId") {
		t.Fatalf("UpdateSettings re-enable with retired flow expected flowId error, got %v", err)
	}
}
