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

import type { Task } from "../api/models";

// Wire contracts for pkg/ui/schedules.go, templates.go, tasks_from_template.go,
// suites.go, composition.go, repo_workflows.go, declarations.go, and
// declaration_acceptance.go.

export type ProcessTab = "schedules" | "templates" | "suites" | "declarations";

export interface WriteTarget {
  repo: string;
  base?: string;
}

export interface DeclarationRef {
  repo: string;
  path: string;
}

export interface GitHubWorkflowRunTrigger {
  workflow?: string;
  conclusions?: string[];
  branches?: string[];
}

export interface GitRefTrigger {
  repo: string;
  ref: string;
}

export interface Recurrence {
  kind: string;
  everyNHours?: number;
  everyNMinutes?: number;
  timeOfDay?: string;
  weekday?: string;
  dayOfMonth?: number;
  timeZone?: string;
  githubWorkflowRun?: GitHubWorkflowRunTrigger;
  gitRef?: GitRefTrigger;
}

export interface ScheduleSuppression {
  reason: string;
  taskId?: string;
  until?: string;
  detail?: string;
  heldByScheduleId?: string;
}

export interface ScheduleSkip {
  occurrence: string;
  at: string;
  reason: string;
  summary: string;
  taskId?: string;
  taskState?: string;
  outcome?: string;
  resolvedAt?: string;
  firedTaskId?: string;
  folded?: number;
  heldByScheduleId?: string;
}

export interface ScheduleWorkflowRun {
  runId?: string;
  branch?: string;
  workflow?: string;
  conclusion?: string;
  detail?: string;
  unfinished?: boolean;
  firedAt: string;
  finishedAt?: string;
  reviewTaskId?: string;
  reviewNotNeeded?: boolean;
}

export interface Schedule {
  id: string;
  title: string;
  description: string;
  repo: string;
  base?: string;
  autoMerge: boolean;
  autoApproveProposals?: boolean;
  reads?: string[];
  writes?: WriteTarget[];
  networkAccess?: string;
  nothingNeededAction?: string;
  keepRunning?: boolean;
  admission?: string;
  hosting?: string;
  model?: string;
  templateId?: string;
  templateName?: string;
  system?: boolean;
  suiteId?: string;
  suiteName?: string;
  capabilities: string[];
  recurrence: Recurrence;
  timeZone?: string;
  overlap: string;
  overlapGroup?: string;
  declaredIn?: DeclarationRef;
  source: string;
  type: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  suppressed?: ScheduleSuppression;
  lastWorkflowRun?: ScheduleWorkflowRun;
  workflowReview?: string;
  skips?: ScheduleSkip[];
  revision?: string;
}

export interface CreateScheduleRequest {
  title?: string;
  description?: string;
  repo: string;
  base?: string;
  autoMerge?: boolean;
  autoApproveProposals?: boolean;
  capabilities?: string[];
  reads?: string[];
  writes?: WriteTarget[];
  networkAccess?: string;
  nothingNeededAction?: string;
  keepRunning?: boolean;
  model?: string;
  templateId?: string;
  suiteId?: string;
  recurrence: Recurrence;
  timeZone?: string;
  overlap?: string;
  overlapGroup?: string;
  enabled?: boolean;
}

export interface UpdateScheduleRequest {
  title?: string;
  description?: string;
  repo?: string;
  base?: string;
  autoMerge?: boolean;
  autoApproveProposals?: boolean;
  capabilities?: string[];
  templateId?: string;
  suiteId?: string;
  recurrence?: Recurrence;
  timeZone?: string;
  overlap?: string;
  overlapGroup?: string;
  enabled?: boolean;
  revision?: string;
}

export interface ScheduleRun {
  taskId?: string;
  suiteRunId?: number;
  workflowRun?: boolean;
  schedule: Schedule;
}

export interface TemplateField {
  name: string;
  label?: string;
  options?: string[];
  default?: string;
  required?: boolean;
}

export interface Template {
  id: string;
  name: string;
  title: string;
  description: string;
  fields?: TemplateField[];
  repo?: string;
  base?: string;
  priority?: number;
  autoMerge: boolean;
  networkAccess?: string;
  nothingNeededAction?: string;
  model?: string;
  interactive?: boolean;
  keepRunning?: boolean;
  admission?: string;
  hosting?: string;
  reads?: string[];
  writes?: WriteTarget[];
  capabilities: string[];
  createdAt?: string;
  declaredIn?: DeclarationRef;
  system?: boolean;
  revision?: string;
}

