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
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/qa"
)

// PreCloneQAResult is the outcome of the pre-clone S0 EARS intent & ambiguity gate.
type PreCloneQAResult struct {
	Prompt             string
	NeedsClarification bool
	Question           string
}

// ExecutePreCloneQAPhase runs the S0 EARS intent extraction gate before git clone so zero
// clone work is wasted when a task requires human clarification.
func ExecutePreCloneQAPhase(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	spec *qa.FlowSpec,
	expID, armID, flowHash string,
	initialPrompt string,
) PreCloneQAResult {
	if spec == nil || armID == model.QAArmControl {
		return PreCloneQAResult{Prompt: initialPrompt}
	}
	rt := LiveQARuntime()
	if rt == nil || rt.RunIsolatedPrompt == nil {
		return PreCloneQAResult{Prompt: initialPrompt}
	}

	comp := qa.AssessTaskComplexity(qa.ComplexityInput{
		Title:       task.Title,
		Body:        task.Body,
		ReadsCount:  len(task.Reads),
		WritesCount: len(task.Writes),
	}, rt.Profiler)

	finalPrompt := initialPrompt

	if spec.S0Intent && !comp.HasDesignItem {
		if len(spec.S0IntentConfig.Complexities) == 0 || slices.Contains(spec.S0IntentConfig.Complexities, string(comp.Tier)) {
			timeout := time.Duration(spec.S0IntentConfig.MaxSeconds) * time.Second
			if timeout <= 0 || timeout > 30*time.Second {
				timeout = 30 * time.Second
			}
			intentGuidance := strings.TrimSpace(spec.IntentSkillText)
			if intentGuidance == "" {
				intentGuidance = "Extract 2 to 6 testable WHEN ... SHALL acceptance criteria and explicit non-goals strictly from the task title and body."
			}
			var alreadyHeld bool
			var commentsContext string
			if store != nil {
				if priorRuns, rErr := store.ListQACheckRunsForTask(ctx, task.ID); rErr == nil {
					for _, pr := range priorRuns {
						if pr.Stage == "S0" && pr.Verdict == "hold" {
							alreadyHeld = true
							break
						}
					}
				}
				if comments, cErr := store.Comments(ctx, task.ID); cErr == nil && len(comments) > 0 {
					var cb strings.Builder
					for _, c := range comments {
						body := strings.TrimSpace(c.Body)
						if body != "" {
							cb.WriteString("\n- ")
							cb.WriteString(body)
						}
					}
					if cb.Len() > 0 {
						commentsContext = "\n\nConversation / Clarification Replies:" + cb.String()
					}
				}
			}
			prompt := intentGuidance + "\n\nTask title: " + task.Title + "\n\nTask body:\n" + task.Body + commentsContext
			runCtx, cancel := context.WithTimeout(ctx, timeout)
			start := time.Now()
			out, inTok, outTok, err := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s0", prompt, spec.S0IntentConfig.MaxTokens)
			duration := time.Since(start).Milliseconds()
			cancel()

			cr := model.QACheckRun{
				TaskID:         task.ID,
				RunID:          task.ID + "-qa-s0",
				Stage:          "S0",
				CheckID:        "qa:intent",
				Arm:            model.QAArmTreatment,
				Verdict:        "pass",
				DurationMS:     duration,
				TokensIn:       inTok,
				TokensOut:      outTok,
				ComplexityTier: string(comp.Tier),
				ExperimentID:   expID,
				ArmID:          armID,
				FlowHash:       flowHash,
				QAEngineRev:    qa.QAEngineRev,
				Model:          task.Model,
			}
			if err != nil {
				cr.Verdict = "error"
			} else {
				checklist := strings.TrimSpace(out)
				if strings.Contains(strings.ToLower(checklist), "status: needs_clarification") {
					if strings.EqualFold(strings.TrimSpace(spec.S0IntentConfig.OnClarification), "ask_human") && !alreadyHeld {
						cr.Verdict = "hold"
						if store != nil {
							_, _ = store.RecordQACheckRun(ctx, cr, nil)
						}
						return PreCloneQAResult{
							Prompt:             initialPrompt,
							NeedsClarification: true,
							Question:           extractClarificationQuestion(checklist),
						}
					}
					cr.Verdict = "warn"
				}
				if checklist != "" {
					finalPrompt += "\n\n## EARS Intent Checklist\n" + checklist
				}
			}
			if store != nil {
				_, _ = store.RecordQACheckRun(ctx, cr, nil)
			}
		}
	}

	return PreCloneQAResult{Prompt: finalPrompt}
}

