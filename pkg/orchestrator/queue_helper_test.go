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

	hugeID := strings.Repeat("x", 1<<20)
	cases := []struct {
		name     string
		taskID   string
		priority int
		want     string
	}{
		{
			name:     "min_priority_boundary",
			taskID:   "task-1",
			priority: 0,
			want:     "[P0] task-1",
		},
		{
			name:     "typical_priority",
			taskID:   "task-476",
			priority: 5,
			want:     "[P5] task-476",
		},
		{
			name:     "max_priority_boundary",
			taskID:   "task-100",
			priority: 100,
			want:     "[P100] task-100",
		},
		{
			name:     "format_verbs_not_reinterpreted",
			taskID:   "task_%s_%d",
			priority: 42,
			want:     "[P42] task_%s_%d",
		},
		{
			name:     "unicode_task_id",
			taskID:   "task-αβγ",
			priority: 50,
			want:     "[P50] task-αβγ",
		},
		{
			name:     "huge_task_id",
			taskID:   hugeID,
			priority: 10,
			want:     "[P10] " + hugeID,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := orchestrator.FormatQueueTask(tc.taskID, tc.priority)
			if err != nil {
				t.Fatalf("FormatQueueTask(%q, %d) unexpected error: %v", tc.taskID, tc.priority, err)
			}
			if got != tc.want {
				t.Fatalf("FormatQueueTask(%q, %d) = %q, want %q", tc.taskID, tc.priority, got, tc.want)
			}
		})
	}
}

func TestFormatQueueTaskInvalid(t *testing.T) {
	t.Parallel()

	hugePrefix := strings.Repeat("a", 1<<20)
	cases := []struct {
		name     string
		taskID   string
		priority int
	}{
		{
			name:     "empty_task_id_valid_priority",
			taskID:   "",
			priority: 0,
		},
		{
			name:     "empty_task_id_mid_priority",
			taskID:   "",
			priority: 50,
		},
		{
			name:     "empty_task_id_invalid_priority",
			taskID:   "",
			priority: -1,
		},
		{
			name:     "priority_below_min",
			taskID:   "task-1",
			priority: -1,
		},
		{
			name:     "priority_above_max",
			taskID:   "task-1",
			priority: 101,
		},
		{
			name:     "priority_min_int",
			taskID:   "task-1",
			priority: math.MinInt,
		},
		{
			name:     "priority_max_int",
			taskID:   "task-1",
			priority: math.MaxInt,
		},
		{
			name:     "contains_less_than",
			taskID:   "task<1",
			priority: 10,
		},
		{
			name:     "contains_greater_than",
			taskID:   "task>1",
			priority: 10,
		},
		{
			name:     "contains_angle_brackets",
			taskID:   "<script>alert(1)</script>",
			priority: 10,
		},
		{
			name:     "single_less_than",
			taskID:   "<",
			priority: 0,
		},
		{
			name:     "single_greater_than",
			taskID:   ">",
			priority: 100,
		},
		{
			name:     "invalid_utf8_before_angle_bracket",
			taskID:   "task\xff<",
			priority: 5,
		},
		{
			name:     "huge_task_id_trailing_less_than",
			taskID:   hugePrefix + "<",
			priority: 5,
		},
		{
			name:     "huge_task_id_trailing_greater_than",
			taskID:   hugePrefix + ">",
			priority: 5,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := orchestrator.FormatQueueTask(tc.taskID, tc.priority)
			if err == nil {
				t.Fatalf("FormatQueueTask(%q, %d) = (%q, nil), want error", tc.taskID, tc.priority, got)
			}
			if got != "" {
				t.Fatalf("FormatQueueTask(%q, %d) returned non-empty string %q alongside error %v", tc.taskID, tc.priority, got, err)
			}
		})
	}
}
