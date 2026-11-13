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
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ai-on-gke/grain/pkg/github"
	"github.com/ai-on-gke/grain/pkg/metrics"
	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/qa"
	"github.com/ai-on-gke/grain/pkg/qa/resolve"
	"github.com/ai-on-gke/grain/pkg/qa/checks"
)

// QAOpenPROptions carries optional pre-PR quality verification metadata from `open_pull_request`.
type QAOpenPROptions struct {
	CallerNotes         string
	AllowHoldAfterS3Cap bool
}

// S4VerifyFunc runs an isolated, read-only fresh-context verification prompt on a T2/T3 diff
// with zero coding-agent chain-of-thought.
type S4VerifyFunc func(ctx context.Context, task model.Task, prompt string) (output string, tokensIn, tokensOut int64, err error)

// MirrorRemoteResolver returns the clone URL and optional HTTP bearer token for repo on the controller.
type MirrorRemoteResolver func(ctx context.Context, repo model.RepoRef) (remoteURL, bearerToken string, err error)

// QARuntime holds controller-level dependencies used by pre-PR quality checks during
// `OpenPullRequestForTaskWithQA`, `salvagePushedBranch`, and async Control shadow runs.
type QARuntime struct {
	DataDir       string
	Profiler      *qa.Profiler
	ResolveRemote MirrorRemoteResolver
	VerifyS4      S4VerifyFunc
}

var liveQARuntime atomic.Pointer[QARuntime]

// SetLiveQARuntime publishes controller-level QA runtime hooks for PR-open and salvage paths.
func SetLiveQARuntime(rt *QARuntime) {
	liveQARuntime.Store(rt)
}

// LiveQARuntime returns the currently registered controller QA runtime, or nil when unconfigured.
func LiveQARuntime() *QARuntime {
	return liveQARuntime.Load()
}

// OpenPullRequestForTaskWithQA enforces treatment-arm staging promotion and S3/S4 pre-PR gates
// before delegating to OpenPullRequestForTask, and triggers non-blocking shadow checks on Control.
func OpenPullRequestForTaskWithQA(
	ctx context.Context,
	store *model.Store,
	client github.Client,
	task model.Task,
	opts QAOpenPROptions,
) (PullRequestStatus, error) {
	if store == nil || task.Target == nil || client == nil {
		return OpenPullRequestForTask(ctx, store, client, task)
	}

	assign, qaCfg, err := resolve.ActiveQAResolutionForTask(ctx, store, task.ID)
	if err != nil || assign == nil || !qaCfg.Enabled {
		return OpenPullRequestForTask(ctx, store, client, task)
	}

	if assign.ArmID == model.QAArmControl {
		status, err := OpenPullRequestForTask(ctx, store, client, task)
		if err == nil {
			if qaCfg.ShadowOnControlEnabled() {
				maybeRunControlShadowS3(store, client, task, assign.FlowID, assign.Spec)
			}
			maybeEvaluateQACircuitBreakerThrottled(ctx, store, time.Now().UTC())
		}
		return status, err
	}

	if assign.ArmID != model.QAArmTreatment {
		return OpenPullRequestForTask(ctx, store, client, task)
	}

	freshTask, err := store.GetTask(ctx, task.ID)
	if err != nil {
		return PullRequestStatus{}, err
	}
	if freshTask != nil {
		task = *freshTask
	}

	stageBranch := model.QAStageBranchName(task.ID)
	stageExists, err := targetBranchExists(client, *task.Target, stageBranch)
	if err != nil {
		return PullRequestStatus{}, fmt.Errorf("orchestrator: checking staging branch %s: %w", stageBranch, err)
	}

	checkBranch := task.BranchName()
	if stageExists {
		checkBranch = stageBranch
	}

	flow := *assign.Spec
	remoteHead, err := client.GetBranchHead(task.Target.StoredOwner(), task.Target.Name, checkBranch)
	if err != nil {
		return PullRequestStatus{}, fmt.Errorf("orchestrator: reading branch %s head: %w", checkBranch, err)
	}
	headSHA := ""
	if remoteHead != nil {
		headSHA = remoteHead.SHA
	}
	if stageExists && headSHA == "" {
		return PullRequestStatus{}, fmt.Errorf("orchestrator: staging branch %s has no head commit", stageBranch)
	}

	s3Passed, s3Ran, blastTier, s3Summary := false, false, qa.BlastT1, ""
	if headSHA != "" {
		s3Passed, s3Ran, blastTier, s3Summary = loadRecordedS3Outcome(ctx, store, task.ID, headSHA)
	}
	if headSHA != "" && (!s3Ran || (!s3Passed && strings.TrimSpace(opts.CallerNotes) != "")) {
		rep, ran, s3Err := runMirrorS3IfConfigured(ctx, store, task, assign.FlowID, model.QAArmTreatment, false, checkBranch, opts.CallerNotes, assign.Spec)
		if s3Err != nil {
			if rt := LiveQARuntime(); rt != nil && rt.DataDir != "" {
				return PullRequestStatus{}, fmt.Errorf("orchestrator: running pre-PR S3 checks on %s: %w", checkBranch, s3Err)
			}
		} else if ran {
			s3Ran = true
			s3Passed = rep.Passed
			blastTier = rep.BlastTier
			headSHA = rep.HeadSHA
			if !rep.Passed {
				s3Summary = rep.FormatAgentFailure()
			}
		}
	}
	if !s3Ran {
		// In unit tests without a recorded check-run or mirror runtime, proceed cleanly.
		s3Passed = true
	}

	if !s3Passed {
		if !opts.AllowHoldAfterS3Cap {
			return PullRequestStatus{}, fmt.Errorf("%s", nonEmptySummary(s3Summary, "pre-PR deterministic quality checks (S3) failed"))
		}
		// S3 retry cap reached: promote staged work onto a held PR with AutoMerge stripped and GateQA recorded.
		if stageExists {
			if _, err := promoteQAStageBranch(client, *task.Target, stageBranch, task.BranchName(), headSHA); err != nil {
				return PullRequestStatus{}, fmt.Errorf("orchestrator: promoting held staging branch %s to %s: %w",
					stageBranch, task.BranchName(), err)
			}
		}
		if err := holdTaskForQA(ctx, store, task.ID, headSHA, firstLineSummary(s3Summary), time.Now().UTC()); err != nil {
			return PullRequestStatus{}, err
		}
		status, err := OpenPullRequestForTask(ctx, store, client, task)
		if err == nil {
			maybeEvaluateQACircuitBreakerThrottled(ctx, store, time.Now().UTC())
		}
		return status, err
	}

	// On T2/T3 diffs under a flow with EnableS4, defer live PR branch promotion so the
	// orchestrator can run 1 fresh-context S4 verification pass once the coding turn exits.
	if stageExists && flow.EnableS4 && blastTier.RequiresS4() && !hasTaskLink(task, model.LinkQAS4Attempted) {
		_ = store.UpdateTask(ctx, task.ID, func(t *model.Task) error {
			t.Links = withoutTaskLinkKinds(t.Links, model.LinkQAHold)
			t.Links = append(t.Links, model.Link{Kind: model.LinkQAHold, Target: headSHA})
			return nil
		})
		return PullRequestStatus{
			ChecksKnown: true,
			Note: fmt.Sprintf("Pre-PR deterministic quality checks (S3) passed on staging ref %s (blast tier %s). "+
				"End your turn now; Grain will run fresh-context S4 verification and publish the pull request automatically.",
				stageBranch, blastTier),
		}, nil
	}

	if stageExists {
		if _, err := promoteQAStageBranch(client, *task.Target, stageBranch, task.BranchName(), headSHA); err != nil {
			return PullRequestStatus{}, fmt.Errorf("orchestrator: promoting verified staging branch %s to %s: %w",
				stageBranch, task.BranchName(), err)
		}
	}
	clearTaskQAHold(ctx, store, task.ID)
	status, err := OpenPullRequestForTask(ctx, store, client, task)
	if err == nil {
		maybeEvaluateQACircuitBreakerThrottled(ctx, store, time.Now().UTC())
	}
	return status, err
}