// ExecutePostCloneWorkflowPhases executes post-clone S1 codebase/caller context discovery,
// S0b goal/subtask decomposition, S2 plan critic (with bounded MaxBounces), and active coding
// guidance assembly (ReadabilityPacks, SkillSteps, PRContract).
func ExecutePostCloneWorkflowPhases(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	worktreeDir string,
	spec *qa.FlowSpec,
	expID, armID, flowHash string,
	currentPrompt string,
) string {
	if spec == nil || armID == model.QAArmControl {
		return currentPrompt
	}
	rt := LiveQARuntime()
	var prof *qa.Profiler
	if rt != nil {
		prof = rt.Profiler
	}

	s1Start := time.Now()
	_, allCandidatePaths, siblingDirs, contextBlock := discoverRepoAndCallerContext(worktreeDir, task, spec)
	s1Duration := time.Since(s1Start).Milliseconds()

	comp := qa.AssessTaskComplexity(qa.ComplexityInput{
		Title:       task.Title,
		Body:        task.Body,
		ReadsCount:  len(task.Reads),
		WritesCount: max(len(task.Writes), len(allCandidatePaths)),
	}, prof)

	prelimRisk := qa.AssessDiffBlast(qa.DiffStats{
		Files:                 allCandidatePaths,
		SiblingCallerPackages: len(siblingDirs),
	}, spec.RiskOverrides, prof)

	finalPrompt := currentPrompt

	// 1. S1 (step:context-repo-discovery): record check run and append bounded Codebase & Caller Context.
	if spec.Context.Enabled || (spec.S2PlanCritic && strings.TrimSpace(worktreeDir) != "") {
		cr := model.QACheckRun{
			TaskID:         task.ID,
			RunID:          task.ID + "-qa-s1",
			Stage:          "S1",
			CheckID:        "qa:context-discovery",
			Arm:            model.QAArmTreatment,
			Verdict:        "pass",
			DurationMS:     s1Duration,
			ComplexityTier: string(comp.Tier),
			BlastTier:      string(prelimRisk.Tier),
			BlastScore:     prelimRisk.Score,
			ExperimentID:   expID,
			ArmID:          armID,
			FlowHash:       flowHash,
			QAEngineRev:    qa.QAEngineRev,
			Model:          task.Model,
		}
		if store != nil {
			_, _ = store.RecordQACheckRun(ctx, cr, nil)
		}
		if contextBlock != "" && !strings.Contains(finalPrompt, "## Codebase & Caller Context") {
			finalPrompt += "\n\n## Codebase & Caller Context\n" + contextBlock
		}
	}

	// 2. S0b (step:goal-subtask-decomposer): structured slice_plan or propose_dag guidance.
	if spec.Decompose.Enabled && spec.Decompose.Mode != "" && spec.Decompose.Mode != "off" {
		if len(spec.Decompose.Complexities) == 0 || slices.Contains(spec.Decompose.Complexities, string(comp.Tier)) {
			decompText := buildDecomposeSection(spec.Decompose, allCandidatePaths)
			if decompText != "" {
				finalPrompt += "\n\n" + decompText
			}
			if store != nil {
				_, _ = store.RecordQACheckRun(ctx, model.QACheckRun{
					TaskID:         task.ID,
					RunID:          task.ID + "-qa-s0b",
					Stage:          "S0b",
					CheckID:        "step:goal-subtask-decomposer",
					Arm:            model.QAArmTreatment,
					Verdict:        "pass",
					ComplexityTier: string(comp.Tier),
					BlastTier:      string(prelimRisk.Tier),
					BlastScore:     prelimRisk.Score,
					ExperimentID:   expID,
					ArmID:          armID,
					FlowHash:       flowHash,
					QAEngineRev:    qa.QAEngineRev,
					Model:          task.Model,
				}, nil)
			}
		}
	}

	// 3. S2 (qa:plan-critic): run after checkout with discovered Codebase & Caller Context,
	// honoring both Complexities and Tiers and bounded MaxBounces (0..2).
	if spec.S2PlanCritic && rt != nil && rt.RunIsolatedPrompt != nil {
		if shouldRunS2Critic(spec.S2PlanCriticConfig, comp.Tier, prelimRisk.Tier) {
			timeout := time.Duration(spec.S2PlanCriticConfig.MaxSeconds) * time.Second
			if timeout <= 0 || timeout > 45*time.Second {
				timeout = 45 * time.Second
			}
			criticGuidance := strings.TrimSpace(spec.PlanCriticSkillText)
			if criticGuidance == "" {
				criticGuidance = "Inspect the proposed file plan and sibling importers. Flag missing caller updates, missing schema/route registrations, or scope creep beyond the task specification."
			}
			baseCriticPrompt := criticGuidance + "\n\nTask title: " + task.Title + "\n\nTask body:\n" + task.Body
			if contextBlock != "" {
				baseCriticPrompt += "\n\n## Codebase & Caller Context\n" + contextBlock
			}

			maxBounces := max(0, min(spec.S2PlanCriticConfig.MaxBounces, 2))
			runCtx, cancel := context.WithTimeout(ctx, timeout)
			start := time.Now()

			var totalInTok, totalOutTok int64
			out, inTok, outTok, err := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s2", baseCriticPrompt, spec.S2PlanCriticConfig.MaxTokens)
			totalInTok += inTok
			totalOutTok += outTok

			for bounce := 1; err == nil && bounce <= maxBounces && runCtx.Err() == nil; bounce++ {
				trimmed := strings.TrimSpace(out)
				if !strings.Contains(strings.ToUpper(trimmed), "REVISE_PLAN:") {
					break
				}
				refinePrompt := baseCriticPrompt + "\n\nPrior Plan Critique (pass " + fmt.Sprint(bounce) + "):\n" + trimmed +
					"\n\nRefine the plan to address all REVISE_PLAN findings while keeping the diff minimal and within scope."
				nextOut, bIn, bOut, bErr := rt.RunIsolatedPrompt(runCtx, task, fmt.Sprintf("%s-qa-s2-bounce-%d", task.ID, bounce), refinePrompt, spec.S2PlanCriticConfig.MaxTokens)
				totalInTok += bIn
				totalOutTok += bOut
				if bErr != nil {
					break
				}
				if strings.TrimSpace(nextOut) != "" {
					out = nextOut
				}
			}
			duration := time.Since(start).Milliseconds()
			cancel()

			cr := model.QACheckRun{
				TaskID:         task.ID,
				RunID:          task.ID + "-qa-s2",
				Stage:          "S2",
				CheckID:        "qa:plan-critic",
				Arm:            model.QAArmTreatment,
				Verdict:        "pass",
				DurationMS:     duration,
				TokensIn:       totalInTok,
				TokensOut:      totalOutTok,
				ComplexityTier: string(comp.Tier),
				BlastTier:      string(prelimRisk.Tier),
				BlastScore:     prelimRisk.Score,
				ExperimentID:   expID,
				ArmID:          armID,
				FlowHash:       flowHash,
				QAEngineRev:    qa.QAEngineRev,
				Model:          task.Model,
			}
			if err != nil {
				cr.Verdict = "error"
			} else {
				critique := strings.TrimSpace(out)
				if critique != "" {
					finalPrompt += "\n\n## S2 Plan Critique\n" + critique
				}
			}
			if store != nil {
				_, _ = store.RecordQACheckRun(ctx, cr, nil)
			}
		}
	}

	// 4. Coding prompt assembly: inject ActiveCodingGuidance (ReadabilityPacks, SkillSteps, PRContract).
	finalPrompt = appendActiveCodingGuidance(finalPrompt, spec, allCandidatePaths)

	return finalPrompt
}

