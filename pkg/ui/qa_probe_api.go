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

package ui

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ai-on-gke/grain/pkg/qa"
)

type postQAProbeReq struct {
	FlowHash       string   `json:"flowHash"`
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	Files          []string `json:"files"`
	NonTestAdded   int      `json:"nonTestAdded"`
	SiblingCallers int      `json:"siblingCallers"`
}

func (s *Server) handlePostQAProbe(w http.ResponseWriter, r *http.Request) {
	var req postQAProbeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	flowHash := req.FlowHash
	if flowHash == "" {
		flowHash = "golden-v3@1"
	}

	flowBundle, err := qa.ResolveAnyFlowDeclaration([]byte(flowHash), 0, func(p string) (qa.FlowVersionBundle, bool) {
		b, _, _, _, ok, _ := s.lookupFlowBundle(r.Context(), p)
		return b, ok
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	flow := flowBundle.Resolved

	comp := qa.AssessTaskComplexity(qa.ComplexityInput{
		Title:       req.Title,
		Body:        req.Body,
		ReadsCount:  0,
		WritesCount: len(req.Files),
	}, nil)

	risk := qa.AssessDiffBlast(qa.DiffStats{
		Files:                 req.Files,
		NonTestAdded:          req.NonTestAdded,
		SiblingCallerPackages: req.SiblingCallers,
	}, flow.RiskOverrides, nil)

	stagesFired := []string{}
	if flow.S0Intent && !comp.HasDesignItem {
		if len(flow.S0IntentConfig.Complexities) == 0 || contains(flow.S0IntentConfig.Complexities, string(comp.Tier)) {
			stagesFired = append(stagesFired, "S0")
		}
	}
	stagesFired = append(stagesFired, "S1")
	
	if flow.S2PlanCritic {
		if comp.Tier == qa.ComplexityHigh || contains(flow.S2PlanCriticConfig.Complexities, string(comp.Tier)) {
			stagesFired = append(stagesFired, "S2")
		}
	}
	stagesFired = append(stagesFired, "S3")

	for _, stg := range flow.CustomStages {
		tierMatch := true
		if stg.MinTier != "" {
			if comp.Tier == qa.ComplexityLow && stg.MinTier != "low" {
				tierMatch = false
			} else if comp.Tier == qa.ComplexityMedium && stg.MinTier == "high" {
				tierMatch = false
			}
		}
		pathMatch := true
		if len(stg.WhenPaths) > 0 {
			pathMatch = false
			for _, p := range stg.WhenPaths {
				for _, w := range req.Files {
					if strings.Contains(w, p) || strings.HasPrefix(w, p) {
						pathMatch = true
						break
					}
				}
				if pathMatch {
					break
				}
			}
		}
		if tierMatch && pathMatch {
			stagesFired = append(stagesFired, stg.ID)
		}
	}

	if flow.RequiresS4ForTier(risk.Tier) {
		stagesFired = append(stagesFired, "S4")
	}

	var triage qa.TriageVerdict
	var modeStr string
	if flow.S5MergeTriage.Mode != "" && flow.S5MergeTriage.Mode != "off" {
		stagesFired = append(stagesFired, "S5")
		modeStr = flow.S5MergeTriage.Mode
		var autoTiers, humTiers []qa.BlastTier
		for _, s := range flow.S5MergeTriage.AutoMergeTiers {
			autoTiers = append(autoTiers, qa.BlastTier(s))
		}
		for _, s := range flow.S5MergeTriage.RequireHumanTiers {
			humTiers = append(humTiers, qa.BlastTier(s))
		}
		triageIn := qa.TriageInput{
			Mode:                       flow.S5MergeTriage.Mode,
			AutoMergeTiers:             autoTiers,
			RequireHumanTiers:          humTiers,
			TrustBoundaryRequiresHuman: false,
			FilesTruncated:             len(req.Files) >= 3000,
			HasUnresolvedFindings:      false,
			OperatorAutoMergeEnabled:   true,
		}
		triage = qa.EvaluateTriage(triageIn, nil)
	}

	res := map[string]any{
		"complexity": map[string]any{
			"tier":          comp.Tier,
			"score":         comp.Score,
			"signals":       comp.Signals,
			"hasDesignItem": comp.HasDesignItem,
		},
		"risk": map[string]any{
			"tier":          risk.Tier,
			"score":         risk.Score,
			"signals":       risk.Reasons,
			"testTampered":  risk.TestTampered,
			"trustBoundary": risk.TrustBoundaryHit,
		},
		"stagesFired": stagesFired,
		"triage": map[string]any{
			"decision":       string(triage.Decision),
			"enforced":       triage.Enforced,
			"mode":           modeStr,
			"tier":           string(triage.Tier),
			"blastScore":     triage.BlastScore,
			"reasons":        triage.Reasons,
			"blockedByFloor": triage.BlockedByFloor,
		},
	}
	writeJSON(w, http.StatusOK, res)
}

func contains(slice []string, val string) bool {
	for _, item := range slice {
		if item == val {
			return true
		}
	}
	return false
}