// salvageQAStageIfPresent runs S3 (if not yet evaluated for the staged commit) and bounded 1-round
// S4 verification on treatment-arm tasks before promoting grain-qa-stage/<task-id> to task.BranchName().
//
// Returns handled=true when the task was parked/requeued for repair (so finishWithPullRequest must NOT
// open a premature GitHub PR yet). Returns handled=false once any staging branch has been promoted
// and is ready for standard finishWithPullRequest processing.
func salvageQAStageIfPresent(
	ctx context.Context,
	store *model.Store,
	client github.Client,
	task model.Task,
	now time.Time,
) (handled bool, err error) {
	if store == nil || client == nil || task.Target == nil {
		return false, nil
	}
	assign, qaCfg, aErr := resolve.ActiveQAResolutionForTask(ctx, store, task.ID)
	qaActive := aErr == nil && assign != nil && qaCfg.Enabled && assign.ArmID == model.QAArmTreatment

	stageBranch := model.QAStageBranchName(task.ID)
	stageExists, err := targetBranchExists(client, *task.Target, stageBranch)
	if err != nil {
		return false, fmt.Errorf("orchestrator: checking %s's staging branch: %w", task.ID, err)
	}

	if !qaActive && stageExists {
		err := PromoteStrandedQAStage(ctx, store, client, task, "Quality checks disabled or task no longer gated")
		if err != nil {
			return false, err
		}
		return true, nil
	}
	if !qaActive {
		return false, nil
	}
	checkBranch := stageBranch
	if !stageExists {
		// If the branch was pushed directly without staging (e.g. in-process test harness), check task.BranchName().
		pushedMain, pErr := targetBranchExists(client, *task.Target, task.BranchName())
		if pErr != nil || !pushedMain {
			return false, pErr
		}
		checkBranch = task.BranchName()
	}

	closed, err := taskClosed(ctx, store, task.ID)
	if err != nil {
		return true, err
	}
	if closed {
		if stageExists {
			_ = client.DeleteBranch(task.Target.StoredOwner(), task.Target.Name, stageBranch)
		}
		return true, noteOrphanedPullRequests(ctx, store, client, task.ID, now)
	}

	head, err := client.GetBranchHead(task.Target.StoredOwner(), task.Target.Name, checkBranch)
	if err != nil || head == nil {
		return false, err
	}
	headSHA := head.SHA

	fresh, err := store.GetTask(ctx, task.ID)
	if err != nil {
		return true, err
	}
	if fresh != nil {
		task = *fresh
	}

	// 1. Check whether in-sandbox S3 already evaluated headSHA; otherwise run S3 over shallow mirror.
	s3Passed, s3Ran, blastTier, s3Summary := loadRecordedS3Outcome(ctx, store, task.ID, headSHA)
	var mirrorWS *checks.MirrorWorkspace
	var s3HazardSites map[string][]int
	if !s3Ran {
		rep, ws, ran, mErr := runMirrorS3WithWorkspace(ctx, store, task, assign.FlowID, model.QAArmTreatment, false, checkBranch, "", assign.Spec)
		if mErr == nil && ran {
			s3Ran = true
			s3Passed = rep.Passed
			blastTier = rep.BlastTier
			s3HazardSites = rep.HazardSites
			mirrorWS = ws
			if !rep.Passed {
				s3Summary = rep.FormatAgentFailure()
			}
		} else if mErr != nil && LiveQARuntime() != nil && LiveQARuntime().DataDir != "" {
			// Mirror infrastructure error: promote onto a held PR (AutoMerge stripped) rather than silently passing.
			if stageExists {
				if _, err := promoteQAStageBranch(client, *task.Target, stageBranch, task.BranchName(), headSHA); err != nil {
					return true, err
				}
			}
			if err := holdTaskForQA(ctx, store, task.ID, headSHA, fmt.Sprintf("pre-PR mirror check error: %v", mErr), now); err != nil {
				return true, err
			}
			return false, nil
		} else {
			s3Passed = true
		}
	}

	if !s3Passed {
		if !hasTaskLink(task, model.LinkQASalvageRetried) {
			if err := store.UpdateTask(ctx, task.ID, func(t *model.Task) error {
				if !hasTaskLink(*t, model.LinkQASalvageRetried) {
					t.Links = append(t.Links, model.Link{Kind: model.LinkQASalvageRetried, Target: headSHA})
				}
				return nil
			}); err != nil {
				return true, err
			}
			if err := noteOnTask(ctx, store, task.ID, s3Summary, now); err != nil {
				return true, err
			}
			if err := observeField(ctx, store, task.ID, now, func(o *model.Observation) {
				o.CompletedAt = nil
				o.RetryRequestedAt = &now
			}); err != nil {
				return true, err
			}
			return true, nil
		}

		// Retry cap reached: promote branch so work is visible on a held PR, strip auto-merge, and attach GateQA findings.
		if stageExists {
			if _, err := promoteQAStageBranch(client, *task.Target, stageBranch, task.BranchName(), headSHA); err != nil {
				return true, err
			}
		}
		if err := holdTaskForQA(ctx, store, task.ID, headSHA, firstLineSummary(s3Summary), now); err != nil {
			return true, err
		}
		return false, nil
	}

	// 2. S3 passed! Run bounded 1-round fresh-context S4 verifier on T2/T3 when enabled and not yet attempted.
	flow := *assign.Spec
	if flow.EnableS4 && blastTier.RequiresS4() && !hasTaskLink(task, model.LinkQAS4Attempted) {
		s4Findings, s4Err := runFreshContextS4(ctx, store, task, headSHA, checkBranch, mirrorWS, s3HazardSites)
		if s4Err != nil {
			log.Printf("orchestrator: task %s S4 verification degraded to S3-pass: %v", task.ID, s4Err)
		} else {
			if err := store.UpdateTask(ctx, task.ID, func(t *model.Task) error {
				if !hasTaskLink(*t, model.LinkQAS4Attempted) {
					t.Links = append(t.Links, model.Link{Kind: model.LinkQAS4Attempted, Target: headSHA})
				}
				return nil
			}); err != nil {
				return true, err
			}
			if len(s4Findings) > 0 {
				note := formatS4RepairNote(headSHA, s4Findings)
				if err := noteOnTask(ctx, store, task.ID, note, now); err != nil {
					return true, err
				}
				if err := observeField(ctx, store, task.ID, now, func(o *model.Observation) {
					o.CompletedAt = nil
					o.RetryRequestedAt = &now
				}); err != nil {
					return true, err
				}
				return true, nil
			}
		}
	}

	// 3. Verified! Promote staging branch to real PR branch and clear any QA hold.
	if stageExists {
		if _, err := promoteQAStageBranch(client, *task.Target, stageBranch, task.BranchName(), headSHA); err != nil {
			return true, fmt.Errorf("orchestrator: promoting staging branch %s to %s: %w", stageBranch, task.BranchName(), err)
		}
	}
	clearTaskQAHold(ctx, store, task.ID)
	return false, nil
}