export interface CreateTemplateRequest {
  name: string;
  title: string;
  description: string;
  fields?: TemplateField[];
  repo?: string;
  base?: string;
  autoMerge: boolean;
  networkAccess?: string;
  nothingNeededAction?: string;
  model?: string;
  interactive?: boolean;
  keepRunning?: boolean;
  capabilities: string[];
  reads: string[];
  writes: WriteTarget[];
  customFields: Record<string, unknown>;
}

export interface UpdateTemplateRequest {
  name?: string;
  title?: string;
  description?: string;
  fields?: TemplateField[];
  repo?: string;
  base?: string;
  autoMerge?: boolean;
  networkAccess?: string;
  nothingNeededAction?: string;
  model?: string;
  interactive?: boolean;
  keepRunning?: boolean;
  capabilities?: string[];
  revision?: string;
}

export interface SuiteItem {
  templateId: string;
  templateName?: string;
}

export interface Suite {
  id: string;
  name: string;
  items: SuiteItem[];
  mode: string;
  count?: number;
  maxPasses?: number;
  requireApproval: boolean;
  autoMerge: boolean;
  autoApproveProposals: boolean;
  createdAt?: string;
  declaredIn?: DeclarationRef;
  revision?: string;
}

export interface CreateSuiteRequest {
  name: string;
  templateIds: string[];
  mode: string;
  count: number;
  maxPasses: number;
  requireApproval: boolean;
  autoMerge?: boolean;
  autoApproveProposals?: boolean;
}

export interface UpdateSuiteRequest {
  name?: string;
  templateIds?: string[];
  mode?: string;
  count?: number;
  maxPasses?: number;
  requireApproval?: boolean;
  autoMerge?: boolean;
  autoApproveProposals?: boolean;
  revision?: string;
}

export interface SuiteRunTask {
  taskId: string;
  templateId: string;
  templateName: string;
  pass: number;
  state: string;
  approved: boolean;
  openedPullRequest: boolean;
  proposed: boolean;
}

export interface SuiteRun {
  id: number;
  suiteId: string;
  suiteName: string;
  scheduleId?: string;
  repo: string;
  base: string;
  mode: string;
  count?: number;
  maxPasses?: number;
  requireApproval: boolean;
  autoMerge: boolean;
  autoApproveProposals?: boolean;
  status: string;
  error?: string;
  pass: number;
  createdAt: string;
  completedAt?: string;
  // null on a run that has filed nothing yet (or ended before it could):
  // the server sends Go's nil slice as JSON null, not [].
  tasks: SuiteRunTask[] | null;
  taskCount?: number;
  tasksTruncated?: boolean;
}

export interface ComposedField {
  name: string;
  values?: string[];
  source: string;
  sources?: string[];
}

export interface ComposedTask {
  templateId?: string;
  templateName?: string;
  title: string;
  fields: ComposedField[];
}

export interface Composition {
  kind: string;
  scheduleId?: string;
  suiteId?: string;
  suiteName?: string;
  repo?: string;
  base?: string;
  mode?: string;
  count?: number;
  maxPasses?: number;
  tasks: ComposedTask[];
}

export interface DeclaredPush {
  repo: string;
  path: string;
  commit?: string;
  refs: { pattern: string; force?: boolean }[];
}

export interface RepoDeclarationsStatus {
  commit?: string;
  checkedAt?: string;
  syncedAt?: string;
  error?: string;
  templates?: string[];
  suites?: string[];
  schedules?: string[];
  triggers?: string[];
  pushes?: DeclaredPush[];
  mergeRules?: string;
  warnings?: string[];
}

export interface RepoDefaultsView {
  repo?: string;
  declarations: boolean;
  declarationsStatus?: RepoDeclarationsStatus | null;
  [key: string]: unknown;
}

export interface RepoWorkflow {
  path: string;
  text: string;
  name?: string;
}

export interface RepoWorkflowsResponse {
  repo: string;
  dir: string;
  workflows: RepoWorkflow[];
}

