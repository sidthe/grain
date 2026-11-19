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

package daemon

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/agent"
	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/model/sqlite"
	"github.com/ai-on-gke/grain/pkg/orchestrator"
)

type stubQAFramework struct {
	name string
}

func (s *stubQAFramework) Run(_ context.Context, _ agent.RunConfig) (*agent.Result, error) {
	return &agent.Result{FinalText: s.name}, nil
}

func TestQAStageRoutingThroughJudgementModelAndStartupOverhead(t *testing.T) {
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

	cfg := Config{
		AgentBackends: []model.AgentBackend{
			{
				ID:        "antigravity-ambient",
				Framework: model.AgentFrameworkAntigravity,
				Models:    []string{"auto", "gemini-3.1-pro"},
			},
			{
				ID:        "claude-api",
				Framework: model.AgentFrameworkClaude,
				Models:    []string{"claude-sonnet-5-5"},
			},
		},
	}
	task := model.Task{
		ID:             "t-14",
		AgentFramework: model.AgentFrameworkAntigravity,
		Model:          "auto",
	}

	// 1. Without judgement_model configured: uses task's framework/model with Priority=true and 60s antigravity startup overhead.
	primary, fallback := resolveQAStageAgentChoices(ctx, store, cfg, task)
	if primary.Framework != model.AgentFrameworkAntigravity || primary.Model != "auto" || !primary.Priority || fallback != nil {
		t.Fatalf("without judgement_model: got primary=%+v fallback=%+v, want antigravity/auto Priority=true nil fallback", primary, fallback)
	}
	if overhead := qaStageStartupOverhead(ctx, store, cfg, task); overhead != 60*time.Second {
		t.Fatalf("antigravity startup overhead = %v, want 60s", overhead)
	}

	// 2. With judgement_model configured to a Claude model: routes primary to judgement_model (with task fallback)
	// and uses Claude's 20s startup overhead instead of antigravity's 60s.
	storedCfg, err := store.GetConfig(ctx)
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if storedCfg == nil {
		storedCfg = &model.Config{}
	}
	storedCfg.JudgementModel = "claude-sonnet-5-5"
	if err := store.PutConfig(ctx, *storedCfg); err != nil {
		t.Fatalf("PutConfig: %v", err)
	}

	primary, fallback = resolveQAStageAgentChoices(ctx, store, cfg, task)
	if primary.Model != "claude-sonnet-5-5" || primary.Framework != "" || !primary.Priority {
		t.Fatalf("with judgement_model: got primary=%+v, want Model=claude-sonnet-5-5 Priority=true", primary)
	}
	if fallback == nil || fallback.Framework != model.AgentFrameworkAntigravity || fallback.Model != "auto" || !fallback.Priority {
		t.Fatalf("with judgement_model: got fallback=%+v, want antigravity/auto Priority=true", fallback)
	}
	if overhead := qaStageStartupOverhead(ctx, store, cfg, task); overhead != 20*time.Second {
		t.Fatalf("claude judgement_model startup overhead = %v, want 20s", overhead)
	}

	// 3. buildQAStageFramework tries judgement_model first and falls back cleanly if unavailable.
	var tried []orchestrator.AgentChoice
	fw, err := buildQAStageFramework(ctx, store, cfg, func(_ context.Context, ch orchestrator.AgentChoice) (agent.Framework, error) {
		tried = append(tried, ch)
		if ch.Model == "claude-sonnet-5-5" {
			return nil, errors.New("claude unavailable")
		}
		return &stubQAFramework{name: ch.Framework + ":" + ch.Model}, nil
	}, task)
	if err != nil || fw == nil {
		t.Fatalf("expected fallback to succeed, got fw=%v err=%v", fw, err)
	}
	if len(tried) != 2 || tried[0].Model != "claude-sonnet-5-5" || tried[1].Framework != model.AgentFrameworkAntigravity {
		t.Fatalf("unexpected build attempts: %+v", tried)
	}
}