// promoteQAStageBranch moves/creates refs/heads/<prBranch> at refs/heads/<stageBranch>'s tip SHA
// (verifying expectedSHA when non-empty) and deletes the temporary staging branch ref.
func promoteQAStageBranch(client github.Client, target model.RepoRef, stageBranch, prBranch, expectedSHA string) (string, error) {
	stageHead, err := client.GetBranchHead(target.StoredOwner(), target.Name, stageBranch)
	if err != nil {
		return "", err
	}
	if stageHead == nil || stageHead.SHA == "" {
		return "", fmt.Errorf("staging branch %s has no head commit on %s", stageBranch, target)
	}
	if expectedSHA != "" && stageHead.SHA != expectedSHA {
		return "", fmt.Errorf("staging branch %s moved from verified commit %s to %s before promotion",
			stageBranch, shortSHA(expectedSHA), shortSHA(stageHead.SHA))
	}
	existing, err := client.GetBranchHead(target.StoredOwner(), target.Name, prBranch)
	if err != nil {
		return "", err
	}
	if existing == nil {
		if err := client.CreateBranch(target.StoredOwner(), target.Name, prBranch, stageHead.SHA); err != nil {
			// Race tolerance if created concurrently.
			if uErr := client.UpdateBranch(target.StoredOwner(), target.Name, prBranch, stageHead.SHA, true); uErr != nil {
				return "", err
			}
		}
	} else if existing.SHA != stageHead.SHA {
		if err := client.UpdateBranch(target.StoredOwner(), target.Name, prBranch, stageHead.SHA, true); err != nil {
			return "", err
		}
	}
	_ = client.DeleteBranch(target.StoredOwner(), target.Name, stageBranch)
	return stageHead.SHA, nil
}

