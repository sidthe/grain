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

package orchestrator_test

import (
	"math"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/orchestrator"
)

func TestFormatQueueTaskValid(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		taskID   string
		priority int
		want     string
	}{
		{name: "min_priority_zero", taskID: "task-1", priority: 0, want: "[P0] task-1"},
		{name: "priority_one", taskID: "task-2", priority: 1, want: "[P1] task-2"},
		{name: "mid_priority", taskID: "grain/task-477", priority: 50, want: "[P50] grain/task-477"},
		{name: "priority_99", taskID: "t99", priority: 99, want: "[P99] t99"},
		{name: "max_priority_100", taskID: "t100", priority: 100, want: "[P100] t100"},
		{name: "single_char", taskID: "a", priority: 5, want: "[P5] a"},
		{name: "single_space", taskID: " ", priority: 10, want: "[P10]  "},
		{name: "special_non_angle_chars", taskID: `foo & "bar" [P0]`, priority: 42, want: `[P42] foo & "bar" [P0]`},
		{name: "unicode", taskID: "日本語-🚀", priority: 7, want: "[P7] 日本語-🚀"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := orchestrator.FormatQueueTask(tc.taskID, tc.priority)
			if err != nil {
				t.Fatalf("FormatQueueTask(%q, %d) unexpected error: %v", tc.taskID, tc.priority, err)
			}
			if got != tc.want {
				t.Errorf("FormatQueueTask(%q, %d) = %q, want %q", tc.taskID, tc.priority, got, tc.want)
			}
		})
	}
}

func TestFormatQueueTaskInvalid(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		taskID   string
		priority int
	}{
		{name: "empty_taskID_p0", taskID: "", priority: 0},
		{name: "empty_taskID_p50", taskID: "", priority: 50},
		{name: "empty_taskID_negative_priority", taskID: "", priority: -1},
		{name: "empty_taskID_high_priority", taskID: "", priority: 101},
		{name: "priority_negative_one", taskID: "task-1", priority: -1},
		{name: "priority_negative_large", taskID: "task-1", priority: -1000},
		{name: "priority_min_int32", taskID: "task-1", priority: math.MinInt32},
		{name: "priority_min_int", taskID: "task-1", priority: math.MinInt},
		{name: "priority_101", taskID: "task-1", priority: 101},
		{name: "priority_large", taskID: "task-1", priority: 1000},
		{name: "priority_max_int32", taskID: "task-1", priority: math.MaxInt32},
		{name: "priority_max_int", taskID: "task-1", priority: math.MaxInt},
		{name: "only_lt", taskID: "<", priority: 10},
		{name: "only_gt", taskID: ">", priority: 10},
		{name: "both_angles", taskID: "<>", priority: 10},
		{name: "html_script_tag", taskID: "<script>alert(1)</script>", priority: 10},
		{name: "contains_lt", taskID: "task<1", priority: 0},
		{name: "contains_gt", taskID: "task>1", priority: 100},
		{name: "contains_both_middle", taskID: "a<b>c", priority: 50},
		{name: "invalid_utf8_with_lt", taskID: "\xff<", priority: 1},
		{name: "invalid_utf8_with_gt", taskID: "\xff>", priority: 1},
		{name: "angles_and_negative_priority", taskID: "<a>", priority: -1},
		{name: "angles_and_high_priority", taskID: "<a>", priority: 101},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := orchestrator.FormatQueueTask(tc.taskID, tc.priority)
			if err == nil {
				t.Fatalf("FormatQueueTask(%q, %d) = %q, nil; want error", tc.taskID, tc.priority, got)
			}
			if got != "" {
				t.Errorf("FormatQueueTask(%q, %d) returned non-empty string %q alongside error %v", tc.taskID, tc.priority, got, err)
			}
		})
	}
}

func TestFormatQueueTaskHugeInputs(t *testing.T) {
	t.Parallel()

	hugeValid := strings.Repeat("x", 1<<20)
	got, err := orchestrator.FormatQueueTask(hugeValid, 50)
	if err != nil {
		t.Fatalf("FormatQueueTask(hugeValid, 50) unexpected error: %v", err)
	}
	want := "[P50] " + hugeValid
	if got != want {
		t.Errorf("FormatQueueTask(hugeValid, 50) len=%d, want len=%d", len(got), len(want))
	}

	for _, tc := range []struct {
		name   string
		taskID string
	}{
		{name: "huge_trailing_lt", taskID: hugeValid + "<"},
		{name: "huge_leading_gt", taskID: ">" + hugeValid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := orchestrator.FormatQueueTask(tc.taskID, 50)
			if err == nil {
				t.Fatalf("FormatQueueTask(%s, 50) succeeded unexpectedly", tc.name)
			}
			if got != "" {
				t.Errorf("FormatQueueTask(%s, 50) = %q, want empty string", tc.name, got)
			}
			if len(err.Error()) >= 256 {
				t.Errorf("FormatQueueTask(%s, 50) error message unexpectedly large (%d bytes)", tc.name, len(err.Error()))
			}
		})
	}
}
