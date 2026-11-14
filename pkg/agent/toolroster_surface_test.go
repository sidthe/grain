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

package agent

import (
	"slices"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/metrics"
	"github.com/ai-on-gke/grain/pkg/model"
)

// The two surfaces partition PublishedToolNames: every published tool is
// on exactly one of them, and the ones the design names are where it
// puts them (design/design/sandbox-first-agent-surface.design.md §1, §6).
func TestPublishedSurfacesPartitionTheRoster(t *testing.T) {
	control := PublishedControlToolNames()
	cli := PublishedCLICommandNames()
	for _, name := range PublishedToolNames() {
		in := slices.Contains(control, name)
		if in == slices.Contains(cli, name) {
			t.Errorf("%q is on both surfaces or neither (control %v)", name, in)
		}
	}
	for _, name := range []string{"run_command", "edit_file", "ask_question", "comment_on_issue",
		"nothing_needed", "propose_task", "wait_for_task", "resume_later", "recreate_sandbox", "chat",
		"execute_grain_db"} {
		if ToolSurface(name) != SurfaceControl {
			t.Errorf("ToolSurface(%q) = %q, want %q", name, ToolSurface(name), SurfaceControl)
		}
	}
	for _, name := range []string{"wait_for_checks", "get_ci_log", "grain_read", "update_status",
		"write_handover", "add_review_comment", "query_grain_db", "cap__widgets__ping"} {
		if ToolSurface(name) != SurfaceCLI {
			t.Errorf("ToolSurface(%q) = %q, want %q", name, ToolSurface(name), SurfaceCLI)
		}
	}
	if got := ToolSurface("Bash"); got != "" {
		t.Errorf("ToolSurface(Bash) = %q, want empty for a name grain does not publish", got)
	}
}

// TestPublishedSurfacesMatchMetrics holds pkg/metrics's local toolSurface
// classification to agent.ToolSurface so pkg/metrics need not import pkg/agent
// (which would create a pkg/ci -> pkg/metrics -> pkg/agent -> pkg/mcp -> pkg/ci
// import cycle). Any tool added or reclassified in PublishedToolNames fails
// here if pkg/metrics's table drifts.
func TestPublishedSurfacesMatchMetrics(t *testing.T) {
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	until := since.Add(24 * time.Hour)

	finished := since.Add(2 * time.Hour)

	names := append(PublishedToolNames(), "cap__widgets__ping", "Bash")
	uses := make([]model.RunToolUse, 0, len(names))
	for _, name := range names {
		uses = append(uses, model.RunToolUse{RunID: "r1", Tool: name, Calls: 1})
	}

	rep := metrics.Compute(metrics.Input{
		Window: metrics.Window{Since: since, Until: until},
		Runs: []model.RunTiming{{
			RunID:      "r1",
			TaskID:     "t1",
			Attempt:    1,
			StartedAt:  since.Add(time.Hour),
			FinishedAt: &finished,
			Outcome:    "succeeded",
		}},
		ToolUses: uses,
	})

	if len(rep.Tools.ByTool) != len(names) {
		t.Fatalf("metrics reported %d tools, want %d", len(rep.Tools.ByTool), len(names))
	}
	for _, use := range rep.Tools.ByTool {
		if want := ToolSurface(use.Name); use.Surface != want {
			t.Errorf("metrics Surface(%q) = %q, want %q (agent.ToolSurface drifted from pkg/metrics)", use.Name, use.Surface, want)
		}
	}
}
