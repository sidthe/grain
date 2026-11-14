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

package orchestrator

import (
	"errors"
	"fmt"
	"strings"
)

// FormatQueueTask validates taskID and priority and formats them as "[P<priority>] <taskID>".
// It rejects an empty taskID, priorities outside 0..100 inclusive, and taskID values
// containing '<' or '>'.
func FormatQueueTask(taskID string, priority int) (string, error) {
	if taskID == "" {
		return "", errors.New("orchestrator: taskID must not be empty")
	}
	if priority < 0 || priority > 100 {
		return "", fmt.Errorf("orchestrator: priority %d must be between 0 and 100", priority)
	}
	if strings.ContainsAny(taskID, "<>") {
		return "", errors.New("orchestrator: taskID must not contain '<' or '>'")
	}
	return fmt.Sprintf("[P%d] %s", priority, taskID), nil
}