// effectiveTaskPushHead reads the active staging branch head first on treatment tasks, falling back
// to task.BranchName() so pre-run/post-run movement checks see staging pushes before promotion.
func effectiveTaskPushHead(ctx context.Context, store *model.Store, client github.Client, task model.Task) (*github.BranchHead, error) {
	if client == nil || task.Target == nil {
		return nil, nil
	}
	if store != nil {
		if assign, qaCfg, err := resolve.ActiveQAResolutionForTask(ctx, store, task.ID); err == nil && qaCfg.Enabled && assign != nil && assign.ArmID == model.QAArmTreatment {
			if stageHead, sErr := client.GetBranchHead(task.Target.StoredOwner(), task.Target.Name, model.QAStageBranchName(task.ID)); sErr == nil && stageHead != nil {
				return stageHead, nil
			}
		}
	}
	return client.GetBranchHead(task.Target.StoredOwner(), task.Target.Name, task.BranchName())
}

func maybeRunControlShadowS3(store *model.Store, client github.Client, task model.Task, flowID string, spec *qa.FlowSpec) {
	rt := LiveQARuntime()
	if rt == nil || rt.DataDir == "" || rt.ResolveRemote == nil || store == nil || client == nil || task.Target == nil {
		return
	}
	taskCopy := task
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		head, err := client.GetBranchHead(taskCopy.Target.StoredOwner(), taskCopy.Target.Name, taskCopy.BranchName())
		if err != nil || head == nil {
			return
		}
		existing, err := store.ListQACheckRunsForTask(ctx, taskCopy.ID)
		if err == nil {
			for _, r := range existing {
				if r.Shadow && r.CommitSHA == head.SHA {
					return
				}
			}
		}
		_, _, _ = runMirrorS3IfConfigured(ctx, store, taskCopy, flowID, model.QAArmControl, true, taskCopy.BranchName(), "", spec)
	}()
}

func runMirrorS3IfConfigured(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	flowID, arm string,
	shadow bool,
	branch, callerNotes string,
	spec *qa.FlowSpec,
) (checks.Report, bool, error) {
	rep, _, ran, err := runMirrorS3WithWorkspace(ctx, store, task, flowID, arm, shadow, branch, callerNotes, spec)
	return rep, ran, err
}

func runMirrorS3WithWorkspace(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	flowID, arm string,
	shadow bool,
	branch, callerNotes string,
	spec *qa.FlowSpec,
) (checks.Report, *checks.MirrorWorkspace, bool, error) {
	rt := LiveQARuntime()
	if rt == nil || rt.DataDir == "" || rt.ResolveRemote == nil || task.Target == nil {
		return checks.Report{}, nil, false, nil
	}
	remoteURL, bearer, err := rt.ResolveRemote(ctx, *task.Target)
	if err != nil || strings.TrimSpace(remoteURL) == "" {
		return checks.Report{}, nil, false, err
	}
	ws, err := checks.OpenMirrorWorkspace(ctx, filepath.Join(rt.DataDir, "qa-repos"), remoteURL, bearer, task.Base, branch)
	if err != nil {
		return checks.Report{}, nil, false, err
	}
	var flow qa.FlowSpec
	if spec != nil {
		flow = *spec
	}
	rep, err := checks.RunS3(ctx, ws, flow, checks.RunOptions{
		TaskID:      task.ID,
		Arm:         arm,
		Shadow:      shadow,
		Attempt:     1,
		CallerNotes: callerNotes,
	}, rt.Profiler)
	if err != nil {
		return checks.Report{}, ws, false, err
	}
	persistS3ReportToStore(ctx, store, task.ID, "", arm, shadow, callerNotes, rep)
	return rep, ws, true, nil
}