export interface DeclarationAcceptanceView {
  id: string;
  kind: string;
  repo?: string;
  requested: string[];
  requestedCommit?: string;
  requestedAt: string;
  accepted?: string[];
  acceptedBy?: string;
  acceptedScopes?: string[];
  acceptedCommit?: string;
  acceptedAt?: string;
  awaiting: boolean;
  unaccepted?: string[];
  needsScopes: string[];
}

export function isEventTrigger(s: Schedule): boolean {
  const k = (s.recurrence?.kind || "").toLowerCase();
  return k === "github_workflow_run" || k === "git_ref";
}

export function formatCadence(
  rec: Recurrence | undefined,
  tz?: string,
): string {
  if (!rec) return "Custom cadence";
  const zone = tz || rec.timeZone || "UTC";
  switch (rec.kind) {
    case "everyNMinutes":
      return `Every ${rec.everyNMinutes || 15} min`;
    case "everyNHours":
      return `Every ${rec.everyNHours || 1} hr`;
    case "daily":
      return `Daily at ${rec.timeOfDay || "09:00"} (${zone})`;
    case "weekly": {
      const day = rec.weekday
        ? rec.weekday.charAt(0).toUpperCase() + rec.weekday.slice(1)
        : "Monday";
      return `Weekly · ${day} ${rec.timeOfDay || "09:00"} (${zone})`;
    }
    case "monthly":
      return `Monthly · day ${rec.dayOfMonth || 1} at ${rec.timeOfDay || "09:00"} (${zone})`;
    case "github_workflow_run": {
      const gha = rec.githubWorkflowRun;
      const wf = gha?.workflow || "workflow";
      const concls = (gha?.conclusions ?? []).filter(Boolean);
      const branches = (gha?.branches ?? []).filter(Boolean);
      const parts: string[] = [];
      if (concls.length) parts.push(concls.join(", "));
      if (branches.length) parts.push(`on ${branches.join(", ")}`);
      const suffix = parts.length ? ` (${parts.join(" · ")})` : "";
      return `On GitHub workflow: ${wf}${suffix}`;
    }
    case "git_ref": {
      const r = rec.gitRef?.repo || "repo";
      const ref = rec.gitRef?.ref || "push";
      return `On git ref: ${r} @ ${ref}`;
    }
    default:
      return rec.kind || "Scheduled";
  }
}

export const formatRecurrence = formatCadence;

export function scheduleStatusBadge(s: Schedule): {
  label: string;
  tone: "healthy" | "blast" | "neutral";
  iconKind: string;
} {
  if (!s.enabled) {
    return { label: "Paused", tone: "neutral", iconKind: "neutral" };
  }
  if (s.suppressed) {
    return { label: "Suppressed", tone: "blast", iconKind: "blast" };
  }
  return { label: "Enabled", tone: "healthy", iconKind: "healthy" };
}

export function templateSourceBadge(t: Template): {
  label: string;
  tone: "proposal" | "reply" | "neutral";
  iconKind: string;
} {
  if (t.system) {
    return { label: "Built-in", tone: "neutral", iconKind: "neutral" };
  }
  if (t.declaredIn) {
    return { label: "Repo-declared", tone: "reply", iconKind: "reply" };
  }
  return { label: "Deployment", tone: "proposal", iconKind: "proposal" };
}

export function describeSuiteMode(
  mode: string,
  count?: number,
  maxPasses?: number,
): string {
  if (mode === "count") return `Run ${count || 1}×`;
  if (mode === "until_clean") {
    return `Until clean (max ${maxPasses || 1} ${maxPasses === 1 ? "pass" : "passes"})`;
  }
  return mode || "Suite";
}

export function suiteRunBadge(status: string): {
  label: string;
  tone: "setup" | "healthy" | "error" | "neutral";
  iconKind: string;
} {
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "running") {
    return { label: "Active", tone: "setup", iconKind: "running" };
  }
  if (s === "succeeded" || s === "passed") {
    return { label: "Succeeded", tone: "healthy", iconKind: "passed" };
  }
  if (s === "failed" || s === "errored") {
    return { label: "Failed", tone: "error", iconKind: "failed" };
  }
  return { label: status || "Unknown", tone: "neutral", iconKind: "neutral" };
}