// ExecutePreDispatchQAPhases executes pre-clone S0 and post-clone S0b/S1/S2 workflow phases in sequence.
func ExecutePreDispatchQAPhases(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	spec *qa.FlowSpec,
	expID, armID, flowHash string,
	initialPrompt string,
) string {
	s0 := ExecutePreCloneQAPhase(ctx, store, task, spec, expID, armID, flowHash, initialPrompt)
	if s0.NeedsClarification {
		return s0.Prompt
	}
	return ExecutePostCloneWorkflowPhases(ctx, store, task, "", spec, expID, armID, flowHash, s0.Prompt)
}

func shouldRunS2Critic(cfg qa.S2PlanCriticDecl, compTier qa.ComplexityTier, blastTier qa.BlastTier) bool {
	if len(cfg.Complexities) == 0 && len(cfg.Tiers) == 0 {
		return compTier == qa.ComplexityHigh || blastTier.RequiresS4()
	}
	if slices.Contains(cfg.Complexities, string(compTier)) {
		return true
	}
	if slices.Contains(cfg.Tiers, string(blastTier)) {
		return true
	}
	return false
}

func extractClarificationQuestion(s0Output string) string {
	lines := strings.Split(strings.TrimSpace(s0Output), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		for _, prefix := range []string{"question:", "clarification_question:", "clarification:"} {
			if strings.HasPrefix(lower, prefix) {
				q := strings.TrimSpace(trimmed[len(prefix):])
				if q != "" {
					return q
				}
			}
		}
	}
	var nonStatus []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.Contains(strings.ToLower(trimmed), "status: needs_clarification") {
			continue
		}
		nonStatus = append(nonStatus, trimmed)
	}
	if len(nonStatus) > 0 {
		return strings.Join(nonStatus, "\n")
	}
	return strings.TrimSpace(s0Output)
}