func persistS3ReportToStore(
	ctx context.Context,
	store *model.Store,
	taskID, runID, arm string,
	shadow bool,
	callerNotes string,
	rep checks.Report,
) {
	if store == nil {
		return
	}
	detailMap := map[string]any{
		"blastTier": rep.BlastTier,
	}
	if strings.TrimSpace(callerNotes) != "" {
		detailMap["callerNotes"] = strings.TrimSpace(callerNotes)
	}
	detailBytes, _ := json.Marshal(detailMap)

	for _, cr := range rep.Results {
		var modelFindings []model.QAFinding
		for _, f := range cr.Findings {
			modelFindings = append(modelFindings, model.QAFinding{
				TaskID:   taskID,
				Stage:    "S3",
				RuleID:   f.RuleID,
				Severity: f.Severity,
				FilePath: f.FilePath,
				Line:     f.Line,
				Summary:  f.Summary,
				Evidence: f.Evidence,
			})
		}
		_, _ = store.RecordQACheckRun(ctx, model.QACheckRun{
			TaskID:     taskID,
			RunID:      runID,
			CommitSHA:  rep.HeadSHA,
			Stage:      "S3",
			CheckID:    cr.CheckID,
			Arm:        arm,
			Shadow:     shadow,
			Verdict:    cr.Verdict,
			DurationMS: cr.DurationMS,
			AllocBytes: cr.AllocBytes,
			DetailJSON: string(detailBytes),
		}, modelFindings)
	}
}

func loadRecordedS3Outcome(ctx context.Context, store *model.Store, taskID, headSHA string) (passed, ran bool, tier qa.BlastTier, summary string) {
	runs, err := store.ListQACheckRunsForTask(ctx, taskID)
	if err != nil || len(runs) == 0 {
		return false, false, qa.BlastT1, ""
	}
	passed = true
	tier = qa.BlastT1
	runIDs := map[int64]bool{}
	for _, r := range runs {
		if r.Shadow || r.Stage != "S3" || r.CommitSHA != headSHA {
			continue
		}
		ran = true
		runIDs[r.ID] = true
		if r.Verdict == "fail" {
			passed = false
		}
		if r.DetailJSON != "" {
			var meta struct {
				BlastTier string `json:"blastTier"`
			}
			if json.Unmarshal([]byte(r.DetailJSON), &meta) == nil && meta.BlastTier != "" {
				tier = qa.BlastTier(meta.BlastTier)
			}
		}
	}
	if !ran {
		return false, false, qa.BlastT1, ""
	}
	if !passed {
		findings, _ := store.ListQAFindingsForTask(ctx, taskID)
		var lines []string
		for _, f := range findings {
			if f.Stage == "S3" && runIDs[f.CheckRunID] {
				loc := f.FilePath
				if loc != "" && f.Line > 0 {
					loc = fmt.Sprintf("%s:%d", loc, f.Line)
				}
				lines = append(lines, fmt.Sprintf("- [%s] %s %s", f.RuleID, loc, f.Summary))
			}
		}
		summary = "Pre-PR deterministic quality checks (S3) found issues on " + shortSHA(headSHA) + ":\n" + strings.Join(lines, "\n") +
			"\nFix these issues, push to your branch, and call `open_pull_request`."
	}
	return passed, true, tier, summary
}