export interface SuitePassView {
  pass: number;
  items: {
    entry: SuiteRunTask;
    liveState: string;
    title: string;
    spawned: Task[];
  }[];
}

export function buildSuiteRunPasses(
  run: SuiteRun,
  allTasks: readonly Task[],
): SuitePassView[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const byParent = new Map<string, Task[]>();
  for (const t of allTasks) {
    if (!t.generatedFrom) continue;
    const arr = byParent.get(t.generatedFrom) ?? [];
    arr.push(t);
    byParent.set(t.generatedFrom, arr);
  }
  const seen = new Set((run.tasks ?? []).map((t) => t.taskId));
  const walkChildren = (id: string): Task[] => {
    const out: Task[] = [];
    for (const c of byParent.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c, ...walkChildren(c.id));
    }
    return out;
  };

  const groups = new Map<number, SuitePassView["items"]>();
  for (const entry of run.tasks ?? []) {
    const live = byId.get(entry.taskId);
    const list = groups.get(entry.pass) ?? [];
    list.push({
      entry,
      liveState: live?.state || entry.state || "queued",
      title: live?.title || entry.templateName || `Task #${entry.taskId}`,
      spawned: walkChildren(entry.taskId),
    });
    groups.set(entry.pass, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pass, items]) => ({ pass, items }));
}

export function isOpenTaskState(state: string): boolean {
  const s = (state || "").toLowerCase();
  return (
    s === "running" ||
    s === "queued" ||
    s === "proposed" ||
    s === "awaiting_reply" ||
    s === "paused"
  );
}

export type SchedTargetKind = "prompt" | "template" | "suite";

export type SchedFieldKey =
  | "templateId"
  | "suiteId"
  | "title"
  | "repo"
  | "base"
  | "everyNMinutes"
  | "everyNHours"
  | "timeOfDay"
  | "timeZone"
  | "dayOfMonth"
  | "triggerWorkflow"
  | "gitRefRepo"
  | "gitRef";

export interface ScheduleDraftSnapshot {
  system: boolean;
  targetKind: SchedTargetKind;
  templateId: string;
  boundTemplateRepo: string;
  suiteId: string;
  title: string;
  repo: string;
  base: string;
  kind: string;
  everyNMinutes: string;
  everyNHours: string;
  timeOfDay: string;
  timeZone: string;
  dayOfMonth: string;
  triggerWorkflow: string;
  gitRefRepo: string;
  gitRef: string;
  badNumberInputs?: Partial<
    Record<"everyNMinutes" | "everyNHours" | "dayOfMonth", boolean>
  >;
}