func buildDecomposeSection(d qa.DecomposeDecl, candidatePaths []string) string {
	targetLines := d.TargetDiffLines
	if targetLines <= 0 {
		targetLines = 250
	}
	maxSubtasks := d.MaxSubtasks
	if maxSubtasks <= 0 {
		maxSubtasks = 4
	}
	var b strings.Builder
	switch d.Mode {
	case "slice_plan":
		fmt.Fprintf(&b, "## Subtask Decomposition (slice_plan)\n")
		fmt.Fprintf(&b, "Break your implementation into at most %d ordered, self-contained verification slices within this single pull request (target ~%d diff lines per slice):\n", maxSubtasks, targetLines)
		if len(candidatePaths) > 0 {
			fmt.Fprintf(&b, "- Candidate target paths: `%s`\n", strings.Join(candidatePaths, "`, `"))
		}
		b.WriteString("1. Slice 1: Core types, interfaces, and unit test scaffolding.\n")
		b.WriteString("2. Slice 2: Primary implementation logic and sibling caller updates.\n")
		b.WriteString("3. Slice 3: Edge-case hardening and end-to-end verification before opening the PR.")
	case "propose_dag":
		fmt.Fprintf(&b, "## Subtask Decomposition (propose_dag)\n")
		fmt.Fprintf(&b, "When decomposing work across follow-up tasks via `propose_task` (at most %d subtasks, ~%d diff lines each):\n", maxSubtasks, targetLines)
		b.WriteString("- Partition `writes[]` across subtasks so file/package ownership is strictly non-overlapping.\n")
		b.WriteString("- Wire explicit `depends_on` wave ordering so foundational schema/interface tasks merge before downstream callers.")
	}
	return b.String()
}

