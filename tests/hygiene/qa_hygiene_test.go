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

package hygiene_test

import (
	"os/exec"
	"strings"
	"testing"
)

func TestOnlyResolverReadsQAAssignment(t *testing.T) {
	cmd := exec.Command("git", "grep", "-E", "(ActiveQAAssignmentForTask|AssignOrLoadArm|qa\\.LookupFlow|checks\\.ResolveEffectiveFlow)", "--", "*.go")
	cmd.Dir = "../../"
	out, err := cmd.Output()
	if err != nil && cmd.ProcessState.ExitCode() != 1 {
		t.Fatalf("git grep failed: %v", err)
	}
	
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "pkg/qa/") &&
			!strings.HasPrefix(line, "pkg/model/qa") &&
			!strings.HasPrefix(line, "pkg/metrics/qa.go") &&
			!strings.HasPrefix(line, "tests/hygiene/qa_hygiene_test.go") &&
			!strings.HasPrefix(line, "pkg/daemon/mcpserver.go") {
			t.Errorf("Forbidden QA read outside pkg/qa/ and pkg/model/qa.go: %s", line)
		}
	}
}