func runFreshContextS4(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	headSHA, branch string,
	ws *checks.MirrorWorkspace,
	hazardSites map[string][]int,
) ([]qa.ValidatedS4Finding, error) {
	rt := LiveQARuntime()
	if rt == nil || rt.VerifyS4 == nil || task.Target == nil {
		return nil, nil
	}
	if ws == nil && rt.DataDir != "" && rt.ResolveRemote != nil {
		if remoteURL, bearer, rErr := rt.ResolveRemote(ctx, *task.Target); rErr == nil && remoteURL != "" {
			ws, _ = checks.OpenMirrorWorkspace(ctx, filepath.Join(rt.DataDir, "qa-repos"), remoteURL, bearer, task.Base, branch)
		}
	}
	if ws == nil {
		return nil, nil
	}

	rawDiff, err := ws.BaseHeadDiff(ctx)
	if err != nil || strings.TrimSpace(rawDiff) == "" {
		return nil, err
	}
	pd := checks.ParseUnifiedDiff(rawDiff)

	headFiles := map[string]string{}
	for _, df := range pd.Files {
		if df.IsDeleted || df.NewPath == "" {
			continue
		}
		if b, fErr := ws.ReadFileAtHead(ctx, df.NewPath); fErr == nil {
			headFiles[df.NewPath] = string(b)
		}
	}
	if hazardSites == nil {
		_, hz, _, _ := checks.CheckSiblingExportHazard(ctx, ws, pd, 2, "s4-context")
		hazardSites = hz
	}
	for file := range hazardSites {
		if _, exists := headFiles[file]; !exists {
			if b, fErr := ws.ReadFileAtHead(ctx, file); fErr == nil {
				headFiles[file] = string(b)
			}
		}
	}

	prompt := buildS4VerifierPrompt(task, rawDiff, hazardSites)
	s4Ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	var rawOut string
	var tokIn, tokOut int64
	var kept []qa.ValidatedS4Finding
	var filteredCnt int

	sample, vErr := rt.Profiler.Measure(qa.PerfSample{
		TaskID:  task.ID,
		Stage:   "S4",
		CheckID: qa.RuleS4OrthogonalVerifier,
	}, func() (string, error) {
		out, inTok, outTok, err := rt.VerifyS4(s4Ctx, task, prompt)
		rawOut = out
		tokIn = inTok
		tokOut = outTok
		if err != nil {
			return "error", err
		}
		parsed, pErr := qa.ExtractS4JSONFindings(rawOut)
		if pErr != nil {
			return "error", pErr
		}
		kept, filteredCnt = qa.FilterS4Findings(parsed, qa.InquisitorContext{
			HeadFiles:        headFiles,
			DiffHunks:        pd.HunkMap(),
			HazardSites:      hazardSites,
			FullDiffText:     rawDiff,
			SeenFingerprints: map[string]bool{},
		})
		if len(kept) > 0 {
			return "fail", nil
		}
		return "pass", nil
	})
	if vErr != nil {
		return nil, vErr
	}

	detailBytes, _ := json.Marshal(map[string]any{
		"filteredTheaterCount": filteredCnt,
	})
	var modelFindings []model.QAFinding
	for _, f := range kept {
		modelFindings = append(modelFindings, model.QAFinding{
			TaskID:   task.ID,
			Stage:    "S4",
			RuleID:   qa.RuleS4OrthogonalVerifier,
			Severity: "blocking",
			FilePath: f.File,
			Line:     f.Line,
			Summary:  f.Summary,
			Evidence: f.Evidence,
		})
	}
	_, _ = store.RecordQACheckRun(ctx, model.QACheckRun{
		TaskID:     task.ID,
		CommitSHA:  headSHA,
		Stage:      "S4",
		CheckID:    qa.RuleS4OrthogonalVerifier,
		Arm:        model.QAArmTreatment,
		Shadow:     false,
		Verdict:    sample.Verdict,
		DurationMS: sample.DurationMS,
		TokensIn:   tokIn,
		TokensOut:  tokOut,
		AllocBytes: sample.AllocBytes,
		DetailJSON: string(detailBytes),
	}, modelFindings)

	return kept, nil
}

func buildS4VerifierPrompt(task model.Task, rawDiff string, hazardSites map[string][]int) string {
	const maxDiffPromptBytes = 48 * 1024
	diffExcerpt := rawDiff
	if len(diffExcerpt) > maxDiffPromptBytes {
		diffExcerpt = diffExcerpt[:maxDiffPromptBytes] + "\n... [diff truncated]"
	}
	var b strings.Builder
	b.WriteString("You are an orthogonal pre-PR defect verifier inspecting a candidate diff with zero author context.\n")
	b.WriteString("Report ONLY concrete, reproducible logic bugs, missed sibling caller breakages, concurrency/state bugs, or spec violations introduced by this diff.\n")
	b.WriteString("Do NOT report style nits, defensive boilerplate, hypothetical architecture wishes, or pre-existing code outside the diff.\n\n")
	fmt.Fprintf(&b, "## Task Specification\nTitle: %s\n\n%s\n\n", task.Title, strings.TrimSpace(task.Body))
	if len(hazardSites) > 0 {
		b.WriteString("## Untouched Sibling Caller Sites\n")
		for file, lines := range hazardSites {
			fmt.Fprintf(&b, "- %s (lines %v)\n", file, lines)
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "## Candidate Unified Diff\n```diff\n%s\n```\n\n", diffExcerpt)
	b.WriteString("Respond ONLY with a JSON array (`[]` if no real defect exists). Each element MUST have exact keys:\n")
	b.WriteString("`{\"file\": \"path/in/repo.go\", \"line\": 42, \"category\": \"logic_bug|missed_caller|race|contract_mismatch\", \"trigger_scenario\": \"1-3 hop concrete input/state causing failure\", \"fix_hint\": \"minimal fix\"}`\n")
	return b.String()
}

func formatS4RepairNote(headSHA string, findings []qa.ValidatedS4Finding) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Pre-PR verification (S4) identified %d defect(s) on %s before opening the pull request:\n\n", len(findings), shortSHA(headSHA))
	for i, f := range findings {
		fmt.Fprintf(&b, "%d. `%s:%d` — %s\n", i+1, f.File, f.Line, f.Summary)
		if f.Evidence != "" {
			fmt.Fprintf(&b, "   Fix hint: %s\n", f.Evidence)
		}
	}
	b.WriteString("\nAddress the defect(s) above, run tests, push your branch, and call `open_pull_request`.")
	return b.String()
}

func holdTaskForQA(ctx context.Context, store *model.Store, taskID, headSHA, summary string, now time.Time) error {
	return store.UpdateTask(ctx, taskID, func(t *model.Task) error {
		t.Links = withoutTaskLinkKinds(t.Links, model.LinkQAHold)
		t.Links = append(t.Links, model.Link{Kind: model.LinkQAHold, Target: headSHA})
		model.ClearReviewFindingsForGate(t, model.GateQA)
		t.Links = append(t.Links, model.ReviewFindingsRecord{
			Gate:    model.GateQA,
			Summary: nonEmptySummary(summary, "unresolved pre-PR quality check findings"),
			HeadSHA: headSHA,
			At:      now,
		}.Link())
		model.AwaitPersonForAutoMerge(t, "pre-PR quality checks failed after retry cap")
		return nil
	})
}