func appendActiveCodingGuidance(currentPrompt string, spec *qa.FlowSpec, candidatePaths []string) string {
	if spec == nil {
		return currentPrompt
	}
	active := strings.TrimSpace(spec.ActiveCodingGuidance(candidatePaths))
	if active == "" {
		return currentPrompt
	}
	baseSkill := strings.TrimSpace(spec.SkillPrompt())
	extra := active
	if baseSkill != "" && strings.Contains(currentPrompt, baseSkill) {
		extra = strings.TrimSpace(strings.TrimPrefix(active, baseSkill))
	}
	if extra == "" || strings.Contains(currentPrompt, extra) {
		return currentPrompt
	}
	if strings.TrimSpace(currentPrompt) == "" {
		return extra
	}
	return currentPrompt + "\n\n" + extra
}

func discoverRepoAndCallerContext(worktreeDir string, task model.Task, spec *qa.FlowSpec) (verifiedPaths, allCandidatePaths, siblingDirs []string, contextBlock string) {
	deadline := time.Now().Add(180 * time.Millisecond)

	rawTokens := collectCandidatePathTokens(task, spec)
	seenCand := map[string]bool{}
	for _, tok := range rawTokens {
		cleaned := cleanRepoRelPath(tok)
		if cleaned == "" || seenCand[cleaned] {
			continue
		}
		seenCand[cleaned] = true
		allCandidatePaths = append(allCandidatePaths, cleaned)
	}

	targetDirs := map[string]bool{}
	seenVerified := map[string]bool{}
	var realWorktreeRoot string
	if strings.TrimSpace(worktreeDir) != "" {
		if rRoot, rErr := filepath.EvalSymlinks(worktreeDir); rErr == nil {
			if rInfo, sErr := os.Stat(rRoot); sErr == nil && rInfo.IsDir() {
				realWorktreeRoot = rRoot
			}
		}
	}
	if realWorktreeRoot != "" {
		for _, cand := range allCandidatePaths {
			if time.Now().After(deadline) {
				break
			}
			if strings.ContainsAny(cand, "*?[") {
				matches, _ := filepath.Glob(filepath.Join(worktreeDir, filepath.FromSlash(cand)))
				for _, m := range matches {
					if !isSafeWorktreePath(realWorktreeRoot, m) {
						continue
					}
					if rel, rErr := filepath.Rel(worktreeDir, m); rErr == nil {
						relSlash := cleanRepoRelPath(filepath.ToSlash(rel))
						if relSlash != "" && !seenVerified[relSlash] {
							seenVerified[relSlash] = true
							verifiedPaths = append(verifiedPaths, relSlash)
						}
					}
				}
				continue
			}
			full := filepath.Join(worktreeDir, filepath.FromSlash(cand))
			if isSafeWorktreePath(realWorktreeRoot, full) {
				if info, err := os.Stat(full); err == nil {
					if !seenVerified[cand] {
						seenVerified[cand] = true
						verifiedPaths = append(verifiedPaths, cand)
					}
					if info.IsDir() {
						targetDirs[cand] = true
					} else if d := path.Dir(cand); d != "." && d != "" {
						targetDirs[d] = true
					}
				}
			} else if d := path.Dir(cand); d != "." && d != "" {
				dFull := filepath.Join(worktreeDir, filepath.FromSlash(d))
				if isSafeWorktreePath(realWorktreeRoot, dFull) {
					if dInfo, dErr := os.Stat(dFull); dErr == nil && dInfo.IsDir() {
						targetDirs[d] = true
					}
				}
			}
		}

		if (spec == nil || spec.Context.IncludeCallers || spec.S2PlanCritic) && len(targetDirs) > 0 && time.Now().Before(deadline) {
			siblingDirs = findSiblingImporterDirs(worktreeDir, targetDirs, deadline)
		}
	}

	maxTokens := 2000
	if spec != nil && spec.Context.MaxTokens > 0 && spec.Context.MaxTokens < maxTokens {
		maxTokens = spec.Context.MaxTokens
	}
	maxBytes := maxTokens * 3 // conservative <= 2000 tokens (~6000 bytes)
	if maxBytes > 6000 {
		maxBytes = 6000
	}

	var b strings.Builder
	b.WriteString("<codebase-context>\n")
	if len(verifiedPaths) > 0 {
		b.WriteString("Verified target paths in checkout:\n")
		for _, vp := range verifiedPaths {
			fmt.Fprintf(&b, "- %s\n", vp)
		}
	} else if len(allCandidatePaths) > 0 {
		b.WriteString("Referenced candidate paths:\n")
		for _, cp := range allCandidatePaths {
			fmt.Fprintf(&b, "- %s\n", cp)
		}
	}
	if len(siblingDirs) > 0 {
		b.WriteString("Direct Go/TS sibling importer directories:\n")
		for _, sd := range siblingDirs {
			fmt.Fprintf(&b, "- %s\n", sd)
		}
	}
	if realWorktreeRoot != "" && len(verifiedPaths) > 0 && time.Now().Before(deadline) {
		for _, vp := range verifiedPaths {
			if time.Now().After(deadline) || b.Len() >= maxBytes-256 {
				break
			}
			full := filepath.Join(worktreeDir, filepath.FromSlash(vp))
			if !isSafeWorktreePath(realWorktreeRoot, full) {
				continue
			}
			info, err := os.Stat(full)
			if err != nil || info.IsDir() || info.Size() > 64*1024 {
				continue
			}
			raw, err := os.ReadFile(full)
			if err != nil {
				continue
			}
			snippet := extractFileHeadline(string(raw), 600)
			if snippet != "" {
				fmt.Fprintf(&b, "File summary (%s):\n%s\n", vp, snippet)
			}
		}
	}
	body := b.String()
	if len(body) > maxBytes-len("</codebase-context>") {
		body = body[:maxBytes-len("</codebase-context>")] + "\n"
	}
	body += "</codebase-context>"
	return verifiedPaths, allCandidatePaths, siblingDirs, body
}

