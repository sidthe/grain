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
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/qa"
	"github.com/ai-on-gke/grain/pkg/redact"
	"github.com/ai-on-gke/grain/pkg/safepath"
)

// PreCloneQAResult holds the result of pre-clone S0 EARS intent extraction.
type PreCloneQAResult struct {
	Prompt             string
	NeedsClarification bool
	Question           string
}

const (
	maxPromptSpecAttachmentBytes = 16 * 1024

	defaultS0InferenceTimeout     = 45 * time.Second
	defaultS2InferenceTimeout     = 45 * time.Second
	defaultS4InferenceTimeout     = 90 * time.Second
	maxQAStageInferenceCap        = 180 * time.Second
	maxQAStageTotalCap            = 300 * time.Second
	maxQAStageStartupOverheadCap  = 120 * time.Second
	antigravityCLIStartupOverhead = 60 * time.Second
	otherCLIStartupOverhead       = 20 * time.Second
)

// CLIStartupOverheadForFramework returns the extra CLI subprocess cold-start latency
// allowance added to lightweight QA stage timeouts (S0/S2/S4) so cold-starting a coding
// CLI (such as ambient Antigravity taking 20-46s before turn 1) does not kill the stage
// before receiving tokens.
func CLIStartupOverheadForFramework(framework string) time.Duration {
	switch model.NormalizeAgentFrameworkName(strings.ToLower(strings.TrimSpace(framework))) {
	case model.AgentFrameworkAntigravity:
		return antigravityCLIStartupOverhead
	case model.AgentFrameworkClaude, model.AgentFrameworkCodex:
		return otherCLIStartupOverhead
	default:
		return 0
	}
}

func resolveQAStageStartupOverhead(ctx context.Context, store *model.Store, rt *QARuntime, task model.Task) time.Duration {
	if rt != nil && rt.StageStartupOverhead != nil {
		d := rt.StageStartupOverhead(ctx, task)
		if d < 0 {
			return 0
		}
		if d > maxQAStageStartupOverheadCap {
			return maxQAStageStartupOverheadCap
		}
		return d
	}
	if fw := strings.TrimSpace(task.AgentFramework); fw != "" {
		return CLIStartupOverheadForFramework(fw)
	}
	if store != nil {
		if cfg, err := store.GetConfig(ctx); err == nil && cfg != nil {
			return CLIStartupOverheadForFramework(model.NormalizeAgentFramework(cfg.AgentFramework))
		}
	}
	return antigravityCLIStartupOverhead
}

func effectiveQAStageTimeout(
	ctx context.Context,
	store *model.Store,
	rt *QARuntime,
	task model.Task,
	configuredSeconds int,
	defaultInference, maxInference time.Duration,
) (total, overhead time.Duration) {
	var inference time.Duration
	switch {
	case configuredSeconds <= 0:
		inference = defaultInference
	case maxInference > 0 && int64(configuredSeconds) > int64(maxInference/time.Second):
		inference = maxInference
	case int64(configuredSeconds) > int64(maxQAStageTotalCap/time.Second):
		inference = maxQAStageTotalCap
	default:
		inference = time.Duration(configuredSeconds) * time.Second
	}
	if maxInference > 0 && inference > maxInference {
		inference = maxInference
	}
	overhead = resolveQAStageStartupOverhead(ctx, store, rt, task)
	total = inference + overhead
	if total > maxQAStageTotalCap {
		total = maxQAStageTotalCap
	}
	return total, overhead
}

func sanitizeQAStageErrorMessage(rt *QARuntime, raw string) string {
	msg := strings.TrimSpace(raw)
	if msg == "" {
		return ""
	}
	if rt != nil && rt.RedactText != nil {
		msg = rt.RedactText(msg)
	}
	// Always apply shape-based credential redaction before truncating so a boundary cut
	// cannot expose a partial secret even when no runtime known-secret redactor is wired.
	msg, _ = (*redact.Redactor)(nil).Text(msg)
	msg = strings.TrimSpace(msg)
	if len(msg) > 1024 {
		msg = model.TruncateValidUTF8(msg, 1024) + "..."
	}
	return msg
}

func classifyQAStageError(rt *QARuntime, err error, runCtx context.Context) (kind string, exitCode *int, message string) {
	if err == nil {
		return "", nil, ""
	}
	msg := sanitizeQAStageErrorMessage(rt, err.Error())
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitCode()
		exitCode = &code
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded) || (runCtx != nil && errors.Is(runCtx.Err(), context.DeadlineExceeded)):
		kind = "timeout"
	case errors.Is(err, context.Canceled) || (runCtx != nil && errors.Is(runCtx.Err(), context.Canceled)):
		kind = "canceled"
	case exitCode != nil:
		kind = "exit_error"
	default:
		kind = "error"
	}
	return kind, exitCode, msg
}

func buildQAStageErrorDetail(
	rt *QARuntime,
	err error,
	runCtx context.Context,
	timeout, startupOverhead time.Duration,
	extra map[string]any,
) string {
	detail := make(map[string]any, len(extra)+5)
	for k, v := range extra {
		detail[k] = v
	}
	kind, exitCode, msg := classifyQAStageError(rt, err, runCtx)
	if _, hasKind := detail["errorKind"]; !hasKind && kind != "" {
		detail["errorKind"] = kind
	}
	if msg != "" {
		detail["error"] = msg
	}
	if exitCode != nil {
		detail["exitCode"] = *exitCode
	}
	if timeout > 0 {
		detail["timeoutSeconds"] = int(timeout / time.Second)
	}
	if startupOverhead > 0 {
		detail["startupOverheadSeconds"] = int(startupOverhead / time.Second)
	}
	b, _ := json.Marshal(detail)
	return string(b)
}

