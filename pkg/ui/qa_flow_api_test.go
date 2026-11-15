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
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/model/sqlite"
	"github.com/ai-on-gke/grain/pkg/qa"
	"github.com/ai-on-gke/grain/pkg/ui"
)

func TestQAFlowAPIStagesViewAndRawJSONDeclarationPublish(t *testing.T) {
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

	const tok = "test-qa-v4-flow-token"
	srv := ui.NewServer(ui.Config{
		Actor:         ui.DefaultActor("alice"),
		LocalAPIToken: tok,
	}, store)
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)

	doJSON := func(method, path string, body any) (int, map[string]any) {
		t.Helper()
		var rdr *bytes.Reader
		if body != nil {
			raw, mErr := json.Marshal(body)
			if mErr != nil {
				t.Fatalf("marshal: %v", mErr)
			}
			rdr = bytes.NewReader(raw)
		} else {
			rdr = bytes.NewReader(nil)
		}
		req, rErr := http.NewRequestWithContext(ctx, method, ts.URL+path, rdr)
		if rErr != nil {
			t.Fatalf("NewRequest: %v", rErr)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, dErr := http.DefaultClient.Do(req)
		if dErr != nil {
			t.Fatalf("Do(%s %s): %v", method, path, dErr)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// 1. GET /api/qa/flow-versions/engineering-workflow-v4@1 returns declarationV4 and 8-stage stagesView.
	code, v4Resp := doJSON(http.MethodGet, "/api/qa/flow-versions/engineering-workflow-v4@1", nil)
	if code != http.StatusOK {
		t.Fatalf("GET engineering-workflow-v4@1: status=%d body=%+v", code, v4Resp)
	}
	if v4Resp["schemaVer"] != qa.FlowSchemaV4 {
		t.Fatalf("schemaVer = %v, want %q", v4Resp["schemaVer"], qa.FlowSchemaV4)
	}
	if v4Resp["declarationV4"] == nil {
		t.Fatalf("expected non-nil declarationV4 on engineering-workflow-v4@1")
	}
	stages, ok := v4Resp["stagesView"].([]any)
	if !ok || len(stages) != 8 {
		t.Fatalf("expected 8 stages in stagesView, got %T len=%d", v4Resp["stagesView"], len(stages))
	}

	// 2. Publish a V4 declaration via raw JSON `declaration` field (without YAML string).
	rawV4Decl := map[string]any{
		"schema":  qa.FlowSchemaV4,
		"key":     "json-published-v4",
		"extends": "engineering-workflow-v4@1",
		"label":   "JSON Published V4",
		"decompose": map[string]any{
			"enabled":         true,
			"mode":            "propose_dag",
			"complexities":    []string{"high"},
			"maxSubtasks":     4,
			"targetDiffLines": 350,
		},
		"readabilityPacks": []map[string]any{
			{"id": "go", "enabled": true, "activation": "always"},
			{"id": "ts-angular", "enabled": true, "activation": "auto"},
		},
		"prContract": map[string]any{
			"enabled":               true,
			"mode":                  "blocking",
			"maxSubjectChars":       68,
			"requiredSections":      []string{"Summary", "Verification", "Rollback"},
			"auditLintSuppressions": true,
		},
	}
	code, pubResp := doJSON(http.MethodPost, "/api/qa/flow-versions", map[string]any{
		"declaration": rawV4Decl,
	})
	if code != http.StatusCreated {
		t.Fatalf("POST /api/qa/flow-versions (JSON V4): status=%d body=%+v", code, pubResp)
	}
	pubHash, _ := pubResp["hash"].(string)
	if pubHash == "" {
		t.Fatalf("expected non-empty hash on JSON V4 publish: %+v", pubResp)
	}
	verMap, _ := pubResp["version"].(map[string]any)
	if verMap == nil || verMap["declarationV4"] == nil {
		t.Fatalf("expected version.declarationV4 in POST response: %+v", pubResp)
	}

	// 3. Hydrate stored V4 flow version via GET /api/qa/flow-versions/{hash} and verify V4 fields survive intact.
	code, getStored := doJSON(http.MethodGet, "/api/qa/flow-versions/"+pubHash, nil)
	if code != http.StatusOK {
		t.Fatalf("GET stored V4 flow: status=%d body=%+v", code, getStored)
	}
	declV4Map, _ := getStored["declarationV4"].(map[string]any)
	if declV4Map == nil {
		t.Fatalf("expected declarationV4 on hydrated stored flow: %+v", getStored)
	}
	decompMap, _ := declV4Map["decompose"].(map[string]any)
	if decompMap["mode"] != "propose_dag" {
		t.Fatalf("hydrated decompose.mode = %v, want propose_dag", decompMap["mode"])
	}
	prContractMap, _ := declV4Map["prContract"].(map[string]any)
	if prContractMap["mode"] != "blocking" {
		t.Fatalf("hydrated prContract.mode = %v, want blocking", prContractMap["mode"])
	}
	storedStages, ok := getStored["stagesView"].([]any)
	if !ok || len(storedStages) != 8 {
		t.Fatalf("expected 8 stages in hydrated stagesView, got %d", len(storedStages))
	}

	// 4. Publish a V3 declaration via raw JSON `declaration` field and verify V3 stages are preserved.
	rawV3Decl := map[string]any{
		"schema":  qa.FlowSchemaV3,
		"key":     "json-published-v3",
		"extends": "golden-v3@1",
		"stages": map[string]any{
			"s5-merge-triage": map[string]any{
				"mode": "enforced",
			},
		},
	}
	code, pubV3Resp := doJSON(http.MethodPost, "/api/qa/flow-versions", map[string]any{
		"declaration": rawV3Decl,
	})
	if code != http.StatusCreated {
		t.Fatalf("POST /api/qa/flow-versions (JSON V3): status=%d body=%+v", code, pubV3Resp)
	}
	v3VerMap, _ := pubV3Resp["version"].(map[string]any)
	if v3VerMap == nil || v3VerMap["declarationV3"] == nil {
		t.Fatalf("expected declarationV3 on JSON V3 publish: %+v", pubV3Resp)
	}
}