func extractFileHeadline(content string, maxBytes int) string {
	var out []string
	total := 0
	for _, line := range strings.Split(content, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "package ") || strings.HasPrefix(t, "func ") || strings.HasPrefix(t, "type ") ||
			strings.HasPrefix(t, "export ") || strings.HasPrefix(t, "interface ") {
			if total+len(t)+1 > maxBytes {
				break
			}
			out = append(out, "  "+t)
			total += len(t) + 3
		}
	}
	return strings.Join(out, "\n")
}

func findSiblingImporterDirs(worktreeDir string, targetDirs map[string]bool, deadline time.Time) []string {
	realWorktreeRoot, rErr := filepath.EvalSymlinks(worktreeDir)
	if rErr != nil || realWorktreeRoot == "" {
		return nil
	}
	var targets []string
	for d := range targetDirs {
		targets = append(targets, d)
	}
	sort.Strings(targets)

	importers := map[string]bool{}
	_ = filepath.WalkDir(worktreeDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || time.Now().After(deadline) {
			return filepath.SkipDir
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if name == ".git" || name == "node_modules" || name == "vendor" || name == "dist" || name == "build" {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		isGo := strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go")
		isTS := strings.HasSuffix(name, ".ts") || strings.HasSuffix(name, ".tsx") || strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".jsx")
		if !isGo && !isTS {
			return nil
		}
		if !isSafeWorktreePath(realWorktreeRoot, p) {
			return nil
		}
		rel, rErr := filepath.Rel(worktreeDir, p)
		if rErr != nil {
			return nil
		}
		relDir := path.Dir(filepath.ToSlash(rel))
		if targetDirs[relDir] || importers[relDir] {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		header := string(raw)
		if len(header) > 4096 {
			header = header[:4096]
		}
		for _, td := range targets {
			base := path.Base(td)
			if isGo && (strings.Contains(header, "/"+td+"\"") || strings.Contains(header, "\""+td+"\"")) {
				importers[relDir] = true
				break
			}
			if isTS && (strings.Contains(header, td) || (base != "" && strings.Contains(header, "/"+base+"'")) || (base != "" && strings.Contains(header, "/"+base+"\""))) {
				importers[relDir] = true
				break
			}
		}
		return nil
	})

	out := make([]string, 0, len(importers))
	for dir := range importers {
		out = append(out, dir)
	}
	sort.Strings(out)
	return out
}

func collectCandidatePathTokens(task model.Task, spec *qa.FlowSpec) []string {
	var tokens []string
	tokens = append(tokens, extractPathTokensFromText(task.Title)...)
	tokens = append(tokens, extractPathTokensFromText(task.Body)...)
	if task.Folder != nil && len(task.Folder.Path) > 0 {
		tokens = append(tokens, strings.Join(task.Folder.Path, "/"))
	}
	for _, w := range task.Writes {
		if s := strings.TrimSpace(w.Repo.String()); s != "" && looksLikeRepoPath(s) {
			tokens = append(tokens, s)
		}
		if s := strings.TrimSpace(w.Base); s != "" && looksLikeRepoPath(s) {
			tokens = append(tokens, s)
		}
	}
	if spec != nil {
		tokens = append(tokens, spec.Context.ExtraPaths...)
	}
	return tokens
}

func extractPathTokensFromText(text string) []string {
	var out []string
	fields := strings.FieldsFunc(text, func(r rune) bool {
		switch r {
		case ' ', '\t', '\n', '\r', '`', '"', '\'', '(', ')', '[', ']', '{', '}', '<', '>', ',', ';':
			return true
		}
		return false
	})
	for _, f := range fields {
		f = strings.TrimPrefix(f, "./")
		f = strings.TrimRight(f, ".:,!?")
		if idx := strings.IndexByte(f, ':'); idx > 0 {
			f = f[:idx]
		}
		if looksLikeRepoPath(f) {
			out = append(out, f)
		}
	}
	return out
}

func looksLikeRepoPath(s string) bool {
	if s == "" || strings.Contains(s, "://") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, "http") {
		return false
	}
	exts := []string{".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".yml", ".yaml", ".json", ".sql", ".md", ".css", ".html"}
	for _, ext := range exts {
		if strings.HasSuffix(s, ext) {
			return true
		}
	}
	if strings.Contains(s, "/") {
		parts := strings.Split(s, "/")
		switch parts[0] {
		case "pkg", "cmd", "internal", "ui", "src", "web", "app", "lib", "tests", "test", "docs", ".grain", ".github", "scripts", "api", "config", "deploy":
			return true
		}
	}
	return false
}

func cleanRepoRelPath(p string) string {
	p = strings.TrimSpace(filepath.ToSlash(p))
	if strings.ContainsRune(p, 0) || strings.ContainsRune(p, '\\') {
		return ""
	}
	for strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/") {
		if strings.HasPrefix(p, "./") {
			p = strings.TrimPrefix(p, "./")
		} else {
			p = strings.TrimPrefix(p, "/")
		}
	}
	p = strings.TrimSuffix(p, "/")
	if p == "" || p == "." {
		return ""
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return ""
		}
	}
	return p
}

func isSafeWorktreePath(realWorktreeRoot, candidateFull string) bool {
	if realWorktreeRoot == "" || candidateFull == "" {
		return false
	}
	fi, err := os.Lstat(candidateFull)
	if err != nil || fi.Mode()&os.ModeSymlink != 0 {
		return false
	}
	realCand, err := filepath.EvalSymlinks(candidateFull)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(realWorktreeRoot, realCand)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}