var urlTokenRe = regexp.MustCompile("https?://[^\\s)>\\]\"'`]+")
var pathTokenRe = regexp.MustCompile(`(?:[a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+\.(?:tsx|jsx|hpp|cpp|scss|html|yaml|json|go|ts|js|py|cc|md|yml|sql|css|h)`)
var numberedAttBasenameRe = regexp.MustCompile(`^\d+-[a-zA-Z0-9_.-]+\.(?:html|md|markdown|txt)$`)
var dirTokenRe = regexp.MustCompile(`(?:[a-zA-Z0-9_.-]+/)+[a-zA-Z0-9_.-]+`)
var goImportLineRe = regexp.MustCompile(`"([^"]+)"`)
var tsImportLineRe = regexp.MustCompile(`(?:from|require\()\s*['"]([^'"]+)['"]`)

func isPathTokenContByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_' || b == '-'
}

func loadTaskSpecAttachments(ctx context.Context, store *model.Store, task model.Task, worktreeDir string) model.TaskSpecAttachments {
	if store != nil && strings.TrimSpace(task.ID) != "" {
		if att, err := store.TaskSpecAttachments(ctx, task.ID, model.DefaultTaskSpecAttachmentMaxBytes); err == nil {
			for i := range att.Files {
				if att.Files[i].SandboxPath == "" {
					if att.Files[i].ID > 0 {
						att.Files[i].SandboxPath = AttachmentPath(att.Files[i].ID, att.Files[i].Filename)
					} else {
						att.Files[i].SandboxPath = path.Join(AttachmentsDir, attachmentFilename(att.Files[i].Filename))
					}
				}
			}
			return att
		}
		return model.TaskSpecAttachments{}
	}
	if strings.TrimSpace(worktreeDir) == "" {
		return model.TaskSpecAttachments{}
	}
	attDir, err := safepath.Within(worktreeDir, "attachments")
	if err != nil {
		return model.TaskSpecAttachments{}
	}
	root, err := os.OpenRoot(attDir)
	if err != nil {
		return model.TaskSpecAttachments{}
	}
	defer func() { _ = root.Close() }()

	dirFile, err := root.Open(".")
	if err != nil {
		return model.TaskSpecAttachments{}
	}
	entries, err := dirFile.ReadDir(-1)
	_ = dirFile.Close()
	if err != nil {
		return model.TaskSpecAttachments{}
	}
	var out model.TaskSpecAttachments
	maxRead := int64(model.DefaultTaskSpecAttachmentMaxBytes + utf8.UTFMax)
	for _, ent := range entries {
		if ent.IsDir() || ent.Type()&fs.ModeSymlink != 0 {
			continue
		}
		info, iErr := root.Lstat(ent.Name())
		if iErr != nil || !info.Mode().IsRegular() {
			continue
		}
		sz := info.Size()
		if sz < 0 {
			sz = 0
		}
		isSpec, isMD := model.IsSpecTextAttachment(ent.Name(), "")
		isHTML := model.IsHTMLAttachment(ent.Name(), "")

		out.TotalCount++
		if out.TotalBytes <= math.MaxInt64-sz {
			out.TotalBytes += sz
		} else {
			out.TotalBytes = math.MaxInt64
		}
		if isHTML {
			out.HTMLCount++
		}

		validSpecText := false
		if isSpec {
			f, oErr := root.Open(ent.Name())
			if oErr == nil {
				raw, rErr := io.ReadAll(io.LimitReader(f, maxRead))
				_ = f.Close()
				if rErr == nil && len(raw) > 0 && !slices.Contains(raw, 0) {
					raw = model.TrimIncompleteTrailingUTF8Bytes(raw, model.DefaultTaskSpecAttachmentMaxBytes)
					if len(raw) > 0 && utf8.Valid(raw) {
						if trimmed := strings.TrimSpace(string(raw)); trimmed != "" {
							validSpecText = true
							if isMD {
								out.MarkdownCount++
							}
							if out.SpecBytes <= math.MaxInt64-sz {
								out.SpecBytes += sz
							} else {
								out.SpecBytes = math.MaxInt64
							}
							if len(out.Text) < model.DefaultTaskSpecAttachmentMaxBytes {
								joined := trimmed
								if out.Text != "" {
									joined = out.Text + "\n\n" + trimmed
								}
								out.Text = model.TruncateValidUTF8(joined, model.DefaultTaskSpecAttachmentMaxBytes)
							}
						}
					}
				}
			}
		}
		out.Files = append(out.Files, model.TaskAttachmentMeta{
			Filename:    ent.Name(),
			Size:        sz,
			SandboxPath: path.Join(AttachmentsDir, attachmentFilename(ent.Name())),
			IsSpecText:  validSpecText,
			IsMarkdown:  validSpecText && isMD,
			IsHTML:      isHTML,
		})
	}
	return out
}

var closingTaskAttachmentsTagRe = regexp.MustCompile(`(?i)</task-attachments\s*>`)

func attachmentSandboxRelPath(f model.TaskAttachmentMeta) string {
	if f.ID > 0 {
		return AttachmentPath(f.ID, f.Filename)
	}
	if strings.TrimSpace(f.Filename) != "" {
		return path.Join(AttachmentsDir, attachmentFilename(f.Filename))
	}
	return path.Join(AttachmentsDir, attachmentFilename(f.SandboxPath))
}

