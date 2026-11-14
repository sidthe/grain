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

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { Subscription } from "rxjs";
import type { RouteKey } from "../api/generated-routes";
import { GrainApi, splitRepo } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { errText } from "../settings/settings-state.service";
import {
  ConfirmDialogComponent,
  bypassConfirm,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import { StatusIconComponent } from "../shared/status-icon.component";

export type RepoTabId =
  | "overview"
  | "ci"
  | "merge-queue"
  | "agents"
  | "branches"
  | "releases"
  | "advanced";

const REPO_TABS: readonly { id: RepoTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "ci", label: "CI & Workflows" },
  { id: "merge-queue", label: "Merge Queue" },
  { id: "agents", label: "Agents & Grants" },
  { id: "branches", label: "Branches" },
  { id: "releases", label: "Releases" },
  { id: "advanced", label: "Advanced" },
];

function normalizeRepoTabId(val: string | null | undefined): RepoTabId | null {
  const clean = (val ?? "").toLowerCase();
  if (clean === "declarations") return "advanced";
  return REPO_TABS.some((t) => t.id === clean) ? (clean as RepoTabId) : null;
}

function isRepoTabId(val: string | null | undefined): val is RepoTabId {
  return normalizeRepoTabId(val) !== null;
}

function normalizeWorkflowPath(raw: string): string {
  const clean = raw.trim().replace(/^\/+/, "");
  if (!clean) return "";
  if (clean.includes("/")) return clean;
  const withExt =
    clean.endsWith(".yml") || clean.endsWith(".yaml") ? clean : `${clean}.yml`;
  return `.grain/workflows/${withExt}`;
}

interface DeclaredPushRef {
  ref?: string;
  pattern?: string;
  force?: boolean;
  delete?: boolean;
}

interface DeclaredPushRow {
  repo?: string;
  path: string;
  commit?: string;
  refs?: DeclaredPushRef[];
}

interface RepoDeclarationsStatus {
  commit?: string;
  checkedAt?: string;
  syncedAt?: string;
  error?: string;
  templates?: string[];
  suites?: string[];
  schedules?: string[];
  triggers?: string[];
  pushes?: DeclaredPushRow[];
  mergeRules?: string;
  warnings?: string[];
}

interface RepoPortDirection {
  from: string;
  to: string;
  paired: boolean;
  operatorTypes?: string[];
  declaredTypes?: string[];
  types?: string[];
}

interface RepoDeclarationsResponse {
  repo?: string;
  declarations: boolean;
  declarationsStatus?: RepoDeclarationsStatus | null;
  pairedBranches?: string[];
  portBranches?: string[];
  declaredPortBranches?: string[];
  portDirections?: RepoPortDirection[];
  portWarnings?: string[];
}

function declaredSummary(status: RepoDeclarationsStatus): string {
  const base =
    `${(status.templates ?? []).length} template(s), ` +
    `${(status.suites ?? []).length} suite(s), ` +
    `${(status.schedules ?? []).length} schedule(s), ` +
    `${(status.triggers ?? []).length} trigger(s)`;
  return status.mergeRules
    ? `${base}, merge rules in ${status.mergeRules}`
    : base;
}

function formatDeclaredPushRef(r: DeclaredPushRef): string {
  const name = r.ref ?? r.pattern ?? "";
  const flags = [r.force && "force", r.delete && "delete"].filter(Boolean);
  return flags.length ? `${name} (${flags.join(", ")})` : name;
}

interface BranchRow {
  name: string;
  sha?: string;
  head?: string;
  protected?: boolean;
}

interface RepoWorkflowRow {
  path: string;
  text: string;
  name?: string;
}

interface ReleaseRow {
  name: string;
  latestBranch?: string;
  prodBranch?: string;
  status?: string;
  pullRequestUrl?: string;
  error?: string;
}

interface CandidateRow {
  id: number | string;
  release?: string;
  number?: number;
  branch?: string;
  status?: string;
  version?: string;
  error?: string;
}

interface RepoReleaseSecretRow {
  name: string;
  present?: boolean;
}

interface PendingReleaseRow {
  version: string;
  summary?: string;
  soakReady?: boolean;
}

type OwnershipState = "" | "on" | "off";

interface RepoWorkDeclaration {
  repo?: string;
  path: string;
}

interface RepoWorkItem {
  item: string;
  kind: string;
  title?: string;
  override: OwnershipState;
  runs: boolean;
  paused?: boolean;
  declaration?: RepoWorkDeclaration;
}

interface RepoWorkOwnershipResponse {
  repo?: string;
  default: OwnershipState;
  defaultRuns: boolean;
  items: RepoWorkItem[];
}

const OWNERSHIP_OPTIONS: readonly {
  key: string;
  state: OwnershipState;
  label: string;
  ariaSuffix: string;
}[] = [
  { key: "on", state: "on", label: "On", ariaSuffix: "on" },
  { key: "off", state: "off", label: "Off", ariaSuffix: "off" },
  {
    key: "unset",
    state: "",
    label: "Say nothing",
    ariaSuffix: "say nothing",
  },
];

function parseOwnershipState(raw: unknown): OwnershipState | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase();
  if (clean === "" || clean === "on" || clean === "off") {
    return clean;
  }
  return null;
}

function validateWorkItemId(raw: string): { id: string; error: string | null } {
  const id = raw.trim();
  if (!id) {
    return { id: "", error: "item: a work item id cannot be empty" };
  }
  if (/[=,]/.test(id)) {
    return {
      id: "",
      error: `item: work item "${id}" holds ',' or '=', which the override list separates on`,
    };
  }
  return { id, error: null };
}

function normalizeWorkOwnership(raw: unknown): RepoWorkOwnershipResponse {
  const rec =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const def = parseOwnershipState(rec["default"]) ?? "";
  const defaultRuns =
    typeof rec["defaultRuns"] === "boolean"
      ? rec["defaultRuns"]
      : def !== "off";
  const rawItems = Array.isArray(rec["items"]) ? rec["items"] : [];
  const items: RepoWorkItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const it = entry as Record<string, unknown>;
    const item = typeof it["item"] === "string" ? it["item"] : "";
    if (!item) continue;
    const override = parseOwnershipState(it["override"]) ?? "";
    const rawDecl = it["declaration"];
    const declaration =
      rawDecl &&
      typeof rawDecl === "object" &&
      typeof (rawDecl as Record<string, unknown>)["path"] === "string"
        ? {
            repo:
              typeof (rawDecl as Record<string, unknown>)["repo"] === "string"
                ? ((rawDecl as Record<string, unknown>)["repo"] as string)
                : undefined,
            path: (rawDecl as Record<string, unknown>)["path"] as string,
          }
        : undefined;
    items.push({
      item,
      kind: typeof it["kind"] === "string" ? it["kind"] : "",
      title: typeof it["title"] === "string" ? it["title"] : undefined,
      override,
      runs: Boolean(it["runs"]),
      paused: Boolean(it["paused"]),
      ...(declaration ? { declaration } : {}),
    });
  }
  return {
    repo: typeof rec["repo"] === "string" ? rec["repo"] : undefined,
    default: def,
    defaultRuns,
    items,
  };
}

interface RepoUnfixableChecksState {
  unfixableChecks: string[];
  grainCICheckName: string;
}

function sameCheckName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function normalizeUnfixableChecks(raw: unknown): RepoUnfixableChecksState {
  const rec =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawList = Array.isArray(rec["unfixableChecks"])
    ? rec["unfixableChecks"]
    : [];
  const checks: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push(trimmed);
  }
  const rawName = rec["grainCICheckName"];
  const grainCICheckName =
    typeof rawName === "string" && rawName.trim() ? rawName.trim() : "grain CI";
  return {
    unfixableChecks: checks,
    grainCICheckName,
  };
}