const BRANCH_NAME_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidRepoSegment(seg: string): boolean {
  if (!seg || seg === "." || seg === ".." || hasControlOrSpace(seg)) {
    return false;
  }
  return !/[\\/:?#[\]%~^@]/.test(seg);
}

export function isValidRepoRef(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const parts = trimmed.split("/");
  if (parts.length === 2) {
    return isValidRepoSegment(parts[0]) && isValidRepoSegment(parts[1]);
  }
  if (parts.length === 3) {
    const [host, owner, name] = parts;
    if (!host || (!host.includes(".") && !host.includes(":"))) return false;
    if (hasControlOrSpace(host) || /[\\/?#@]/.test(host)) return false;
    return isValidRepoSegment(owner) && isValidRepoSegment(name);
  }
  return false;
}

export function isValidBranchName(raw: string): boolean {
  const name = raw.trim();
  if (!name) return false;
  if (new TextEncoder().encode(name).length > 244) return false;
  if (!BRANCH_NAME_SAFE_RE.test(name)) return false;
  if (
    name.includes("..") ||
    name.includes("//") ||
    name.endsWith("/") ||
    name.endsWith(".")
  ) {
    return false;
  }
  for (const part of name.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock")) return false;
  }
  return true;
}

export function isValidTimeOfDay(raw: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

export function isValidIanaTimeZone(raw: string): boolean {
  const tz = raw.trim();
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidGitRef(raw: string): boolean {
  const ref = raw.trim();
  if (!ref.startsWith("refs/") || ref.length <= "refs/".length) return false;
  if (/[\s^~:?*[\\]/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    return false;
  }
  return true;
}

function validateIntegerRange(
  raw: string,
  badInput: boolean | undefined,
  min: number,
  max: number,
  label: string,
): string | null {
  if (badInput) {
    return `Enter a valid whole number between ${min} and ${max}.`;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return `${label} is required.`;
  }
  if (!/^\d+$/.test(trimmed)) {
    return `Enter a whole number between ${min} and ${max}.`;
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min) {
    return `${label} must be at least ${min}.`;
  }
  if (n > max) {
    return `${label} must be at most ${max}.`;
  }
  return null;
}

export function validateScheduleDraft(
  d: ScheduleDraftSnapshot,
): Partial<Record<SchedFieldKey, string>> {
  const errors: Partial<Record<SchedFieldKey, string>> = {};
  if (!d.system) {
    if (d.targetKind === "template") {
      if (!d.templateId.trim()) {
        errors.templateId = "Select a template.";
      }
    } else if (d.targetKind === "suite") {
      if (!d.suiteId.trim()) {
        errors.suiteId = "Select a suite.";
      }
    } else if (!d.title.trim()) {
      errors.title = "Task title is required.";
    }

    const repo = d.repo.trim();
    const bound =
      d.targetKind === "template" && Boolean(d.boundTemplateRepo.trim());
    if (!repo) {
      if (!bound) {
        errors.repo = "Repository (owner/name) is required.";
      }
    } else if (!isValidRepoRef(repo)) {
      errors.repo = "Use owner/name (or host/owner/name).";
    }

    const base = d.base.trim();
    if (d.targetKind === "suite" && !base) {
      errors.base = "Base branch is required for suite schedules.";
    } else if (base && !isValidBranchName(base)) {
      errors.base =
        "Use a valid git branch name (no spaces, '..', '//', or trailing '/').";
    }
  }

  switch (d.kind) {
    case "everyNMinutes": {
      const err = validateIntegerRange(
        d.everyNMinutes,
        d.badNumberInputs?.everyNMinutes,
        10,
        527040,
        "Interval in minutes",
      );
      if (err) errors.everyNMinutes = err;
      break;
    }
    case "everyNHours": {
      const err = validateIntegerRange(
        d.everyNHours,
        d.badNumberInputs?.everyNHours,
        1,
        8784,
        "Interval in hours",
      );
      if (err) errors.everyNHours = err;
      break;
    }
    case "daily":
    case "weekly":
    case "monthly": {
      if (!d.timeOfDay.trim()) {
        errors.timeOfDay = "Time of day (HH:MM) is required.";
      } else if (!isValidTimeOfDay(d.timeOfDay)) {
        errors.timeOfDay = "Use 24-hour HH:MM format (00:00–23:59).";
      }
      if (d.timeZone.trim() && !isValidIanaTimeZone(d.timeZone)) {
        errors.timeZone =
          "Enter a valid IANA time zone (e.g. UTC, America/New_York).";
      }
      if (d.kind === "monthly") {
        const err = validateIntegerRange(
          d.dayOfMonth,
          d.badNumberInputs?.dayOfMonth,
          1,
          28,
          "Day of month",
        );
        if (err) errors.dayOfMonth = err;
      }
      break;
    }
    case "github_workflow_run": {
      if (!d.triggerWorkflow.trim()) {
        errors.triggerWorkflow = "Workflow name or file is required.";
      }
      break;
    }
    case "git_ref": {
      const refRepo = d.gitRefRepo.trim();
      const fallbackRepo =
        d.repo.trim() ||
        (d.targetKind === "template" ? d.boundTemplateRepo.trim() : "");
      if (!refRepo && !fallbackRepo) {
        errors.gitRefRepo = "Watched git repository is required.";
      } else if (refRepo && !isValidRepoRef(refRepo)) {
        errors.gitRefRepo = "Use owner/name (or host/owner/name).";
      }
      const ref = d.gitRef.trim();
      if (!ref) {
        errors.gitRef = "Watched git ref is required.";
      } else if (!isValidGitRef(ref)) {
        errors.gitRef =
          "Use a full git ref starting with refs/ (e.g. refs/heads/main).";
      }
      break;
    }
  }
  return errors;
}