// sanitizeManifestContentType reduces an attachment's client-supplied Content-Type
// to a bounded single-line string without control characters, line/paragraph separators,
// backticks, or angle brackets so it cannot break out of the prompt's manifest or
// <task-attachments> block.
func sanitizeManifestContentType(raw string) string {
	const maxContentTypeLen = 80
	var b strings.Builder
	b.Grow(min(len(raw), maxContentTypeLen))
	prevSpace := false
	for _, r := range strings.TrimSpace(raw) {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' || r == '`' || r == '<' || r == '>' {
			continue
		}
		if unicode.IsSpace(r) {
			if prevSpace || b.Len() == 0 {
				continue
			}
			prevSpace = true
			if b.Len()+1 > maxContentTypeLen {
				break
			}
			b.WriteByte(' ')
			continue
		}
		prevSpace = false
		if b.Len()+utf8.RuneLen(r) > maxContentTypeLen {
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

func formatAttachmentsManifest(specAtt model.TaskSpecAttachments) string {
	if len(specAtt.Files) == 0 {
		return ""
	}
	const maxListed = 25
	var b strings.Builder
	for i, f := range specAtt.Files {
		if i >= maxListed {
			fmt.Fprintf(&b, "- ... (%d additional attachment(s) in `./%s/`)\n", len(specAtt.Files)-maxListed, AttachmentsDir)
			break
		}
		relPath := attachmentSandboxRelPath(f)
		if ct := sanitizeManifestContentType(f.ContentType); ct != "" {
			fmt.Fprintf(&b, "- `./%s` (%d bytes, %s)\n", relPath, f.Size, ct)
		} else {
			fmt.Fprintf(&b, "- `./%s` (%d bytes)\n", relPath, f.Size)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func buildAttachmentContextBlock(specAtt model.TaskSpecAttachments, maxTokens int) string {
	if specAtt.TotalCount == 0 && len(specAtt.Files) == 0 && strings.TrimSpace(specAtt.Text) == "" {
		return ""
	}
	if maxTokens <= 0 {
		maxTokens = 1000
	}
	if maxTokens > 4000 {
		maxTokens = 4000
	}
	maxChars := maxTokens * 4
	if maxChars < 512 {
		maxChars = 512
	}

	var b strings.Builder
	b.WriteString("<task-attachments>\n")
	b.WriteString("IMPORTANT: Inspect EVERY file in `./attachments/` before designing, implementing, or decomposing this task.\n")
	if specAtt.TotalCount > 0 {
		fmt.Fprintf(&b, "Attached files (%d total, %d bytes):\n", specAtt.TotalCount, specAtt.TotalBytes)
	}
	if manifest := formatAttachmentsManifest(specAtt); manifest != "" {
		b.WriteString(manifest)
		b.WriteString("\n")
	}
	if trimmed := strings.TrimSpace(specAtt.Text); trimmed != "" {
		trimmed = closingTaskAttachmentsTagRe.ReplaceAllString(trimmed, "&lt;/task-attachments&gt;")
		header := "--- Attached Specification Excerpt ---\n"
		closing := "\n</task-attachments>"
		remaining := maxChars - b.Len() - len(header) - len(closing)
		if remaining > 96 {
			b.WriteString(header)
			b.WriteString(model.TruncateValidUTF8(trimmed, remaining))
			b.WriteString("\n")
		}
	}
	b.WriteString("</task-attachments>")
	return b.String()
}

func isSubtaskOfWorkstream(ctx context.Context, store *model.Store, task model.Task) bool {
	proposerTaskID := strings.TrimSpace(task.Proposer.TaskID)
	if proposerTaskID != "" && task.Proposer.Attribution.Actor.Source != model.SourceSession {
		return true
	}
	if hasTaskLink(task, model.LinkContinues) {
		return true
	}
	origTask := task.WorkOrigin.Task()
	if origTask != "" && origTask != task.ID {
		if task.Proposer.Attribution.Actor.Source == model.SourceSession && origTask == proposerTaskID {
			return false
		}
		if store != nil {
			if orig, err := store.GetTask(ctx, origTask); err == nil && orig != nil && (orig.Interactive || orig.HasConsole()) {
				return false
			}
		}
		return true
	}
	return false
}

func matchesComplexityTier(allowed []string, actual qa.ComplexityTier) bool {
	if len(allowed) == 0 {
		return true
	}
	act := strings.ToLower(strings.TrimSpace(string(actual)))
	for _, raw := range allowed {
		norm := strings.ToLower(strings.TrimSpace(raw))
		if norm == "large" {
			norm = string(qa.ComplexityHigh)
		}
		if norm == act {
			return true
		}
	}
	return false
}

func extractS0ClarificationQuestion(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	var kept []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "status:") && strings.Contains(lower, "needs_clarification") {
			if idx := strings.Index(lower, "needs_clarification"); idx >= 0 {
				rest := strings.TrimSpace(trimmed[idx+len("needs_clarification"):])
				rest = strings.TrimLeft(rest, ":- ")
				if rest != "" {
					kept = append(kept, rest)
				}
			}
			continue
		}
		if strings.HasPrefix(lower, "question:") {
			q := strings.TrimSpace(trimmed[len("question:"):])
			if q != "" {
				return q
			}
		}
		upper := strings.ToUpper(trimmed)
		if strings.HasPrefix(upper, "- WHEN ") || strings.HasPrefix(upper, "* WHEN ") {
			continue
		}
		kept = append(kept, trimmed)
	}
	if len(kept) == 0 {
		return "Clarification is required on ambiguous requirements before implementation proceeds."
	}
	return strings.Join(kept, "\n")
}

// ExecutePreCloneQAPhase runs S0 EARS intent extraction before git checkout so zero clone work is
// spent when the specification requires human clarification.
func ExecutePreCloneQAPhase(
	ctx context.Context,
	store *model.Store,
	task model.Task,
	spec *qa.FlowSpec,
	expID, armID, flowHash string,
	currentPrompt string,
) PreCloneQAResult {
	if spec == nil || armID == model.QAArmControl {
		return PreCloneQAResult{Prompt: currentPrompt}
	}
	rt := LiveQARuntime()
	if rt == nil || rt.RunIsolatedPrompt == nil {
		return PreCloneQAResult{Prompt: currentPrompt}
	}

	specAtt := loadTaskSpecAttachments(ctx, store, task, "")
	comp := qa.AssessTaskComplexity(
		qa.ComplexityInputFromTask(task, specAtt, extractCandidatePathsWithSpec(task, spec, "", specAtt.Text)),
		rt.Profiler,
	)

	finalPrompt := currentPrompt
	s0Enabled := spec.S0Intent || spec.S0IntentConfig.Enabled
	if s0Enabled && !comp.HasDesignItem && matchesComplexityTier(spec.S0IntentConfig.Complexities, comp.Tier) {
		var priorS0Hold bool
		if store != nil && task.ID != "" {
			if runs, rErr := store.ListQACheckRunsForTask(ctx, task.ID); rErr == nil {
				for _, r := range runs {
					if r.Stage == "S0" && r.Verdict == "hold" {
						priorS0Hold = true
						break
					}
				}
			}
		}
		timeout, startupOverhead := effectiveQAStageTimeout(
			ctx, store, rt, task,
			spec.S0IntentConfig.MaxSeconds,
			defaultS0InferenceTimeout,
			maxQAStageInferenceCap,
		)
		intentGuidance := strings.TrimSpace(spec.IntentSkillText)
		if intentGuidance == "" {
			intentGuidance = "Extract 2 to 6 testable WHEN ... SHALL acceptance criteria and explicit non-goals strictly from the task title and body."
		}
		prompt := intentGuidance + "\n\nTask title: " + task.Title + "\n\nTask body:\n" + task.Body
		if manifest := formatAttachmentsManifest(specAtt); manifest != "" {
			prompt += "\n\nTask attachments (in `./attachments/`):\n" + manifest
		}
		if specAtt.Text != "" {
			specMaxBytes := maxPromptSpecAttachmentBytes
			if spec.Context.MaxTokens > 0 && spec.Context.MaxTokens*4 < specMaxBytes {
				specMaxBytes = max(spec.Context.MaxTokens*4, 512)
			}
			prompt += "\n\nAttached specification:\n" + model.TruncateValidUTF8(specAtt.Text, specMaxBytes)
		}
		runCtx, cancel := context.WithTimeout(ctx, timeout)
		start := time.Now()
		out, inTok, outTok, err := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s0", prompt, spec.S0IntentConfig.MaxTokens)
		duration := time.Since(start).Milliseconds()

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
		var needsClarification bool
		var question string
		if err != nil {
			cr.Verdict = "error"
			cr.DetailJSON = buildQAStageErrorDetail(rt, err, runCtx, timeout, startupOverhead, map[string]any{
				"complexityTier":  string(comp.Tier),
				"attachmentCount": specAtt.TotalCount,
				"attachmentBytes": specAtt.TotalBytes,
			})
		} else {
			checklist := strings.TrimSpace(out)
			if strings.Contains(strings.ToLower(checklist), "status: needs_clarification") {
				question = extractS0ClarificationQuestion(checklist)
				onClarify := strings.ToLower(strings.TrimSpace(spec.S0IntentConfig.OnClarification))
				detailBytes, _ := json.Marshal(map[string]any{
					"onClarification": onClarify,
					"question":        question,
					"output":          checklist,
				})
				cr.DetailJSON = string(detailBytes)
				if onClarify == "ask_human" && !priorS0Hold {
					cr.Verdict = "hold"
					needsClarification = true
				} else {
					cr.Verdict = "warn"
					if checklist != "" {
						finalPrompt += "\n\n## EARS Intent Checklist\n" + checklist
					}
				}
			} else if checklist != "" {
				finalPrompt += "\n\n## EARS Intent Checklist\n" + checklist
			}
		}
		cancel()
		if store != nil {
			_, _ = store.RecordQACheckRun(ctx, cr, nil)
		}
		if needsClarification {
			return PreCloneQAResult{
				Prompt:             finalPrompt,
				NeedsClarification: true,
				Question:           question,
			}
		}
	}

	return PreCloneQAResult{Prompt: finalPrompt}
}

// ExecutePostCloneWorkflowPhases runs post-checkout S1 repository & caller context discovery,
// S0b goal decomposition guidance, S2 fresh-context plan critique (with bounded REVISE_PLAN bounces),
// and ActiveCodingGuidance injection.
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

	finalPrompt := currentPrompt
	specAtt := loadTaskSpecAttachments(ctx, store, task, worktreeDir)
	candidatePaths := extractCandidatePathsWithSpec(task, spec, worktreeDir, specAtt.Text)

	// 1. S1 (step:context-repo-discovery): deterministic repo, sibling importer, and task attachment context discovery.
	var codebaseContext string
	var siblingImporters []string
	var attachmentContext string
	s2Enabled := spec.S2PlanCritic || spec.S2PlanCriticConfig.Enabled
	hasAttachments := specAtt.TotalCount > 0 || len(specAtt.Files) > 0 || strings.TrimSpace(specAtt.Text) != ""
	if spec.Context.Enabled || s2Enabled {
		s1Start := time.Now()
		var existingPaths []string
		configuredMaxTokens := spec.Context.MaxTokens
		if configuredMaxTokens <= 0 {
			configuredMaxTokens = 2000
		}
		if strings.TrimSpace(worktreeDir) != "" {
			repoMaxTokens := min(configuredMaxTokens, 2000)
			codebaseContext, existingPaths, siblingImporters = discoverPostCloneCodebaseContext(worktreeDir, candidatePaths, repoMaxTokens, 180*time.Millisecond)
			for _, ep := range existingPaths {
				if !slices.Contains(candidatePaths, ep) {
					candidatePaths = append(candidatePaths, ep)
				}
			}
		}
		if hasAttachments {
			remainingTokens := configuredMaxTokens - len(codebaseContext)/4
			if remainingTokens < 256 {
				remainingTokens = min(configuredMaxTokens, 512)
			}
			attachmentContext = buildAttachmentContextBlock(specAtt, remainingTokens)
		}
		s1Duration := time.Since(s1Start).Milliseconds()
		if spec.Context.Enabled || codebaseContext != "" || attachmentContext != "" {
			if codebaseContext != "" {
				finalPrompt += "\n\n## Codebase & Caller Context\n" + codebaseContext
			} else if spec.Context.Enabled && len(candidatePaths) > 0 {
				codebaseContext = "<codebase-context>\nCandidate paths: " + strings.Join(candidatePaths, ", ") + "\n</codebase-context>"
				finalPrompt += "\n\n## Codebase & Caller Context\n" + codebaseContext
			}
			if attachmentContext != "" {
				finalPrompt += "\n\n## Task Attachments Context\n" + attachmentContext
			}
			if store != nil && (spec.Context.Enabled || codebaseContext != "" || attachmentContext != "") {
				attachmentPaths := make([]string, 0, len(specAtt.Files))
				for _, f := range specAtt.Files {
					attachmentPaths = append(attachmentPaths, "./"+attachmentSandboxRelPath(f))
				}
				detailMap := map[string]any{
					"discoveredPaths":  existingPaths,
					"candidatePaths":   candidatePaths,
					"siblingImporters": siblingImporters,
					"contextBytes":     len(codebaseContext) + len(attachmentContext),
				}
				if len(attachmentPaths) > 0 || specAtt.TotalCount > 0 {
					detailMap["attachments"] = attachmentPaths
					detailMap["attachmentCount"] = specAtt.TotalCount
					detailMap["attachmentBytes"] = specAtt.TotalBytes
				}
				detailBytes, _ := json.Marshal(detailMap)
				_, _ = store.RecordQACheckRun(ctx, model.QACheckRun{
					TaskID:       task.ID,
					RunID:        task.ID + "-qa-s1",
					Stage:        "S1",
					CheckID:      "qa:context-discovery",
					Arm:          model.QAArmTreatment,
					Verdict:      "pass",
					DurationMS:   s1Duration,
					DetailJSON:   string(detailBytes),
					ExperimentID: expID,
					ArmID:        armID,
					FlowHash:     flowHash,
					QAEngineRev:  qa.QAEngineRev,
					Model:        task.Model,
				}, nil)
			}
		}
	}

	comp := qa.AssessTaskComplexity(qa.ComplexityInputFromTask(task, specAtt, candidatePaths), prof)
	if store != nil && strings.TrimSpace(task.ID) != "" && !isSubtaskOfWorkstream(ctx, store, task) {
		epoch := 1
		if qaCfg, cErr := store.ConfigQA(ctx); cErr == nil {
			epoch = qaCfg.EpochOrDefault()
		}
		_ = store.UpdateQAAssignmentComplexityTier(ctx, model.ResolveQARootOrigin(task.WorkOrigin, task.ID), epoch, string(comp.Tier))
	}

	// 2. S0b (step:goal-subtask-decomposer): complexity-gated slice plan / wave DAG coordinator.
	if spec.Decompose.Enabled {
		effectiveMode, overrideApplied := spec.Decompose.EffectiveModeWithOverride(comp.Tier, comp.DecomposeOverride)
		if effectiveMode != "" && effectiveMode != "off" {
			maxSub := spec.Decompose.MaxSubtasks
			if maxSub <= 0 {
				maxSub = 4
			}
			targetLines := spec.Decompose.TargetDiffLines
			if targetLines <= 0 {
				targetLines = 400
			}
			isChildSubtask := isSubtaskOfWorkstream(ctx, store, task)
			// Only step down to single-PR slice_plan on already-decomposed child subtasks so
			// children never fan out recursively; root tasks honor the configured mode truthfully.
			if effectiveMode == "propose_dag" && isChildSubtask {
				effectiveMode = "slice_plan"
			}
			attManifest := formatAttachmentsManifest(specAtt)
			switch effectiveMode {
			case "propose_dag":
				var attClause string
				if attManifest != "" {
					attClause = "\n\n**Required pre-planning step:** Read **every** file in `./attachments/` before designing, implementing, or decomposing work:\n" + attManifest
				} else {
					attClause = " If `./attachments/` contains any files, read every file in `./attachments/` first before designing, implementing, or decomposing work."
				}
				finalPrompt += fmt.Sprintf(
					"\n\n## Workstream Subtask Decomposition (S0b — propose_dag)\n"+
						"You are running on a root Workstream task (`%s` complexity). Inspect the repository layout first.%s\n\n"+
						"Choose ONE of two paths:\n"+
						"1. **Single-PR execution:** If the entire change fits cleanly inside one focused pull request (<= ~%d diff lines within one subsystem), implement and verify it directly in this run without calling `propose_task`.\n"+
						"2. **Wave-ordered Workstream DAG:** If the work spans multiple subsystems or waves (> ~%d diff lines), decompose it into 2 to %d wave-ordered child tasks via `propose_task`:\n"+
						"   - Assign each subtask a unique symbolic `id` (e.g. `wave1-backend`, `wave2-ui`) and wire wave ordering explicitly with `depends_on` referencing earlier subtasks' `id` values.\n"+
						"   - Make every child `propose_task` `body` completely **self-contained**: read all `./attachments/` and distill all required specification, API/schema contracts, UI mock details, target file paths, and acceptance tests directly into each child's `body` (or committed design docs), because **child tasks do not inherit parent `./attachments/`**.\n"+
						"   - Keep file scopes non-overlapping across parallel tasks in the same wave so pull requests never conflict.\n"+
						"   - When filing a child DAG, make **zero** code edits or git commits on this root task and finish by calling `nothing_needed` with a concise summary of the proposed subtask DAG so this root closes cleanly as the Workstream header.",
					comp.Tier, attClause, targetLines, targetLines, maxSub,
				)
			default:
				var attNote string
				if attManifest != "" {
					attNote = " Read every file in `./attachments/` before starting slice 1."
				}
				finalPrompt += fmt.Sprintf(
					"\n\n## Goal Subtask Decomposition (S0b — slice_plan)\n"+
						"Execute this change as at most %d ordered single-PR slice steps targeting ~%d diff lines per slice, "+
						"verifying compilation and targeted tests after each slice.%s",
					maxSub, targetLines, attNote,
				)
			}
			s0bDetail := map[string]any{
				"configuredMode":  spec.Decompose.Mode,
				"effectiveMode":   effectiveMode,
				"isChildSubtask":  isChildSubtask,
				"overrideApplied": overrideApplied,
			}
			if comp.DecomposeOverride != "" {
				s0bDetail["decomposeOverride"] = comp.DecomposeOverride
			}
			if comp.ComplexityForced {
				s0bDetail["complexityForced"] = true
			}
			if specAtt.TotalCount > 0 {
				s0bDetail["attachmentCount"] = specAtt.TotalCount
				s0bDetail["attachmentBytes"] = specAtt.TotalBytes
			}
			detailBytes, _ := json.Marshal(s0bDetail)
			if store != nil {
				_, _ = store.RecordQACheckRun(ctx, model.QACheckRun{
					TaskID:         task.ID,
					RunID:          task.ID + "-qa-s0b",
					Stage:          "S0b",
					CheckID:        "step:goal-subtask-decomposer",
					Arm:            model.QAArmTreatment,
					Verdict:        "pass",
					DetailJSON:     string(detailBytes),
					ComplexityTier: string(comp.Tier),
					ExperimentID:   expID,
					ArmID:          armID,
					FlowHash:       flowHash,
					QAEngineRev:    qa.QAEngineRev,
					Model:          task.Model,
				}, nil)
			}
		}
	}

	// 3. S2 (qa:plan-critic): post-checkout plan critic honoring both Complexities and Tiers + MaxBounces.
	if s2Enabled && rt != nil && rt.RunIsolatedPrompt != nil {
		prelimRisk := qa.AssessDiffBlast(qa.DiffStats{
			Files:                 candidatePaths,
			SiblingCallerPackages: len(siblingImporters),
		}, spec.RiskOverrides, prof)

		hasComplexities := len(spec.S2PlanCriticConfig.Complexities) > 0
		hasTiers := len(spec.S2PlanCriticConfig.Tiers) > 0
		compMatch := matchesComplexityTier(spec.S2PlanCriticConfig.Complexities, comp.Tier)
		tierMatch := slices.Contains(spec.S2PlanCriticConfig.Tiers, string(prelimRisk.Tier))

		shouldRunS2 := false
		switch {
		case hasComplexities && hasTiers:
			shouldRunS2 = compMatch || tierMatch
		case hasComplexities:
			shouldRunS2 = compMatch
		case hasTiers:
			shouldRunS2 = tierMatch
		default:
			shouldRunS2 = comp.Tier == qa.ComplexityHigh || prelimRisk.Tier == qa.BlastT2 || prelimRisk.Tier == qa.BlastT3
		}

		if shouldRunS2 {
			maxBounces := spec.S2PlanCriticConfig.MaxBounces
			if maxBounces < 0 {
				maxBounces = 0
			} else if maxBounces > 2 {
				maxBounces = 2
			}
			callTimeout, startupOverhead := effectiveQAStageTimeout(
				ctx, store, rt, task,
				spec.S2PlanCriticConfig.MaxSeconds,
				defaultS2InferenceTimeout,
				maxQAStageInferenceCap,
			)
			totalTimeout := callTimeout * time.Duration(1+maxBounces)
			if totalTimeout > maxQAStageTotalCap {
				totalTimeout = maxQAStageTotalCap
			}
			criticGuidance := strings.TrimSpace(spec.PlanCriticSkillText)
			if criticGuidance == "" {
				criticGuidance = "Inspect the proposed file plan and sibling importers. Flag missing caller updates, missing schema/route registrations, or scope creep beyond the task specification."
			}
			s2Prompt := criticGuidance + "\n\nTask title: " + task.Title + "\n\nTask body:\n" + task.Body
			if manifest := formatAttachmentsManifest(specAtt); manifest != "" {
				s2Prompt += "\n\nTask attachments (in `./attachments/`):\n" + manifest
			}
			if specAtt.Text != "" {
				s2Prompt += "\n\nAttached specification:\n" + model.TruncateValidUTF8(specAtt.Text, maxPromptSpecAttachmentBytes)
			}
			if codebaseContext != "" {
				s2Prompt += "\n\n## Codebase & Caller Context\n" + codebaseContext
			}

			runCtx, cancel := context.WithTimeout(ctx, totalTimeout)
			start := time.Now()
			out, inTok, outTok, err := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s2", s2Prompt, spec.S2PlanCriticConfig.MaxTokens)
			totalInTok := inTok
			totalOutTok := outTok
			bounces := 0
			for bounces < maxBounces && err == nil && runCtx.Err() == nil && strings.Contains(out, "REVISE_PLAN:") {
				bounces++
				refinePrompt := fmt.Sprintf("%s\n\nPrevious Critique (Pass %d):\n%s\n\nRefine the implementation plan to resolve the REVISE_PLAN findings above.",
					s2Prompt, bounces, strings.TrimSpace(out))
				bOut, bIn, bOutTok, bErr := rt.RunIsolatedPrompt(runCtx, task, task.ID+"-qa-s2", refinePrompt, spec.S2PlanCriticConfig.MaxTokens)
				totalInTok += bIn
				totalOutTok += bOutTok
				if bErr != nil {
					break
				}
				if strings.TrimSpace(bOut) != "" {
					out = bOut
				}
			}
			duration := time.Since(start).Milliseconds()

			s2Extra := map[string]any{
				"bounces":          bounces,
				"maxBounces":       maxBounces,
				"prelimBlastTier":  prelimRisk.Tier,
				"siblingImporters": siblingImporters,
			}
			var detailStr string
			if err != nil {
				detailStr = buildQAStageErrorDetail(rt, err, runCtx, totalTimeout, startupOverhead, s2Extra)
			} else {
				detailBytes, _ := json.Marshal(s2Extra)
				detailStr = string(detailBytes)
			}
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
				DetailJSON:     detailStr,
				BlastTier:      string(prelimRisk.Tier),
				BlastScore:     prelimRisk.Score,
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
	if guidance := strings.TrimSpace(spec.ActiveCodingGuidance(candidatePaths)); guidance != "" {
		if !strings.Contains(finalPrompt, guidance) {
			finalPrompt += "\n\n## Active Workflow Coding & PR Guidance\n" + guidance
		}
	}

	return finalPrompt
}

// ExecutePreDispatchQAPhases executes pre-clone S0 and post-clone workflow stages for backward-compatible callers.
func ExecutePreDispatchQAPhases(ctx context.Context, store *model.Store, task model.Task, spec *qa.FlowSpec, expID, armID, flowHash string, initialPrompt string) string {
	pre := ExecutePreCloneQAPhase(ctx, store, task, spec, expID, armID, flowHash, initialPrompt)
	if pre.NeedsClarification {
		return pre.Prompt
	}
	return ExecutePostCloneWorkflowPhases(ctx, store, task, "", spec, expID, armID, flowHash, pre.Prompt)
}

func cleanRelativeRepoPath(raw string) (string, bool) {
	p := strings.TrimSpace(raw)
	p = strings.Trim(p, "`'\"()[]{}")
	p = strings.TrimRight(p, ".,:;")
	p = filepath.ToSlash(p)
	for strings.HasPrefix(p, "./") {
		p = strings.TrimPrefix(p, "./")
	}
	if p == "" || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "http://") || strings.HasPrefix(p, "https://") {
		return "", false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", false
		}
	}
	cleaned := path.Clean(p)
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
		return "", false
	}
	return cleaned, true
}

