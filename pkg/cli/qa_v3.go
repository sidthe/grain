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

package cli

import (
	"github.com/ai-on-gke/grain/pkg/ui"
	"context"
	"fmt"
	"strings"
)

type adoptFlags struct {
	Repo   string `name:"repo" help:"GitHub repository (owner/name)"`
	Path   string `name:"path" help:"Path to the flow declaration inside the repository"`
	Commit string `name:"commit" help:"40-char commit SHA to read from"`
	DryRun bool   `name:"dry-run" help:"Validate and simulate adoption without saving"`
}

func runQAFlowAdopt(ctx context.Context, c *ui.HTTPClient, out *printer, f adoptFlags) error {
	if len(f.Commit) != 40 {
		return fmt.Errorf("commit must be a 40-char hex string")
	}
	if f.Path == "" {
		return fmt.Errorf("path is required")
	}

	req := map[string]any{
		"repo":   f.Repo,
		"path":   f.Path,
		"commit": f.Commit,
		"dryRun": f.DryRun,
	}

	var res map[string]any
	if err := c.DoJSON(ctx, "POST", "/api/qa/flow-versions/adopt", req, &res); err != nil {
		return err
	}

	if f.DryRun {
		out.encode(res)
		return nil
	}

	if out.json {
		out.encode(res)
		return nil
	}

	fmt.Printf("Adopted flow version %s\n", res["hash"])
	return nil
}

type probeFlags struct {
	Flow         string `name:"flow" help:"Flow hash or key@version to probe (default golden-v3@1)"`
	Title        string `name:"title" help:"Simulated pull request title"`
	Body         string `name:"body" help:"Simulated pull request body description"`
	Files        string `name:"files" help:"Comma-separated list of simulated changed file paths"`
	NonTestAdded int    `name:"non-test-added" help:"Simulated non-test lines added"`
}

func runQAFlowProbe(ctx context.Context, c *ui.HTTPClient, out *printer, f probeFlags) error {
	files := []string{}
	if f.Files != "" {
		for _, v := range strings.Split(f.Files, ",") {
			files = append(files, strings.TrimSpace(v))
		}
	}

	req := map[string]any{
		"flowHash":     f.Flow,
		"title":        f.Title,
		"body":         f.Body,
		"files":        files,
		"nonTestAdded": f.NonTestAdded,
	}

	var res map[string]any
	if err := c.DoJSON(ctx, "POST", "/api/qa/probe", req, &res); err != nil {
		return err
	}
	
	if out.json {
		out.encode(res)
		return nil
	}
	
	fmt.Printf("Probe Results:\n")
	fmt.Printf("  Stages Fired: %v\n", res["stagesFired"])
	return nil
}
