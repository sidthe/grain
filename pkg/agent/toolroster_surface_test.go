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

// TestMetricsToolSurfaceMatchesRoster keeps pkg/metrics' local surface table
// aligned with ToolSurface so pkg/metrics stays independent of pkg/agent.
func TestMetricsToolSurfaceMatchesRoster(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	names := append([]string(nil), PublishedToolNames()...)
	names = append(names, "cap__widgets__ping", "Bash")
	uses := make([]model.RunToolUse, 0, len(names))
	for _, name := range names {
		uses = append(uses, model.RunToolUse{RunID: "r1", Tool: name, Calls: 1})
	}
	rep := metrics.Compute(metrics.Input{
		Window: metrics.Window{Since: now.Add(-time.Hour), Until: now.Add(time.Hour)},
		Runs: []model.RunTiming{{
			RunID: "r1", TaskID: "t1", Attempt: 1,
			StartedAt: now.Add(-time.Minute), FinishedAt: &now, Outcome: "succeeded",
		}},
		ToolUses: uses,
	})
	got := make(map[string]string, len(rep.Tools.ByTool))
	for _, u := range rep.Tools.ByTool {
		got[u.Name] = u.Surface
	}
	for _, name := range names {
		want := ToolSurface(name)
		if got[name] != want {
			t.Errorf("metrics surface for %q = %q, want %q (update pkg/metrics/tools.go toolSurfaces)", name, got[name], want)
		}
	}
	if want := len(PublishedControlToolNames()); rep.Tools.ControlCalls != want {
		t.Errorf("ControlCalls = %d, want %d", rep.Tools.ControlCalls, want)
	}
	if want := len(PublishedCLICommandNames()) + 1; rep.Tools.CLICalls != want {
		t.Errorf("CLICalls = %d, want %d", rep.Tools.CLICalls, want)
	}
}