func extractCandidatePaths(task model.Task, spec *qa.FlowSpec, worktreeDir string) []string {
	return extractCandidatePathsWithSpec(task, spec, worktreeDir, "")
}

func extractCandidatePathsWithSpec(task model.Task, spec *qa.FlowSpec, worktreeDir, attachmentText string) []string {
	seen := make(map[string]bool)
	var out []string
	add := func(raw string) {
		p, ok := cleanRelativeRepoPath(raw)
		if !ok {
			return
		}
		if p == "attachments" || strings.HasPrefix(p, "attachments/") {
			return
		}
		if !strings.Contains(p, "/") && numberedAttBasenameRe.MatchString(p) {
			return
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}

	var realWorktree string
	if strings.TrimSpace(worktreeDir) != "" {
		if resolved, err := safepath.Within(worktreeDir, "."); err == nil {
			realWorktree = resolved
		}
	}

	text := task.Title + "\n" + task.Body
	if strings.TrimSpace(attachmentText) != "" {
		text += "\n" + attachmentText
	}
	cleanText := urlTokenRe.ReplaceAllString(text, " ")
	for _, loc := range pathTokenRe.FindAllStringIndex(cleanText, -1) {
		start, end := loc[0], loc[1]
		if end < len(cleanText) {
			if isPathTokenContByte(cleanText[end]) {
				continue
			}
			if cleanText[end] == '.' && end+1 < len(cleanText) && isPathTokenContByte(cleanText[end+1]) {
				continue
			}
		}
		tok := strings.TrimLeft(cleanText[start:end], "-")
		add(tok)
	}
	for _, loc := range dirTokenRe.FindAllStringIndex(cleanText, -1) {
		m := strings.TrimLeft(cleanText[loc[0]:loc[1]], "-")
		rel, ok := cleanRelativeRepoPath(m)
		if !ok || rel == "attachments" || strings.HasPrefix(rel, "attachments/") {
			continue
		}
		if realWorktree != "" {
			if target, err := safepath.Within(realWorktree, rel); err == nil {
				if info, lErr := os.Lstat(target); lErr == nil && info.Mode()&os.ModeSymlink == 0 {
					add(rel)
					continue
				}
			}
			continue
		}
		if strings.HasPrefix(rel, "pkg/") || strings.HasPrefix(rel, "cmd/") || strings.HasPrefix(rel, "ui/") || strings.HasPrefix(rel, "ui-ng/") || strings.HasPrefix(rel, "internal/") || strings.HasPrefix(rel, "tests/") {
			add(rel)
		}
	}
	for _, w := range task.Writes {
		if w.Repo.Name != "" {
			add(w.Repo.Name)
		}
		if w.Base != "" && strings.Contains(w.Base, "/") {
			add(w.Base)
		}
	}
	if spec != nil {
		for _, ep := range spec.Context.ExtraPaths {
			cleaned := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(ep), "/**"), "/*")
			if cleaned != "" {
				add(cleaned)
			}
		}
	}
	return out
}