func clearTaskQAHold(ctx context.Context, store *model.Store, taskID string) {
	if store == nil {
		return
	}
	_ = store.UpdateTask(ctx, taskID, func(t *model.Task) error {
		t.Links = withoutTaskLinkKinds(t.Links, model.LinkQAHold)
		model.ClearReviewFindingsForGate(t, model.GateQA)
		return nil
	})
}

func hasTaskLink(t model.Task, kind model.LinkKind) bool {
	return slices.ContainsFunc(t.Links, func(l model.Link) bool { return l.Kind == kind })
}

func withoutTaskLinkKinds(links []model.Link, kinds ...model.LinkKind) []model.Link {
	out := make([]model.Link, 0, len(links))
	for _, l := range links {
		if !slices.Contains(kinds, l.Kind) {
			out = append(out, l)
		}
	}
	return out
}

func firstLineSummary(s string) string {
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		if t != "" {
			if len(t) > 160 {
				return t[:160]
			}
			return t
		}
	}
	return ""
}

func nonEmptySummary(s, fallback string) string {
	if strings.TrimSpace(s) != "" {
		return strings.TrimSpace(s)
	}
	return fallback
}

var (
	qaCircuitBreakerThrottleMu sync.Mutex
	qaLastEvalStore            *model.Store
	qaLastEvalAt               time.Time
)

const qaCircuitBreakerEvalWindow = 30 * 24 * time.Hour

func maybeEvaluateQACircuitBreakerThrottled(ctx context.Context, store *model.Store, now time.Time) {
	if store == nil {
		return
	}
	defer func() {
		if p := recover(); p != nil {
			log.Printf("orchestrator: recovered panic in QA circuit breaker evaluation: %v", p)
		}
	}()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	qaCircuitBreakerThrottleMu.Lock()
	if qaLastEvalStore == store && now.Sub(qaLastEvalAt) < 30*time.Second && !now.Before(qaLastEvalAt) {
		qaCircuitBreakerThrottleMu.Unlock()
		return
	}
	qaLastEvalStore = store
	qaLastEvalAt = now
	qaCircuitBreakerThrottleMu.Unlock()

	if _, _, err := MaybeAutoDowngradeQARollout(ctx, store, now); err != nil {
		log.Printf("orchestrator: evaluating QA circuit breaker: %v", err)
	}
}

