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
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
)

func TestHeaderIdentityConfigAndSettingsRoundTrip(t *testing.T) {
	t.Parallel()
	srv, _ := testServer(t)

	// Initial GET /api/config omits empty headerColor / headerPattern.
	initialCfgRec := do(t, srv, http.MethodGet, "/api/config", "")
	if initialCfgRec.Code != http.StatusOK {
		t.Fatalf("initial GET /api/config: %d %s", initialCfgRec.Code, initialCfgRec.Body.String())
	}
	var rawInitial map[string]any
	if err := json.Unmarshal(initialCfgRec.Body.Bytes(), &rawInitial); err != nil {
		t.Fatalf("decode initial /api/config: %v", err)
	}
	if _, ok := rawInitial["headerColor"]; ok {
		t.Errorf("empty headerColor should be omitted from GET /api/config, got %v", rawInitial["headerColor"])
	}
	if _, ok := rawInitial["headerPattern"]; ok {
		t.Errorf("empty headerPattern should be omitted from GET /api/config, got %v", rawInitial["headerPattern"])
	}
	if id, _ := rawInitial["deploymentId"].(string); id == "" {
		t.Errorf("authenticated GET /api/config should include non-empty deploymentId")
	}

	// First save seeds required fields alongside identity fields.
	seed := `{"pollInterval":"30s","githubHost":"github.com","environmentName":"staging-eu","headerColor":"ocean","headerPattern":"waves"}`
	if rec := do(t, srv, http.MethodPost, "/api/settings", seed); rec.Code != http.StatusOK {
		t.Fatalf("seed POST /api/settings: %d %s", rec.Code, rec.Body.String())
	}

	// GET /api/config exposes environmentName, headerColor, headerPattern.
	cfgRec := do(t, srv, http.MethodGet, "/api/config", "")
	if cfgRec.Code != http.StatusOK {
		t.Fatalf("GET /api/config: %d %s", cfgRec.Code, cfgRec.Body.String())
	}
	var cfg struct {
		EnvironmentName string `json:"environmentName"`
		HeaderColor     string `json:"headerColor"`
		HeaderPattern   string `json:"headerPattern"`
	}
	if err := json.Unmarshal(cfgRec.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("decode /api/config: %v", err)
	}
	if cfg.EnvironmentName != "staging-eu" || cfg.HeaderColor != "ocean" || cfg.HeaderPattern != "waves" {
		t.Fatalf("GET /api/config = %+v, want staging-eu / ocean / waves", cfg)
	}

	// Every curated preset pair round-trips through POST /api/settings/plan and POST /api/settings.
	for _, color := range model.HeaderColors() {
		for _, pattern := range model.HeaderPatterns() {
			body, _ := json.Marshal(map[string]string{
				"headerColor":   color,
				"headerPattern": pattern,
			})
			planRec := do(t, srv, http.MethodPost, "/api/settings/plan", string(body))
			if planRec.Code != http.StatusOK {
				t.Fatalf("POST /api/settings/plan (%q,%q): %d %s", color, pattern, planRec.Code, planRec.Body.String())
			}
			saveRec := do(t, srv, http.MethodPost, "/api/settings", string(body))
			if saveRec.Code != http.StatusOK {
				t.Fatalf("POST /api/settings (%q,%q): %d %s", color, pattern, saveRec.Code, saveRec.Body.String())
			}
			var saved map[string]any
			if err := json.Unmarshal(saveRec.Body.Bytes(), &saved); err != nil {
				t.Fatalf("decode save response: %v", err)
			}
			// Must be present even when cleared to "" so frontend merges overwrite old values.
			gotColor, hasColor := saved["headerColor"]
			gotPattern, hasPattern := saved["headerPattern"]
			if !hasColor || gotColor != color || !hasPattern || gotPattern != pattern {
				t.Fatalf("saved (%q,%q): gotColor=(%v,%v) gotPattern=(%v,%v)",
					color, pattern, gotColor, hasColor, gotPattern, hasPattern)
			}
		}
	}
}

func TestHeaderIdentityRejectsInvalidValuesWith400(t *testing.T) {
	t.Parallel()
	srv, _ := testServer(t)

	if rec := do(t, srv, http.MethodPost, "/api/settings", `{"pollInterval":"30s","githubHost":"github.com","headerColor":"forest","headerPattern":"dots"}`); rec.Code != http.StatusOK {
		t.Fatalf("seed POST /api/settings: %d %s", rec.Code, rec.Body.String())
	}

	badBodies := []struct {
		body string
		want string
	}{
		{`{"headerColor":"blue"}`, "headerColor"},
		{`{"headerColor":"#ff0000"}`, "headerColor"},
		{`{"headerColor":"OCEAN"}`, "headerColor"},
		{`{"headerColor":"ocean;color:red"}`, "headerColor"},
		{`{"headerPattern":"stripes"}`, "headerPattern"},
		{`{"headerPattern":"solid"}`, "headerPattern"},
		{`{"headerPattern":"url(evil)"}`, "headerPattern"},
	}
	for _, tc := range badBodies {
		for _, path := range []string{"/api/settings", "/api/settings/plan"} {
			rec := do(t, srv, http.MethodPost, path, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("POST %s %s: status = %d, want 400 (body: %s)", path, tc.body, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Errorf("POST %s %s: body = %q, want mention of %q", path, tc.body, rec.Body.String(), tc.want)
			}
		}
	}

	// Stored values remain untouched after refused writes.
	rec := do(t, srv, http.MethodGet, "/api/settings", "")
	var got struct {
		HeaderColor   string `json:"headerColor"`
		HeaderPattern string `json:"headerPattern"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.HeaderColor != "forest" || got.HeaderPattern != "dots" {
		t.Fatalf("stored values mutated after 400: %+v", got)
	}
}

func TestHeaderIdentityEnforcesAuthAndSettingsLocked(t *testing.T) {
	// Role enforcement (viewer refused with 403).
	h := newRoleHarness(t)
	h.allow(t, "user:viv@example.com", "grain/viewer")
	if code, body := h.call("viv@example.com", http.MethodPost, "/api/settings", `{"headerColor":"coral","headerPattern":"grid"}`); code != http.StatusForbidden {
		t.Fatalf("viewer POST /api/settings: %d %s, want 403", code, body)
	}

	// settingsLocked enforcement (config-managed fields refused with 409).
	srv := stateRepoServer(t, &fakeStateRepo{})
	if rec := do(t, srv, http.MethodPost, "/api/settings", `{"settingsLocked":true}`); rec.Code >= 300 {
		t.Fatalf("locking settings: %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{
		`{"headerColor":"amber"}`,
		`{"headerPattern":"grid"}`,
		`{"environmentName":"locked-out","headerColor":"coral","headerPattern":"dots"}`,
	} {
		if rec := do(t, srv, http.MethodPost, "/api/settings", body); rec.Code != http.StatusConflict {
			t.Errorf("POST /api/settings %s while locked: status = %d, want 409: %s", body, rec.Code, rec.Body.String())
		}
	}
	if rec := do(t, srv, http.MethodPost, "/api/settings", `{"settingsLocked":false}`); rec.Code >= 300 {
		t.Fatalf("unlocking settings: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, srv, http.MethodPost, "/api/settings", `{"environmentName":"unlocked","headerColor":"amber","headerPattern":"grid"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST /api/settings after unlocking: %d %s", rec.Code, rec.Body.String())
	}
}