func discoverPostCloneCodebaseContext(
	worktreeDir string,
	candidatePaths []string,
	maxTokens int,
	maxDuration time.Duration,
) (contextBlock string, existingPaths []string, siblingImporters []string) {
	deadline := time.Now().Add(maxDuration)
	if maxTokens <= 0 || maxTokens > 2000 {
		maxTokens = 2000
	}
	maxChars := maxTokens * 4

	realRoot, err := safepath.Within(worktreeDir, ".")
	if err != nil {
		return "", nil, nil
	}
	root, err := os.OpenRoot(realRoot)
	if err != nil {
		return "", nil, nil
	}
	defer func() { _ = root.Close() }()

	seenExist := make(map[string]bool)
	targetDirs := make(map[string]bool)
	targetBasenames := make(map[string]bool)

	isSafeRegularFile := func(rel string) (string, bool) {
		cleanRel, ok := cleanRelativeRepoPath(rel)
		if !ok {
			return "", false
		}
		if _, sErr := safepath.Within(realRoot, cleanRel); sErr != nil {
			return "", false
		}
		info, lErr := root.Lstat(cleanRel)
		if lErr != nil || !info.Mode().IsRegular() {
			return "", false
		}
		return cleanRel, true
	}

	addExistingFile := func(rel string) {
		cleanRel, ok := isSafeRegularFile(rel)
		if !ok || seenExist[cleanRel] {
			return
		}
		seenExist[cleanRel] = true
		existingPaths = append(existingPaths, cleanRel)
		dir := path.Dir(cleanRel)
		if dir != "" && dir != "." {
			targetDirs[dir] = true
		}
		base := strings.TrimSuffix(path.Base(cleanRel), path.Ext(cleanRel))
		if base != "" {
			targetBasenames[base] = true
		}
	}

	for _, cp := range candidatePaths {
		if time.Now().After(deadline) {
			break
		}
		rel, ok := cleanRelativeRepoPath(cp)
		if !ok {
			continue
		}
		abs, sErr := safepath.Within(realRoot, rel)
		if sErr != nil {
			continue
		}
		info, err := root.Lstat(rel)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if info.Mode().IsRegular() {
			addExistingFile(rel)
			continue
		}
		if !info.IsDir() {
			continue
		}
		targetDirs[rel] = true
		entries, rErr := os.ReadDir(abs)
		if rErr != nil {
			continue
		}
		addedInDir := 0
		for _, ent := range entries {
			if ent.IsDir() || ent.Type()&fs.ModeSymlink != 0 {
				continue
			}
			name := ent.Name()
			if strings.HasSuffix(name, "_test.go") || strings.HasSuffix(name, ".spec.ts") {
				continue
			}
			if strings.HasSuffix(name, ".go") || strings.HasSuffix(name, ".ts") || strings.HasSuffix(name, ".py") || strings.HasSuffix(name, ".md") {
				childRel := path.Join(rel, name)
				if _, ok := isSafeRegularFile(childRel); ok {
					addExistingFile(childRel)
					addedInDir++
					if addedInDir >= 3 {
						break
					}
				}
			}
		}
	}

	// If no candidate path resolved directly in worktreeDir, fall back to matching basenames or top-level source files.
	if len(existingPaths) == 0 && !time.Now().After(deadline) {
		candidateBases := make(map[string]bool)
		for _, cp := range candidatePaths {
			b := path.Base(filepath.ToSlash(cp))
			if b != "" && b != "." && b != ".." {
				candidateBases[b] = true
			}
		}
		_ = fs.WalkDir(root.FS(), ".", func(rel string, d fs.DirEntry, err error) error {
			if err != nil || time.Now().After(deadline) {
				return fs.SkipAll
			}
			if d.Type()&fs.ModeSymlink != 0 {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				name := d.Name()
				if name == ".git" || name == "node_modules" || name == "vendor" || name == "dist" {
					return fs.SkipDir
				}
				return nil
			}
			if len(candidateBases) > 0 && candidateBases[d.Name()] {
				addExistingFile(rel)
			}
			return nil
		})
	}

	// Discover direct Go/TS sibling importer directories within the 200ms budget.
	if (len(targetDirs) > 0 || len(targetBasenames) > 0) && !time.Now().After(deadline) {
		importerSet := make(map[string]bool)
		scannedFiles := 0
		_ = fs.WalkDir(root.FS(), ".", func(rel string, d fs.DirEntry, err error) error {
			if err != nil || time.Now().After(deadline) || scannedFiles >= 300 {
				return fs.SkipAll
			}
			if d.Type()&fs.ModeSymlink != 0 {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				name := d.Name()
				if name == ".git" || name == "node_modules" || name == "vendor" || name == "dist" {
					return fs.SkipDir
				}
				return nil
			}
			name := d.Name()
			isGo := strings.HasSuffix(name, ".go")
			isTS := strings.HasSuffix(name, ".ts") || strings.HasSuffix(name, ".tsx") || strings.HasSuffix(name, ".js")
			if !isGo && !isTS {
				return nil
			}
			cleanRel, ok := isSafeRegularFile(rel)
			if !ok {
				return nil
			}
			relDir := path.Dir(cleanRel)
			if targetDirs[relDir] || importerSet[relDir] {
				return nil
			}
			scannedFiles++
			raw, rErr := root.ReadFile(cleanRel)
			if rErr != nil {
				return nil
			}
			if len(raw) > 4096 {
				raw = raw[:4096]
			}
			snippet := string(raw)
			if isGo {
				for _, m := range goImportLineRe.FindAllStringSubmatch(snippet, -1) {
					imp := m[1]
					for td := range targetDirs {
						if imp == td || strings.HasSuffix(imp, "/"+td) {
							importerSet[relDir] = true
							break
						}
					}
				}
			} else if isTS {
				for _, m := range tsImportLineRe.FindAllStringSubmatch(snippet, -1) {
					imp := m[1]
					for td := range targetDirs {
						baseDir := path.Base(td)
						if strings.Contains(imp, td) || (baseDir != "" && baseDir != "." && strings.Contains(imp, baseDir)) {
							importerSet[relDir] = true
							break
						}
					}
					for tb := range targetBasenames {
						if tb != "" && (strings.HasSuffix(imp, "/"+tb) || imp == "./"+tb || imp == "../"+tb) {
							importerSet[relDir] = true
							break
						}
					}
				}
			}
			return nil
		})
		for impDir := range importerSet {
			siblingImporters = append(siblingImporters, impDir)
		}
		slices.Sort(siblingImporters)
		if len(siblingImporters) > 8 {
			siblingImporters = siblingImporters[:8]
		}
	}

	if len(existingPaths) == 0 && len(siblingImporters) == 0 {
		return "", nil, nil
	}

	var b strings.Builder
	b.WriteString("<codebase-context>\n")
	if len(siblingImporters) > 0 {
		b.WriteString("Direct sibling importer directories: ")
		b.WriteString(strings.Join(siblingImporters, ", "))
		b.WriteString("\n")
	}
	for _, rel := range existingPaths {
		if time.Now().After(deadline) || b.Len() >= maxChars-128 {
			break
		}
		cleanRel, ok := isSafeRegularFile(rel)
		if !ok {
			continue
		}
		raw, err := root.ReadFile(cleanRel)
		if err != nil {
			continue
		}
		snippet := extractBoundedFileHeader(string(raw), 18, 800)
		entry := fmt.Sprintf("--- %s ---\n%s\n", cleanRel, snippet)
		if b.Len()+len(entry)+32 > maxChars {
			remaining := maxChars - b.Len() - 32
			if remaining > 64 {
				b.WriteString(entry[:remaining])
				b.WriteString("\n")
			}
			break
		}
		b.WriteString(entry)
	}
	b.WriteString("</codebase-context>")
	return b.String(), existingPaths, siblingImporters
}

func extractBoundedFileHeader(content string, maxLines, maxBytes int) string {
	lines := strings.Split(content, "\n")
	var kept []string
	for _, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		if strings.HasPrefix(trimmed, "// Copyright") || strings.HasPrefix(trimmed, "// Licensed") ||
			strings.HasPrefix(trimmed, "// you may not") || strings.HasPrefix(trimmed, "//     http") ||
			strings.HasPrefix(trimmed, "// Unless required") || strings.HasPrefix(trimmed, "// distributed under") ||
			strings.HasPrefix(trimmed, "// WITHOUT WARRANTIES") || strings.HasPrefix(trimmed, "// See the License") ||
			strings.HasPrefix(trimmed, "// limitations under") || trimmed == "//" {
			continue
		}
		kept = append(kept, ln)
		if len(kept) >= maxLines {
			break
		}
	}
	out := strings.TrimSpace(strings.Join(kept, "\n"))
	if len(out) > maxBytes {
		out = strings.TrimSpace(out[:maxBytes])
	}
	return out
}