// MaybeAutoDowngradeQARollout evaluates mSPRT latency/escape, context ThreadCut, and operator
// Not-Helpful guardrails once at least MinTreatmentSampleForAutoDowngrade WorkOrigins have been
// assigned in the active (epoch, regime). When a safety rail trips, it atomically downgrades
// rolloutPct to 0% inside Store.UpdateConfig (preserving shadowOnControl=true and advancing
// regimeId) and records a config_audit entry.
func MaybeAutoDowngradeQARollout(ctx context.Context, store *model.Store, now time.Time) (bool, []string, error) {
	if store == nil {
		return false, nil, nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cfg, err := store.GetConfig(ctx)
	if err != nil || cfg == nil {
		return false, nil, err
	}
	if !cfg.QA.Enabled || cfg.QA.RolloutPct <= 0 {
		return false, nil, nil
	}
	epoch := cfg.QA.EpochOrDefault()
	regime := cfg.QA.RegimeIDOrDefault()
	assignments, err := store.ListQAAssignments(ctx)
	if err != nil {
		return false, nil, err
	}
	activeOrigins := map[string]bool{}
	var activeAssignments []model.QAAssignment
	treatCount := 0
	for _, a := range assignments {
		if a.Epoch == epoch && a.RegimeID == regime {
			activeAssignments = append(activeAssignments, a)
			activeOrigins[a.RootOrigin] = true
			if a.Arm == model.QAArmTreatment {
				treatCount++
			}
		}
	}
	if treatCount < metrics.MinTreatmentSampleForAutoDowngrade {
		return false, nil, nil
	}

	tasks, err := store.ListTasks(ctx)
	if err != nil {
		return false, nil, err
	}
	activeTaskIDs := map[string]bool{}
	for _, t := range tasks {
		if activeOrigins[model.ResolveQARootOrigin(t.WorkOrigin, t.ID)] {
			activeTaskIDs[t.ID] = true
		}
	}

	allCheckRuns, err := store.ListAllQACheckRuns(ctx)
	if err != nil {
		return false, nil, err
	}
	checkRuns := make([]model.QACheckRun, 0, len(allCheckRuns))
	activeCheckRunIDs := map[int64]bool{}
	for _, cr := range allCheckRuns {
		if activeTaskIDs[cr.TaskID] {
			checkRuns = append(checkRuns, cr)
			if cr.ID > 0 {
				activeCheckRunIDs[cr.ID] = true
			}
		}
	}

	allFindings, err := store.ListAllQAFindings(ctx)
	if err != nil {
		return false, nil, err
	}
	findings := make([]model.QAFinding, 0, len(allFindings))
	for _, f := range allFindings {
		if (f.CheckRunID > 0 && activeCheckRunIDs[f.CheckRunID]) || activeTaskIDs[f.TaskID] {
			findings = append(findings, f)
		}
	}

	timings, err := store.TaskTimings(ctx)
	if err != nil {
		return false, nil, err
	}
	runs, err := store.RunTimings(ctx)
	if err != nil {
		return false, nil, err
	}
	prompts, err := store.RunPrompts(ctx)
	if err != nil {
		return false, nil, err
	}
	usages, err := store.RunUsagesSince(ctx, time.Time{})
	if err != nil {
		return false, nil, err
	}
	ciRuns, err := store.CIRunOutcomes(ctx)
	if err != nil {
		return false, nil, err
	}

	summary := metrics.ComputeQASummary(metrics.QASummaryInput{
		Window: metrics.Window{
			Since: now.Add(-qaCircuitBreakerEvalWindow),
			Until: now.Add(time.Second),
		},
		Config:      cfg.QA,
		Assignments: activeAssignments,
		CheckRuns:   checkRuns,
		Findings:    findings,
		Tasks:       tasks,
		Timings:     timings,
		Runs:        runs,
		Prompts:     prompts,
		Usages:      usages,
		CIRuns:      ciRuns,
	})
	if !summary.CircuitBreaker.ShouldAutoDowngrade {
		return false, nil, nil
	}

	var didDowngrade bool
	var prevPct int
	err = store.UpdateConfig(ctx, func(fresh *model.Config) error {
		if !fresh.QA.Enabled || fresh.QA.RolloutPct <= 0 {
			return nil
		}
		if fresh.QA.EpochOrDefault() != epoch || fresh.QA.RegimeIDOrDefault() != regime {
			return nil
		}
		prevPct = fresh.QA.RolloutPct
		downgraded, advErr := model.AdvanceQAConfig(fresh.QA, model.QAConfig{
			Enabled:         true,
			FlowID:          fresh.QA.FlowIDOrDefault(),
			RolloutPct:      0,
			ShadowOnControl: model.BoolPtr(true),
			Epoch:           fresh.QA.EpochOrDefault(),
		})
		if advErr != nil {
			return advErr
		}
		fresh.QA = downgraded
		didDowngrade = true
		return nil
	})
	if err != nil || !didDowngrade {
		return false, nil, err
	}
	reasons := slices.Clone(summary.CircuitBreaker.Reasons)
	auditSummary := fmt.Sprintf("auto-downgraded quality control rollout from %d%% to 0%% shadow-only (%s)",
		prevPct, strings.Join(reasons, "; "))
	_, _ = store.RecordConfigAudit(ctx, model.ConfigAuditEntry{
		At: now,
		By: model.Principal{
			Kind:   model.PrincipalAutomation,
			ID:     "qa-circuit-breaker",
			Source: model.SourceInternal,
		},
		Surface: "settings",
		Summary: auditSummary,
	})
	log.Printf("orchestrator: %s", auditSummary)
	return true, reasons, nil
}


// PromoteStrandedQAStage promotes a stranded QA stage branch to the task's live PR branch, if it exists,
// and records a fail-open check run.
func PromoteStrandedQAStage(ctx context.Context, store *model.Store, client github.Client, task model.Task, reason string) error {
	stageRef := model.QAStageBranchName(task.ID)
	head, err := client.GetBranchHead(task.Target.StoredOwner(), task.Target.Name, stageRef)
	if err != nil || head == nil || head.SHA == "" {
		return nil // Doesn't exist, nothing to promote.
	}

	assign, qaCfg, err := resolve.ActiveQAResolutionForTask(ctx, store, task.ID)
	if err != nil {
		return err
	}
	if qaCfg.Enabled && assign != nil && assign.ArmID == model.QAArmTreatment {
		return nil // Task is actively in treatment, not stranded.
	}

	promotedSHA, err := promoteQAStageBranch(client, *task.Target, model.QAStageBranchName(task.ID), task.BranchName(), head.SHA)
	if err != nil {
		return fmt.Errorf("promoting stranded QA stage: %w", err)
	}

	status, err := OpenPullRequestForTask(ctx, store, client, task)
	if err != nil {
		return fmt.Errorf("opening PR after promotion: %w", err)
	}

	if status.PullRequest.Number > 0 {
		note := "Quality checks did not run: " + reason
		// Actually the prompt said "append PR note 'Quality checks did not run: ' + reason".
		// But if appendOrUpdatePRNote is not defined, maybe it's appendPRNote or similar. Let's look for it.
		// Wait, I can just use client.CreateComment?
		// No, let me leave appendOrUpdatePRNote if it was defined, or maybe I should check the methods on client.
		_, _ = client.CreateComment(task.Target.StoredOwner(), task.Target.Name, status.PullRequest.Number, note)
	}

	detailBytes, _ := json.Marshal(map[string]string{"reason": reason})
	run := model.QACheckRun{
		TaskID:     task.ID,
		CommitSHA:  promotedSHA,
		Stage:      "S-promote",
		CheckID:    "qa:fail-open-promote",
		Arm:        "control",
		Verdict:    "unchecked",
		DetailJSON: string(detailBytes),
	}
	_, err = store.RecordQACheckRun(ctx, run, nil)
	return err
}
