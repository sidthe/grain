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

// approve_upstream.go implements batch upstream-first approval for
// `grain approve -upstream` and `grain approve -workstream`.
package cli

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/ui"
)

func taskIsDone(t ui.Task) bool {
	if t.PrMergedAt != nil || t.State == model.StateClosed {
		return true
	}
	return t.State == model.StateCompleted && strings.TrimSpace(t.PullRequest) == ""
}

func compareTaskIDStrings(a, b string) int {
	na, erra := strconv.Atoi(a)
	nb, errb := strconv.Atoi(b)
	if erra == nil && errb == nil && na != nb {
		if na < nb {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

func approveBatch(ctx context.Context, c *ui.HTTPClient, out *printer, id string, wholeWorkstream bool) error {
	target, err := c.Task(ctx, id)
	if err != nil {
		return err
	}
	listed, err := c.ListTasks(ctx)
	if err != nil {
		return err
	}
	byID := make(map[string]ui.Task, len(listed)+1)
	for _, t := range listed {
		if t.ID != "" {
			byID[t.ID] = t
		}
	}
	byID[target.ID] = target

	// fetchTask treats only a 404 as a missing (deleted) task; any other
	// failure aborts the batch before anything downstream is approved.
	fetchTask := func(tid string) (ui.Task, bool, error) {
		if t, ok := byID[tid]; ok {
			return t, true, nil
		}
		t, ferr := c.Task(ctx, tid)
		if ferr != nil {
			var nf *ui.NotFoundError
			if errors.As(ferr, &nf) {
				return ui.Task{}, false, nil
			}
			return ui.Task{}, false, fmt.Errorf("reading task #%s: %w", tid, ferr)
		}
		byID[t.ID] = t
		return t, true, nil
	}

	selected := map[string]bool{}
	walked := map[string]bool{}
	var depQueue []string

	seedTask := func(t ui.Task) {
		if t.ConsoleSession != "" {
			return
		}
		if t.State == model.StateProposed {
			selected[t.ID] = true
		}
		if !taskIsDone(t) || t.State == model.StateProposed {
			walked[t.ID] = true
			for _, depID := range t.DependsOn {
				if depID != "" && !walked[depID] {
					depQueue = append(depQueue, depID)
				}
			}
		}
	}

	if wholeWorkstream {
		tree, terr := c.WorkTree(ctx, target.ID)
		if terr != nil {
			return terr
		}
		var walkTree func([]ui.WorkTreeNode) error
		walkTree = func(nodes []ui.WorkTreeNode) error {
			for _, n := range nodes {
				t, ok, ferr := fetchTask(n.ID)
				if ferr != nil {
					return ferr
				}
				if ok {
					seedTask(t)
				}
				if err := walkTree(n.Children); err != nil {
					return err
				}
			}
			return nil
		}
		if err := walkTree(tree.Nodes); err != nil {
			return err
		}
		// Ensure target itself is seeded even if a tree omits it.
		if !walked[target.ID] {
			seedTask(target)
		}
	} else {
		seedTask(target)
	}

	for len(depQueue) > 0 {
		depID := depQueue[0]
		depQueue = depQueue[1:]
		if depID == "" || walked[depID] {
			continue
		}
		walked[depID] = true
		dep, ok, ferr := fetchTask(depID)
		if ferr != nil {
			return ferr
		}
		if !ok || dep.ConsoleSession != "" || taskIsDone(dep) {
			continue
		}
		if dep.State == model.StateProposed {
			selected[dep.ID] = true
		}
		for _, next := range dep.DependsOn {
			if next != "" && !walked[next] {
				depQueue = append(depQueue, next)
			}
		}
	}

	ordered := orderProposedIDsUpstreamFirst(selected, byID)
	approved := make([]ui.Task, 0, len(ordered))
	for _, tid := range ordered {
		if err := c.Approve(ctx, tid); err != nil {
			return fmt.Errorf("approving task #%s: %w", tid, err)
		}
		updated, err := c.Task(ctx, tid)
		if err != nil {
			return err
		}
		approved = append(approved, updated)
	}
	if len(approved) == 0 && !out.json {
		out.note(fmt.Sprintf("no proposed tasks to approve for #%s", target.ID))
		return nil
	}
	out.tasks(approved)
	return nil
}

func orderProposedIDsUpstreamFirst(selected map[string]bool, byID map[string]ui.Task) []string {
	if len(selected) == 0 {
		return nil
	}
	inDegree := make(map[string]int, len(selected))
	outgoing := make(map[string]map[string]bool, len(selected))
	for id := range selected {
		inDegree[id] = 0
		outgoing[id] = map[string]bool{}
	}
	for id := range selected {
		visited := map[string]bool{id: true}
		queue := append([]string(nil), byID[id].DependsOn...)
		for len(queue) > 0 {
			depID := queue[0]
			queue = queue[1:]
			if depID == "" || visited[depID] {
				continue
			}
			visited[depID] = true
			if selected[depID] {
				if !outgoing[depID][id] {
					outgoing[depID][id] = true
					inDegree[id]++
				}
				continue
			}
			dep, ok := byID[depID]
			if !ok || dep.ConsoleSession != "" || taskIsDone(dep) {
				continue
			}
			for _, next := range dep.DependsOn {
				if next != "" && !visited[next] {
					queue = append(queue, next)
				}
			}
		}
	}

	remaining := make(map[string]bool, len(selected))
	for id := range selected {
		remaining[id] = true
	}
	out := make([]string, 0, len(selected))
	for len(remaining) > 0 {
		var ready []string
		for id := range remaining {
			if inDegree[id] == 0 {
				ready = append(ready, id)
			}
		}
		if len(ready) == 0 {
			for id := range remaining {
				ready = append(ready, id)
			}
			sort.Slice(ready, func(i, j int) bool { return compareTaskIDStrings(ready[i], ready[j]) < 0 })
			ready = ready[:1]
		} else {
			sort.Slice(ready, func(i, j int) bool { return compareTaskIDStrings(ready[i], ready[j]) < 0 })
		}
		for _, id := range ready {
			delete(remaining, id)
			out = append(out, id)
		}
		for _, id := range ready {
			for next := range outgoing[id] {
				if remaining[next] && inDegree[next] > 0 {
					inDegree[next]--
				}
			}
		}
	}
	return out
}