@Component({
  selector: "g-repo-detail-page",
  imports: [
    RouterLink,
    PillSelectComponent,
    ConfirmDialogComponent,
    StatusIconComponent,
  ],
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    "../shared/work-surface.css",
    "../shared/pill-select.css",
    "../settings/settings-forms.css",
    "./repo-detail.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="view-panel is-active" aria-labelledby="repo-page-heading">
      <div class="repo-page-scroll">
        <div class="repo-page-inner">
          <div class="repo-top-nav">
            <a
              class="btn-text"
              routerLink="/settings/repositories"
              data-testid="back-to-repos-link"
              >← Repositories</a
            >
            <a
              class="btn-tonal s-btn-sm"
              style="text-decoration: none"
              [routerLink]="['/tasks']"
              [queryParams]="{ repo: repoSlug() }"
              >View tasks in {{ repoSlug() }}</a
            >
          </div>

          <div>
            <h1
              class="view-headline tabular"
              id="repo-page-heading"
              data-testid="repo-detail-heading"
            >
              {{ repoSlug() }}
            </h1>
            <p class="view-subtitle">
              Per-repository Git connection, CI workflows, merge gates,
              branches, release qualification, and .grain/ declarations.
            </p>
          </div>

          <nav class="repo-tabs" aria-label="Repository sections">
            @for (t of tabs; track t.id) {
              <button
                type="button"
                class="repo-tab-btn"
                [class.is-active]="activeTab() === t.id"
                [attr.aria-current]="activeTab() === t.id ? 'page' : null"
                [attr.data-testid]="'repo-tab-' + t.id"
                (click)="selectTab(t.id)"
              >
                {{ t.label }}
              </button>
            }
          </nav>

          @if (configRepoOnly()) {
            <div
              class="s-banner readonly"
              id="repo-config-readonly-banner"
              data-testid="repo-readonly-banner"
            >
              Repository configuration is managed in the config repository;
              operational actions (branches, issue import, and releases) remain
              available according to your role.
            </div>
          }

          @if (error(); as err) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="repo-error-banner"
            >
              <span>{{ err }}</span>
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="error.set(null)"
              >
                Dismiss
              </button>
            </div>
          }

          @if (ready()) {
            @switch (activeTab()) {
              @case ("overview") {
                <div class="s-card" data-testid="card-repo-config">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Repository config &amp; Git connection
                      </h2>
                      <p class="s-card-desc">
                        Clone URL override and pinned Git credential.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-repo-config-btn"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/deployment/repos/{owner}/{name}/config',
                          repoSlug()
                        )
                      "
                      (click)="saveRepoConfig()"
                    >
                      Save config
                    </button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="rc-clone">Clone URL</label>
                      <input
                        id="rc-clone"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-repo-clone-url"
                        placeholder="https://github.com/owner/repo.git"
                        [value]="cloneUrl()"
                        [disabled]="
                          configRepoOnly() ||
                          !access.can(
                            'PUT /api/deployment/repos/{owner}/{name}/config',
                            repoSlug()
                          )
                        "
                        (input)="cloneUrl.set($any($event.target).value)"
                      />
                    </div>
                    <div class="s-field">
                      <span class="s-label">Git connection</span>
                      <div class="s-inline">
                        <g-pill-select
                          testid="select-repo-git-conn"
                          ariaLabel="Git connection"
                          align="left"
                          [options]="gitConnOptions()"
                          [value]="gitCredential()"
                          [disabled]="
                            configRepoOnly() ||
                            !access.can(
                              'PUT /api/deployment/repos/{owner}/{name}/git-connection',
                              repoSlug()
                            )
                          "
                          (valueChange)="pinGitConnection($event)"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div class="s-card" data-testid="card-repo-operations">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Issue importer &amp; lifecycle refresh
                      </h2>
                      <p class="s-card-desc">
                        Configure GitHub issue import settings, trigger an
                        immediate import pass, or refresh repository lifecycle
                        state.
                      </p>
                    </div>
                    <div class="s-inline">
                      <span
                        class="status-pill neutral tabular"
                        data-testid="repo-lifecycle-state"
                        >{{ lifecycleState() }}</span
                      >
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="refresh-lifecycle-btn"
                        [disabled]="
                          !access.can(
                            'POST /api/repos/{owner}/{name}/lifecycle/refresh',
                            repoSlug()
                          )
                        "
                        (click)="refreshLifecycle()"
                      >
                        Refresh lifecycle
                      </button>
                    </div>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Enable issue importer</span>
                      <span class="s-hint"
                        >Periodically import open GitHub issues matching the
                        configured label.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      data-testid="switch-issue-import-enabled"
                      [attr.aria-checked]="importEnabled()"
                      [disabled]="!canWriteSettings()"
                      aria-label="Enable issue importer"
                      (click)="importEnabled.set(!importEnabled())"
                    ></button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="imp-label"
                        >Issue label filter</label
                      >
                      <input
                        id="imp-label"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-import-label"
                        placeholder="grain-ready"
                        [value]="importLabel()"
                        [disabled]="!canWriteSettings()"
                        (input)="importLabel.set($any($event.target).value)"
                      />
                    </div>
                    <div class="s-field">
                      <label class="s-label" for="imp-repo"
                        >Source repository (empty = this repo)</label
                      >
                      <input
                        id="imp-repo"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-import-repo"
                        placeholder="upstream/repo (optional)"
                        [value]="importSourceRepo()"
                        [disabled]="!canWriteSettings()"
                        (input)="
                          importSourceRepo.set($any($event.target).value)
                        "
                      />
                    </div>
                  </div>

                  <div class="s-inline">
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-issue-import-btn"
                      [disabled]="!canWriteSettings()"
                      (click)="saveIssueImportSettings()"
                    >
                      Save issue import
                    </button>
                    <button
                      type="button"
                      class="btn-tonal s-btn-sm"
                      data-testid="import-issues-btn"
                      [disabled]="
                        !access.can(
                          'POST /api/repos/{owner}/{name}/import-issues',
                          repoSlug()
                        )
                      "
                      (click)="importIssues()"
                    >
                      Import issues now
                    </button>
                  </div>
                </div>
              }

              @case ("ci") {
                <div class="s-card" data-testid="card-repo-ci">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        CI mode &amp; base-branch runs
                      </h2>
                      <p class="s-card-desc">
                        Choose whether Grain runs .grain/workflows, waits for
                        GitHub checks, or merges without waiting for CI.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-tonal s-btn-sm"
                      data-testid="trigger-base-ci-btn"
                      [disabled]="
                        !access.can(
                          'POST /api/repos/{owner}/{name}/base-branch-runs',
                          repoSlug()
                        )
                      "
                      (click)="triggerBaseCiRun()"
                    >
                      Run base-branch CI
                    </button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <span class="s-label">CI mode</span>
                      <g-pill-select
                        testid="select-repo-ci-mode"
                        ariaLabel="Repository CI mode"
                        align="left"
                        [options]="ciModeOptions"
                        [value]="ciMode()"
                        [disabled]="
                          configRepoOnly() ||
                          !access.can(
                            'PUT /api/repos/{owner}/{name}/ci-mode',
                            repoSlug()
                          )
                        "
                        (valueChange)="saveCiMode($event)"
                      />
                    </div>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Watch default branch</span>
                      <span class="s-hint"
                        >Automatically file repair tasks when trunk CI turns
                        red.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      [attr.aria-checked]="watchDefaultBranch()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/watch-default-branch',
                          repoSlug()
                        )
                      "
                      aria-label="Watch default branch"
                      (click)="toggleWatchDefaultBranch()"
                    ></button>
                  </div>

                  <div class="s-field">
                    <div class="s-row">
                      <label class="s-label" for="wf-yaml">
                        Declared workflow ({{ selectedWorkflowPath() }})
                      </label>
                      <div class="s-inline">
                        @if (workflowOptions().length > 0) {
                          <g-pill-select
                            testid="select-repo-workflow"
                            ariaLabel="Select workflow file"
                            align="left"
                            [options]="workflowOptions()"
                            [value]="selectedWorkflowPath()"
                            (valueChange)="selectWorkflow($event)"
                          />
                        }
                        <input
                          class="s-input s-input-inline tabular"
                          type="text"
                          aria-label="New workflow file path"
                          data-testid="input-new-workflow-path"
                          placeholder=".grain/workflows/release.yml"
                          [value]="newWorkflowPath()"
                          [disabled]="
                            configRepoOnly() ||
                            !access.can(
                              'PUT /api/repos/{owner}/{name}/workflows',
                              repoSlug()
                            )
                          "
                          (input)="
                            newWorkflowPath.set($any($event.target).value)
                          "
                        />
                        <button
                          type="button"
                          class="btn-tonal s-btn-sm"
                          data-testid="add-repo-workflow-btn"
                          [disabled]="
                            !newWorkflowPath().trim() ||
                            configRepoOnly() ||
                            !access.can(
                              'PUT /api/repos/{owner}/{name}/workflows',
                              repoSlug()
                            )
                          "
                          (click)="addWorkflowFile()"
                        >
                          Add file
                        </button>
                      </div>
                    </div>
                    <textarea
                      id="wf-yaml"
                      class="s-textarea tabular"
                      rows="5"
                      data-testid="input-repo-workflow"
                      [value]="workflowYaml()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/workflows',
                          repoSlug()
                        )
                      "
                      (input)="onEditWorkflowText($any($event.target).value)"
                    ></textarea>
                    <div class="s-inline">
                      <button
                        type="button"
                        class="btn-primary s-btn-sm"
                        data-testid="save-repo-workflow-btn"
                        [disabled]="
                          configRepoOnly() ||
                          !access.can(
                            'PUT /api/repos/{owner}/{name}/workflows',
                            repoSlug()
                          )
                        "
                        (click)="saveWorkflows()"
                      >
                        Save workflows
                      </button>
                      @if (workflows().length > 0) {
                        <button
                          type="button"
                          class="btn-text s-btn-sm"
                          data-testid="delete-repo-workflow-btn"
                          [disabled]="
                            configRepoOnly() ||
                            !access.can(
                              'PUT /api/repos/{owner}/{name}/workflows',
                              repoSlug()
                            )
                          "
                          (click)="deleteSelectedWorkflow()"
                        >
                          Remove selected file
                        </button>
                      }
                    </div>
                  </div>
                </div>
              }

              @case ("merge-queue") {
                <div class="s-card" data-testid="card-repo-merge-queue">
                  <h2 class="s-card-title">Merge queue &amp; gate policy</h2>
                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Merge on green</span>
                      <span class="s-hint"
                        >Land approved pull requests automatically once checks
                        succeed.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      data-testid="switch-merge-on-green"
                      [attr.aria-checked]="mergeOnGreen()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/merge-on-green',
                          repoSlug()
                        )
                      "
                      aria-label="Merge on green"
                      (click)="toggleMergeOnGreen()"
                    ></button>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name"
                        >Require branch up to date before merge</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      [attr.aria-checked]="requireUpToDate()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/require-branch-up-to-date',
                          repoSlug()
                        )
                      "
                      aria-label="Require branch up to date"
                      (click)="toggleRequireUpToDate()"
                    ></button>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name"
                        >Base-branch repairs bypass human review gates</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      [attr.aria-checked]="bypassHumanGates()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates',
                          repoSlug()
                        )
                      "
                      aria-label="Base-branch repairs bypass human review gates"
                      (click)="toggleBypassHumanGates()"
                    ></button>
                  </div>
                </div>

                <div class="s-card" data-testid="card-repo-unfixable-checks">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Checks no commit here can clear
                      </h2>
                      <p class="s-card-desc">
                        Checks on {{ repoSlug() }} that will never pass for a
                        pull request grain's agents author, whatever is pushed
                        to the branch — a CLA bot asserting who signed an
                        agreement is the case this exists for.
                        <strong>This does not exempt them.</strong> A pull
                        request with one of these red is still not merged, and a
                        person clears it or nothing merges; what grain stops
                        spending is the base merge and the repair run it would
                        have made trying to reach a green that is not reachable,
                        saying so on the row and in one comment instead. Not for
                        a job that is merely flaky: a real regression in a check
                        named here still holds the queue, which is exactly why
                        naming one is safe.
                      </p>
                    </div>
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/unfixable-checks",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="unfixable-checks-read-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/unfixable-checks",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (unfixableError()) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="unfixable-checks-error-banner"
                    >
                      <span>{{ unfixableError() }}</span>
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="retry-unfixable-checks-btn"
                        (click)="loadUnfixableChecks(true)"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (unfixableData() === null) {
                    <p class="s-hint" data-testid="unfixable-checks-loading">
                      Loading unfixable checks…
                    </p>
                  } @else {
                    @if (unfixableData(); as unfixable) {
                      @if (
                        hasValidRepo() &&
                        !access.can(
                          "PUT /api/repos/{owner}/{name}/unfixable-checks",
                          repoSlug()
                        )
                      ) {
                        <p
                          class="s-hint"
                          id="repo-unfixable-checks-denied-reason"
                          data-testid="unfixable-checks-write-denied"
                        >
                          {{
                            access.deniedReason(
                              "PUT /api/repos/{owner}/{name}/unfixable-checks",
                              repoSlug()
                            )
                          }}
                        </p>
                      }

                      @if (unfixable.unfixableChecks.length === 0) {
                        <p class="s-hint" data-testid="unfixable-checks-empty">
                          grain treats every check {{ repoSlug() }} reports as
                          one a commit could turn green.
                        </p>
                      } @else {
                        <ul
                          class="repo-unfixable-list"
                          aria-label="Declared unfixable checks"
                          data-testid="unfixable-checks-list"
                        >
                          @for (
                            check of unfixable.unfixableChecks;
                            track check
                          ) {
                            <li
                              class="repo-unfixable-chip"
                              [attr.data-testid]="
                                'unfixable-check-chip-' + $index
                              "
                            >
                              <span class="repo-unfixable-name">{{
                                check
                              }}</span>
                              @if (canWriteUnfixableChecks()) {
                                <button
                                  type="button"
                                  class="repo-unfixable-remove"
                                  [attr.data-testid]="
                                    'remove-unfixable-check-' + $index
                                  "
                                  [attr.aria-label]="
                                    'Stop declaring ' + check + ' unfixable'
                                  "
                                  [title]="
                                    'Stop declaring ' + check + ' unfixable'
                                  "
                                  [disabled]="unfixableSaving()"
                                  (click)="removeUnfixableCheck(check)"
                                >
                                  ×
                                </button>
                              }
                            </li>
                          }
                        </ul>
                      }

                      @if (unfixableWarning(); as warn) {
                        <div
                          class="s-banner warn"
                          id="repo-unfixable-checks-warning"
                          role="alert"
                          data-testid="unfixable-checks-warning"
                        >
                          {{ warn }}
                        </div>
                      }

                      <form
                        class="repo-unfixable-form"
                        autocomplete="off"
                        (submit)="addUnfixableCheck($event)"
                      >
                        <label class="s-label" for="mq-unfixable-check"
                          >Check that cannot pass</label
                        >
                        <div class="repo-unfixable-row">
                          <input
                            id="mq-unfixable-check"
                            name="unfixableCheck"
                            class="s-input s-mono"
                            type="text"
                            autocomplete="off"
                            autocapitalize="none"
                            autocorrect="off"
                            spellcheck="false"
                            data-testid="input-unfixable-check"
                            placeholder="cla/google"
                            [value]="unfixableDraft()"
                            [disabled]="!canWriteUnfixableChecks()"
                            [attr.aria-describedby]="
                              unfixableChecksDescribedBy(
                                'mq-unfixable-helper',
                                unfixableWarning()
                                  ? 'repo-unfixable-checks-warning'
                                  : null
                              )
                            "
                            [attr.aria-invalid]="
                              unfixableWarning() ? 'true' : null
                            "
                            (input)="
                              onUnfixableDraftInput($any($event.target).value)
                            "
                          />
                          <button
                            type="submit"
                            class="btn-primary s-btn-sm"
                            data-testid="add-unfixable-check-btn"
                            [disabled]="
                              !canWriteUnfixableChecks() ||
                              unfixableSaving() ||
                              !unfixableDraft().trim()
                            "
                            [attr.aria-describedby]="
                              unfixableChecksDescribedBy()
                            "
                          >
                            Add
                          </button>
                        </div>
                        <p class="s-hint" id="mq-unfixable-helper">
                          The check's exact name, as the pull request reports it
                          — matched without case, never by part of a name.
                          {{ unfixable.grainCICheckName }} cannot be named here:
                          it judges this exact commit, so its verdict is always
                          the branch's own.
                        </p>
                      </form>
                    }
                  }
                </div>
              }

              @case ("agents") {
                <div class="s-card" data-testid="card-repo-agents">
                  <h2 class="s-card-title">
                    Repository instructions, setup &amp; capability grants
                  </h2>
                  <div class="s-field">
                    <label class="s-label" for="rp-setup"
                      >Sandbox setup command</label
                    >
                    <input
                      id="rp-setup"
                      class="s-input tabular"
                      type="text"
                      data-testid="input-repo-setup-cmd"
                      placeholder="npm ci"
                      [value]="setupCommand()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/setup-command',
                          repoSlug()
                        )
                      "
                      (input)="setupCommand.set($any($event.target).value)"
                    />
                  </div>
                  <div class="s-field">
                    <label class="s-label" for="rp-prompt"
                      >Standing prompt extension</label
                    >
                    <textarea
                      id="rp-prompt"
                      class="s-textarea"
                      rows="4"
                      data-testid="input-repo-prompt-ext"
                      [value]="promptExtension()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/prompt-extension',
                          repoSlug()
                        )
                      "
                      (input)="promptExtension.set($any($event.target).value)"
                    ></textarea>
                  </div>
                  <div class="s-field">
                    <label class="s-label" for="rp-caps"
                      >Default capabilities (comma-separated)</label
                    >
                    <input
                      id="rp-caps"
                      class="s-input tabular"
                      type="text"
                      data-testid="input-repo-caps"
                      [value]="repoCaps()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/capabilities',
                          repoSlug()
                        )
                      "
                      (input)="repoCaps.set($any($event.target).value)"
                    />
                  </div>
                  <div class="s-inline">
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-repo-agents-btn"
                      [disabled]="!canSaveRepoAgents()"
                      (click)="saveAgentTabSettings()"
                    >
                      Save agent settings
                    </button>
                  </div>
                </div>
              }

              @case ("branches") {
                <div class="s-card" data-testid="card-repo-branches">
                  <h2 class="s-card-title">Repository branches</h2>
                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/branches",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="branches-read-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/branches",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (branchesError()) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="branches-error-banner"
                    >
                      <span>{{ branchesError() }}</span>
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="retry-branches-btn"
                        (click)="loadBranches(true)"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (!branchesLoaded()) {
                    <p class="s-hint" data-testid="branches-loading">
                      Loading branches…
                    </p>
                  } @else if (branches().length === 0) {
                    <div class="repo-empty-state" data-testid="branches-empty">
                      <p class="repo-empty-title">
                        No Grain-managed branches yet
                      </p>
                      <p class="s-hint">
                        Create a branch below to manage release or long-lived
                        branches with Grain.
                      </p>
                    </div>
                  } @else {
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Repository branches">
                        <thead>
                          <tr>
                            <th>Branch</th>
                            <th>HEAD</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (b of branches(); track b.name) {
                            <tr [attr.data-testid]="'branch-row-' + b.name">
                              <td class="tabular">{{ b.name }}</td>
                              <td class="tabular">
                                {{ (b.sha || b.head || "—").slice(0, 10) }}
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }
                  @if (
                    hasValidRepo() &&
                    !access.can(
                      "POST /api/repos/{owner}/{name}/branches",
                      repoSlug()
                    )
                  ) {
                    <p
                      class="s-hint"
                      id="repo-branches-denied-reason"
                      data-testid="branches-write-denied"
                    >
                      {{
                        access.deniedReason(
                          "POST /api/repos/{owner}/{name}/branches",
                          repoSlug()
                        )
                      }}
                    </p>
                  }
                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="br-name"
                        >New branch name</label
                      >
                      <input
                        id="br-name"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-new-branch-name"
                        placeholder="release/v1.2"
                        [value]="newBranchName()"
                        [disabled]="
                          !access.can(
                            'POST /api/repos/{owner}/{name}/branches',
                            repoSlug()
                          )
                        "
                        [attr.aria-describedby]="branchesDescribedBy()"
                        (input)="newBranchName.set($any($event.target).value)"
                      />
                    </div>
                    <div class="s-field">
                      <label class="s-label" for="br-from">From ref</label>
                      <input
                        id="br-from"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-new-branch-from"
                        placeholder="main"
                        [value]="newBranchFrom()"
                        [disabled]="
                          !access.can(
                            'POST /api/repos/{owner}/{name}/branches',
                            repoSlug()
                          )
                        "
                        [attr.aria-describedby]="branchesDescribedBy()"
                        (input)="newBranchFrom.set($any($event.target).value)"
                      />
                    </div>
                  </div>
                  <div class="s-inline">
                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="create-branch-btn"
                      [disabled]="
                        !newBranchName().trim() ||
                        !access.can(
                          'POST /api/repos/{owner}/{name}/branches',
                          repoSlug()
                        )
                      "
                      [attr.aria-describedby]="branchesDescribedBy()"
                      (click)="createBranch()"
                    >
                      Create branch
                    </button>
                  </div>
                </div>
              }

              @case ("releases") {
                <div class="s-card" data-testid="card-repo-work-ownership">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">Work ownership</h2>
                      <p class="s-card-desc">
                        Choose whether this deployment runs {{ repoSlug() }}'s
                        standing automated work and per-item overrides.
                      </p>
                    </div>
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/work-ownership",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="work-ownership-read-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/work-ownership",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (workOwnershipError()) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="work-ownership-error-banner"
                    >
                      <span>{{ workOwnershipError() }}</span>
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="retry-work-ownership-btn"
                        (click)="loadWorkOwnership(true)"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (workOwnershipData() === null) {
                    <p class="s-hint" data-testid="work-ownership-loading">
                      Loading work ownership…
                    </p>
                  } @else {
                    @if (workOwnershipData(); as work) {
                      <div class="repo-wo-body">
                        <div class="s-toggle-row">
                          <div class="s-toggle-copy">
                            <span
                              class="s-toggle-name"
                              data-testid="work-ownership-switch-label"
                            >
                              Standing work on this deployment:
                              {{ work.defaultRuns ? "on" : "off" }}
                            </span>
                            @if (
                              !access.can(
                                "PUT /api/repos/{owner}/{name}/work-ownership",
                                repoSlug()
                              )
                            ) {
                              <span
                                class="s-hint"
                                id="repo-work-ownership-denied-reason"
                                data-testid="work-ownership-write-denied"
                              >
                                {{
                                  access.deniedReason(
                                    "PUT /api/repos/{owner}/{name}/work-ownership",
                                    repoSlug()
                                  )
                                }}
                              </span>
                            }
                          </div>
                          <button
                            type="button"
                            class="g-switch"
                            role="switch"
                            data-testid="switch-work-ownership-default"
                            aria-label="Standing work on this deployment"
                            [attr.aria-checked]="work.defaultRuns"
                            [attr.aria-describedby]="workOwnershipDescribedBy()"
                            [disabled]="
                              !canWriteWorkOwnership() || workOwnershipSaving()
                            "
                            (click)="
                              setWorkOwnershipDefault(
                                work.defaultRuns ? 'off' : 'on'
                              )
                            "
                          ></button>
                        </div>

                        <div class="repo-wo-copy">
                          <p class="repo-wo-note">
                            Covers: this repository's schedules (declared, set
                            up here, and workflow crons), its release, the
                            base-branch check, post-merge jobs, automatic ports,
                            and the triage and repair tasks grain files on its
                            own.
                          </p>
                          <p class="repo-wo-note">
                            Does not cover: tasks people file by hand against
                            this repository, their pull requests' CI, the merge
                            queue for them, and the repair of those pull
                            requests — those run either way.
                          </p>
                        </div>

                        <p class="repo-wo-note">
                          Whether <em>this</em> deployment is the one running
                          this repository's standing work, as against another
                          deployment watching the same repository. The
                          repository declares that the work exists; this says
                          who does it. Saying nothing is its own answer, and a
                          different one from saying no: an item that says
                          nothing follows the default and moves with it, and one
                          that says off stays off when the default is turned
                          back on — and one that says on runs while the default
                          is off.
                        </p>

                        <div
                          class="repo-wo-row is-default"
                          data-testid="work-ownership-default-row"
                        >
                          <span class="repo-wo-row-main">
                            <span class="repo-wo-item-title"
                              >Repository default:</span
                            >
                            <span
                              [class]="
                                'status-pill ' + saidPillTone(work.default)
                              "
                            >
                              <g-status-icon
                                [tone]="saidPillTone(work.default)"
                                [kind]="saidPillKind(work.default)"
                              />
                              {{ saidLabel(work.default) }}
                            </span>
                            <span
                              [class]="
                                'status-pill repo-wo-resolved ' +
                                (work.defaultRuns ? 'is-runs' : 'is-off')
                              "
                            >
                              <g-status-icon
                                [tone]="
                                  work.defaultRuns ? 'healthy' : 'neutral'
                                "
                                [kind]="
                                  work.defaultRuns ? 'healthy' : 'neutral'
                                "
                              />
                              {{
                                work.defaultRuns
                                  ? "Runs this repository's work"
                                  : "Does not run this repository's work"
                              }}
                            </span>
                          </span>
                          <div
                            class="segmented repo-wo-segmented"
                            role="group"
                            aria-label="Repository default ownership"
                          >
                            @for (opt of ownershipOptions; track opt.key) {
                              <button
                                type="button"
                                [attr.data-testid]="
                                  'work-ownership-default-' + opt.key
                                "
                                [attr.aria-label]="
                                  'the repository default: ' + opt.ariaSuffix
                                "
                                [attr.aria-pressed]="work.default === opt.state"
                                [attr.aria-describedby]="
                                  workOwnershipDescribedBy()
                                "
                                [disabled]="
                                  !canWriteWorkOwnership() ||
                                  workOwnershipSaving()
                                "
                                (click)="setWorkOwnershipDefault(opt.state)"
                              >
                                {{ opt.label }}
                              </button>
                            }
                          </div>
                        </div>

                        @if (work.items.length === 0) {
                          <p class="s-hint" data-testid="work-ownership-empty">
                            No work items: this repository declares no schedules
                            here, none fires into it, and nothing has been said
                            about one.
                          </p>
                        } @else {
                          <div
                            class="repo-wo-list"
                            data-testid="work-ownership-items"
                          >
                            @for (item of work.items; track item.item) {
                              @let label = workItemLabel(item);
                              <div
                                class="repo-wo-row"
                                [attr.data-testid]="
                                  'work-ownership-item-' + item.item
                                "
                              >
                                <span class="repo-wo-row-main">
                                  <span
                                    [class]="
                                      'status-pill repo-wo-resolved ' +
                                      (item.runs ? 'is-runs' : 'is-off')
                                    "
                                  >
                                    <g-status-icon
                                      [tone]="item.runs ? 'healthy' : 'neutral'"
                                      [kind]="item.runs ? 'healthy' : 'neutral'"
                                    />
                                    {{ item.runs ? "Runs" : "Not run" }}
                                  </span>
                                  <span class="repo-wo-item-title">{{
                                    label
                                  }}</span>
                                  <span
                                    [class]="
                                      'status-pill ' +
                                      saidPillTone(item.override)
                                    "
                                  >
                                    <g-status-icon
                                      [tone]="saidPillTone(item.override)"
                                      [kind]="saidPillKind(item.override)"
                                    />
                                    {{ saidLabel(item.override) }}
                                  </span>
                                  @if (item.title && item.title !== item.item) {
                                    <code class="repo-decl-code">{{
                                      item.item
                                    }}</code>
                                  }
                                  @if (item.paused) {
                                    <span class="status-pill quiet">
                                      <g-status-icon
                                        tone="blast"
                                        kind="warning"
                                      />
                                      Paused on its own row
                                    </span>
                                  }
                                  @if (item.declaration; as decl) {
                                    <span class="repo-wo-meta"
                                      >declared in {{ decl.path }}</span
                                    >
                                  }
                                  @if (item.kind === "unknown") {
                                    <span class="repo-wo-meta"
                                      >nothing here has this id — a decision
                                      left behind by whatever it named</span
                                    >
                                  }
                                </span>
                                <div
                                  class="segmented repo-wo-segmented"
                                  role="group"
                                  [attr.aria-label]="label + ' ownership'"
                                >
                                  @for (
                                    opt of ownershipOptions;
                                    track opt.key
                                  ) {
                                    <button
                                      type="button"
                                      [attr.data-testid]="
                                        'work-ownership-item-' +
                                        item.item +
                                        '-' +
                                        opt.key
                                      "
                                      [attr.aria-label]="
                                        label + ': ' + opt.ariaSuffix
                                      "
                                      [attr.aria-pressed]="
                                        item.override === opt.state
                                      "
                                      [attr.aria-describedby]="
                                        workOwnershipDescribedBy()
                                      "
                                      [disabled]="
                                        !canWriteWorkOwnership() ||
                                        workOwnershipSaving()
                                      "
                                      (click)="
                                        setWorkItemOwnership(
                                          item.item,
                                          opt.state
                                        )
                                      "
                                    >
                                      {{ opt.label }}
                                    </button>
                                  }
                                </div>
                              </div>
                            }
                          </div>
                        }

                        <p class="repo-wo-caption">
                          Grain resolves this before every piece of standing
                          work it starts here. A skipped schedule says so on its
                          own status and moves on to its next occurrence, so
                          turning the work back on does not release a backlog of
                          catch-up firings. The deployment's own configuration
                          repository is checked whatever this says.
                        </p>
                      </div>
                    }
                  }
                </div>

                <div class="s-card" data-testid="card-repo-release-settings">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Release workflow &amp; base-branch CI jobs
                      </h2>
                      <p class="s-card-desc">
                        Controls release publishing, base-branch judging jobs,
                        post-merge dispatch jobs, and release secrets.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-repo-release-btn"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/release',
                          repoSlug()
                        )
                      "
                      (click)="saveReleaseSettings()"
                    >
                      Save release settings
                    </button>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Enable release workflow</span>
                      <span class="s-hint"
                        >Run declared release workflows when base branches
                        advance.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      data-testid="switch-repo-release-enabled"
                      [attr.aria-checked]="releaseEnabled()"
                      [disabled]="
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/release',
                          repoSlug()
                        )
                      "
                      aria-label="Enable release workflow"
                      (click)="releaseEnabled.set(!releaseEnabled())"
                    ></button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="rel-base-jobs"
                        >Base-branch CI jobs (comma-separated)</label
                      >
                      <input
                        id="rel-base-jobs"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-release-base-jobs"
                        placeholder="empty = all push jobs"
                        [value]="baseBranchJobsText()"
                        [disabled]="
                          configRepoOnly() ||
                          !access.can(
                            'PUT /api/repos/{owner}/{name}/release',
                            repoSlug()
                          )
                        "
                        (input)="
                          baseBranchJobsText.set($any($event.target).value)
                        "
                      />
                    </div>
                    <div class="s-field">
                      <label class="s-label" for="rel-post-jobs"
                        >Post-merge dispatch jobs (comma-separated)</label
                      >
                      <input
                        id="rel-post-jobs"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-release-post-merge-jobs"
                        placeholder="guest-cache (optional)"
                        [value]="postMergeJobsText()"
                        [disabled]="
                          configRepoOnly() ||
                          !access.can(
                            'PUT /api/repos/{owner}/{name}/release',
                            repoSlug()
                          )
                        "
                        (input)="
                          postMergeJobsText.set($any($event.target).value)
                        "
                      />
                    </div>
                  </div>

                  @if (releaseSecrets().length > 0) {
                    <div class="s-inline" data-testid="repo-release-secrets">
                      <span class="s-label">Release secrets:</span>
                      @for (sec of releaseSecrets(); track sec.name) {
                        <span
                          [class]="
                            'status-pill tabular ' +
                            (sec.present !== false ? 'healthy' : 'warn')
                          "
                        >
                          {{ sec.name }}:
                          {{ sec.present !== false ? "present" : "missing" }}
                        </span>
                      }
                    </div>
                  }
                </div>

                @if (pendingReleases().length > 0) {
                  <div class="s-card" data-testid="card-pending-releases">
                    <h2 class="s-card-title">
                      Pending trunk releases awaiting approval
                    </h2>
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Pending releases">
                        <thead>
                          <tr>
                            <th>Version</th>
                            <th>Summary</th>
                            <th>Decision</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (pr of pendingReleases(); track pr.version) {
                            <tr
                              [attr.data-testid]="
                                'pending-release-row-' + pr.version
                              "
                            >
                              <td class="tabular">{{ pr.version }}</td>
                              <td>{{ pr.summary || "Staged for release" }}</td>
                              <td>
                                <div class="s-inline">
                                  <button
                                    type="button"
                                    class="btn-primary s-btn-sm"
                                    [attr.data-testid]="
                                      'approve-pending-release-' + pr.version
                                    "
                                    [disabled]="
                                      !access.can(
                                        'POST /api/repos/{owner}/{name}/pending-releases/{version}/approve',
                                        repoSlug()
                                      )
                                    "
                                    (click)="approvePendingRelease(pr.version)"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [attr.data-testid]="
                                      'reject-pending-release-' + pr.version
                                    "
                                    [disabled]="
                                      !access.can(
                                        'POST /api/repos/{owner}/{name}/pending-releases/{version}/reject',
                                        repoSlug()
                                      )
                                    "
                                    (click)="rejectPendingRelease(pr.version)"
                                  >
                                    Reject
                                  </button>
                                </div>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  </div>
                }

                <div class="s-card" data-testid="card-releases-list">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Release trains &amp; candidate qualification
                      </h2>
                      <p class="s-card-desc">
                        Cut release trains, qualify release candidates, and
                        promote verified builds.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-tonal s-btn-sm"
                      data-testid="trigger-release-run-btn"
                      [disabled]="
                        !access.can(
                          'POST /api/repos/{owner}/{name}/release-runs',
                          repoSlug()
                        )
                      "
                      (click)="triggerReleaseRun()"
                    >
                      Run release workflow
                    </button>
                  </div>

                  @if (releases().length > 0) {
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Releases">
                        <thead>
                          <tr>
                            <th>Release</th>
                            <th>Status</th>
                            <th>Candidates &amp; promotion</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (rel of releases(); track rel.name) {
                            <tr [attr.data-testid]="'release-row-' + rel.name">
                              <td class="tabular">{{ rel.name }}</td>
                              <td>
                                <span
                                  class="status-pill neutral"
                                  [attr.data-testid]="
                                    'release-status-' + rel.name
                                  "
                                  >{{ rel.status || "open" }}</span
                                >
                              </td>
                              <td>
                                <div class="s-inline">
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [attr.data-testid]="
                                      'inspect-rc-' + rel.name
                                    "
                                    [attr.aria-pressed]="
                                      selectedRelease() === rel.name
                                    "
                                    (click)="
                                      selectReleaseForCandidates(rel.name)
                                    "
                                  >
                                    Inspect RCs
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [attr.data-testid]="'cut-rc-' + rel.name"
                                    [disabled]="
                                      !access.can(
                                        'POST /api/repos/{owner}/{name}/releases/{release}/candidates',
                                        repoSlug()
                                      )
                                    "
                                    (click)="cutCandidate(rel.name)"
                                  >
                                    Cut RC
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-primary s-btn-sm"
                                    [attr.data-testid]="
                                      'promote-rc-' + rel.name
                                    "
                                    [disabled]="
                                      !access.can(
                                        'POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote',
                                        repoSlug()
                                      )
                                    "
                                    (click)="promoteCandidate(rel.name)"
                                  >
                                    Promote RC
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [disabled]="
                                      !access.can(
                                        'POST /api/repos/{owner}/{name}/releases/{release}/merge',
                                        repoSlug()
                                      )
                                    "
                                    (click)="mergeRelease(rel.name)"
                                  >
                                    Merge back
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-text s-btn-sm"
                                    [disabled]="
                                      !access.can(
                                        'DELETE /api/repos/{owner}/{name}/releases/{release}',
                                        repoSlug()
                                      )
                                    "
                                    (click)="deleteRelease(rel.name)"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }

                  @if (releases().length > 1) {
                    <div class="s-inline">
                      <span class="s-label">Inspecting candidates for:</span>
                      <g-pill-select
                        testid="select-inspect-release"
                        ariaLabel="Select release to inspect candidates"
                        align="left"
                        [options]="releaseOptions()"
                        [value]="selectedRelease()"
                        (valueChange)="selectReleaseForCandidates($event)"
                      />
                    </div>
                  }

                  @if (candidates().length > 0) {
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Release candidates">
                        <thead>
                          <tr>
                            <th>Candidate</th>
                            <th>Branch</th>
                            <th>Status</th>
                            <th>Qualification</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (c of candidates(); track c.id) {
                            <tr [attr.data-testid]="'candidate-row-' + c.id">
                              <td class="tabular">
                                {{
                                  c.number !== undefined
                                    ? "rc#" + c.number
                                    : c.version || c.id
                                }}
                              </td>
                              <td class="tabular">
                                {{ c.branch || c.version || "—" }}
                              </td>
                              <td>
                                <span class="status-pill neutral">{{
                                  c.status || "active"
                                }}</span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  class="btn-tonal s-btn-sm"
                                  [attr.data-testid]="
                                    'approve-qualification-' + c.id
                                  "
                                  [disabled]="
                                    !access.can(
                                      'POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve',
                                      repoSlug()
                                    )
                                  "
                                  (click)="approveQualification('' + c.id)"
                                >
                                  Approve qualification
                                </button>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }

                  <div class="s-inline">
                    <input
                      class="s-input s-input-inline tabular"
                      type="text"
                      aria-label="New release name"
                      data-testid="input-new-release-name"
                      placeholder="v1.4.0"
                      [value]="newReleaseName()"
                      [disabled]="
                        !access.can(
                          'POST /api/repos/{owner}/{name}/releases',
                          repoSlug()
                        )
                      "
                      (input)="newReleaseName.set($any($event.target).value)"
                    />
                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="create-release-btn"
                      [disabled]="
                        !newReleaseName().trim() ||
                        !access.can(
                          'POST /api/repos/{owner}/{name}/releases',
                          repoSlug()
                        )
                      "
                      (click)="createRelease()"
                    >
                      Create release
                    </button>
                  </div>
                </div>
              }

              @case ("advanced") {
                <div class="s-card" data-testid="card-repo-declarations">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">Declarations</h2>
                      <p class="s-card-desc">
                        Control whether Grain reads templates, suites,
                        schedules, path triggers, and merge rules from
                        <code class="repo-decl-code">.grain/</code> on
                        {{ repoSlug() }}'s default branch.
                      </p>
                    </div>
                    @if (declarationsData(); as decl) {
                      <span
                        [class]="
                          'status-pill ' +
                          (decl.declarationsStatus?.error
                            ? 'error'
                            : decl.declarations
                              ? 'healthy'
                              : 'neutral')
                        "
                        data-testid="declarations-state-pill"
                      >
                        {{
                          decl.declarationsStatus?.error
                            ? "Sync error"
                            : decl.declarations
                              ? "Enabled"
                              : "Off"
                        }}
                      </span>
                    }
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/declarations",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="declarations-read-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/declarations",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (declarationsError()) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="declarations-error-banner"
                    >
                      <span>{{ declarationsError() }}</span>
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="retry-declarations-btn"
                        (click)="loadDeclarations()"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (declarationsData() === null) {
                    <p class="s-hint" data-testid="declarations-loading">
                      Loading declarations…
                    </p>
                  } @else {
                    @if (declarationsData(); as decl) {
                      <div class="s-toggle-row">
                        <div class="s-toggle-copy">
                          <span class="s-toggle-name"
                            >Read {{ repoSlug() }}'s own declarations</span
                          >
                          <span class="s-hint">
                            Read the templates, suites, schedules and path
                            triggers {{ repoSlug() }} declares in its own
                            .grain/templates, .grain/suites, .grain/schedules
                            and .grain/triggers. Grain re-reads them within a
                            couple of minutes of every change, and they cannot
                            be edited here — the files are. A declaration files
                            work in {{ repoSlug() }} on a cadence; it can never
                            widen what that work reads, writes, or holds.
                          </span>
                          @if (
                            !access.can(
                              "PUT /api/repos/{owner}/{name}/declarations",
                              repoSlug()
                            )
                          ) {
                            <span
                              class="s-hint"
                              id="repo-decl-denied-reason"
                              data-testid="declarations-write-denied"
                            >
                              {{
                                access.deniedReason(
                                  "PUT /api/repos/{owner}/{name}/declarations",
                                  repoSlug()
                                )
                              }}
                            </span>
                          }
                        </div>
                        <button
                          type="button"
                          class="g-switch"
                          role="switch"
                          data-testid="switch-repo-declarations"
                          [attr.aria-checked]="!!decl.declarations"
                          [attr.aria-label]="declarationsSwitchLabel()"
                          [attr.aria-describedby]="
                            !access.can(
                              'PUT /api/repos/{owner}/{name}/declarations',
                              repoSlug()
                            )
                              ? 'repo-decl-denied-reason'
                              : null
                          "
                          [disabled]="
                            configRepoOnly() ||
                            declarationsSaving() ||
                            !access.can(
                              'PUT /api/repos/{owner}/{name}/declarations',
                              repoSlug()
                            )
                          "
                          (click)="toggleDeclarations()"
                        ></button>
                      </div>

                      @if (decl.declarationsStatus; as status) {
                        <div
                          class="repo-decl-status"
                          data-testid="declarations-status"
                        >
                          <p
                            class="repo-decl-summary"
                            data-testid="declarations-status-summary"
                          >
                            @if (status.error) {
                              Last read failed: {{ status.error
                              }}{{
                                status.commit
                                  ? " — still running what " +
                                    status.commit.slice(0, 12) +
                                    " declared."
                                  : ""
                              }}
                            } @else {
                              Read at
                              {{
                                (status.commit || "").slice(0, 12) ||
                                  "no commit"
                              }}: {{ declaredSummaryText(status) }}
                            }
                          </p>

                          @if ((status.triggers ?? []).length > 0) {
                            <p
                              class="repo-decl-line"
                              data-testid="declarations-triggers"
                            >
                              Path triggers:
                              @for (
                                path of status.triggers ?? [];
                                track path;
                                let i = $index
                              ) {
                                @if (i > 0) {
                                  ,
                                }
                                <code class="repo-decl-code">{{ path }}</code>
                              }
                            </p>
                          }

                          @if (status.error && status.commit) {
                            <p
                              class="repo-decl-line"
                              data-testid="declarations-still-running"
                            >
                              Still running from
                              {{ status.commit.slice(0, 12) }}:
                              {{ declaredSummaryText(status) }}
                            </p>
                          }

                          @for (p of status.pushes ?? []; track p.path) {
                            <p
                              class="repo-decl-line"
                              data-testid="declarations-push"
                            >
                              Tasks from
                              <code class="repo-decl-code">{{ p.path }}</code>
                              may also push: {{ formatPushRefs(p.refs) }}
                            </p>
                          }

                          @for (w of status.warnings ?? []; track w) {
                            <p
                              class="repo-decl-warning"
                              data-testid="declarations-warning"
                            >
                              Warning: {{ w }}
                            </p>
                          }

                          @if (hasDeclaredFiles(status)) {
                            <ul
                              class="repo-decl-files"
                              data-testid="declarations-files"
                            >
                              @for (p of status.templates ?? []; track p) {
                                <li class="repo-decl-file">
                                  <code class="repo-decl-code">{{ p }}</code>
                                  <span class="status-pill neutral"
                                    >template</span
                                  >
                                </li>
                              }
                              @for (p of status.suites ?? []; track p) {
                                <li class="repo-decl-file">
                                  <code class="repo-decl-code">{{ p }}</code>
                                  <span class="status-pill neutral">suite</span>
                                </li>
                              }
                              @for (p of status.schedules ?? []; track p) {
                                <li class="repo-decl-file">
                                  <code class="repo-decl-code">{{ p }}</code>
                                  <span class="status-pill neutral"
                                    >schedule</span
                                  >
                                </li>
                              }
                              @for (p of status.triggers ?? []; track p) {
                                <li class="repo-decl-file">
                                  <code class="repo-decl-code">{{ p }}</code>
                                  <span class="status-pill neutral"
                                    >trigger</span
                                  >
                                </li>
                              }
                              @if (status.mergeRules) {
                                <li class="repo-decl-file">
                                  <code class="repo-decl-code">{{
                                    status.mergeRules
                                  }}</code>
                                  <span class="status-pill neutral"
                                    >merge-rules</span
                                  >
                                </li>
                              }
                            </ul>
                          }
                        </div>
                      } @else if (decl.declarations) {
                        <p
                          class="s-hint"
                          data-testid="declarations-not-read-yet"
                        >
                          Not read yet — grain picks this up on its next cycle.
                        </p>
                      } @else {
                        <p
                          class="s-hint"
                          data-testid="declarations-disabled-hint"
                        >
                          Declarations are off for {{ repoSlug() }}.
                        </p>
                      }
                    }
                  }
                </div>

                @if (declarationsData(); as decl) {
                  @if (
                    (decl.pairedBranches?.length ?? 0) > 0 ||
                    (decl.portDirections?.length ?? 0) > 0
                  ) {
                    <div
                      class="s-card repo-ports"
                      data-testid="card-repo-ports"
                    >
                      <div>
                        <h2 class="s-card-title">Ports</h2>
                        <p class="s-card-desc">
                          {{
                            (decl.pairedBranches?.length ?? 0) > 0
                              ? "Grain ports each merge between " +
                                decl.pairedBranches!.join(", ")
                              : "No branches are paired"
                          }}
                          — operator:
                          {{ decl.portBranches?.join(", ") || "none" }};
                          declared in .grain/settings.yml:
                          {{ decl.declaredPortBranches?.join(", ") || "none" }}.
                          Set by the operator in grain/config and by
                          {{ repoSlug() }}'s own port-types; not editable here.
                        </p>
                      </div>

                      <div
                        class="s-table-wrap"
                        tabindex="0"
                        role="region"
                        aria-label="Port directions"
                      >
                        <table class="s-table" aria-label="Port directions">
                          <thead>
                            <tr>
                              <th>Direction</th>
                              <th>Operator</th>
                              <th>Declared</th>
                              <th>Ports</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (
                              d of decl.portDirections ?? [];
                              track d.from + "->" + d.to
                            ) {
                              <tr>
                                <td>
                                  <code class="repo-decl-code"
                                    >{{ d.from }}-&gt;{{ d.to }}</code
                                  >
                                </td>
                                <td>
                                  {{ d.operatorTypes?.join(", ") || "—" }}
                                </td>
                                <td>
                                  {{ d.declaredTypes?.join(", ") || "—" }}
                                </td>
                                <td>
                                  {{
                                    !d.paired
                                      ? "nothing (not a paired branch)"
                                      : d.types?.join(", ") || "every merge"
                                  }}
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>

                      @for (w of portWarningsFiltered(decl); track w) {
                        <p
                          class="repo-decl-warning"
                          data-testid="repo-port-warning"
                        >
                          Warning: {{ w }}
                        </p>
                      }
                    </div>
                  }
                }
              }
            }
          }
        </div>
      </div>
      @if (confirmReq(); as req) {
        <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
      }
    </section>
  `,
})
export class RepoDetailPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(GrainApi);
  protected readonly access = inject(AccessService);
  private readonly snackbar = inject(SnackbarService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly host = input<string | undefined>(undefined);
  readonly owner = input<string | undefined>(undefined);
  readonly name = input<string | undefined>(undefined);
  readonly tab = input<string | undefined>(undefined);

  protected readonly tabs = REPO_TABS;
  // The three modes PUT .../ci-mode accepts (model.CIMode: grain,
  // github, none). The page used to offer "both" and "off", which the
  // server refuses with a 400, and had no option for "none", so a repo
  // on no CI read as the first option, Grain CI (2026-11-13 repository
  // walkthrough).
  protected readonly ciModeOptions: readonly PillOption[] = [
    { value: "grain", label: "Grain CI (.grain/workflows)" },
    { value: "github", label: "GitHub Actions checks" },
    { value: "none", label: "No CI (merge without waiting)" },
  ];

  private readonly routeHost = signal("");
  private readonly routeOwner = signal("");
  private readonly routeName = signal("");
  private readonly routeTab = signal<string | null>(null);

  protected readonly ready = signal(false);
  protected readonly configRepoOnly = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly baseBranch = signal("main");
  protected readonly cloneUrl = signal("");
  protected readonly gitCredential = signal("");
  protected readonly availableGitCreds = signal<string[]>([]);
  protected readonly lifecycleState = signal("active");
  protected readonly importEnabled = signal(false);
  protected readonly importLabel = signal("");
  protected readonly importSourceRepo = signal("");
  protected readonly importApproved = signal(false);

  protected readonly ciMode = signal("grain");
  protected readonly watchDefaultBranch = signal(false);
  protected readonly workflows = signal<RepoWorkflowRow[]>([]);
  protected readonly selectedWorkflowPath = signal(".grain/workflows/ci.yml");
  protected readonly workflowYaml = signal("");
  protected readonly newWorkflowPath = signal("");

  protected readonly mergeOnGreen = signal(false);
  protected readonly requireUpToDate = signal(false);
  protected readonly bypassHumanGates = signal(false);
  protected readonly confirmReq = signal<ConfirmRequest | null>(null);

  protected readonly setupCommand = signal("");
  protected readonly promptExtension = signal("");
  protected readonly repoCaps = signal("");

  protected readonly branches = signal<BranchRow[]>([]);
  protected readonly branchesLoading = signal(false);
  protected readonly branchesLoaded = signal(false);
  protected readonly branchesError = signal<string | null>(null);
  protected readonly newBranchName = signal("");
  protected readonly newBranchFrom = signal("main");

  protected readonly releaseEnabled = signal(false);
  protected readonly baseBranchJobsText = signal("");
  protected readonly postMergeJobsText = signal("");
  protected readonly releaseSecrets = signal<RepoReleaseSecretRow[]>([]);
  protected readonly releases = signal<ReleaseRow[]>([]);
  protected readonly selectedRelease = signal("");
  protected readonly candidates = signal<CandidateRow[]>([]);
  protected readonly pendingReleases = signal<PendingReleaseRow[]>([]);
  protected readonly newReleaseName = signal("");

  protected readonly ownershipOptions = OWNERSHIP_OPTIONS;

  protected readonly declarationsData = signal<RepoDeclarationsResponse | null>(
    null,
  );
  protected readonly declarationsLoading = signal(false);
  protected readonly declarationsSaving = signal(false);
  protected readonly declarationsError = signal<string | null>(null);

  protected readonly workOwnershipData =
    signal<RepoWorkOwnershipResponse | null>(null);
  protected readonly workOwnershipLoading = signal(false);
  protected readonly workOwnershipSaving = signal(false);
  protected readonly workOwnershipError = signal<string | null>(null);

  protected readonly unfixableData = signal<RepoUnfixableChecksState | null>(
    null,
  );
  protected readonly unfixableLoading = signal(false);
  protected readonly unfixableSaving = signal(false);
  protected readonly unfixableError = signal<string | null>(null);
  protected readonly unfixableWarning = signal<string | null>(null);
  protected readonly unfixableDraft = signal("");

  private subs: Subscription[] = [];
  private loadedRepoSlug = "";
  private declarationsInFlightRepo = "";
  private workOwnershipInFlightRepo = "";
  private workOwnershipReadSeq = 0;
  private workOwnershipSaveSeq = 0;
  private unfixableInFlightRepo = "";
  private unfixableReadSeq = 0;
  private unfixableSaveSeq = 0;
  private branchesInFlightRepo = "";
  private branchesReadSeq = 0;
  private lastScopedErrors: Record<
    "workOwnership" | "unfixable",
    string | null
  > = {
    workOwnership: null,
    unfixable: null,
  };

  private readonly normalizedRouteParts = computed(() => {
    const rawHost = this.routeHost() || this.host() || "";
    const rawOwner = this.routeOwner() || this.owner() || "";
    const rawName = this.routeName() || this.name() || "";
    const rawTab = this.routeTab() ?? this.tab() ?? null;

    // Handle plain-path collisions when a 3-segment URL matches either
    // repos/:owner/:name/:tab or repos/:host/:owner/:name:
    if (!rawHost && /[.:]/.test(rawOwner) && rawTab && !isRepoTabId(rawTab)) {
      return {
        host: rawOwner,
        owner: rawName,
        name: rawTab,
        tab: null as string | null,
      };
    }
    if (rawHost && !/[.:]/.test(rawHost) && !rawTab && isRepoTabId(rawName)) {
      return {
        host: "",
        owner: rawHost,
        name: rawOwner,
        tab: rawName,
      };
    }
    return {
      host: rawHost,
      owner: rawOwner,
      name: rawName,
      tab: rawTab,
    };
  });

  protected readonly resolvedHost = computed(
    () => this.normalizedRouteParts().host,
  );
  protected readonly resolvedOwner = computed(
    () => this.normalizedRouteParts().owner,
  );
  protected readonly resolvedName = computed(
    () => this.normalizedRouteParts().name,
  );
  protected readonly repoSlug = computed(() => {
    const h = this.resolvedHost();
    const o = this.resolvedOwner();
    const n = this.resolvedName();
    return h ? `${h}/${o}/${n}` : `${o}/${n}`;
  });

  protected readonly activeTab = computed<RepoTabId>(
    () => normalizeRepoTabId(this.normalizedRouteParts().tab) ?? "overview",
  );

  protected gitConnOptions(): PillOption[] {
    const creds = this.availableGitCreds();
    return [
      { value: "", label: "Deployment default" },
      ...creds.map((c) => ({ value: c, label: c })),
    ];
  }

  protected workflowOptions(): PillOption[] {
    return this.workflows().map((w) => ({
      value: w.path,
      label: w.name ? `${w.path} (${w.name})` : w.path,
    }));
  }

  protected releaseOptions(): PillOption[] {
    return this.releases().map((r) => ({ value: r.name, label: r.name }));
  }

  protected declaredSummaryText(status: RepoDeclarationsStatus): string {
    return declaredSummary(status);
  }

  protected formatPushRefs(refs: DeclaredPushRef[] | undefined): string {
    return (refs ?? []).map(formatDeclaredPushRef).filter(Boolean).join(", ");
  }

  protected portWarningsFiltered(decl: RepoDeclarationsResponse): string[] {
    const seen = new Set(decl.declarationsStatus?.warnings ?? []);
    return (decl.portWarnings ?? []).filter((w) => !seen.has(w));
  }

  protected hasDeclaredFiles(
    status: RepoDeclarationsStatus | null | undefined,
  ): boolean {
    if (!status) return false;
    return Boolean(
      status.templates?.length ||
      status.suites?.length ||
      status.schedules?.length ||
      status.triggers?.length ||
      status.mergeRules,
    );
  }

  protected hasValidRepo(): boolean {
    return Boolean(this.resolvedOwner() && this.resolvedName());
  }

  protected canWriteSettings(): boolean {
    if (this.configRepoOnly() || !this.hasValidRepo()) return false;
    return this.access.can(
      "PUT /api/repos/{owner}/{name}/settings",
      this.repoSlug(),
    );
  }

  protected canWriteWorkOwnership(): boolean {
    if (this.configRepoOnly() || !this.hasValidRepo()) return false;
    return this.access.can(
      "PUT /api/repos/{owner}/{name}/work-ownership",
      this.repoSlug(),
    );
  }

  protected canWriteUnfixableChecks(): boolean {
    if (this.configRepoOnly() || !this.hasValidRepo()) return false;
    return this.access.can(
      "PUT /api/repos/{owner}/{name}/unfixable-checks",
      this.repoSlug(),
    );
  }

  protected workOwnershipDescribedBy(): string | null {
    return this.describedByIds(
      "PUT /api/repos/{owner}/{name}/work-ownership",
      "repo-work-ownership-denied-reason",
      true,
    );
  }

  protected unfixableChecksDescribedBy(
    ...extraIds: (string | null | undefined)[]
  ): string | null {
    return this.describedByIds(
      "PUT /api/repos/{owner}/{name}/unfixable-checks",
      "repo-unfixable-checks-denied-reason",
      true,
      ...extraIds,
    );
  }

  protected branchesDescribedBy(): string | null {
    return this.describedByIds(
      "POST /api/repos/{owner}/{name}/branches",
      "repo-branches-denied-reason",
      false,
    );
  }

  private describedByIds(
    route: RouteKey,
    deniedId: string,
    includeConfigRepo: boolean,
    ...extraIds: (string | null | undefined)[]
  ): string | null {
    const ids: string[] = [];
    if (includeConfigRepo && this.configRepoOnly()) {
      ids.push("repo-config-readonly-banner");
    }
    if (this.hasValidRepo() && !this.access.can(route, this.repoSlug())) {
      ids.push(deniedId);
    }
    for (const extra of extraIds) {
      if (extra) ids.push(extra);
    }
    return ids.length ? ids.join(" ") : null;
  }

  protected workItemLabel(item: RepoWorkItem): string {
    return item.title || item.item;
  }

  protected saidLabel(said: OwnershipState): string {
    if (said === "on") return "On, set here";
    if (said === "off") return "Off, set here";
    return "Nobody has said";
  }

  protected saidPillTone(said: OwnershipState): string {
    if (said === "on") return "healthy";
    if (said === "off") return "error";
    return "neutral";
  }

  protected saidPillKind(said: OwnershipState): string {
    if (said === "on") return "healthy";
    if (said === "off") return "error";
    return "neutral";
  }

  protected canSaveRepoAgents(): boolean {
    if (this.configRepoOnly() || !this.hasValidRepo()) return false;
    const repo = this.repoSlug();
    return (
      this.access.can("PUT /api/repos/{owner}/{name}/setup-command", repo) ||
      this.access.can("PUT /api/repos/{owner}/{name}/prompt-extension", repo) ||
      this.access.can("PUT /api/repos/{owner}/{name}/capabilities", repo)
    );
  }

  ngOnInit(): void {
    this.subs.push(
      this.route.paramMap.subscribe((pm) => {
        this.routeHost.set(pm.get("host") ?? "");
        this.routeOwner.set(pm.get("owner") ?? "");
        this.routeName.set(pm.get("name") ?? "");
        this.routeTab.set(pm.get("tab"));
        if (this.ready()) {
          const slug = this.repoSlug();
          if (slug !== this.loadedRepoSlug) {
            this.resetRepoState();
            void this.reloadRepoAndTab();
          } else {
            void this.loadTabData();
          }
        }
      }),
    );
    void this.initPage();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  protected can(route: RouteKey): boolean {
    if (!this.hasValidRepo()) return false;
    return this.access.can(route, this.repoSlug());
  }

  protected selectTab(tab: RepoTabId): void {
    this.routeTab.set(tab);
    const h = this.resolvedHost();
    const o = this.resolvedOwner();
    const n = this.resolvedName();
    const base = h ? ["/repos", h, o, n] : ["/repos", o, n];
    if (tab === "overview") {
      void this.router.navigate(base);
    } else {
      void this.router.navigate([...base, tab]);
    }
    void this.loadTabData(tab);
  }

  private params(): { owner: string; name: string } {
    return splitRepo(this.repoSlug());
  }

  private resetRepoState(): void {
    this.declarationsData.set(null);
    this.declarationsError.set(null);
    this.workOwnershipData.set(null);
    this.workOwnershipError.set(null);
    this.workOwnershipLoading.set(false);
    this.workOwnershipSaving.set(false);
    this.workOwnershipInFlightRepo = "";
    this.workOwnershipReadSeq++;
    this.workOwnershipSaveSeq++;
    this.clearBannerError("workOwnership");
    this.unfixableData.set(null);
    this.unfixableError.set(null);
    this.unfixableWarning.set(null);
    this.unfixableDraft.set("");
    this.unfixableLoading.set(false);
    this.unfixableSaving.set(false);
    this.unfixableInFlightRepo = "";
    this.unfixableReadSeq++;
    this.unfixableSaveSeq++;
    this.clearBannerError("unfixable");
    this.workflows.set([]);
    this.branches.set([]);
    this.branchesLoading.set(false);
    this.branchesLoaded.set(false);
    this.branchesError.set(null);
    this.branchesInFlightRepo = "";
    this.branchesReadSeq++;
    this.releases.set([]);
    this.candidates.set([]);
    this.pendingReleases.set([]);
    this.repoCaps.set("");
  }

  private async reloadRepoAndTab(): Promise<void> {
    await this.loadCoreRepo();
    await this.loadTabData();
  }

  private async initPage(): Promise<void> {
    try {
      const cfg = await this.api.config();
      if (cfg) {
        this.access.setConfig(cfg);
        const rec = cfg as Record<string, unknown>;
        this.configRepoOnly.set(
          Boolean(
            rec["configRepoOnly"] ||
            rec["externalConfigRepo"] ||
            rec["settingsLocked"],
          ),
        );
      }
      await this.loadCoreRepo();
      await this.loadTabData();
      this.ready.set(true);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  private async loadCoreRepo(): Promise<void> {
    const p = this.params();
    if (!p.owner || !p.name) return;
    const repo = this.repoSlug();
    this.loadedRepoSlug = repo;
    if (
      this.access.can("GET /api/deployment/repos/{owner}/{name}/config", repo)
    ) {
      try {
        const cfg = await this.api.get<Record<string, unknown>>(
          "GET /api/deployment/repos/{owner}/{name}/config",
          p,
        );
        const eff =
          (cfg?.["effective"] as Record<string, unknown> | undefined) ?? cfg;
        if (eff?.["cloneUrl"] !== undefined) {
          this.cloneUrl.set(String(eff["cloneUrl"] ?? ""));
        }
        if (eff?.["gitCredential"] !== undefined) {
          this.gitCredential.set(String(eff["gitCredential"] ?? ""));
        }
      } catch {
        // Non-fatal
      }
    }
    if (this.access.can("GET /api/repos/{owner}/{name}/settings", repo)) {
      try {
        const st = await this.api.get<Record<string, unknown>>(
          "GET /api/repos/{owner}/{name}/settings",
          p,
        );
        if (st?.["ciMode"]) this.ciMode.set(String(st["ciMode"]));
        if (st?.["mergeOnGreen"] !== undefined) {
          this.mergeOnGreen.set(Boolean(st["mergeOnGreen"]));
        }
        if (st?.["requireBranchUpToDate"] !== undefined) {
          this.requireUpToDate.set(Boolean(st["requireBranchUpToDate"]));
        }
        if (st?.["baseRepairBypassesHumanGates"] !== undefined) {
          this.bypassHumanGates.set(
            Boolean(st["baseRepairBypassesHumanGates"]),
          );
        }
        if (st?.["watchDefaultBranch"] !== undefined) {
          this.watchDefaultBranch.set(Boolean(st["watchDefaultBranch"]));
        }
        if (st?.["setupCommand"] !== undefined) {
          this.setupCommand.set(String(st["setupCommand"] ?? ""));
        }
        if (st?.["promptExtension"] !== undefined) {
          this.promptExtension.set(String(st["promptExtension"] ?? ""));
        }
        const imp = st?.["issueImport"] as
          | {
              enabled?: boolean;
              label?: string;
              repo?: string;
              approved?: boolean;
            }
          | undefined;
        if (imp && typeof imp === "object") {
          this.importEnabled.set(Boolean(imp.enabled));
          this.importLabel.set(String(imp.label ?? ""));
          this.importSourceRepo.set(String(imp.repo ?? ""));
          this.importApproved.set(Boolean(imp.approved));
        }
      } catch {
        // Non-fatal
      }
    }
    if (this.access.can("GET /api/deployment/git-connections")) {
      try {
        const conns = await this.api.get<
          { credential?: string; id?: string }[] | { connections?: unknown[] }
        >("GET /api/deployment/git-connections");
        const arr = (
          Array.isArray(conns) ? conns : (conns?.connections ?? [])
        ) as { credential?: string; id?: string }[];
        this.availableGitCreds.set(
          arr.map((c) => c.credential ?? c.id ?? "").filter(Boolean),
        );
      } catch {
        // Non-fatal
      }
    }
  }

  private async loadTabData(t: RepoTabId = this.activeTab()): Promise<void> {
    const p = this.params();
    if (!p.owner || !p.name) return;
    const repo = this.repoSlug();
    if (t === "overview") {
      if (this.access.can("GET /api/repos/{owner}/{name}/lifecycle", repo)) {
        void this.api
          .get<Record<string, unknown>>(
            "GET /api/repos/{owner}/{name}/lifecycle",
            p,
          )
          .then((l) => {
            const st = l?.["state"] ?? l?.["stage"];
            if (st) this.lifecycleState.set(String(st));
          })
          .catch(() => undefined);
      }
    } else if (t === "ci") {
      if (this.access.can("GET /api/repos/{owner}/{name}/workflows", repo)) {
        void this.api
          .get<{ workflows?: RepoWorkflowRow[] } | RepoWorkflowRow[]>(
            "GET /api/repos/{owner}/{name}/workflows",
            p,
          )
          .then((w) => {
            const list = (Array.isArray(w) ? w : (w?.workflows ?? [])).map(
              (item) => ({
                path: item.path,
                text: item.text ?? "",
                ...(item.name ? { name: item.name } : {}),
              }),
            );
            this.workflows.set(list);
            const cur = this.selectedWorkflowPath();
            const active = list.find((x) => x.path === cur) ?? list[0] ?? null;
            if (active) {
              this.selectedWorkflowPath.set(active.path);
              this.workflowYaml.set(active.text);
            } else {
              this.selectedWorkflowPath.set(".grain/workflows/ci.yml");
              this.workflowYaml.set("");
            }
          })
          .catch(() => undefined);
      }
    } else if (t === "merge-queue") {
      await this.loadUnfixableChecks();
    } else if (t === "agents") {
      if (this.access.can("GET /api/repos/{owner}/{name}/capabilities", repo)) {
        void this.api
          .get<{ defaultCapabilities?: string[] }>(
            "GET /api/repos/{owner}/{name}/capabilities",
            p,
          )
          .then((c) => {
            if (Array.isArray(c?.defaultCapabilities)) {
              this.repoCaps.set(c.defaultCapabilities.join(", "));
            }
          })
          .catch(() => undefined);
      }
    } else if (t === "branches") {
      await this.loadBranches();
    } else if (t === "releases") {
      await this.loadReleasesTab();
    } else if (t === "advanced") {
      await this.loadDeclarations();
    }
  }

  protected async loadDeclarations(): Promise<void> {
    if (!this.hasValidRepo()) return;
    const expectedRepo = this.repoSlug();
    if (
      !this.access.can(
        "GET /api/repos/{owner}/{name}/declarations",
        expectedRepo,
      )
    ) {
      return;
    }
    if (
      this.declarationsLoading() &&
      this.declarationsInFlightRepo === expectedRepo
    ) {
      return;
    }
    this.declarationsInFlightRepo = expectedRepo;
    this.declarationsLoading.set(true);
    this.declarationsError.set(null);
    try {
      const res = await this.api.get<RepoDeclarationsResponse>(
        "GET /api/repos/{owner}/{name}/declarations",
        this.params(),
      );
      if (this.repoSlug() !== expectedRepo) return;
      this.declarationsData.set(
        res && typeof res === "object"
          ? {
              ...res,
              declarations: Boolean(res.declarations),
            }
          : { declarations: false },
      );
    } catch (err) {
      if (this.repoSlug() === expectedRepo) {
        this.declarationsError.set(errText(err));
      }
    } finally {
      if (this.declarationsInFlightRepo === expectedRepo) {
        this.declarationsInFlightRepo = "";
        this.declarationsLoading.set(false);
      }
    }
  }

  private applyReleaseSettings(relCfg: Record<string, unknown> | null): void {
    if (!relCfg) return;
    if (relCfg["enabled"] !== undefined) {
      this.releaseEnabled.set(Boolean(relCfg["enabled"]));
    }
    if (Array.isArray(relCfg["baseBranchJobs"])) {
      this.baseBranchJobsText.set(
        (relCfg["baseBranchJobs"] as string[]).join(", "),
      );
    }
    if (Array.isArray(relCfg["postMergeDispatchJobs"])) {
      this.postMergeJobsText.set(
        (relCfg["postMergeDispatchJobs"] as string[]).join(", "),
      );
    }
    if (Array.isArray(relCfg["secrets"])) {
      this.releaseSecrets.set(relCfg["secrets"] as RepoReleaseSecretRow[]);
    }
    if (Array.isArray(relCfg["baseBranches"]) && relCfg["baseBranches"][0]) {
      this.baseBranch.set(String(relCfg["baseBranches"][0]));
    }
    if (Array.isArray(relCfg["pendingReleases"])) {
      this.pendingReleases.set(
        relCfg["pendingReleases"] as PendingReleaseRow[],
      );
    }
  }

  private async loadReleasesTab(): Promise<void> {
    const p = this.params();
    const repo = this.repoSlug();
    const ownershipTask = this.loadWorkOwnership();
    const releaseCfgTask = (async () => {
      if (this.access.can("GET /api/repos/{owner}/{name}/release", repo)) {
        try {
          const relCfg = await this.api.get<Record<string, unknown>>(
            "GET /api/repos/{owner}/{name}/release",
            p,
          );
          this.applyReleaseSettings(relCfg);
        } catch {
          // Non-fatal
        }
      }
    })();
    const releasesListTask = (async () => {
      if (this.access.can("GET /api/repos/{owner}/{name}/releases", repo)) {
        try {
          const list = await this.api.get<
            ReleaseRow[] | { releases?: ReleaseRow[]; items?: ReleaseRow[] }
          >("GET /api/repos/{owner}/{name}/releases", p);
          const rows = Array.isArray(list)
            ? list
            : (list?.releases ?? list?.items ?? []);
          this.releases.set(rows);
          const current = this.selectedRelease();
          const target =
            rows.find((r) => r.name === current)?.name ?? rows[0]?.name ?? "";
          this.selectedRelease.set(target);
          if (target) {
            await this.loadCandidatesFor(target);
          } else {
            this.candidates.set([]);
          }
        } catch {
          // Non-fatal
        }
      }
    })();
    await Promise.all([ownershipTask, releaseCfgTask, releasesListTask]);
  }

  protected async loadWorkOwnership(force = false): Promise<void> {
    if (!this.hasValidRepo()) return;
    const expectedRepo = this.repoSlug();
    if (
      !this.access.can(
        "GET /api/repos/{owner}/{name}/work-ownership",
        expectedRepo,
      )
    ) {
      return;
    }
    if (
      !force &&
      this.workOwnershipLoading() &&
      this.workOwnershipInFlightRepo === expectedRepo
    ) {
      return;
    }
    const readSeq = ++this.workOwnershipReadSeq;
    this.workOwnershipInFlightRepo = expectedRepo;
    this.workOwnershipLoading.set(true);
    this.workOwnershipError.set(null);
    try {
      const res = await this.api.get<unknown>(
        "GET /api/repos/{owner}/{name}/work-ownership",
        this.params(),
      );
      if (
        this.repoSlug() !== expectedRepo ||
        readSeq !== this.workOwnershipReadSeq
      ) {
        return;
      }
      const normalized = normalizeWorkOwnership(res);
      this.workOwnershipData.set(normalized);
      this.syncReleaseEnabledFromOwnership(normalized);
      this.clearBannerError("workOwnership");
    } catch (err) {
      if (
        this.repoSlug() === expectedRepo &&
        readSeq === this.workOwnershipReadSeq
      ) {
        this.workOwnershipError.set(errText(err));
      }
    } finally {
      if (
        this.workOwnershipInFlightRepo === expectedRepo &&
        readSeq === this.workOwnershipReadSeq
      ) {
        this.workOwnershipInFlightRepo = "";
        this.workOwnershipLoading.set(false);
      }
    }
  }

  protected async selectReleaseForCandidates(release: string): Promise<void> {
    this.selectedRelease.set(release);
    await this.loadCandidatesFor(release);
  }

  private async loadCandidatesFor(release: string): Promise<void> {
    if (
      !release ||
      !this.hasValidRepo() ||
      !this.access.can(
        "GET /api/repos/{owner}/{name}/releases/{release}/candidates",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      const cands = await this.api.get<
        CandidateRow[] | { candidates?: CandidateRow[]; items?: CandidateRow[] }
      >("GET /api/repos/{owner}/{name}/releases/{release}/candidates", {
        ...this.params(),
        release,
      });
      this.candidates.set(
        Array.isArray(cands)
          ? cands
          : (cands?.candidates ?? cands?.items ?? []),
      );
    } catch {
      // Non-fatal
    }
  }

  protected async saveRepoConfig(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/deployment/repos/{owner}/{name}/config",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.put(
        "PUT /api/deployment/repos/{owner}/{name}/config",
        this.params(),
        {
          cloneUrl: this.cloneUrl().trim(),
          ...(this.gitCredential()
            ? { gitCredential: this.gitCredential() }
            : {}),
        },
      );
      this.snackbar.show("Repository configuration saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async pinGitConnection(credential: string): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/deployment/repos/{owner}/{name}/git-connection",
        this.repoSlug(),
      )
    ) {
      return;
    }
    this.gitCredential.set(credential);
    try {
      await this.api.put(
        "PUT /api/deployment/repos/{owner}/{name}/git-connection",
        this.params(),
        { credential },
      );
      this.snackbar.show("Pinned Git connection");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async refreshLifecycle(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/lifecycle/refresh",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      const res = await this.api.post<{ state?: string; stage?: string }>(
        "POST /api/repos/{owner}/{name}/lifecycle/refresh",
        this.params(),
        {},
      );
      const st = res?.state ?? res?.stage;
      if (st) this.lifecycleState.set(st);
      this.snackbar.show("Lifecycle refreshed");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveIssueImportSettings(): Promise<void> {
    if (!this.canWriteSettings()) return;
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/settings",
        this.params(),
        {
          issueImportEnabled: this.importEnabled(),
          issueImportLabel: this.importLabel().trim(),
          issueImportRepo: this.importSourceRepo().trim(),
          issueImportApproved: this.importApproved(),
        },
      );
      this.snackbar.show("Issue importer settings saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async importIssues(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/import-issues",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/import-issues",
        this.params(),
        {},
      );
      this.snackbar.show("Issue import triggered");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveCiMode(ciMode: string): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can("PUT /api/repos/{owner}/{name}/ci-mode", this.repoSlug())
    ) {
      return;
    }
    const previous = this.ciMode();
    this.ciMode.set(ciMode);
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/ci-mode",
        this.params(),
        { ciMode },
      );
      this.snackbar.show(`CI mode set to ${ciMode}`);
    } catch (err) {
      // A refused mode is not the repo's mode: put the pill back on
      // what the server still has rather than leave it naming one it
      // refused.
      this.ciMode.set(previous);
      this.error.set(errText(err));
    }
  }

  protected async toggleWatchDefaultBranch(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/watch-default-branch",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const next = !this.watchDefaultBranch();
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/watch-default-branch",
        this.params(),
        { watchDefaultBranch: next },
      );
      this.watchDefaultBranch.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async triggerBaseCiRun(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/base-branch-runs",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/base-branch-runs",
        this.params(),
        { branch: this.baseBranch() || "main" },
      );
      this.snackbar.show("Triggered base-branch CI run");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected selectWorkflow(path: string): void {
    this.selectedWorkflowPath.set(path);
    const found = this.workflows().find((w) => w.path === path);
    this.workflowYaml.set(found?.text ?? "");
  }

  protected onEditWorkflowText(text: string): void {
    this.workflowYaml.set(text);
    const path = this.selectedWorkflowPath();
    this.workflows.update((list) => {
      const idx = list.findIndex((w) => w.path === path);
      if (idx < 0) return list;
      const copy = [...list];
      copy[idx] = { ...copy[idx], text };
      return copy;
    });
  }

  protected addWorkflowFile(): void {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const path = normalizeWorkflowPath(this.newWorkflowPath());
    if (!path) return;
    this.newWorkflowPath.set("");
    const existing = this.workflows().find((w) => w.path === path);
    if (existing) {
      this.selectedWorkflowPath.set(existing.path);
      this.workflowYaml.set(existing.text);
      return;
    }
    const stub = `name: ${
      path
        .split("/")
        .pop()
        ?.replace(/\.ya?ml$/, "") || "ci"
    }\n`;
    this.workflows.update((list) => [...list, { path, text: stub }]);
    this.selectedWorkflowPath.set(path);
    this.workflowYaml.set(stub);
  }

  protected async deleteSelectedWorkflow(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const target = this.selectedWorkflowPath();
    const remaining = this.workflows().filter((w) => w.path !== target);
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.params(),
        {
          workflows: remaining.map((w) => ({ path: w.path, text: w.text })),
        },
      );
      this.workflows.set(remaining);
      const next = remaining[0] ?? null;
      this.selectedWorkflowPath.set(next?.path ?? ".grain/workflows/ci.yml");
      this.workflowYaml.set(next?.text ?? "");
      this.snackbar.show(`Removed workflow ${target}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveWorkflows(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const path =
      normalizeWorkflowPath(this.selectedWorkflowPath()) ||
      ".grain/workflows/ci.yml";
    const text = this.workflowYaml();
    const current = this.workflows();
    const idx = current.findIndex((w) => w.path === path);
    let next: RepoWorkflowRow[];
    if (text.trim()) {
      if (idx >= 0) {
        next = current.map((w, i) => (i === idx ? { ...w, path, text } : w));
      } else {
        next = [...current, { path, text }];
      }
    } else {
      next = current.filter((w) => w.path !== path);
    }
    try {
      const res = await this.api.put<{ workflows?: RepoWorkflowRow[] }>(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.params(),
        {
          workflows: next.map((w) => ({ path: w.path, text: w.text })),
        },
      );
      if (Array.isArray(res?.workflows)) {
        this.workflows.set(res.workflows);
      } else {
        this.workflows.set(next);
      }
      this.snackbar.show("Workflows saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveReleaseSettings(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can("PUT /api/repos/{owner}/{name}/release", this.repoSlug())
    ) {
      return;
    }
    const parseJobs = (raw: string): string[] =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    try {
      const res = await this.api.put<Record<string, unknown>>(
        "PUT /api/repos/{owner}/{name}/release",
        this.params(),
        {
          enabled: this.releaseEnabled(),
          baseBranchJobs: parseJobs(this.baseBranchJobsText()),
          postMergeDispatchJobs: parseJobs(this.postMergeJobsText()),
        },
      );
      if (res && typeof res === "object") {
        this.applyReleaseSettings(res);
      }
      this.snackbar.show("Release settings saved");
      await this.loadWorkOwnership(true);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async toggleMergeOnGreen(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/merge-on-green",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const next = !this.mergeOnGreen();
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/merge-on-green",
        this.params(),
        { mergeOnGreen: next },
      );
      this.mergeOnGreen.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async toggleRequireUpToDate(): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/require-branch-up-to-date",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const next = !this.requireUpToDate();
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/require-branch-up-to-date",
        this.params(),
        { requireBranchUpToDate: next },
      );
      this.requireUpToDate.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async onConfirmDone(accepted: boolean): Promise<void> {
    const req = this.confirmReq();
    this.confirmReq.set(null);
    if (!accepted || !req) return;
    await req.run();
  }

  protected toggleBypassHumanGates(): void {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const next = !this.bypassHumanGates();
    if (next) {
      this.confirmReq.set(
        bypassConfirm(this.repoSlug(), () => this.saveBypassHumanGates(true)),
      );
      return;
    }
    void this.saveBypassHumanGates(false);
  }

  private async saveBypassHumanGates(next: boolean): Promise<void> {
    if (
      this.configRepoOnly() ||
      !this.hasValidRepo() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates",
        this.params(),
        { baseRepairBypassesHumanGates: next },
      );
      this.bypassHumanGates.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveAgentTabSettings(): Promise<void> {
    if (!this.canSaveRepoAgents()) return;
    const p = this.params();
    const repo = this.repoSlug();
    try {
      if (
        this.access.can("PUT /api/repos/{owner}/{name}/setup-command", repo)
      ) {
        await this.api.put("PUT /api/repos/{owner}/{name}/setup-command", p, {
          setupCommand: this.setupCommand(),
        });
      }
      if (
        this.access.can("PUT /api/repos/{owner}/{name}/prompt-extension", repo)
      ) {
        await this.api.put(
          "PUT /api/repos/{owner}/{name}/prompt-extension",
          p,
          { promptExtension: this.promptExtension() },
        );
      }
      if (this.access.can("PUT /api/repos/{owner}/{name}/capabilities", repo)) {
        const defaultCapabilities = this.repoCaps()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        await this.api.put("PUT /api/repos/{owner}/{name}/capabilities", p, {
          defaultCapabilities,
        });
      }
      this.snackbar.show("Saved repository agent settings");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async createBranch(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/branches",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const name = this.newBranchName().trim();
    if (!name) return;
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/branches",
        this.params(),
        { name, from: this.newBranchFrom().trim() || "main" },
      );
      this.newBranchName.set("");
      await this.loadBranches(true);
      this.snackbar.show(`Created branch ${name}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async createRelease(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/releases",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const name = this.newReleaseName().trim();
    if (!name) return;
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases",
        this.params(),
        { name },
      );
      this.newReleaseName.set("");
      await this.loadReleasesTab();
      this.snackbar.show(`Created release ${name}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async cutCandidate(release: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates",
        { ...this.params(), release },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Cut candidate for ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async promoteCandidate(release: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote",
        { ...this.params(), release },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Promoted candidate on ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async mergeRelease(release: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/releases/{release}/merge",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases/{release}/merge",
        { ...this.params(), release },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Merged ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async deleteRelease(release: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "DELETE /api/repos/{owner}/{name}/releases/{release}",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.delete(
        "DELETE /api/repos/{owner}/{name}/releases/{release}",
        { ...this.params(), release },
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Deleted release ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async approveQualification(id: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve",
        { ...this.params(), id },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show("Approved candidate qualification");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async triggerReleaseRun(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/release-runs",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/release-runs",
        this.params(),
        {},
      );
      this.snackbar.show("Started release workflow run");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async approvePendingRelease(version: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/approve",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/approve",
        { ...this.params(), version },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Approved release ${version}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async rejectPendingRelease(version: string): Promise<void> {
    if (
      !this.hasValidRepo() ||
      !this.access.can(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/reject",
        this.repoSlug(),
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/reject",
        { ...this.params(), version },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Rejected release ${version}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected declarationsSwitchLabel(): string {
    return `Read ${this.repoSlug()}'s own declarations`;
  }

  protected async toggleDeclarations(): Promise<void> {
    if (
      !this.hasValidRepo() ||
      this.configRepoOnly() ||
      this.declarationsSaving() ||
      !this.access.can(
        "PUT /api/repos/{owner}/{name}/declarations",
        this.repoSlug(),
      )
    ) {
      return;
    }
    const current = this.declarationsData();
    if (!current) return;
    const next = !current.declarations;
    this.declarationsSaving.set(true);
    try {
      const res = await this.api.put<RepoDeclarationsResponse>(
        "PUT /api/repos/{owner}/{name}/declarations",
        this.params(),
        { declarations: next },
      );
      if (res && typeof res === "object" && "declarations" in res) {
        this.declarationsData.set(res);
      } else {
        this.declarationsData.set({ ...current, declarations: next });
      }
      this.snackbar.show(
        next
          ? `Enabled .grain/ declarations for ${this.repoSlug()}`
          : `Disabled .grain/ declarations for ${this.repoSlug()}`,
      );
    } catch (err) {
      this.error.set(errText(err));
    } finally {
      this.declarationsSaving.set(false);
    }
  }

  protected async setWorkOwnershipDefault(state: string): Promise<void> {
    if (!this.canWriteWorkOwnership() || this.workOwnershipSaving()) return;
    const parsed = parseOwnershipState(state);
    if (parsed === null) {
      this.recordBannerError(
        "workOwnership",
        `default: "${state}" is not an ownership setting ("on", "off" or empty)`,
      );
      return;
    }
    const label = parsed === "" ? "say nothing" : parsed;
    await this.saveWorkOwnership(
      { default: parsed },
      `Updated repository work ownership default (${label})`,
    );
  }

  protected async setWorkItemOwnership(
    item: string,
    state: string,
  ): Promise<void> {
    if (!this.canWriteWorkOwnership() || this.workOwnershipSaving()) return;
    const checked = validateWorkItemId(item);
    if (checked.error) {
      this.recordBannerError("workOwnership", checked.error);
      return;
    }
    const parsed = parseOwnershipState(state);
    if (parsed === null) {
      this.recordBannerError(
        "workOwnership",
        `state: "${state}" is not an ownership setting ("on", "off" or empty)`,
      );
      return;
    }
    const label = parsed === "" ? "say nothing" : parsed;
    await this.saveWorkOwnership(
      { item: checked.id, state: parsed },
      `Updated work ownership for ${checked.id} (${label})`,
    );
  }

  private async saveWorkOwnership(
    body: { default: OwnershipState } | { item: string; state: OwnershipState },
    successNote: string,
  ): Promise<void> {
    if (!this.canWriteWorkOwnership() || this.workOwnershipSaving()) return;
    const expectedRepo = this.repoSlug();
    const token = ++this.workOwnershipSaveSeq;
    // Supersede any older in-flight GET so stale reads cannot overwrite this save.
    this.workOwnershipReadSeq++;
    this.clearBannerError("workOwnership");
    this.workOwnershipSaving.set(true);
    try {
      const res = await this.api.put<unknown>(
        "PUT /api/repos/{owner}/{name}/work-ownership",
        this.params(),
        body,
      );
      if (
        this.repoSlug() !== expectedRepo ||
        token !== this.workOwnershipSaveSeq
      ) {
        return;
      }
      if (res && typeof res === "object" && "defaultRuns" in res) {
        const normalized = normalizeWorkOwnership(res);
        this.workOwnershipData.set(normalized);
        this.workOwnershipError.set(null);
        this.syncReleaseEnabledFromOwnership(normalized);
      } else {
        await this.loadWorkOwnership(true);
      }
      this.snackbar.show(successNote);
    } catch (err) {
      if (
        this.repoSlug() === expectedRepo &&
        token === this.workOwnershipSaveSeq
      ) {
        this.recordBannerError("workOwnership", errText(err));
      }
    } finally {
      if (this.workOwnershipSaveSeq === token) {
        this.workOwnershipSaving.set(false);
      }
    }
  }

  protected async loadUnfixableChecks(force = false): Promise<void> {
    if (!this.hasValidRepo()) return;
    const expectedRepo = this.repoSlug();
    if (
      !this.access.can(
        "GET /api/repos/{owner}/{name}/unfixable-checks",
        expectedRepo,
      )
    ) {
      return;
    }
    if (
      !force &&
      this.unfixableLoading() &&
      this.unfixableInFlightRepo === expectedRepo
    ) {
      return;
    }
    const readSeq = ++this.unfixableReadSeq;
    this.unfixableInFlightRepo = expectedRepo;
    this.unfixableLoading.set(true);
    this.unfixableError.set(null);
    try {
      const res = await this.api.get<unknown>(
        "GET /api/repos/{owner}/{name}/unfixable-checks",
        this.params(),
      );
      if (
        this.repoSlug() !== expectedRepo ||
        readSeq !== this.unfixableReadSeq
      ) {
        return;
      }
      this.unfixableData.set(normalizeUnfixableChecks(res));
      this.clearBannerError("unfixable");
    } catch (err) {
      if (
        this.repoSlug() === expectedRepo &&
        readSeq === this.unfixableReadSeq
      ) {
        this.unfixableError.set(errText(err));
      }
    } finally {
      if (
        this.unfixableInFlightRepo === expectedRepo &&
        readSeq === this.unfixableReadSeq
      ) {
        this.unfixableInFlightRepo = "";
        this.unfixableLoading.set(false);
      }
    }
  }

  protected onUnfixableDraftInput(value: string): void {
    this.unfixableDraft.set(value);
    if (this.unfixableWarning() !== null) {
      this.unfixableWarning.set(null);
    }
  }

  protected async addUnfixableCheck(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canWriteUnfixableChecks() || this.unfixableSaving()) return;
    const current = this.unfixableData();
    if (!current) return;
    const name = this.unfixableDraft().trim();
    if (!name) return;

    if (sameCheckName(name, current.grainCICheckName)) {
      this.unfixableWarning.set(
        `${current.grainCICheckName} judges one exact commit on the branch, so its verdict is always that branch's own answer and declaring it here would change nothing. Grain would go on repairing it.`,
      );
      return;
    }
    if (name.includes(",")) {
      this.unfixableWarning.set(
        `${name} contains a comma, and unfixable checks are stored as a comma-separated list — name one check per entry.`,
      );
      return;
    }
    if (current.unfixableChecks.some((c) => sameCheckName(c, name))) {
      this.unfixableWarning.set(
        `${this.repoSlug()} already declares ${name} unfixable — check names are matched without case.`,
      );
      return;
    }

    const ok = await this.saveUnfixableChecks(
      [...current.unfixableChecks, name],
      `Declared ${name} unfixable`,
    );
    if (ok) {
      this.unfixableDraft.set("");
    }
  }

  protected async removeUnfixableCheck(check: string): Promise<void> {
    if (!this.canWriteUnfixableChecks() || this.unfixableSaving()) return;
    const current = this.unfixableData();
    if (!current) return;
    const next = current.unfixableChecks.filter(
      (other) => !sameCheckName(other, check),
    );
    await this.saveUnfixableChecks(
      next,
      `Stopped declaring ${check} unfixable`,
    );
  }

  private async saveUnfixableChecks(
    checks: string[],
    successNote: string,
  ): Promise<boolean> {
    if (!this.canWriteUnfixableChecks() || this.unfixableSaving()) {
      return false;
    }
    const expectedRepo = this.repoSlug();
    const token = ++this.unfixableSaveSeq;
    // Supersede any older in-flight GET so stale reads cannot overwrite this save.
    this.unfixableReadSeq++;
    this.unfixableWarning.set(null);
    this.clearBannerError("unfixable");
    this.unfixableSaving.set(true);
    try {
      const res = await this.api.put<unknown>(
        "PUT /api/repos/{owner}/{name}/unfixable-checks",
        this.params(),
        { unfixableChecks: checks },
      );
      if (this.repoSlug() !== expectedRepo || token !== this.unfixableSaveSeq) {
        return false;
      }
      if (
        res &&
        typeof res === "object" &&
        ("unfixableChecks" in res || "grainCICheckName" in res)
      ) {
        this.unfixableData.set(normalizeUnfixableChecks(res));
        this.unfixableError.set(null);
      } else {
        await this.loadUnfixableChecks(true);
      }
      this.snackbar.show(successNote);
      return true;
    } catch (err) {
      if (this.repoSlug() === expectedRepo && token === this.unfixableSaveSeq) {
        this.recordBannerError("unfixable", errText(err));
      }
      return false;
    } finally {
      if (this.unfixableSaveSeq === token) {
        this.unfixableSaving.set(false);
      }
    }
  }

  protected async loadBranches(force = false): Promise<void> {
    if (!this.hasValidRepo()) return;
    const expectedRepo = this.repoSlug();
    if (
      !this.access.can("GET /api/repos/{owner}/{name}/branches", expectedRepo)
    ) {
      return;
    }
    if (
      !force &&
      this.branchesLoading() &&
      this.branchesInFlightRepo === expectedRepo
    ) {
      return;
    }
    const readSeq = ++this.branchesReadSeq;
    this.branchesInFlightRepo = expectedRepo;
    this.branchesLoading.set(true);
    this.branchesError.set(null);
    try {
      const res = await this.api.get<BranchRow[] | { branches?: BranchRow[] }>(
        "GET /api/repos/{owner}/{name}/branches",
        this.params(),
      );
      if (
        this.repoSlug() !== expectedRepo ||
        readSeq !== this.branchesReadSeq
      ) {
        return;
      }
      this.branches.set(Array.isArray(res) ? res : (res?.branches ?? []));
      this.branchesLoaded.set(true);
    } catch (err) {
      if (
        this.repoSlug() === expectedRepo &&
        readSeq === this.branchesReadSeq
      ) {
        this.branchesError.set(errText(err));
      }
    } finally {
      if (
        this.branchesInFlightRepo === expectedRepo &&
        readSeq === this.branchesReadSeq
      ) {
        this.branchesInFlightRepo = "";
        this.branchesLoading.set(false);
      }
    }
  }

  private syncReleaseEnabledFromOwnership(
    work: RepoWorkOwnershipResponse,
  ): void {
    const releaseRow = work.items.find((i) => i.item === "release");
    if (releaseRow) {
      this.releaseEnabled.set(Boolean(releaseRow.runs));
    }
  }

  private recordBannerError(
    slot: "workOwnership" | "unfixable",
    msg: string,
  ): void {
    this.lastScopedErrors[slot] = msg;
    this.error.set(msg);
  }

  private clearBannerError(slot: "workOwnership" | "unfixable"): void {
    const prev = this.lastScopedErrors[slot];
    if (prev !== null && this.error() === prev) {
      this.error.set(null);
    }
    this.lastScopedErrors[slot] = null;
  }
}
