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

import { DOCUMENT } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  type OnDestroy,
  type OnInit,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { type RouteKey } from "../api/generated-routes";
import { routeScope } from "../api/grain-api.service";
import { runProviderQueryParams } from "../ci/ci.models";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { TaskFeedStore } from "../services/task-feed.service";
import { ViewFilter } from "../services/view-filter.service";
import { errorText } from "../sessions/session-helpers";
import { ActorChipComponent } from "../shared/actor-chip.component";
import {
  ConfirmDialogComponent,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import { DialogTrapDirective } from "../shared/dialog-trap.directive";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import { SplitController } from "../shared/split-controller";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import { CompositionViewComponent } from "./composition-view.component";
import {
  type Composition,
  type CreateScheduleRequest,
  type CreateSuiteRequest,
  type DeclarationAcceptanceView,
  type ProcessTab,
  type Recurrence,
  type RepoWorkflow,
  type Schedule,
  type Suite,
  type SuiteRun,
  type Template,
  type TemplateField,
  type UpdateScheduleRequest,
  buildSuiteRunPasses,
  describeSuiteMode,
  formatCadence,
  isEventTrigger,
  scheduleStatusBadge,
  suiteRunBadge,
  templateSourceBadge,
} from "./processes.models";
import { ProcessesStore } from "./processes.store";

const TABS: readonly { id: ProcessTab; label: string; tip: string }[] = [
  {
    id: "schedules",
    label: "Schedules & Triggers",
    tip: "Recurring schedules and GitHub/git-ref event triggers.",
  },
  {
    id: "templates",
    label: "Templates",
    tip: "Parameterized task templates across this deployment and repositories.",
  },
  {
    id: "suites",
    label: "Suites & Runs",
    tip: "Multi-template suites and live/completed suite runs.",
  },
  {
    id: "declarations",
    label: "Repo Workflows & Declarations",
    tip: "Repository .grain/ declarations, workflows, and capability acceptances.",
  },
];

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const CADENCE_KINDS: readonly { id: string; label: string }[] = [
  { id: "everyNMinutes", label: "Every N min" },
  { id: "everyNHours", label: "Every N hr" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "github_workflow_run", label: "GitHub workflow" },
  { id: "git_ref", label: "Git ref push" },
];

type SchedFilter = "all" | "active" | "paused" | "triggers" | "suppressed";
type TmplFilter = "all" | "deployment" | "declared" | "system";
type SuitesPaneView = "suites" | "runs";
type SchedFieldKey =
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

const MIN_EVERY_N_MINUTES = 10;
const MAX_EVERY_N_HOURS = 366 * 24;
const MAX_EVERY_N_MINUTES = MAX_EVERY_N_HOURS * 60;
const BRANCH_NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_BRANCH_NAME_LEN = 244;

const SCHED_FIELD_ORDER: readonly SchedFieldKey[] = [
  "templateId",
  "suiteId",
  "title",
  "repo",
  "base",
  "everyNMinutes",
  "everyNHours",
  "timeOfDay",
  "timeZone",
  "dayOfMonth",
  "triggerWorkflow",
  "gitRefRepo",
  "gitRef",
];

const SCHED_TARGET_FIELDS: readonly SchedFieldKey[] = [
  "templateId",
  "suiteId",
  "title",
  "base",
];

const SCHED_CADENCE_FIELDS: readonly SchedFieldKey[] = [
  "everyNMinutes",
  "everyNHours",
  "timeOfDay",
  "timeZone",
  "dayOfMonth",
  "triggerWorkflow",
  "gitRefRepo",
  "gitRef",
];

const SCHED_FIELD_TESTIDS: Record<SchedFieldKey, string> = {
  templateId: "sched-template-picker",
  suiteId: "sched-suite-picker",
  title: "sched-title-input",
  repo: "sched-repo-input",
  base: "sched-base-input",
  everyNMinutes: "sched-every-min-input",
  everyNHours: "sched-every-hr-input",
  timeOfDay: "sched-time-input",
  timeZone: "sched-tz-input",
  dayOfMonth: "sched-day-of-month-input",
  triggerWorkflow: "sched-trigger-workflow-input",
  gitRefRepo: "sched-git-ref-repo-input",
  gitRef: "sched-git-ref-input",
};

function validRepoSegment(s: string): boolean {
  if (!s || s === "." || s === "..") return false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
    if ("/\\:?#@[]%~^".includes(ch)) return false;
  }
  return true;
}

function isValidRepoSpec(raw: string): boolean {
  let spec = raw.trim();
  if (!spec) return false;
  let hostGiven = false;
  const at = spec.indexOf("@");
  if (at >= 0 && !spec.includes("://")) {
    const colon = spec.indexOf(":", at);
    if (colon >= 0) {
      hostGiven = true;
      spec = spec.slice(colon + 1);
    }
  }
  const scheme = spec.indexOf("://");
  if (scheme >= 0) {
    spec = spec.slice(scheme + 3);
    const slash = spec.indexOf("/");
    spec = slash >= 0 ? spec.slice(slash + 1) : "";
    hostGiven = true;
  }
  spec = spec.replace(/^\/+|\/+$/g, "");
  if (spec.endsWith(".git")) spec = spec.slice(0, -4);
  spec = spec.replace(/^\/+|\/+$/g, "");
  if (!hostGiven) {
    const slash = spec.indexOf("/");
    if (slash >= 0) {
      const first = spec.slice(0, slash);
      if (first.includes(".") || first.includes(":")) {
        hostGiven = true;
        spec = spec.slice(slash + 1);
      }
    }
  }
  const slash = spec.indexOf("/");
  if (slash < 0) return false;
  return (
    validRepoSegment(spec.slice(0, slash)) &&
    validRepoSegment(spec.slice(slash + 1))
  );
}

function isValidBranchName(raw: string): boolean {
  if (!raw || raw.length > MAX_BRANCH_NAME_LEN) return false;
  if (!BRANCH_NAME_SAFE.test(raw)) return false;
  if (
    raw.includes("..") ||
    raw.includes("//") ||
    raw.endsWith("/") ||
    raw.endsWith(".")
  ) {
    return false;
  }
  return raw
    .split("/")
    .every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function isValidTimeOfDay(raw: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(raw.trim());
}

function isValidTimeZone(raw: string): boolean {
  const tz = raw.trim();
  if (!tz || tz === "UTC") return true;
  if (tz === "Local") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseStrictInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

function isValidGitRef(raw: string): boolean {
  const ref = raw.trim();
  if (!ref.startsWith("refs/") || ref.length <= "refs/".length) return false;
  return !(/[\s^~:?*[\\]/.test(ref) || ref.includes("..") || ref.endsWith("/"));
}

@Component({
  selector: "g-processes-page",
  imports: [
    RouterLink,
    TipDirective,
    StatusIconComponent,
    ActorChipComponent,
    ConfirmDialogComponent,
    CompositionViewComponent,
    DialogTrapDirective,
    PillSelectComponent,
  ],
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    "../shared/work-surface.css",
    "../shared/pill-select.css",
    "../inbox/inbox-queue.css",
    "../ci/ci-list.css",
    "./processes-list.css",
    "./processes-detail.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="view-panel is-active"
      aria-labelledby="processes-headline"
      [attr.inert]="modalOpen() ? '' : null"
    >
      <div class="stage-header">
        <div class="view-headline-row">
          <h1
            class="view-headline"
            id="processes-headline"
            data-testid="processes-headline"
          >
            Processes
          </h1>
          <div class="headline-actions">
            @switch (activeTab()) {
              @case ("schedules") {
                @if (access.can("POST /api/schedules")) {
                  <button
                    type="button"
                    class="btn-primary"
                    data-testid="proc-new-schedule-btn"
                    (click)="openScheduleDialog(null)"
                  >
                    New schedule
                  </button>
                }
              }
              @case ("templates") {
                @if (
                  store.templates().length > 0 && canOpenLaunchTemplateDialog()
                ) {
                  <button
                    type="button"
                    class="btn-tonal"
                    data-testid="proc-launch-template-btn"
                    (click)="openLaunchTemplateDialog(selectedTemplate())"
                  >
                    Launch from template
                  </button>
                }
                @if (access.can("POST /api/templates")) {
                  <button
                    type="button"
                    class="btn-primary"
                    data-testid="proc-new-template-btn"
                    (click)="openTemplateDialog(null)"
                  >
                    New template
                  </button>
                }
              }
              @case ("suites") {
                @if (store.suites().length > 0 && canOpenRunSuiteDialog()) {
                  <button
                    type="button"
                    class="btn-tonal"
                    data-testid="proc-run-suite-btn"
                    (click)="openRunSuiteDialog(selectedSuite())"
                  >
                    Run suite
                  </button>
                }
                @if (canGlobalRoute("POST /api/suites")) {
                  <button
                    type="button"
                    class="btn-primary"
                    data-testid="proc-new-suite-btn"
                    (click)="openSuiteDialog(null)"
                  >
                    New suite
                  </button>
                }
              }
            }
          </div>
        </div>
        <p class="view-subtitle">
          Standing schedules, event triggers, reusable templates, multi-pass
          suites, and repository <code>.grain/</code> declarations.
        </p>

        <nav class="tab-strip" aria-label="Process sections">
          @for (t of tabs; track t.id) {
            <a
              class="tab-link"
              [routerLink]="['/processes', t.id]"
              [attr.aria-current]="activeTab() === t.id ? 'page' : null"
              [attr.data-testid]="'proc-tab-' + t.id"
              [gTip]="t.tip"
            >
              {{ t.label }}
              <span
                class="tab-count tabular"
                [class.warn]="
                  t.id === 'declarations' &&
                  store.awaitingAcceptancesCount() > 0
                "
                >{{ tabCount(t.id) }}</span
              >
            </a>
          }
        </nav>
      </div>

      @if (store.loadError(); as err) {
        <p
          class="banner banner-error"
          role="alert"
          data-testid="proc-load-error"
        >
          {{ err }}
        </p>
      }
      @if (store.actionError(); as err) {
        <p
          class="banner banner-error"
          role="alert"
          data-testid="proc-action-error"
        >
          {{ err }}
          <button
            type="button"
            class="btn-text"
            (click)="store.actionError.set(null)"
          >
            Dismiss
          </button>
        </p>
      }

      <div
        class="inbox-split proc-split"
        #split
        [class.is-collapsed]="sp.collapsed()"
        [class.is-dragging]="sp.dragging()"
        [class.has-mobile-detail]="mobileDetailOpen()"
        [style.--queue-w.%]="sp.ratioExact()"
      >
        <!-- LEFT LIST PANE -->
        <section
          class="queue-pane"
          aria-label="Process items"
          data-testid="proc-list-pane"
        >
          @switch (activeTab()) {
            @case ("schedules") {
              <div
                class="proc-subbar"
                role="toolbar"
                aria-label="Schedule filter"
              >
                @for (sf of schedFilters; track sf.id) {
                  <button
                    type="button"
                    class="filter-chip"
                    [attr.aria-pressed]="schedFilter() === sf.id"
                    [attr.data-testid]="'sched-filter-' + sf.id"
                    (click)="schedFilter.set(sf.id)"
                  >
                    {{ sf.label }}
                  </button>
                }
              </div>
              @if (store.loaded() && filteredSchedules().length === 0) {
                <div class="empty-state" data-testid="schedules-empty">
                  <p>No schedules or event triggers match this view.</p>
                </div>
              } @else {
                <ul class="proc-list">
                  @for (s of filteredSchedules(); track s.id) {
                    @let badge = schedBadge(s);
                    <li class="proc-li">
                      <button
                        type="button"
                        class="proc-row"
                        [class.is-selected]="selectedScheduleId() === s.id"
                        [attr.aria-current]="
                          selectedScheduleId() === s.id ? 'true' : null
                        "
                        [attr.data-testid]="'sched-row-' + s.id"
                        (click)="selectSchedule(s.id, true)"
                        (keydown.space)="
                          selectSchedule(s.id, true); $event.preventDefault()
                        "
                      >
                        <div class="proc-row-top">
                          <span [class]="'status-pill ' + badge.tone">
                            <g-status-icon
                              [tone]="badge.tone"
                              [kind]="badge.iconKind"
                            />
                            {{ badge.label }}
                          </span>
                          <span class="proc-row-title">{{
                            s.title || s.templateName || s.suiteName || s.id
                          }}</span>
                          @if (isTrigger(s)) {
                            <span class="ci-provider-tag">Trigger</span>
                          }
                          @if (s.declaredIn) {
                            <span class="ci-provider-tag">.grain</span>
                          }
                        </div>
                        <div class="proc-row-sub">
                          <span>{{ cadenceOf(s.recurrence, s.timeZone) }}</span>
                          @if (s.repo) {
                            <span class="tabular">· {{ s.repo }}</span>
                          }
                          <span>· overlap: {{ s.overlap || "skip" }}</span>
                        </div>
                      </button>
                    </li>
                  }
                </ul>
              }
            }

            @case ("templates") {
              <div
                class="proc-subbar"
                role="toolbar"
                aria-label="Template filter"
              >
                @for (tf of tmplFilters; track tf.id) {
                  <button
                    type="button"
                    class="filter-chip"
                    [attr.aria-pressed]="tmplFilter() === tf.id"
                    [attr.data-testid]="'tmpl-filter-' + tf.id"
                    (click)="tmplFilter.set(tf.id)"
                  >
                    {{ tf.label }}
                  </button>
                }
              </div>
              @if (store.loaded() && filteredTemplates().length === 0) {
                <div class="empty-state" data-testid="templates-empty">
                  <p>No task templates match this filter.</p>
                </div>
              } @else {
                <ul class="proc-list">
                  @for (t of filteredTemplates(); track t.id) {
                    @let badge = tmplBadge(t);
                    <li class="proc-li">
                      <button
                        type="button"
                        class="proc-row"
                        [class.is-selected]="selectedTemplateId() === t.id"
                        [attr.aria-current]="
                          selectedTemplateId() === t.id ? 'true' : null
                        "
                        [attr.data-testid]="'tmpl-row-' + t.id"
                        (click)="selectTemplate(t.id, true)"
                        (keydown.space)="
                          selectTemplate(t.id, true); $event.preventDefault()
                        "
                      >
                        <div class="proc-row-top">
                          <span [class]="'status-pill ' + badge.tone">
                            <g-status-icon
                              [tone]="badge.tone"
                              [kind]="badge.iconKind"
                            />
                            {{ badge.label }}
                          </span>
                          <span class="proc-row-title">{{
                            t.name || t.title || t.id
                          }}</span>
                          @if ((t.fields ?? []).length > 0) {
                            <span class="ci-provider-tag tabular"
                              >{{ (t.fields ?? []).length }} params</span
                            >
                          }
                        </div>
                        <div class="proc-row-sub">
                          <span>{{ t.title }}</span>
                          @if (t.declaredIn) {
                            <span class="tabular"
                              >· {{ t.declaredIn.repo }} ({{
                                t.declaredIn.path
                              }})</span
                            >
                          } @else if (t.repo) {
                            <span class="tabular">· bound to {{ t.repo }}</span>
                          }
                        </div>
                      </button>
                    </li>
                  }
                </ul>
              }
            }

            @case ("suites") {
              <div class="proc-subbar" role="toolbar" aria-label="Suites view">
                <div class="segmented" role="group" aria-label="Suites or runs">
                  <button
                    type="button"
                    data-testid="suites-subview-suites"
                    [attr.aria-pressed]="suitesView() === 'suites'"
                    (click)="suitesView.set('suites')"
                  >
                    Suites ({{ filteredSuites().length }})
                  </button>
                  <button
                    type="button"
                    data-testid="suites-subview-runs"
                    [attr.aria-pressed]="suitesView() === 'runs'"
                    (click)="suitesView.set('runs')"
                  >
                    Suite runs ({{ filteredSuiteRuns().length }})
                  </button>
                </div>
              </div>

              @if (suitesView() === "suites") {
                @if (store.loaded() && filteredSuites().length === 0) {
                  <div class="empty-state" data-testid="suites-empty">
                    <p>No suites configured yet.</p>
                  </div>
                } @else {
                  <ul class="proc-list">
                    @for (st of filteredSuites(); track st.id) {
                      <li class="proc-li">
                        <button
                          type="button"
                          class="proc-row"
                          [class.is-selected]="
                            selectedSuiteRunId() === null &&
                            selectedSuiteId() === st.id
                          "
                          [attr.aria-current]="
                            selectedSuiteRunId() === null &&
                            selectedSuiteId() === st.id
                              ? 'true'
                              : null
                          "
                          [attr.data-testid]="'suite-row-' + st.id"
                          (click)="selectSuite(st.id, true)"
                          (keydown.space)="
                            selectSuite(st.id, true); $event.preventDefault()
                          "
                        >
                          <div class="proc-row-top">
                            <span class="status-pill proposal">
                              <g-status-icon tone="proposal" kind="proposal" />
                              {{ suiteModeOf(st.mode, st.count, st.maxPasses) }}
                            </span>
                            <span class="proc-row-title">{{ st.name }}</span>
                            @if (st.declaredIn) {
                              <span class="ci-provider-tag">.grain</span>
                            }
                          </div>
                          <div class="proc-row-sub">
                            <span class="tabular"
                              >{{ st.items.length }} templates</span
                            >
                            @if (st.autoMerge) {
                              <span>· auto-merge</span>
                            }
                            @if (st.requireApproval) {
                              <span>· requires approval</span>
                            }
                          </div>
                        </button>
                      </li>
                    }
                  </ul>
                }
              } @else {
                @if (store.loaded() && filteredSuiteRuns().length === 0) {
                  <div class="empty-state" data-testid="suite-runs-empty">
                    <p>No suite runs recorded yet.</p>
                  </div>
                } @else {
                  <ul class="proc-list">
                    @for (sr of filteredSuiteRuns(); track sr.id) {
                      @let rBadge = runBadgeOf(sr.status);
                      <li class="proc-li">
                        <button
                          type="button"
                          class="proc-row"
                          [class.is-selected]="selectedSuiteRunId() === sr.id"
                          [attr.aria-current]="
                            selectedSuiteRunId() === sr.id ? 'true' : null
                          "
                          [attr.data-testid]="'suite-run-row-' + sr.id"
                          (click)="selectSuiteRun(sr.id, true)"
                          (keydown.space)="
                            selectSuiteRun(sr.id, true); $event.preventDefault()
                          "
                        >
                          <div class="proc-row-top">
                            <span [class]="'status-pill ' + rBadge.tone">
                              <g-status-icon
                                [tone]="rBadge.tone"
                                [kind]="rBadge.iconKind"
                              />
                              {{ rBadge.label }}
                            </span>
                            <span class="proc-row-title"
                              >{{ sr.suiteName || sr.suiteId }} #{{
                                sr.id
                              }}</span
                            >
                            @if (sr.pass > 0) {
                              <span class="ci-provider-tag tabular"
                                >Pass {{ sr.pass }}</span
                              >
                            }
                          </div>
                          <div class="proc-row-sub">
                            <span class="tabular"
                              >{{ sr.repo }} &#64;
                              {{ sr.base || "default" }}</span
                            >
                            <span class="tabular"
                              >·
                              {{ sr.taskCount ?? sr.tasks?.length ?? 0 }}
                              tasks</span
                            >
                          </div>
                        </button>
                      </li>
                    }
                  </ul>
                }
              }
            }

            @case ("declarations") {
              @if (
                store.knownRepos().length === 0 &&
                store.acceptances().length === 0
              ) {
                <div class="empty-state" data-testid="declarations-empty">
                  <p>No repositories or .grain/ declarations discovered yet.</p>
                </div>
              } @else {
                <ul class="proc-list">
                  @for (repo of filteredDeclRepos(); track repo) {
                    @let pendingCount = repoPendingAcceptances(repo);
                    <li class="proc-li">
                      <button
                        type="button"
                        class="proc-row"
                        [class.is-selected]="selectedDeclRepo() === repo"
                        [attr.aria-current]="
                          selectedDeclRepo() === repo ? 'true' : null
                        "
                        [attr.data-testid]="'decl-repo-row-' + repo"
                        (click)="selectDeclRepo(repo, true)"
                        (keydown.space)="
                          selectDeclRepo(repo, true); $event.preventDefault()
                        "
                      >
                        <div class="proc-row-top">
                          <span
                            [class]="
                              pendingCount > 0
                                ? 'status-pill blast'
                                : 'status-pill healthy'
                            "
                          >
                            <g-status-icon
                              [tone]="pendingCount > 0 ? 'blast' : 'healthy'"
                              [kind]="pendingCount > 0 ? 'blast' : 'healthy'"
                            />
                            {{
                              pendingCount > 0
                                ? pendingCount + " awaiting acceptance"
                                : "Synced"
                            }}
                          </span>
                          <span class="proc-row-title tabular">{{ repo }}</span>
                        </div>
                        <div class="proc-row-sub">
                          @if (store.repoDefaults()[repo]; as def) {
                            <span>
                              .grain declarations:
                              {{ def.declarations ? "enabled" : "disabled" }}
                            </span>
                            @if (def.declarationsStatus?.error) {
                              <span style="color: var(--md-sys-color-error)"
                                >· sync error</span
                              >
                            }
                          } @else {
                            <span
                              >Inspect .grain/ declarations & workflows</span
                            >
                          }
                        </div>
                      </button>
                    </li>
                  }
                </ul>
              }
            }
          }
        </section>

        <!-- RESIZER -->
        <div
          class="inbox-resizer"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Resize process list and inspector"
          [attr.aria-valuenow]="sp.ratioPct()"
          [attr.aria-valuemin]="sp.minPct()"
          [attr.aria-valuemax]="sp.maxPct()"
          (pointerdown)="sp.onResizeStart($event)"
          (pointermove)="sp.onResizeMove($event)"
          (pointerup)="sp.onResizeEnd($event)"
          (pointercancel)="sp.onResizeCancel()"
          (dblclick)="sp.reset()"
          (keydown)="sp.onKey($event)"
        >
          <span class="inbox-resizer-pill" aria-hidden="true"></span>
        </div>

        <!-- RIGHT DETAIL PANE -->
        <section
          class="proc-inspector"
          aria-label="Process detail inspector"
          data-testid="proc-inspector"
          tabindex="0"
        >
          @switch (activeTab()) {
            @case ("schedules") {
              @if (selectedSchedule(); as s) {
                @let badge = schedBadge(s);
                <div class="proc-insp-head">
                  <div class="proc-insp-top">
                    <div class="headline-cluster">
                      <button
                        type="button"
                        class="btn-text proc-mobile-back"
                        (click)="mobileDetailOpen.set(false)"
                      >
                        ← Back
                      </button>
                      <span [class]="'status-pill ' + badge.tone">
                        <g-status-icon
                          [tone]="badge.tone"
                          [kind]="badge.iconKind"
                        />
                        {{ badge.label }}
                      </span>
                      <h2
                        class="proc-insp-title"
                        data-testid="sched-detail-title"
                      >
                        {{ s.title || s.templateName || s.suiteName || s.id }}
                      </h2>
                    </div>

                    <div class="headline-actions">
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="sched-run-now-btn"
                        [disabled]="
                          !canGlobalRoute('POST /api/schedules/{id}/run')
                        "
                        [gTip]="
                          globalDeniedReason(
                            'POST /api/schedules/{id}/run',
                            'Running a schedule'
                          ) || 'Fire this schedule immediately.'
                        "
                        (click)="runScheduleNow(s)"
                      >
                        Run now
                      </button>
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="sched-toggle-enabled-btn"
                        [disabled]="
                          !!s.declaredIn ||
                          !canGlobalRoute('PATCH /api/schedules/{id}')
                        "
                        [gTip]="
                          s.declaredIn
                            ? 'Declared in ' +
                              s.declaredIn.path +
                              ' — edit in repository.'
                            : globalDeniedReason(
                                'PATCH /api/schedules/{id}',
                                s.enabled
                                  ? 'Pausing a schedule'
                                  : 'Resuming a schedule'
                              )
                        "
                        (click)="toggleScheduleEnabled(s)"
                      >
                        {{ s.enabled ? "Pause" : "Resume" }}
                      </button>
                      @if (!s.declaredIn) {
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="sched-edit-btn"
                          [disabled]="
                            !canGlobalRoute('PATCH /api/schedules/{id}')
                          "
                          [gTip]="
                            globalDeniedReason(
                              'PATCH /api/schedules/{id}',
                              'Editing a schedule'
                            )
                          "
                          (click)="openScheduleDialog(s)"
                        >
                          Edit
                        </button>
                      }
                      @if (!s.declaredIn && !s.system) {
                        <button
                          type="button"
                          class="btn-text danger"
                          data-testid="sched-delete-btn"
                          [disabled]="
                            !canGlobalRoute('DELETE /api/schedules/{id}')
                          "
                          [gTip]="
                            globalDeniedReason(
                              'DELETE /api/schedules/{id}',
                              'Deleting a schedule'
                            )
                          "
                          (click)="confirmDeleteSchedule(s)"
                        >
                          Delete
                        </button>
                      }
                    </div>
                  </div>

                  <div class="proc-meta-row">
                    <g-actor-chip
                      [label]="s.source || 'deployment'"
                      [kind]="s.system ? 'grain' : 'service'"
                    />
                    <span>{{ cadenceOf(s.recurrence, s.timeZone) }}</span>
                    @if (s.repo) {
                      <span class="tabular"
                        >Repo: <strong>{{ s.repo }}</strong>
                        {{ s.base ? "@ " + s.base : "" }}</span
                      >
                    }
                    <span
                      >Overlap: <strong>{{ s.overlap || "skip" }}</strong></span
                    >
                    @if (s.nextRunAt) {
                      <span class="tabular">Next: {{ s.nextRunAt }}</span>
                    }
                    @if (s.lastRunAt) {
                      <span class="tabular">Last: {{ s.lastRunAt }}</span>
                    }
                  </div>

                  @if (s.declaredIn) {
                    <p class="banner banner-info" style="margin: 6px 0 0">
                      Declared in <code>{{ s.declaredIn.repo }}</code> at
                      <code>{{ s.declaredIn.path }}</code
                      >. Update that file in git to modify this schedule.
                    </p>
                  }
                  @if (s.suppressed; as sup) {
                    <div class="banner banner-error" style="margin: 6px 0 0">
                      Suppressed ({{ sup.reason }}):
                      {{ sup.detail || "Previous firing is still open." }}
                      @if (sup.taskId) {
                        —
                        <a [routerLink]="['/task', sup.taskId]"
                          >Open task #{{ sup.taskId }}</a
                        >
                      }
                    </div>
                  }
                </div>

                @if (s.description) {
                  <div class="proc-card">
                    <h3 class="section-title">Prompt / instructions</h3>
                    <div class="proc-prompt-well">{{ s.description }}</div>
                  </div>
                }

                <g-composition-view [composition]="scheduleComposition()" />

                <div class="proc-card">
                  <h3 class="section-title">Recent fired tasks & skips</h3>
                  @if (s.lastWorkflowRun; as lwr) {
                    <div class="proc-kv-item">
                      <span>
                        Workflow run
                        @if (lwr.runId) {
                          <a
                            [routerLink]="['/ci', 'runs', lwr.runId]"
                            [queryParams]="workflowRunQueryParams(lwr.runId)"
                            >{{ lwr.runId }}</a
                          >
                        }
                        ({{ lwr.conclusion || "running" }})
                      </span>
                      @if (lwr.reviewTaskId) {
                        <a [routerLink]="['/task', lwr.reviewTaskId]"
                          >Review #{{ lwr.reviewTaskId }}</a
                        >
                      }
                    </div>
                  }
                  @if (scheduledTasksFor(s).length > 0) {
                    <ul class="proc-kv-list">
                      @for (t of scheduledTasksFor(s); track t.id) {
                        <li class="proc-kv-item">
                          <a [routerLink]="['/task', t.id]"
                            >#{{ t.id }} · {{ t.title }}</a
                          >
                          <span class="ci-provider-tag">{{ t.state }}</span>
                        </li>
                      }
                    </ul>
                  } @else if (
                    (s.skips ?? []).length === 0 && !s.lastWorkflowRun
                  ) {
                    <p class="muted" style="margin: 0">
                      No recent fired tasks in the active feed.
                    </p>
                  }
                  @for (sk of (s.skips ?? []).slice(0, 5); track sk.at) {
                    <div class="proc-kv-item">
                      <span class="muted">{{ sk.summary }}</span>
                      @if (sk.taskId) {
                        <a [routerLink]="['/task', sk.taskId]"
                          >#{{ sk.taskId }}</a
                        >
                      }
                    </div>
                  }
                </div>
              } @else {
                <div class="empty-state">
                  <p>
                    Select a schedule or event trigger to inspect its cadence
                    and composition.
                  </p>
                </div>
              }
            }

            @case ("templates") {
              @if (selectedTemplate(); as t) {
                @let badge = tmplBadge(t);
                <div class="proc-insp-head">
                  <div class="proc-insp-top">
                    <div class="headline-cluster">
                      <button
                        type="button"
                        class="btn-text proc-mobile-back"
                        (click)="mobileDetailOpen.set(false)"
                      >
                        ← Back
                      </button>
                      <span [class]="'status-pill ' + badge.tone">
                        <g-status-icon
                          [tone]="badge.tone"
                          [kind]="badge.iconKind"
                        />
                        {{ badge.label }}
                      </span>
                      <h2
                        class="proc-insp-title"
                        data-testid="tmpl-detail-title"
                      >
                        {{ t.name || t.title }}
                      </h2>
                    </div>

                    <div class="headline-actions">
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="tmpl-launch-btn"
                        [disabled]="!store.canLaunchTemplate(t)"
                        [gTip]="launchTemplateDeniedReason(t)"
                        (click)="openLaunchTemplateDialog(t)"
                      >
                        Launch task
                      </button>
                      @if (!t.declaredIn && !t.system) {
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="tmpl-edit-btn"
                          [disabled]="
                            !canGlobalRoute('PATCH /api/templates/{id}')
                          "
                          [gTip]="
                            globalDeniedReason(
                              'PATCH /api/templates/{id}',
                              'Editing a template'
                            )
                          "
                          (click)="openTemplateDialog(t)"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          class="btn-text danger"
                          data-testid="tmpl-delete-btn"
                          [disabled]="
                            !canGlobalRoute('DELETE /api/templates/{id}')
                          "
                          [gTip]="
                            globalDeniedReason(
                              'DELETE /api/templates/{id}',
                              'Deleting a template'
                            )
                          "
                          (click)="confirmDeleteTemplate(t)"
                        >
                          Delete
                        </button>
                      }
                    </div>
                  </div>

                  <div class="proc-meta-row">
                    <g-actor-chip
                      [label]="
                        t.declaredIn?.repo ||
                        (t.system ? 'grain' : 'deployment')
                      "
                      [kind]="t.system ? 'grain' : 'service'"
                    />
                    <span
                      >Task title: <strong>{{ t.title }}</strong></span
                    >
                    @if (t.repo) {
                      <span class="tabular"
                        >Bound to {{ t.repo
                        }}{{ t.base ? " @ " + t.base : "" }}</span
                      >
                    }
                    <span>Auto-merge: {{ t.autoMerge ? "on" : "off" }}</span>
                  </div>

                  @if (t.declaredIn) {
                    <p
                      class="banner banner-info"
                      style="margin: 6px 0 0"
                      data-testid="tmpl-declared-banner"
                    >
                      Repo-declared read-only template from
                      <code>{{ t.declaredIn.repo }}</code> (<code>{{
                        t.declaredIn.path
                      }}</code
                      >). Launching uses
                      <code>POST /api/tasks/from-template</code>.
                    </p>
                  }
                </div>

                @if ((t.fields ?? []).length > 0) {
                  <div class="proc-card" data-testid="tmpl-fields-schema">
                    <h3 class="section-title">
                      Parameter schema ({{ (t.fields ?? []).length }})
                    </h3>
                    <ul class="proc-kv-list">
                      @for (f of t.fields ?? []; track f.name) {
                        <li class="proc-kv-item">
                          <div>
                            <code class="tabular"
                              >{{ "{{" + f.name + "}}" }}</code
                            >
                            @if (f.label) {
                              <span> · {{ f.label }}</span>
                            }
                            @if (f.required) {
                              <span class="ci-provider-tag">required</span>
                            }
                          </div>
                          <span class="muted">
                            @if ((f.options ?? []).length > 0) {
                              options: {{ (f.options ?? []).join(", ") }}
                            } @else if (f.default) {
                              default: "{{ f.default }}"
                            } @else {
                              string
                            }
                          </span>
                        </li>
                      }
                    </ul>
                  </div>
                }

                <div class="proc-card">
                  <h3 class="section-title">Prompt preview</h3>
                  <div
                    class="proc-prompt-well"
                    data-testid="tmpl-prompt-preview"
                  >
                    {{ t.description || "(empty prompt body)" }}
                  </div>
                </div>

                <g-composition-view [composition]="templateComposition()" />
              } @else {
                <div class="empty-state">
                  <p>
                    Select a template to inspect its parameter schema and
                    prompt.
                  </p>
                </div>
              }
            }

            @case ("suites") {
              @if (selectedSuiteRun(); as sr) {
                @let rBadge = runBadgeOf(sr.status);
                <div class="proc-insp-head" data-testid="suite-run-inspector">
                  <div class="proc-insp-top">
                    <div class="headline-cluster">
                      <button
                        type="button"
                        class="btn-text proc-mobile-back"
                        (click)="mobileDetailOpen.set(false)"
                      >
                        ← Back
                      </button>
                      <span [class]="'status-pill ' + rBadge.tone">
                        <g-status-icon
                          [tone]="rBadge.tone"
                          [kind]="rBadge.iconKind"
                        />
                        {{ rBadge.label }}
                      </span>
                      <h2 class="proc-insp-title">
                        {{ sr.suiteName || sr.suiteId }} · Run #{{ sr.id }}
                      </h2>
                    </div>

                    <div class="headline-actions">
                      <button
                        type="button"
                        class="btn-tonal"
                        (click)="selectSuite(sr.suiteId, false)"
                      >
                        Inspect suite definition
                      </button>
                      @if (sr.status === "active" && hasOpenSuiteTasks(sr)) {
                        <button
                          type="button"
                          class="btn-tonal danger"
                          data-testid="suite-run-cancel-btn"
                          [disabled]="!canCancelSuiteRun(sr)"
                          [gTip]="cancelSuiteRunDeniedReason(sr)"
                          (click)="confirmCancelSuiteRun(sr)"
                        >
                          Cancel suite run
                        </button>
                      }
                    </div>
                  </div>

                  <div class="proc-meta-row">
                    <span class="tabular"
                      >Target: <strong>{{ sr.repo }}</strong> &#64;
                      {{ sr.base || "default" }}</span
                    >
                    <span
                      >{{ suiteModeOf(sr.mode, sr.count, sr.maxPasses) }}
                      @if (sr.pass > 0) {
                        ·
                        {{
                          sr.status === "active" ? "currently on" : "ended on"
                        }}
                        pass {{ sr.pass }}
                      } @else {
                        ·
                        {{
                          sr.status === "active"
                            ? "no pass filed yet"
                            : "ended without filing a pass"
                        }}
                      }
                    </span>
                    @if (sr.scheduleId) {
                      <span>Started by schedule {{ sr.scheduleId }}</span>
                    }
                  </div>
                  @if (sr.error) {
                    <p class="banner banner-error" style="margin: 6px 0 0">
                      {{ sr.error }}
                    </p>
                  }
                </div>

                @for (p of passesForRun(sr); track p.pass) {
                  <div
                    class="proc-card"
                    [attr.data-testid]="'suite-pass-' + p.pass"
                  >
                    <h3 class="section-title">
                      Pass {{ p.pass }}
                      <span class="muted tabular"
                        >({{ p.items.length }} tasks)</span
                      >
                    </h3>
                    <ul class="proc-kv-list">
                      @for (item of p.items; track item.entry.taskId) {
                        <li class="proc-kv-item">
                          <div>
                            <a
                              [routerLink]="['/task', item.entry.taskId]"
                              [attr.data-testid]="
                                'suite-task-link-' + item.entry.taskId
                              "
                              >#{{ item.entry.taskId }} · {{ item.title }}</a
                            >
                            @if (item.entry.openedPullRequest) {
                              <span class="ci-provider-tag">PR opened</span>
                            }
                            @for (ch of item.spawned; track ch.id) {
                              <div class="muted" style="margin-top: 4px">
                                ↳ Spawned
                                <a [routerLink]="['/task', ch.id]"
                                  >#{{ ch.id }} {{ ch.title }}</a
                                >
                                ({{ ch.state }})
                              </div>
                            }
                          </div>
                          <span class="ci-provider-tag">{{
                            item.liveState
                          }}</span>
                        </li>
                      }
                    </ul>
                  </div>
                }
              } @else if (selectedSuite()) {
                @let st = selectedSuite()!;
                <div class="proc-insp-head" data-testid="suite-inspector">
                  <div class="proc-insp-top">
                    <div class="headline-cluster">
                      <button
                        type="button"
                        class="btn-text proc-mobile-back"
                        (click)="mobileDetailOpen.set(false)"
                      >
                        ← Back
                      </button>
                      <span class="status-pill proposal">
                        <g-status-icon tone="proposal" kind="proposal" />
                        {{ suiteModeOf(st.mode, st.count, st.maxPasses) }}
                      </span>
                      <h2
                        class="proc-insp-title"
                        data-testid="suite-detail-title"
                      >
                        {{ st.name }}
                      </h2>
                    </div>

                    <div class="headline-actions">
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="suite-open-run-dialog-btn"
                        [disabled]="!canRunSuite(st)"
                        [gTip]="runSuiteDeniedReason(st)"
                        (click)="openRunSuiteDialog(st)"
                      >
                        Run suite
                      </button>
                      @if (!st.declaredIn) {
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="suite-edit-btn"
                          [disabled]="!canGlobalRoute('PATCH /api/suites/{id}')"
                          [gTip]="
                            globalDeniedReason(
                              'PATCH /api/suites/{id}',
                              'Editing a suite'
                            )
                          "
                          (click)="openSuiteDialog(st)"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          class="btn-text danger"
                          data-testid="suite-delete-btn"
                          [disabled]="
                            !canGlobalRoute('DELETE /api/suites/{id}')
                          "
                          [gTip]="
                            globalDeniedReason(
                              'DELETE /api/suites/{id}',
                              'Deleting a suite'
                            )
                          "
                          (click)="confirmDeleteSuite(st)"
                        >
                          Delete
                        </button>
                      }
                    </div>
                  </div>

                  <div class="proc-meta-row">
                    <g-actor-chip
                      [label]="st.declaredIn?.repo || 'deployment'"
                      kind="service"
                    />
                    <span
                      >Auto-merge:
                      <strong>{{ st.autoMerge ? "on" : "off" }}</strong></span
                    >
                    <span
                      >Approval:
                      <strong>{{
                        st.requireApproval
                          ? "each pass waits for approval"
                          : "auto-approved"
                      }}</strong></span
                    >
                  </div>
                  @if (st.declaredIn) {
                    <p class="banner banner-info" style="margin: 6px 0 0">
                      Declared in
                      <code>{{ st.declaredIn.repo }}</code> (<code>{{
                        st.declaredIn.path
                      }}</code
                      >).
                    </p>
                  }
                </div>

                <div class="proc-card">
                  <h3 class="section-title">
                    Member templates ({{ st.items.length }})
                  </h3>
                  <ul class="proc-kv-list">
                    @for (it of st.items; track $index) {
                      <li class="proc-kv-item">
                        <span
                          ><strong>{{ $index + 1 }}.</strong>
                          {{ it.templateName || it.templateId }}</span
                        >
                        <code class="tabular muted">{{ it.templateId }}</code>
                      </li>
                    }
                  </ul>
                </div>

                <g-composition-view [composition]="suiteComposition()" />

                @if (runsOfSuite(st.id).length > 0) {
                  <div class="proc-card">
                    <h3 class="section-title">Recent runs of this suite</h3>
                    <ul class="proc-kv-list">
                      @for (r of runsOfSuite(st.id); track r.id) {
                        <li class="proc-kv-item">
                          <button
                            type="button"
                            class="btn-text"
                            (click)="selectSuiteRun(r.id, true)"
                          >
                            Run #{{ r.id }} · {{ r.repo }} &#64;
                            {{ r.base }} (pass {{ r.pass }})
                          </button>
                          <span class="ci-provider-tag">{{ r.status }}</span>
                        </li>
                      }
                    </ul>
                  </div>
                }
              } @else {
                <div class="empty-state">
                  <p>Select a suite or suite run on the left.</p>
                </div>
              }
            }

            @case ("declarations") {
              @if (selectedDeclRepo(); as repo) {
                @let def = store.repoDefaults()[repo];
                @let status = def?.declarationsStatus;
                @let wfResp = store.repoWorkflows()[repo];
                <div class="proc-insp-head" data-testid="decl-inspector">
                  <div class="proc-insp-top">
                    <div class="headline-cluster">
                      <button
                        type="button"
                        class="btn-text proc-mobile-back"
                        (click)="mobileDetailOpen.set(false)"
                      >
                        ← Back
                      </button>
                      <h2 class="proc-insp-title tabular">{{ repo }}</h2>
                    </div>

                    @if (def) {
                      <div class="switch-row">
                        <button
                          type="button"
                          role="switch"
                          class="g-switch"
                          aria-label="Sync .grain/ declarations"
                          data-testid="decl-toggle-switch"
                          [disabled]="
                            !canRouteForRepo(
                              'PUT /api/repos/{owner}/{name}/declarations',
                              repo
                            )
                          "
                          [gTip]="
                            repoDeniedReason(
                              'PUT /api/repos/{owner}/{name}/declarations',
                              repo,
                              'Toggling declarations sync'
                            )
                          "
                          [attr.aria-checked]="def.declarations"
                          (click)="
                            toggleRepoDeclarations(repo, !def.declarations)
                          "
                        ></button>
                        <span>Sync <code>.grain/</code> declarations</span>
                      </div>
                    }
                  </div>

                  <div class="proc-meta-row">
                    @if (status?.commit) {
                      <span class="tabular"
                        >Synced commit:
                        <strong>{{
                          status!.commit!.slice(0, 12)
                        }}</strong></span
                      >
                    }
                    @if (status?.checkedAt) {
                      <span class="tabular"
                        >Checked: {{ status!.checkedAt }}</span
                      >
                    }
                  </div>

                  @if (status?.error) {
                    <p
                      class="banner banner-error"
                      style="margin: 6px 0 0"
                      data-testid="decl-sync-error"
                    >
                      Sync / validation error: {{ status!.error }}
                    </p>
                  }
                  @for (w of status?.warnings ?? []; track w) {
                    <p class="banner banner-info" style="margin: 6px 0 0">
                      Warning: {{ w }}
                    </p>
                  }
                </div>

                @if (acceptancesForRepo(repo).length > 0) {
                  <div class="proc-card" data-testid="decl-acceptances-card">
                    <h3 class="section-title">
                      Declaration capability acceptances
                    </h3>
                    @for (acc of acceptancesForRepo(repo); track acc.id) {
                      <div class="proc-kv-item" style="flex-wrap: wrap">
                        <div>
                          <strong>{{ acc.id }}</strong>
                          <span class="muted"> ({{ acc.kind }})</span>
                          <div class="muted" style="font-size: 12px">
                            Requested:
                            <code>{{ acc.requested.join(", ") }}</code>
                            @if (acc.needsScopes.length > 0) {
                              · Requires scopes:
                              {{ acc.needsScopes.join(", ") }}
                            }
                          </div>
                          @if (acc.acceptedBy) {
                            <div style="margin-top: 4px">
                              Accepted by
                              <g-actor-chip
                                [label]="acc.acceptedBy"
                                kind="human"
                              />
                            </div>
                          }
                        </div>
                        @if (acc.awaiting) {
                          <button
                            type="button"
                            class="btn-primary"
                            [attr.data-testid]="'decl-accept-btn-' + acc.id"
                            [disabled]="!canAcceptDeclaration(acc)"
                            [gTip]="acceptDeniedReason(acc)"
                            (click)="acceptRepoDeclaration(acc)"
                          >
                            Accept declaration
                          </button>
                        } @else {
                          <span class="status-pill healthy">
                            <g-status-icon tone="healthy" kind="healthy" />
                            Accepted
                          </span>
                        }
                      </div>
                    }
                  </div>
                }

                <div class="proc-card" data-testid="decl-discovered-files">
                  <h3 class="section-title">
                    Discovered <code>.grain/</code> files
                  </h3>
                  <ul class="proc-kv-list">
                    @for (p of status?.templates ?? []; track p) {
                      <li class="proc-kv-item">
                        <code class="tabular">{{ p }}</code>
                        <span class="ci-provider-tag">template</span>
                      </li>
                    }
                    @for (p of status?.suites ?? []; track p) {
                      <li class="proc-kv-item">
                        <code class="tabular">{{ p }}</code>
                        <span class="ci-provider-tag">suite</span>
                      </li>
                    }
                    @for (p of status?.schedules ?? []; track p) {
                      <li class="proc-kv-item">
                        <code class="tabular">{{ p }}</code>
                        <span class="ci-provider-tag">schedule</span>
                      </li>
                    }
                    @for (p of status?.triggers ?? []; track p) {
                      <li class="proc-kv-item">
                        <code class="tabular">{{ p }}</code>
                        <span class="ci-provider-tag">trigger</span>
                      </li>
                    }
                    @if (status?.mergeRules) {
                      <li class="proc-kv-item">
                        <code class="tabular">{{ status!.mergeRules }}</code>
                        <span class="ci-provider-tag">merge-rules</span>
                      </li>
                    }
                    @if (
                      !status?.templates?.length &&
                      !status?.suites?.length &&
                      !status?.schedules?.length &&
                      !status?.triggers?.length &&
                      !status?.mergeRules
                    ) {
                      <li class="muted">
                        No <code>.grain/</code> declaration files synced on the
                        default branch yet.
                      </li>
                    }
                  </ul>
                </div>

                <div class="proc-card" data-testid="decl-workflows-card">
                  <div class="proc-insp-top">
                    <h3 class="section-title" style="margin: 0">
                      Deployment-declared workflows ({{
                        (wfResp?.workflows ?? []).length
                      }})
                    </h3>
                    @if (
                      access.can(
                        "PUT /api/repos/{owner}/{name}/workflows",
                        repo
                      )
                    ) {
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="decl-add-workflow-btn"
                        (click)="openWorkflowEditor(repo, null)"
                      >
                        Add workflow YAML
                      </button>
                    }
                  </div>
                  @if ((wfResp?.workflows ?? []).length === 0) {
                    <p class="muted" style="margin: 0">
                      No controller-side workflow overrides stored for
                      {{ repo }}.
                    </p>
                  } @else {
                    <ul class="proc-kv-list">
                      @for (wf of wfResp!.workflows; track wf.path) {
                        <li class="proc-kv-item">
                          <div>
                            <strong>{{ wf.name || wf.path }}</strong>
                            <span class="muted tabular"> · {{ wf.path }}</span>
                          </div>
                          <button
                            type="button"
                            class="btn-text"
                            [attr.data-testid]="'decl-inspect-wf-' + wf.path"
                            (click)="openWorkflowEditor(repo, wf)"
                          >
                            {{
                              access.can(
                                "PUT /api/repos/{owner}/{name}/workflows",
                                repo
                              )
                                ? "Inspect / Edit"
                                : "Inspect"
                            }}
                          </button>
                        </li>
                      }
                    </ul>
                  }
                </div>
              } @else {
                <div class="empty-state">
                  <p>
                    Select a repository to inspect its <code>.grain/</code>
                    declarations, sync errors, and workflow overrides.
                  </p>
                </div>
              }
            }
          }
        </section>
      </div>
    </section>

    <!-- NEW / EDIT SCHEDULE DIALOG -->
    @if (schedDialogOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="closeScheduleDialog()"
      ></div>
      <div
        #schedDialogEl
        class="g-dialog is-drawer proc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sched-dialog-title"
        data-testid="schedule-dialog"
        gDialogTrap
        (gDialogClose)="closeScheduleDialog()"
      >
        <h2 id="sched-dialog-title">
          {{ editingSchedule() ? "Edit schedule" : "New schedule or trigger" }}
        </h2>

        <form (submit)="onScheduleFormSubmit($event)" novalidate>
          @if (editingSchedule()?.system) {
            <p
              class="banner banner-info"
              style="margin: 8px 0 0"
              data-testid="sched-system-banner"
            >
              Built-in Grain schedule — target and prompt are managed by Grain;
              cadence and overlap policy can be customized.
            </p>
          } @else {
            <div class="field">
              <span>Firing target</span>
              <div
                class="segmented"
                role="group"
                aria-label="Schedule target kind"
              >
                <button
                  type="button"
                  data-testid="sched-target-prompt"
                  [disabled]="!!editingSchedule()?.suiteId"
                  [attr.aria-pressed]="schedTargetKind() === 'prompt'"
                  (click)="setSchedTargetKind('prompt')"
                >
                  Inline prompt
                </button>
                <button
                  type="button"
                  data-testid="sched-target-template"
                  [disabled]="!!editingSchedule()?.suiteId"
                  [attr.aria-pressed]="schedTargetKind() === 'template'"
                  (click)="setSchedTargetKind('template')"
                >
                  Template
                </button>
                <button
                  type="button"
                  data-testid="sched-target-suite"
                  [disabled]="
                    editingSchedule() !== null && !editingSchedule()?.suiteId
                  "
                  [attr.aria-pressed]="schedTargetKind() === 'suite'"
                  (click)="setSchedTargetKind('suite')"
                >
                  Suite
                </button>
              </div>
            </div>

            @if (schedTargetKind() === "template") {
              <div class="field">
                <span>
                  Template
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <div class="pill-dropdown">
                  <button
                    type="button"
                    class="pill-trigger"
                    [class.is-invalid]="!!schedVisibleError('templateId')"
                    data-testid="sched-template-picker"
                    aria-haspopup="listbox"
                    [attr.aria-expanded]="openPicker() === 'schedTmpl'"
                    [attr.aria-describedby]="
                      schedVisibleError('templateId')
                        ? 'sched-template-error'
                        : null
                    "
                    (click)="togglePicker('schedTmpl', $event)"
                  >
                    <span>{{
                      templateNameById(sDraftTemplateId()) ||
                        (editingSchedule()?.templateId === sDraftTemplateId()
                          ? editingSchedule()?.templateName
                          : "") ||
                        "Choose template…"
                    }}</span>
                    <span aria-hidden="true">▾</span>
                  </button>
                  @if (openPicker() === "schedTmpl") {
                    <ul class="pop-menu" role="listbox" aria-label="Templates">
                      @for (t of schedulableTemplates(); track t.id) {
                        <li role="none">
                          <button
                            type="button"
                            role="option"
                            [attr.aria-selected]="sDraftTemplateId() === t.id"
                            (click)="selectSchedTemplate(t.id)"
                          >
                            {{ t.name || t.title }}
                          </button>
                        </li>
                      }
                    </ul>
                  }
                </div>
                @if (schedVisibleError("templateId"); as err) {
                  <small
                    id="sched-template-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-template-error"
                    >{{ err }}</small
                  >
                }
              </div>
            } @else if (schedTargetKind() === "suite") {
              <div class="field">
                <span>
                  Suite
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <div class="pill-dropdown">
                  <button
                    type="button"
                    class="pill-trigger"
                    [class.is-invalid]="!!schedVisibleError('suiteId')"
                    data-testid="sched-suite-picker"
                    aria-haspopup="listbox"
                    [attr.aria-expanded]="openPicker() === 'schedSuite'"
                    [attr.aria-describedby]="
                      schedVisibleError('suiteId') ? 'sched-suite-error' : null
                    "
                    (click)="togglePicker('schedSuite', $event)"
                  >
                    <span>{{
                      suiteNameById(sDraftSuiteId()) ||
                        (editingSchedule()?.suiteId === sDraftSuiteId()
                          ? editingSchedule()?.suiteName
                          : "") ||
                        "Choose suite…"
                    }}</span>
                    <span aria-hidden="true">▾</span>
                  </button>
                  @if (openPicker() === "schedSuite") {
                    <ul class="pop-menu" role="listbox" aria-label="Suites">
                      @for (st of store.suites(); track st.id) {
                        <li role="none">
                          <button
                            type="button"
                            role="option"
                            [attr.aria-selected]="sDraftSuiteId() === st.id"
                            (click)="selectSchedSuite(st.id)"
                          >
                            {{ st.name }}
                          </button>
                        </li>
                      }
                    </ul>
                  }
                </div>
                @if (schedVisibleError("suiteId"); as err) {
                  <small
                    id="sched-suite-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-suite-error"
                    >{{ err }}</small
                  >
                }
              </div>
            } @else {
              <label class="field">
                <span>
                  Task title
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  required
                  aria-required="true"
                  data-testid="sched-title-input"
                  placeholder="Nightly dependency audit"
                  [attr.aria-invalid]="
                    schedVisibleError('title') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('title') ? 'sched-title-error' : null
                  "
                  [value]="sDraftTitle()"
                  (input)="
                    onSchedFieldInput('title', $any($event.target).value)
                  "
                  (blur)="markSchedTouched('title')"
                />
                @if (schedVisibleError("title"); as err) {
                  <small
                    id="sched-title-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-title-error"
                    >{{ err }}</small
                  >
                }
              </label>
              <label class="field">
                <span>Task prompt</span>
                <textarea
                  rows="3"
                  data-testid="sched-desc-input"
                  placeholder="Check outdated packages and open a PR if needed."
                  [value]="sDraftDesc()"
                  (input)="sDraftDesc.set($any($event.target).value)"
                ></textarea>
              </label>
            }

            <div class="proc-field-grid">
              <div class="field">
                <span>
                  Repository (owner/name)
                  @if (isSchedRepoRequired()) {
                    <span class="proc-req-mark" aria-hidden="true">*</span>
                  }
                </span>
                @if (store.knownRepos().length > 0) {
                  <g-pill-select
                    [options]="schedRepoOptions()"
                    [value]="
                      store.knownRepos().includes(sDraftRepo())
                        ? sDraftRepo()
                        : ''
                    "
                    ariaLabel="Schedule repository"
                    align="left"
                    testid="sched-repo-select"
                    (valueChange)="onSchedRepoSelect($event)"
                  />
                }
                <input
                  type="text"
                  aria-label="Repository (owner/name)"
                  [attr.aria-required]="isSchedRepoRequired() ? 'true' : null"
                  [attr.aria-invalid]="
                    schedVisibleError('repo') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('repo') ? 'sched-repo-error' : null
                  "
                  data-testid="sched-repo-input"
                  placeholder="acme/widgets"
                  [value]="sDraftRepo()"
                  (input)="onSchedFieldInput('repo', $any($event.target).value)"
                  (blur)="markSchedTouched('repo')"
                />
                @if (schedVisibleError("repo"); as err) {
                  <small
                    id="sched-repo-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-repo-error"
                    >{{ err }}</small
                  >
                }
              </div>
              <label class="field">
                <span>
                  Base branch
                  @if (schedTargetKind() === "suite") {
                    <span class="proc-req-mark" aria-hidden="true">*</span>
                  }
                </span>
                <input
                  type="text"
                  data-testid="sched-base-input"
                  placeholder="Default branch"
                  [attr.aria-required]="
                    schedTargetKind() === 'suite' ? 'true' : null
                  "
                  [attr.aria-invalid]="
                    schedVisibleError('base') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('base') ? 'sched-base-error' : null
                  "
                  [value]="sDraftBase()"
                  (input)="onSchedFieldInput('base', $any($event.target).value)"
                  (blur)="markSchedTouched('base')"
                />
                @if (schedVisibleError("base"); as err) {
                  <small
                    id="sched-base-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-base-error"
                    >{{ err }}</small
                  >
                }
              </label>
            </div>
          }

          <div class="field">
            <span>Cadence / Event trigger</span>
            <div class="filter-strip" style="margin-top: 4px">
              @for (ck of cadenceKinds; track ck.id) {
                <button
                  type="button"
                  class="filter-chip"
                  [attr.aria-pressed]="sDraftKind() === ck.id"
                  [attr.data-testid]="'sched-kind-' + ck.id"
                  (click)="setSchedKind(ck.id)"
                >
                  {{ ck.label }}
                </button>
              }
            </div>
          </div>

          <div class="proc-field-grid">
            @if (sDraftKind() === "everyNMinutes") {
              <label class="field">
                <span>
                  Every N minutes
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <input
                  type="number"
                  min="10"
                  max="527040"
                  step="1"
                  required
                  aria-required="true"
                  data-testid="sched-every-min-input"
                  [attr.aria-invalid]="
                    schedVisibleError('everyNMinutes') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('everyNMinutes')
                      ? 'sched-every-min-error'
                      : null
                  "
                  [value]="sDraftEveryMin()"
                  (input)="
                    onSchedFieldInput(
                      'everyNMinutes',
                      $any($event.target).value
                    )
                  "
                  (blur)="markSchedTouched('everyNMinutes')"
                />
                @if (schedVisibleError("everyNMinutes"); as err) {
                  <small
                    id="sched-every-min-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-every-min-error"
                    >{{ err }}</small
                  >
                }
              </label>
            } @else if (sDraftKind() === "everyNHours") {
              <label class="field">
                <span>
                  Every N hours
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <input
                  type="number"
                  min="1"
                  max="8784"
                  step="1"
                  required
                  aria-required="true"
                  data-testid="sched-every-hr-input"
                  [attr.aria-invalid]="
                    schedVisibleError('everyNHours') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('everyNHours')
                      ? 'sched-every-hr-error'
                      : null
                  "
                  [value]="sDraftEveryHr()"
                  (input)="
                    onSchedFieldInput('everyNHours', $any($event.target).value)
                  "
                  (blur)="markSchedTouched('everyNHours')"
                />
                @if (schedVisibleError("everyNHours"); as err) {
                  <small
                    id="sched-every-hr-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-every-hr-error"
                    >{{ err }}</small
                  >
                }
              </label>
            } @else if (
              sDraftKind() === "daily" ||
              sDraftKind() === "weekly" ||
              sDraftKind() === "monthly"
            ) {
              <label class="field">
                <span>
                  Time of day (HH:MM)
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  required
                  aria-required="true"
                  data-testid="sched-time-input"
                  placeholder="09:00"
                  [attr.aria-invalid]="
                    schedVisibleError('timeOfDay') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('timeOfDay') ? 'sched-time-error' : null
                  "
                  [value]="sDraftTime()"
                  (input)="
                    onSchedFieldInput('timeOfDay', $any($event.target).value)
                  "
                  (blur)="markSchedTouched('timeOfDay')"
                />
                @if (schedVisibleError("timeOfDay"); as err) {
                  <small
                    id="sched-time-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-time-error"
                    >{{ err }}</small
                  >
                }
              </label>
              <label class="field">
                <span>Time zone (IANA)</span>
                <input
                  type="text"
                  data-testid="sched-tz-input"
                  placeholder="UTC"
                  [attr.aria-invalid]="
                    schedVisibleError('timeZone') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('timeZone') ? 'sched-tz-error' : null
                  "
                  [value]="sDraftTz()"
                  (input)="
                    onSchedFieldInput('timeZone', $any($event.target).value)
                  "
                  (blur)="markSchedTouched('timeZone')"
                />
                @if (schedVisibleError("timeZone"); as err) {
                  <small
                    id="sched-tz-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-tz-error"
                    >{{ err }}</small
                  >
                }
              </label>
              @if (sDraftKind() === "weekly") {
                <div class="field">
                  <span>Weekday</span>
                  <div class="pill-dropdown">
                    <button
                      type="button"
                      class="pill-trigger"
                      data-testid="sched-weekday-picker"
                      aria-haspopup="listbox"
                      [attr.aria-expanded]="openPicker() === 'weekday'"
                      (click)="togglePicker('weekday', $event)"
                    >
                      <span>{{ sDraftWeekday() }}</span>
                      <span aria-hidden="true">▾</span>
                    </button>
                    @if (openPicker() === "weekday") {
                      <ul class="pop-menu" role="listbox" aria-label="Weekday">
                        @for (wd of weekdays; track wd) {
                          <li role="none">
                            <button
                              type="button"
                              role="option"
                              [attr.aria-selected]="sDraftWeekday() === wd"
                              (click)="
                                sDraftWeekday.set(wd); openPicker.set(null)
                              "
                            >
                              {{ wd }}
                            </button>
                          </li>
                        }
                      </ul>
                    }
                  </div>
                </div>
              }
              @if (sDraftKind() === "monthly") {
                <label class="field">
                  <span>
                    Day of month (1–31)
                    <span class="proc-req-mark" aria-hidden="true">*</span>
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    step="1"
                    required
                    aria-required="true"
                    data-testid="sched-day-of-month-input"
                    [attr.aria-invalid]="
                      schedVisibleError('dayOfMonth') ? 'true' : null
                    "
                    [attr.aria-describedby]="
                      schedVisibleError('dayOfMonth')
                        ? 'sched-day-of-month-error'
                        : null
                    "
                    [value]="sDraftDayOfMonth()"
                    (input)="
                      onSchedFieldInput('dayOfMonth', $any($event.target).value)
                    "
                    (blur)="markSchedTouched('dayOfMonth')"
                  />
                  @if (schedVisibleError("dayOfMonth"); as err) {
                    <small
                      id="sched-day-of-month-error"
                      class="proc-field-error"
                      role="alert"
                      data-testid="sched-day-of-month-error"
                      >{{ err }}</small
                    >
                  }
                </label>
              }
            } @else if (sDraftKind() === "github_workflow_run") {
              <label class="field">
                <span>
                  Workflow name or file
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  required
                  aria-required="true"
                  data-testid="sched-trigger-workflow-input"
                  placeholder="CI"
                  [attr.aria-invalid]="
                    schedVisibleError('triggerWorkflow') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('triggerWorkflow')
                      ? 'sched-trigger-workflow-error'
                      : null
                  "
                  [value]="sDraftTriggerWorkflow()"
                  (input)="
                    onSchedFieldInput(
                      'triggerWorkflow',
                      $any($event.target).value
                    )
                  "
                  (blur)="markSchedTouched('triggerWorkflow')"
                />
                @if (schedVisibleError("triggerWorkflow"); as err) {
                  <small
                    id="sched-trigger-workflow-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-trigger-workflow-error"
                    >{{ err }}</small
                  >
                }
              </label>
              <label class="field">
                <span>Conclusion filter</span>
                <input
                  type="text"
                  data-testid="sched-trigger-conclusion-input"
                  placeholder="failure"
                  [value]="sDraftTriggerConclusion()"
                  (input)="
                    sDraftTriggerConclusion.set($any($event.target).value)
                  "
                />
              </label>
              <label class="field">
                <span>Branch filter (optional)</span>
                <input
                  type="text"
                  data-testid="sched-trigger-branch-input"
                  placeholder="main"
                  [value]="sDraftTriggerBranch()"
                  (input)="sDraftTriggerBranch.set($any($event.target).value)"
                />
              </label>
            } @else if (sDraftKind() === "git_ref") {
              <label class="field">
                <span>
                  Watched git repository
                  @if (!sDraftRepo().trim() || editingSchedule()?.system) {
                    <span class="proc-req-mark" aria-hidden="true">*</span>
                  }
                </span>
                <input
                  type="text"
                  data-testid="sched-git-ref-repo-input"
                  [placeholder]="sDraftRepo() || 'acme/widgets'"
                  [attr.aria-required]="
                    !sDraftRepo().trim() || editingSchedule()?.system
                      ? 'true'
                      : null
                  "
                  [attr.aria-invalid]="
                    schedVisibleError('gitRefRepo') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('gitRefRepo')
                      ? 'sched-git-ref-repo-error'
                      : null
                  "
                  [value]="sDraftGitRefRepo()"
                  (input)="
                    onSchedFieldInput('gitRefRepo', $any($event.target).value)
                  "
                  (blur)="markSchedTouched('gitRefRepo')"
                />
                @if (schedVisibleError("gitRefRepo"); as err) {
                  <small
                    id="sched-git-ref-repo-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-git-ref-repo-error"
                    >{{ err }}</small
                  >
                }
              </label>
              <label class="field">
                <span>
                  Watched git ref / branch
                  <span class="proc-req-mark" aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  required
                  aria-required="true"
                  data-testid="sched-git-ref-input"
                  placeholder="refs/heads/main"
                  [attr.aria-invalid]="
                    schedVisibleError('gitRef') ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    schedVisibleError('gitRef') ? 'sched-git-ref-error' : null
                  "
                  [value]="sDraftGitRef()"
                  (input)="
                    onSchedFieldInput('gitRef', $any($event.target).value)
                  "
                  (blur)="markSchedTouched('gitRef')"
                />
                @if (schedVisibleError("gitRef"); as err) {
                  <small
                    id="sched-git-ref-error"
                    class="proc-field-error"
                    role="alert"
                    data-testid="sched-git-ref-error"
                    >{{ err }}</small
                  >
                }
              </label>
            }
          </div>

          <div class="field">
            <span>Overlap policy</span>
            <div class="segmented" role="group" aria-label="Overlap policy">
              <button
                type="button"
                [attr.aria-pressed]="sDraftOverlap() === 'skip'"
                (click)="sDraftOverlap.set('skip')"
              >
                Skip while open
              </button>
              <button
                type="button"
                [attr.aria-pressed]="sDraftOverlap() === 'allow'"
                (click)="sDraftOverlap.set('allow')"
              >
                Allow overlap
              </button>
            </div>
          </div>

          @if (!editingSchedule()?.system) {
            <div style="margin-top: 12px">
              <button
                type="button"
                class="btn-tonal"
                data-testid="sched-preview-composition-btn"
                (click)="previewScheduleDraft()"
              >
                Preview composition
              </button>
            </div>
            @if (draftSchedComposition(); as dc) {
              <div style="margin-top: 10px">
                <g-composition-view
                  [composition]="dc"
                  heading="Draft composition preview"
                />
              </div>
            }
          }

          @if (schedSubmitError(); as err) {
            <p
              class="banner banner-error proc-dialog-error"
              role="alert"
              data-testid="sched-dialog-error"
            >
              {{ err }}
            </p>
          }

          <div class="dialog-actions">
            <button
              type="button"
              class="btn-text"
              data-testid="sched-cancel-btn"
              (click)="closeScheduleDialog()"
            >
              Cancel
            </button>
            <button
              type="submit"
              class="btn-primary"
              data-testid="sched-save-btn"
              [disabled]="submitting() || !canAccessScheduleSave()"
              [gTip]="scheduleSaveDeniedReason()"
            >
              {{ submitting() ? "Saving…" : "Save schedule" }}
            </button>
          </div>
        </form>
      </div>
    }

    <!-- LAUNCH TASK FROM TEMPLATE DIALOG -->
    @if (launchDialogOpen()) {
      <div class="scrim" aria-hidden="true" (click)="closeLaunchDialog()"></div>
      <div
        class="g-dialog is-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-tmpl-title"
        data-testid="launch-template-dialog"
        gDialogTrap
        (gDialogClose)="closeLaunchDialog()"
      >
        <h2 id="launch-tmpl-title">Launch task from template</h2>

        <div class="field">
          <span>Template</span>
          <div class="pill-dropdown">
            <button
              type="button"
              class="pill-trigger"
              data-testid="launch-template-picker"
              aria-haspopup="listbox"
              [attr.aria-expanded]="openPicker() === 'launchTmpl'"
              (click)="togglePicker('launchTmpl', $event)"
            >
              <span>{{ launchTemplateLabel() }}</span>
              <span aria-hidden="true">▾</span>
            </button>
            @if (openPicker() === "launchTmpl") {
              <ul class="pop-menu" role="listbox" aria-label="Template">
                @for (t of store.templates(); track t.id) {
                  <li role="none">
                    <button
                      type="button"
                      role="option"
                      [attr.aria-selected]="
                        launchSelectedTemplate()?.id === t.id
                      "
                      (click)="pickLaunchTemplate(t.id)"
                    >
                      {{ t.name || t.title }}
                    </button>
                  </li>
                }
              </ul>
            }
          </div>
        </div>

        @if (launchSelectedTemplate(); as lt) {
          @for (f of lt.fields ?? []; track f.name) {
            @if ((f.options ?? []).length > 0) {
              <div class="field">
                <span>{{ f.label || f.name }}</span>
                <div class="filter-strip" style="margin-top: 4px">
                  @for (opt of f.options ?? []; track opt) {
                    <button
                      type="button"
                      class="filter-chip"
                      [attr.aria-pressed]="launchFields()[f.name] === opt"
                      (click)="setLaunchField(f.name, opt)"
                    >
                      {{ opt }}
                    </button>
                  }
                </div>
              </div>
            } @else {
              <label class="field">
                <span
                  >{{ f.label || f.name
                  }}{{ f.required ? " (required)" : "" }}</span
                >
                <input
                  type="text"
                  [attr.data-testid]="'launch-field-' + f.name"
                  [value]="launchFields()[f.name] || ''"
                  (input)="setLaunchField(f.name, $any($event.target).value)"
                />
              </label>
            }
          }

          @if (!lt.repo && !lt.declaredIn && !lt.system) {
            <div class="proc-field-grid">
              <label class="field">
                <span>Target repository (owner/name)</span>
                <input
                  type="text"
                  data-testid="launch-repo-input"
                  placeholder="acme/widgets"
                  [value]="launchRepo()"
                  (input)="launchRepo.set($any($event.target).value)"
                />
              </label>
              <label class="field">
                <span>Base branch</span>
                <input
                  type="text"
                  data-testid="launch-base-input"
                  placeholder="main"
                  [value]="launchBase()"
                  (input)="launchBase.set($any($event.target).value)"
                />
              </label>
            </div>
          }

          @if (!lt.interactive) {
            <div class="switch-row" style="margin-top: 14px">
              <button
                type="button"
                role="switch"
                class="g-switch"
                aria-label="Approved (queue immediately without proposal hold)"
                [attr.aria-checked]="launchApproved()"
                (click)="launchApproved.set(!launchApproved())"
              ></button>
              <span>Approved (queue immediately without proposal hold)</span>
            </div>
          }
        }

        <div class="dialog-actions">
          <button type="button" class="btn-text" (click)="closeLaunchDialog()">
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="launch-template-submit"
            [disabled]="submitting() || !canSubmitLaunchTemplate()"
            [gTip]="launchSubmitDeniedReason()"
            (click)="submitLaunchTemplate()"
          >
            {{ submitting() ? "Launching…" : "Create task" }}
          </button>
        </div>
      </div>
    }

    <!-- CREATE / EDIT TEMPLATE DIALOG -->
    @if (tmplDialogOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="tmplDialogOpen.set(false)"
      ></div>
      <div
        class="g-dialog is-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tmpl-dialog-title"
        data-testid="template-dialog"
        gDialogTrap
        (gDialogClose)="tmplDialogOpen.set(false)"
      >
        <h2 id="tmpl-dialog-title">
          {{ editingTemplate() ? "Edit template" : "New task template" }}
        </h2>
        <div class="proc-field-grid">
          <label class="field">
            <span>Template name</span>
            <input
              type="text"
              data-testid="tmpl-name-input"
              placeholder="Upgrade Go service"
              [value]="tDraftName()"
              (input)="tDraftName.set($any($event.target).value)"
            />
          </label>
          <label class="field">
            <span>Filed task title (supports {{ "{{param}}" }})</span>
            <input
              type="text"
              data-testid="tmpl-title-input"
              placeholder="chore: upgrade {{ '{{pkg}}' }}"
              [value]="tDraftTitle()"
              (input)="tDraftTitle.set($any($event.target).value)"
            />
          </label>
        </div>
        <label class="field">
          <span>Prompt body</span>
          <textarea
            rows="4"
            data-testid="tmpl-desc-input"
            placeholder="Upgrade {{ '{{pkg}}' }} and run tests."
            [value]="tDraftDesc()"
            (input)="tDraftDesc.set($any($event.target).value)"
          ></textarea>
        </label>
        <div class="proc-field-grid">
          <label class="field">
            <span>Optional bound repository</span>
            <input
              type="text"
              data-testid="tmpl-repo-input"
              placeholder="Leave blank for any repo"
              [value]="tDraftRepo()"
              (input)="tDraftRepo.set($any($event.target).value)"
            />
          </label>
          <label class="field">
            <span>Parameters (comma-separated names)</span>
            <input
              type="text"
              data-testid="tmpl-params-input"
              placeholder="pkg, target_version"
              [value]="tDraftParamsCsv()"
              (input)="onTemplateParamsCsvInput($any($event.target).value)"
            />
          </label>
        </div>

        @if (tDraftFields().length > 0) {
          <div class="field" data-testid="tmpl-draft-fields">
            <span>Parameter metadata</span>
            <div class="tmpl-field-editor-list">
              @for (f of tDraftFields(); track f.name) {
                <div class="tmpl-field-editor-row">
                  <code class="tabular">{{ "{{" + f.name + "}}" }}</code>
                  <input
                    type="text"
                    placeholder="Label (optional)"
                    [attr.aria-label]="'Label for ' + f.name"
                    [attr.data-testid]="'tmpl-field-label-' + f.name"
                    [value]="f.label || ''"
                    (input)="
                      updateTemplateFieldMeta(
                        f.name,
                        'label',
                        $any($event.target).value
                      )
                    "
                  />
                  <input
                    type="text"
                    placeholder="Default value"
                    [attr.aria-label]="'Default value for ' + f.name"
                    [attr.data-testid]="'tmpl-field-default-' + f.name"
                    [value]="f.default || ''"
                    (input)="
                      updateTemplateFieldMeta(
                        f.name,
                        'default',
                        $any($event.target).value
                      )
                    "
                  />
                  <div class="switch-row">
                    <button
                      type="button"
                      role="switch"
                      class="g-switch"
                      [attr.aria-label]="'Required parameter ' + f.name"
                      [attr.data-testid]="'tmpl-field-required-' + f.name"
                      [attr.aria-checked]="!!f.required"
                      (click)="toggleTemplateFieldRequired(f.name)"
                    ></button>
                    <span>Required</span>
                  </div>
                </div>
              }
            </div>
          </div>
        }

        <div class="switch-row" style="margin-top: 14px">
          <button
            type="button"
            role="switch"
            class="g-switch"
            aria-label="Auto-merge passing pull requests"
            [attr.aria-checked]="tDraftAutoMerge()"
            (click)="tDraftAutoMerge.set(!tDraftAutoMerge())"
          ></button>
          <span>Auto-merge passing pull requests</span>
        </div>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn-text"
            (click)="tmplDialogOpen.set(false)"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="tmpl-save-btn"
            [disabled]="submitting() || !canSaveTemplate()"
            [gTip]="templateSaveDeniedReason()"
            (click)="saveTemplateDialog()"
          >
            {{ submitting() ? "Saving…" : "Save template" }}
          </button>
        </div>
      </div>
    }

    <!-- CREATE / EDIT SUITE DIALOG -->
    @if (suiteDialogOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="suiteDialogOpen.set(false)"
      ></div>
      <div
        class="g-dialog is-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="suite-dialog-title"
        data-testid="suite-dialog"
        gDialogTrap
        (gDialogClose)="suiteDialogOpen.set(false)"
      >
        <h2 id="suite-dialog-title">
          {{ editingSuite() ? "Edit suite" : "New suite" }}
        </h2>
        <label class="field">
          <span>Suite name</span>
          <input
            type="text"
            data-testid="suite-name-input"
            placeholder="Release hardening sweep"
            [value]="stDraftName()"
            (input)="stDraftName.set($any($event.target).value)"
          />
        </label>

        <div class="field">
          <span>Stopping mode</span>
          <div class="segmented" role="group" aria-label="Suite mode">
            <button
              type="button"
              data-testid="suite-mode-count"
              [attr.aria-pressed]="stDraftMode() === 'count'"
              (click)="stDraftMode.set('count')"
            >
              Fixed pass count
            </button>
            <button
              type="button"
              data-testid="suite-mode-until-clean"
              [attr.aria-pressed]="stDraftMode() === 'until_clean'"
              (click)="stDraftMode.set('until_clean')"
            >
              Until clean
            </button>
          </div>
        </div>

        @if (stDraftMode() === "count") {
          <label class="field">
            <span>Number of passes</span>
            <input
              type="number"
              min="1"
              data-testid="suite-count-input"
              [value]="stDraftCount()"
              (input)="stDraftCount.set(+$any($event.target).value || 1)"
            />
          </label>
        } @else {
          <label class="field">
            <span>Maximum passes</span>
            <input
              type="number"
              min="1"
              data-testid="suite-max-passes-input"
              [value]="stDraftMaxPasses()"
              (input)="stDraftMaxPasses.set(+$any($event.target).value || 3)"
            />
          </label>
        }

        <div class="field">
          <span>Member templates (toggle to include)</span>
          <div class="filter-strip" style="margin-top: 6px; flex-wrap: wrap">
            @for (t of schedulableTemplates(); track t.id) {
              <button
                type="button"
                class="filter-chip"
                [attr.aria-pressed]="stDraftTemplateIds().includes(t.id)"
                [attr.data-testid]="'suite-tmpl-chip-' + t.id"
                (click)="toggleSuiteTemplateId(t.id)"
              >
                {{ t.name || t.title }}
              </button>
            }
          </div>
        </div>

        <div class="proc-field-grid" style="margin-top: 14px">
          <div class="switch-row">
            <button
              type="button"
              role="switch"
              class="g-switch"
              aria-label="Require approval before each pass"
              data-testid="suite-require-approval-switch"
              [attr.aria-checked]="stDraftRequireApproval()"
              (click)="stDraftRequireApproval.set(!stDraftRequireApproval())"
            ></button>
            <span>Require approval before each pass</span>
          </div>
          <div class="switch-row">
            <button
              type="button"
              role="switch"
              class="g-switch"
              aria-label="Auto-merge passing pull requests"
              data-testid="suite-auto-merge-switch"
              [attr.aria-checked]="stDraftAutoMerge()"
              (click)="stDraftAutoMerge.set(!stDraftAutoMerge())"
            ></button>
            <span>Auto-merge passing pull requests</span>
          </div>
        </div>

        <div style="margin-top: 12px">
          <button
            type="button"
            class="btn-tonal"
            data-testid="suite-preview-composition-btn"
            (click)="previewSuiteDraft()"
          >
            Preview composition
          </button>
        </div>
        @if (draftSuiteComposition(); as dsc) {
          <div style="margin-top: 10px">
            <g-composition-view
              [composition]="dsc"
              heading="Draft suite composition"
            />
          </div>
        }

        <div class="dialog-actions">
          <button
            type="button"
            class="btn-text"
            (click)="suiteDialogOpen.set(false)"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="suite-save-btn"
            [disabled]="submitting() || !canSaveSuite()"
            [gTip]="suiteSaveDeniedReason()"
            (click)="saveSuiteDialog()"
          >
            {{ submitting() ? "Saving…" : "Save suite" }}
          </button>
        </div>
      </div>
    }

    <!-- RUN SUITE DIALOG -->
    @if (runSuiteDialogOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="closeRunSuiteDialog()"
      ></div>
      <div
        class="g-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-suite-title"
        data-testid="run-suite-dialog"
        gDialogTrap
        (gDialogClose)="closeRunSuiteDialog()"
      >
        <h2 id="run-suite-title">Run suite</h2>
        <div class="field">
          <span>Suite</span>
          <div class="pill-dropdown">
            <button
              type="button"
              class="pill-trigger"
              data-testid="run-suite-picker"
              aria-haspopup="listbox"
              [attr.aria-expanded]="openPicker() === 'runSuite'"
              (click)="togglePicker('runSuite', $event)"
            >
              <span>{{ suiteNameById(runSuiteId()) || "Choose suite…" }}</span>
              <span aria-hidden="true">▾</span>
            </button>
            @if (openPicker() === "runSuite") {
              <ul class="pop-menu" role="listbox" aria-label="Suite">
                @for (st of runnableSuites(); track st.id) {
                  <li role="none">
                    <button
                      type="button"
                      role="option"
                      [attr.aria-selected]="runSuiteId() === st.id"
                      (click)="runSuiteId.set(st.id); openPicker.set(null)"
                    >
                      {{ st.name }}
                    </button>
                  </li>
                }
              </ul>
            }
          </div>
        </div>
        <label class="field">
          <span>Repository (owner/name)</span>
          <input
            type="text"
            data-testid="run-suite-repo-input"
            placeholder="acme/widgets"
            [value]="runSuiteRepo()"
            (input)="runSuiteRepo.set($any($event.target).value)"
          />
        </label>
        <label class="field">
          <span>Base branch</span>
          <input
            type="text"
            data-testid="run-suite-base-input"
            placeholder="main"
            [value]="runSuiteBase()"
            (input)="runSuiteBase.set($any($event.target).value)"
          />
        </label>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn-text"
            (click)="closeRunSuiteDialog()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="run-suite-submit"
            [disabled]="submitting() || !canSubmitRunSuite()"
            [gTip]="runSuiteSubmitDeniedReason()"
            (click)="submitRunSuite()"
          >
            {{ submitting() ? "Starting…" : "Start suite run" }}
          </button>
        </div>
      </div>
    }

    <!-- REPO WORKFLOW YAML EDITOR DIALOG -->
    @if (wfEditorOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="wfEditorOpen.set(false)"
      ></div>
      <div
        class="g-dialog is-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-editor-title"
        data-testid="repo-workflow-dialog"
        gDialogTrap
        (gDialogClose)="wfEditorOpen.set(false)"
      >
        <h2 id="wf-editor-title">Workflow YAML for {{ wfEditorRepo() }}</h2>
        <label class="field">
          <span>Workflow file path</span>
          <input
            type="text"
            data-testid="wf-path-input"
            placeholder=".grain/workflows/ci.yml"
            [readOnly]="!canEditWorkflow()"
            [value]="wfEditorPath()"
            (input)="wfEditorPath.set($any($event.target).value)"
          />
        </label>
        <label class="field">
          <span>YAML definition</span>
          <textarea
            class="proc-yaml-editor"
            data-testid="wf-yaml-input"
            [readOnly]="!canEditWorkflow()"
            [value]="wfEditorText()"
            (input)="wfEditorText.set($any($event.target).value)"
          ></textarea>
        </label>
        <div class="dialog-actions">
          @if (wfEditorOriginalPath() && canEditWorkflow()) {
            <button
              type="button"
              class="btn-tonal danger"
              style="margin-right: auto"
              data-testid="wf-delete-btn"
              [disabled]="submitting()"
              (click)="deleteWorkflowOverride()"
            >
              Delete override
            </button>
          }
          <button
            type="button"
            class="btn-text"
            (click)="wfEditorOpen.set(false)"
          >
            {{ canEditWorkflow() ? "Cancel" : "Close" }}
          </button>
          @if (canEditWorkflow()) {
            <button
              type="button"
              class="btn-primary"
              data-testid="wf-save-btn"
              [disabled]="
                submitting() || !wfEditorPath().trim() || !wfEditorText().trim()
              "
              (click)="saveWorkflowEditor()"
            >
              {{ submitting() ? "Saving…" : "Save workflow" }}
            </button>
          }
        </div>
      </div>
    }

    @if (confirming(); as req) {
      <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
    }
  `,
})
export class ProcessesPageComponent implements OnInit, OnDestroy {
  readonly tab = input<string | undefined>(undefined);
  readonly new = input<string | undefined>(undefined);
  readonly launch = input<string | undefined>(undefined);
  readonly launchTemplate = input<string | undefined>(undefined);
  readonly run = input<string | undefined>(undefined);
  readonly runSuite = input<string | undefined>(undefined);

  protected readonly store = inject(ProcessesStore);
  protected readonly access = inject(AccessService);
  protected readonly filter = inject(ViewFilter);
  private readonly taskFeed = inject(TaskFeedStore);
  private readonly router = inject(Router);
  private readonly snackbar = inject(SnackbarService);
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);

  private readonly onCaptureKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && this.openPicker()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.zone.run(() => this.openPicker.set(null));
    }
  };

  protected readonly tabs = TABS;
  protected readonly weekdays = WEEKDAYS;
  protected readonly cadenceKinds = CADENCE_KINDS;

  protected readonly schedFilters: { id: SchedFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "paused", label: "Paused" },
    { id: "triggers", label: "Event triggers" },
    { id: "suppressed", label: "Suppressed" },
  ];

  protected readonly tmplFilters: { id: TmplFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "deployment", label: "Deployment" },
    { id: "declared", label: "Repo-declared" },
    { id: "system", label: "Built-in" },
  ];

  protected readonly schedFilter = signal<SchedFilter>("all");
  protected readonly tmplFilter = signal<TmplFilter>("all");
  protected readonly suitesView = signal<SuitesPaneView>("suites");

  protected readonly selectedScheduleId = signal<string | null>(null);
  protected readonly selectedTemplateId = signal<string | null>(null);
  protected readonly selectedSuiteId = signal<string | null>(null);
  protected readonly selectedSuiteRunId = signal<number | null>(null);
  protected readonly selectedDeclRepo = signal<string | null>(null);
  protected readonly mobileDetailOpen = signal(false);

  protected readonly scheduleComposition = signal<Composition | null>(null);
  protected readonly templateComposition = signal<Composition | null>(null);
  protected readonly suiteComposition = signal<Composition | null>(null);

  protected readonly openPicker = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly confirming = signal<ConfirmRequest | null>(null);

  // Schedule dialog state
  private schedDialogGen = 0;
  private readonly schedDialogEl =
    viewChild<ElementRef<HTMLElement>>("schedDialogEl");
  protected readonly schedDialogOpen = signal(false);
  protected readonly editingSchedule = signal<Schedule | null>(null);
  protected readonly schedTargetKind = signal<"prompt" | "template" | "suite">(
    "prompt",
  );
  protected readonly sDraftTitle = signal("");
  protected readonly sDraftDesc = signal("");
  protected readonly sDraftTemplateId = signal("");
  protected readonly sDraftSuiteId = signal("");
  protected readonly sDraftRepo = signal("");
  protected readonly schedRepoOptions = computed<PillOption[]>(() => [
    { value: "", label: "Choose configured repository…" },
    ...this.store.knownRepos().map((r) => ({ value: r, label: r })),
  ]);
  protected readonly sDraftBase = signal("main");
  protected readonly sDraftKind = signal("daily");
  protected readonly sDraftEveryMin = signal("15");
  protected readonly sDraftEveryHr = signal("6");
  protected readonly sDraftTime = signal("09:00");
  protected readonly sDraftWeekday = signal("monday");
  protected readonly sDraftDayOfMonth = signal("1");
  protected readonly sDraftTz = signal("UTC");
  protected readonly sDraftTriggerWorkflow = signal("");
  protected readonly sDraftTriggerConclusion = signal("failure");
  protected readonly sDraftTriggerBranch = signal("");
  protected readonly sDraftGitRefRepo = signal("");
  protected readonly sDraftGitRef = signal("refs/heads/main");
  protected readonly sDraftOverlap = signal("skip");
  protected readonly draftSchedComposition = signal<Composition | null>(null);
  protected readonly schedTouched = signal<Set<SchedFieldKey>>(new Set());
  protected readonly schedSubmitted = signal(false);
  protected readonly schedSubmitError = signal<string | null>(null);

  protected readonly isSchedRepoRequired = computed(() => {
    if (this.editingSchedule()?.system) return false;
    if (this.schedTargetKind() !== "template") return true;
    const chosenTmpl = this.store
      .templates()
      .find((t) => t.id === this.sDraftTemplateId());
    return !chosenTmpl?.repo;
  });

  protected readonly schedFieldErrors = computed<
    Partial<Record<SchedFieldKey, string>>
  >(() => {
    const errors: Partial<Record<SchedFieldKey, string>> = {};
    const editing = this.editingSchedule();
    const tk = this.schedTargetKind();

    if (!editing?.system) {
      if (tk === "template") {
        if (!this.sDraftTemplateId().trim()) {
          errors.templateId = "Template is required.";
        }
      } else if (tk === "suite") {
        if (!this.sDraftSuiteId().trim()) {
          errors.suiteId = "Suite is required.";
        }
      } else if (!this.sDraftTitle().trim()) {
        errors.title = "Task title is required.";
      }

      const repo = this.sDraftRepo().trim();
      if (!repo && this.isSchedRepoRequired()) {
        errors.repo = "Repository (owner/name) is required.";
      } else if (repo && !isValidRepoSpec(repo)) {
        errors.repo = "Enter repository as owner/name (e.g. acme/widgets).";
      }

      const base = this.sDraftBase().trim();
      if (tk === "suite" && !base) {
        errors.base = "Base branch is required for suite schedules.";
      } else if (base && !isValidBranchName(base)) {
        errors.base =
          "Enter a valid git branch name (letters, digits, '.', '_', '-' and '/').";
      }
    }

    const kind = this.sDraftKind();
    if (kind === "everyNMinutes") {
      const raw = this.sDraftEveryMin().trim();
      if (!raw) {
        errors.everyNMinutes = "Interval in minutes is required.";
      } else {
        const n = parseStrictInt(raw);
        if (n === null || n < MIN_EVERY_N_MINUTES || n > MAX_EVERY_N_MINUTES) {
          errors.everyNMinutes = `Enter a whole number between ${MIN_EVERY_N_MINUTES} and ${MAX_EVERY_N_MINUTES} minutes.`;
        }
      }
    } else if (kind === "everyNHours") {
      const raw = this.sDraftEveryHr().trim();
      if (!raw) {
        errors.everyNHours = "Interval in hours is required.";
      } else {
        const n = parseStrictInt(raw);
        if (n === null || n < 1 || n > MAX_EVERY_N_HOURS) {
          errors.everyNHours = `Enter a whole number between 1 and ${MAX_EVERY_N_HOURS} hours.`;
        }
      }
    } else if (kind === "daily" || kind === "weekly" || kind === "monthly") {
      const time = this.sDraftTime().trim();
      if (!time) {
        errors.timeOfDay = "Time of day (HH:MM) is required.";
      } else if (!isValidTimeOfDay(time)) {
        errors.timeOfDay =
          "Enter a valid 24-hour time in HH:MM format (e.g. 09:00).";
      }

      const tz = this.sDraftTz().trim();
      if (tz && !isValidTimeZone(tz)) {
        errors.timeZone =
          "Enter a valid IANA time zone (e.g. UTC or America/New_York).";
      }

      if (kind === "monthly") {
        const raw = this.sDraftDayOfMonth().trim();
        if (!raw) {
          errors.dayOfMonth = "Day of month is required.";
        } else {
          const n = parseStrictInt(raw);
          if (n === null || n < 1 || n > 31) {
            errors.dayOfMonth = "Enter a whole day between 1 and 31.";
          }
        }
      }
    } else if (kind === "github_workflow_run") {
      if (!this.sDraftTriggerWorkflow().trim()) {
        errors.triggerWorkflow = "Workflow name or file is required.";
      }
    } else if (kind === "git_ref") {
      const watchedRepo = this.sDraftGitRefRepo().trim();
      const fallbackRepo = editing?.system ? "" : this.sDraftRepo().trim();
      if (!watchedRepo && !fallbackRepo) {
        errors.gitRefRepo = "Watched git repository (owner/name) is required.";
      } else if (watchedRepo && !isValidRepoSpec(watchedRepo)) {
        errors.gitRefRepo =
          "Enter watched repository as owner/name (e.g. acme/widgets).";
      } else if (
        !watchedRepo &&
        fallbackRepo &&
        !isValidRepoSpec(fallbackRepo)
      ) {
        errors.gitRefRepo =
          "Enter watched repository as owner/name (Schedule repository is invalid).";
      }

      const ref = this.sDraftGitRef().trim();
      if (!ref) {
        errors.gitRef = "Watched git ref is required.";
      } else if (!isValidGitRef(ref)) {
        errors.gitRef =
          "Enter a full git ref starting with refs/ (e.g. refs/heads/main).";
      }
    }

    return errors;
  });

  // Launch template dialog state
  protected readonly launchDialogOpen = signal(false);
  protected readonly launchTemplateId = signal("");
  protected readonly launchRepo = signal("");
  protected readonly launchBase = signal("");
  protected readonly launchApproved = signal(true);
  protected readonly launchFields = signal<Record<string, string>>({});

  // Create/Edit template dialog state
  protected readonly tmplDialogOpen = signal(false);
  protected readonly editingTemplate = signal<Template | null>(null);
  protected readonly tDraftName = signal("");
  protected readonly tDraftTitle = signal("");
  protected readonly tDraftDesc = signal("");
  protected readonly tDraftRepo = signal("");
  protected readonly tDraftParamsCsv = signal("");
  protected readonly tDraftFields = signal<TemplateField[]>([]);
  protected readonly tDraftAutoMerge = signal(false);

  // Create/Edit suite dialog state
  protected readonly suiteDialogOpen = signal(false);
  protected readonly editingSuite = signal<Suite | null>(null);
  protected readonly stDraftName = signal("");
  protected readonly stDraftMode = signal("count");
  protected readonly stDraftCount = signal(1);
  protected readonly stDraftMaxPasses = signal(3);
  protected readonly stDraftTemplateIds = signal<string[]>([]);
  protected readonly stDraftRequireApproval = signal(false);
  protected readonly stDraftAutoMerge = signal(true);
  protected readonly draftSuiteComposition = signal<Composition | null>(null);

  // Run suite dialog state
  protected readonly runSuiteDialogOpen = signal(false);
  protected readonly runSuiteId = signal("");
  protected readonly runSuiteRepo = signal("");
  protected readonly runSuiteBase = signal("main");

  // Repo workflow editor dialog
  protected readonly wfEditorOpen = signal(false);
  protected readonly wfEditorRepo = signal("");
  protected readonly wfEditorOriginalPath = signal("");
  protected readonly wfEditorPath = signal(".grain/workflows/ci.yml");
  protected readonly wfEditorText = signal("");

  private readonly splitEl = viewChild<ElementRef<HTMLElement>>("split");

  protected readonly sp = new SplitController({
    ratioKey: "grain-ng.processes.split-ratio",
    collapsedKey: "grain-ng.processes.split-collapsed",
    defaultRatio: 0.35,
    element: () => this.splitEl()?.nativeElement,
  });

  protected readonly activeTab = computed<ProcessTab>(() => {
    const raw = (this.tab() || "").toLowerCase();
    if (
      raw === "templates" ||
      raw === "suites" ||
      raw === "declarations" ||
      raw === "schedules"
    ) {
      return raw;
    }
    return "schedules";
  });

  protected readonly modalOpen = computed(
    () =>
      this.schedDialogOpen() ||
      this.launchDialogOpen() ||
      this.tmplDialogOpen() ||
      this.suiteDialogOpen() ||
      this.runSuiteDialogOpen() ||
      this.wfEditorOpen() ||
      !!this.confirming(),
  );

  protected readonly filteredSchedules = computed(() => {
    const f = this.schedFilter();
    const q = this.filter.query().trim().toLowerCase();
    return this.store.schedules().filter((s) => {
      if (f === "active" && !s.enabled) return false;
      if (f === "paused" && s.enabled) return false;
      if (f === "triggers" && !isEventTrigger(s)) return false;
      if (f === "suppressed" && !s.suppressed) return false;
      if (q) {
        const hay = [
          s.id,
          s.title,
          s.repo,
          s.templateName ?? "",
          s.suiteName ?? "",
          formatCadence(s.recurrence, s.timeZone),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  protected readonly filteredTemplates = computed(() => {
    const f = this.tmplFilter();
    const q = this.filter.query().trim().toLowerCase();
    return this.store.templates().filter((t) => {
      if (f === "deployment" && (t.declaredIn || t.system)) return false;
      if (f === "declared" && !t.declaredIn) return false;
      if (f === "system" && !t.system) return false;
      if (q) {
        const hay = [
          t.id,
          t.name,
          t.title,
          t.description,
          t.declaredIn?.repo ?? "",
          t.repo ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  protected readonly schedulableTemplates = computed(() =>
    this.store.templates().filter((t) => !t.system),
  );

  protected readonly filteredSuites = computed(() => {
    const q = this.filter.query().trim().toLowerCase();
    return this.store.suites().filter((s) => {
      if (!q) return true;
      return `${s.id} ${s.name} ${s.declaredIn?.repo ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  });

  protected readonly filteredSuiteRuns = computed(() => {
    const q = this.filter.query().trim().toLowerCase();
    return this.store.suiteRuns().filter((r) => {
      if (!q) return true;
      return `${r.id} ${r.suiteName} ${r.repo} ${r.base} ${r.status}`
        .toLowerCase()
        .includes(q);
    });
  });

  protected readonly filteredDeclRepos = computed(() => {
    const q = this.filter.query().trim().toLowerCase();
    return this.store
      .knownRepos()
      .filter((r) => !q || r.toLowerCase().includes(q));
  });

  protected readonly selectedSchedule = computed(() => {
    const id = this.selectedScheduleId();
    return this.store.schedules().find((s) => s.id === id) ?? null;
  });

  protected readonly selectedTemplate = computed(() => {
    const id = this.selectedTemplateId();
    return this.store.templates().find((t) => t.id === id) ?? null;
  });

  protected readonly selectedSuite = computed(() => {
    const id = this.selectedSuiteId();
    return this.store.suites().find((s) => s.id === id) ?? null;
  });

  protected readonly selectedSuiteRun = computed(() => {
    const id = this.selectedSuiteRunId();
    if (id === null) return null;
    return this.store.suiteRuns().find((r) => r.id === id) ?? null;
  });

  protected readonly launchSelectedTemplate = computed<Template | null>(() => {
    const id = this.launchTemplateId();
    const list = this.store.templates();
    const found = list.find((t) => t.id === id);
    if (found) return found;
    return list.length > 0 ? list[0] : null;
  });

  protected readonly launchTemplateLabel = computed(() => {
    const t = this.launchSelectedTemplate();
    return t ? t.name || t.title || t.id : "Select template";
  });

  private handledDeepLinkKey = "";

  constructor() {
    afterNextRender(() => this.sp.attach());

    // Auto-select top item per tab on desktop when data loads.
    effect(() => {
      const tab = this.activeTab();
      const loaded = this.store.loaded();
      const scheds = this.filteredSchedules();
      const tmpls = this.filteredTemplates();
      const suites = this.filteredSuites();
      const repos = this.filteredDeclRepos();
      untracked(() => {
        if (!loaded) return;
        const isDesktop = (this.doc.defaultView?.innerWidth ?? 1280) >= 600;
        if (!isDesktop) return;
        if (tab === "schedules" && !this.selectedScheduleId() && scheds[0]) {
          this.selectSchedule(scheds[0].id, false);
        } else if (
          tab === "templates" &&
          !this.selectedTemplateId() &&
          tmpls[0]
        ) {
          this.selectTemplate(tmpls[0].id, false);
        } else if (
          tab === "suites" &&
          !this.selectedSuiteId() &&
          this.selectedSuiteRunId() === null &&
          suites[0]
        ) {
          this.selectSuite(suites[0].id, false);
        } else if (
          tab === "declarations" &&
          !this.selectedDeclRepo() &&
          repos[0]
        ) {
          this.selectDeclRepo(repos[0], false);
        }
      });
    });

    // Handle deep-link query params from shell New menu:
    // ?new=1 | ?new=schedule, ?launch=1 | ?launchTemplate=1, ?run=1 | ?runSuite=1
    effect(() => {
      const loaded = this.store.loaded();
      const newParam = this.new();
      const launchParam = this.launch() || this.launchTemplate();
      const runParam = this.run() || this.runSuite();
      const key = `${loaded}:${newParam ?? ""}:${launchParam ?? ""}:${runParam ?? ""}`;
      untracked(() => {
        if (!loaded || key === this.handledDeepLinkKey) return;
        if (newParam === "1" || newParam === "schedule") {
          this.handledDeepLinkKey = key;
          if (this.access.can("POST /api/schedules")) {
            this.openScheduleDialog(null);
          }
        } else if (launchParam === "1") {
          this.handledDeepLinkKey = key;
          if (this.canOpenLaunchTemplateDialog()) {
            const sel = this.selectedTemplate();
            this.openLaunchTemplateDialog(
              (sel && this.store.canLaunchTemplate(sel) ? sel : null) ??
                this.store
                  .templates()
                  .find((x) => this.store.canLaunchTemplate(x)) ??
                null,
            );
          }
        } else if (runParam === "1") {
          this.handledDeepLinkKey = key;
          if (this.canOpenRunSuiteDialog()) {
            const sel = this.selectedSuite();
            this.openRunSuiteDialog(
              (sel && this.canRunSuite(sel) ? sel : null) ??
                this.runnableSuites()[0] ??
                null,
            );
          }
        }
      });
    });
  }

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      this.doc.addEventListener("keydown", this.onCaptureKeydown, true);
    });
    this.store.start();
  }

  ngOnDestroy(): void {
    this.doc.removeEventListener("keydown", this.onCaptureKeydown, true);
    this.sp.detach();
    this.store.stop();
  }

  @HostListener("document:click", ["$event"])
  protected onDocClick(ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (this.openPicker() && !t?.closest(".pill-dropdown")) {
      this.openPicker.set(null);
    }
  }

  protected togglePicker(name: string, ev: Event): void {
    ev.stopPropagation();
    this.openPicker.set(this.openPicker() === name ? null : name);
  }

  protected tabCount(tab: ProcessTab): number {
    switch (tab) {
      case "schedules":
        return this.store.schedules().length;
      case "templates":
        return this.store.templates().length;
      case "suites":
        return this.store.suites().length;
      case "declarations":
        return (
          this.store.awaitingAcceptancesCount() ||
          this.store.knownRepos().length
        );
    }
  }

  protected schedBadge = scheduleStatusBadge;
  protected tmplBadge = templateSourceBadge;
  protected cadenceOf = formatCadence;
  protected isTrigger = isEventTrigger;
  protected suiteModeOf = describeSuiteMode;
  protected runBadgeOf = suiteRunBadge;

  protected templateNameById(id: string): string {
    const t = this.store.templates().find((x) => x.id === id);
    return t ? t.name || t.title : "";
  }

  protected suiteNameById(id: string): string {
    return this.store.suites().find((x) => x.id === id)?.name ?? "";
  }

  protected selectSchedule(id: string, fromClick: boolean): void {
    this.selectedScheduleId.set(id);
    if (fromClick) this.mobileDetailOpen.set(true);
    this.scheduleComposition.set(null);
    if (this.canGlobalRoute("GET /api/schedules/{id}/composition")) {
      void this.store
        .fetchScheduleComposition(id)
        .then((c) => {
          if (this.selectedScheduleId() === id) this.scheduleComposition.set(c);
        })
        .catch(() => undefined);
    }
  }

  protected selectTemplate(id: string, fromClick: boolean): void {
    this.selectedTemplateId.set(id);
    if (fromClick) this.mobileDetailOpen.set(true);
    this.templateComposition.set(null);
    const tmpl = this.store.templates().find((t) => t.id === id);
    if (tmpl && this.canGlobalRoute("GET /api/templates/{id}/composition")) {
      const defaults: Record<string, string> = {};
      for (const f of tmpl.fields ?? []) {
        if (f.default) defaults[f.name] = f.default;
      }
      void this.store
        .fetchTemplateComposition(
          id,
          tmpl.repo || "",
          tmpl.base || "",
          true,
          defaults,
        )
        .then((c) => {
          if (this.selectedTemplateId() === id) this.templateComposition.set(c);
        })
        .catch(() => undefined);
    }
  }

  protected selectSuite(id: string, fromClick: boolean): void {
    this.selectedSuiteRunId.set(null);
    this.selectedSuiteId.set(id);
    if (fromClick) this.mobileDetailOpen.set(true);
    this.suiteComposition.set(null);
    if (this.canGlobalRoute("GET /api/suites/{id}/composition")) {
      void this.store
        .fetchSuiteComposition(id)
        .then((c) => {
          if (this.selectedSuiteId() === id) this.suiteComposition.set(c);
        })
        .catch(() => undefined);
    }
  }

  protected selectSuiteRun(id: number, fromClick: boolean): void {
    this.selectedSuiteRunId.set(id);
    if (fromClick) this.mobileDetailOpen.set(true);
    if (this.canGlobalRoute("GET /api/suite-runs/{id}")) {
      void this.store.fetchSuiteRunDetail(id).catch(() => undefined);
    }
  }

  protected selectDeclRepo(repo: string, fromClick: boolean): void {
    this.selectedDeclRepo.set(repo);
    if (fromClick) this.mobileDetailOpen.set(true);
    void this.store.loadRepoInspect(repo);
  }

  protected scheduledTasksFor(s: Schedule) {
    return this.taskFeed
      .tasks()
      .filter(
        (t) =>
          t.scheduled &&
          (!s.repo || t.repo === s.repo) &&
          (t.title === s.title ||
            (s.templateName && t.title === s.templateName)),
      )
      .slice(0, 6);
  }

  protected runsOfSuite(suiteId: string): SuiteRun[] {
    return this.store.suiteRuns().filter((r) => r.suiteId === suiteId);
  }

  protected passesForRun(run: SuiteRun) {
    return buildSuiteRunPasses(run, this.taskFeed.tasks());
  }

  protected hasOpenSuiteTasks(run: SuiteRun): boolean {
    const byId = new Map(this.taskFeed.tasks().map((t) => [t.id, t]));
    return (run.tasks ?? []).some((rt) => {
      const st = (byId.get(rt.taskId)?.state || rt.state || "").toLowerCase();
      return Boolean(rt.taskId) && st !== "closed" && st !== "merged";
    });
  }

  protected repoPendingAcceptances(repo: string): number {
    return this.store.acceptances().filter((a) => a.awaiting && a.repo === repo)
      .length;
  }

  protected acceptancesForRepo(repo: string): DeclarationAcceptanceView[] {
    return this.store.acceptances().filter((a) => !a.repo || a.repo === repo);
  }

  protected canAcceptDeclaration(acc: DeclarationAcceptanceView): boolean {
    if (!this.access.can("POST /api/declarations/accept")) return false;
    return (acc.needsScopes ?? []).every((sc) =>
      this.access.canGlobalScope(sc),
    );
  }

  protected acceptDeniedReason(acc: DeclarationAcceptanceView): string {
    if (!this.access.can("POST /api/declarations/accept")) {
      return this.access.deniedReason("POST /api/declarations/accept");
    }
    const missing = (acc.needsScopes ?? []).filter(
      (sc) => !this.access.canGlobalScope(sc),
    );
    if (missing.length === 0) return "";
    return `Accepting this declaration requires global scope(s): ${missing.join(", ")}.`;
  }

  private scopeRepoLimits(route: RouteKey): string[] {
    const scope = routeScope(route);
    if (!scope || scope === "signed-in") return [];
    const limits = this.access.repoLimits();
    return limits?.[scope] ?? [];
  }

  protected canGlobalRoute(route: RouteKey): boolean {
    return this.access.canGlobalScope(routeScope(route));
  }

  protected canRouteForRepo(route: RouteKey, repo?: string | null): boolean {
    const trimmed = repo?.trim() || "";
    return trimmed
      ? this.access.can(route, trimmed)
      : this.canGlobalRoute(route);
  }

  protected globalDeniedReason(route: RouteKey, label?: string): string {
    const direct = this.access.deniedReason(route);
    if (direct) return direct;
    const scope = routeScope(route);
    const limits = this.scopeRepoLimits(route);
    if (limits.length > 0 && scope) {
      const what = label || "This action";
      return `${what} requires global ${scope} permission (currently scoped to ${limits.join(", ")}).`;
    }
    return this.access.canGlobalScope(scope)
      ? ""
      : "Requires permission outside your current scope.";
  }

  protected repoDeniedReason(
    route: RouteKey,
    repo?: string | null,
    globalLabel?: string,
  ): string {
    const trimmed = repo?.trim() || "";
    if (!trimmed) {
      return this.globalDeniedReason(route, globalLabel);
    }
    return this.access.deniedReason(route, trimmed);
  }

  protected suiteBoundRepos(st: Suite): string[] {
    const byId = new Map(this.store.templates().map((t) => [t.id, t]));
    const seen = new Map<string, string>();
    for (const it of st.items ?? []) {
      const t = byId.get(it.templateId);
      const repo = (t?.repo || t?.declaredIn?.repo || "").trim();
      const key = repo.toLowerCase();
      if (repo && !seen.has(key)) seen.set(key, repo);
    }
    return [...seen.values()];
  }

  protected canRunSuite(st: Suite | null | undefined): boolean {
    if (!st) return false;
    const repos = this.suiteBoundRepos(st);
    if (repos.length === 1) {
      return this.access.can("POST /api/suite-runs", repos[0]);
    }
    return this.canGlobalRoute("POST /api/suite-runs");
  }

  protected runSuiteDeniedReason(st: Suite): string {
    const repos = this.suiteBoundRepos(st);
    if (repos.length === 1) {
      return this.access.deniedReason("POST /api/suite-runs", repos[0]);
    }
    return this.globalDeniedReason(
      "POST /api/suite-runs",
      "Running a cross-repo suite",
    );
  }

  protected runnableSuites(): Suite[] {
    return this.store.suites().filter((st) => this.canRunSuite(st));
  }

  protected canOpenRunSuiteDialog(): boolean {
    return this.store.suites().some((st) => this.canRunSuite(st));
  }

  private suiteRunTaskRepos(sr: SuiteRun): {
    repos: string[];
    hasUnknownRepo: boolean;
  } {
    const byId = new Map(this.taskFeed.tasks().map((t) => [t.id, t]));
    const repos = new Map<string, string>();
    let hasUnknownRepo = false;
    for (const rt of sr.tasks ?? []) {
      const task = byId.get(rt.taskId);
      const st = (task?.state || rt.state || "").toLowerCase();
      if (!rt.taskId || st === "closed" || st === "merged") continue;
      const repo = (task?.repo || sr.repo || "").trim();
      if (repo) {
        const key = repo.toLowerCase();
        if (!repos.has(key)) repos.set(key, repo);
      } else {
        hasUnknownRepo = true;
      }
    }
    if (repos.size === 0 && !hasUnknownRepo && sr.repo?.trim()) {
      const repo = sr.repo.trim();
      repos.set(repo.toLowerCase(), repo);
    }
    return { repos: [...repos.values()], hasUnknownRepo };
  }

  protected canCancelSuiteRun(sr: SuiteRun): boolean {
    const { repos, hasUnknownRepo } = this.suiteRunTaskRepos(sr);
    if (hasUnknownRepo || repos.length === 0) {
      return this.canGlobalRoute("POST /api/tasks/{id}/close");
    }
    return this.access.can("POST /api/tasks/{id}/close", repos);
  }

  protected cancelSuiteRunDeniedReason(sr: SuiteRun): string {
    const { repos, hasUnknownRepo } = this.suiteRunTaskRepos(sr);
    if (hasUnknownRepo || repos.length === 0) {
      return this.globalDeniedReason(
        "POST /api/tasks/{id}/close",
        "Canceling a cross-repo suite run",
      );
    }
    return this.access.deniedReason("POST /api/tasks/{id}/close", repos);
  }

  protected canOpenLaunchTemplateDialog(): boolean {
    return this.store.templates().some((t) => this.store.canLaunchTemplate(t));
  }

  protected launchTemplateDeniedReason(t: Template): string {
    if (t.declaredIn?.repo) {
      if (this.store.canLaunchTemplate(t)) return "";
      return (
        this.access.deniedReason(
          "POST /api/tasks/from-template",
          t.declaredIn.repo,
        ) || this.access.deniedReason("POST /api/tasks", t.declaredIn.repo)
      );
    }
    return this.repoDeniedReason(
      "POST /api/tasks",
      t.repo,
      "Launching this template",
    );
  }

  protected canSubmitLaunchTemplate(): boolean {
    const lt = this.launchSelectedTemplate();
    if (!lt) return false;
    if (lt.declaredIn?.repo) {
      return (
        this.access.can("POST /api/tasks/from-template", lt.declaredIn.repo) ||
        this.access.can("POST /api/tasks", lt.declaredIn.repo)
      );
    }
    if (lt.system) {
      return this.canRouteForRepo("POST /api/tasks", lt.repo);
    }
    const targetRepo = (lt.repo || this.launchRepo()).trim();
    if (!targetRepo) return false;
    return this.access.can("POST /api/tasks", targetRepo);
  }

  protected launchSubmitDeniedReason(): string {
    const lt = this.launchSelectedTemplate();
    if (!lt) return "";
    if (lt.declaredIn?.repo) {
      return this.launchTemplateDeniedReason(lt);
    }
    if (lt.system) {
      return this.repoDeniedReason(
        "POST /api/tasks",
        lt.repo,
        "Launching a system template",
      );
    }
    const targetRepo = (lt.repo || this.launchRepo()).trim();
    if (!targetRepo) return "";
    return this.access.deniedReason("POST /api/tasks", targetRepo);
  }

  protected readonly canEditWorkflow = computed(
    () =>
      !!this.wfEditorRepo() &&
      this.access.can(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.wfEditorRepo(),
      ),
  );

  // --- Schedule actions & dialog ---

  protected closeScheduleDialog(): void {
    this.schedDialogGen++;
    this.resetScheduleDialogState();
    this.schedDialogOpen.set(false);
  }

  protected closeLaunchDialog(): void {
    this.openPicker.set(null);
    this.launchDialogOpen.set(false);
  }

  protected closeRunSuiteDialog(): void {
    this.openPicker.set(null);
    this.runSuiteDialogOpen.set(false);
  }

  protected async runScheduleNow(s: Schedule): Promise<void> {
    try {
      const res = await this.store.runScheduleNow(s.id);
      if (res.taskId) {
        this.snackbar.show(`Triggered schedule — filed task #${res.taskId}.`, {
          label: "Open task",
          run: () => void this.router.navigate(["/task", res.taskId]),
        });
      } else if (res.suiteRunId) {
        this.snackbar.show(
          `Triggered schedule — started suite run #${res.suiteRunId}.`,
        );
      } else if (res.workflowRun && !res.taskId && !res.suiteRunId) {
        this.snackbar.show(
          "No concluded GitHub workflow run matched this trigger yet.",
        );
      } else {
        this.snackbar.show("Schedule triggered.");
      }
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }

  protected async toggleScheduleEnabled(s: Schedule): Promise<void> {
    try {
      const updated = await this.store.updateSchedule(s.id, {
        enabled: !s.enabled,
        revision: s.revision,
      });
      this.snackbar.show(
        updated.enabled ? "Schedule resumed." : "Schedule paused.",
      );
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }

  protected confirmDeleteSchedule(s: Schedule): void {
    this.confirming.set({
      title: "Delete schedule?",
      message: `Remove schedule "${s.title || s.id}" permanently?`,
      accept: "Delete schedule",
      destructive: true,
      run: async () => {
        await this.store.deleteSchedule(s.id);
        if (this.selectedScheduleId() === s.id) {
          this.selectedScheduleId.set(null);
        }
        this.snackbar.show("Schedule deleted.");
      },
    });
  }

  private resetScheduleDialogState(): void {
    this.openPicker.set(null);
    this.submitting.set(false);
    this.editingSchedule.set(null);
    this.schedTargetKind.set("prompt");
    this.sDraftTitle.set("");
    this.sDraftDesc.set("");
    this.sDraftTemplateId.set("");
    this.sDraftSuiteId.set("");
    this.sDraftRepo.set("");
    this.sDraftBase.set("main");
    this.sDraftKind.set("daily");
    this.sDraftEveryMin.set("15");
    this.sDraftEveryHr.set("6");
    this.sDraftTime.set("09:00");
    this.sDraftWeekday.set("monday");
    this.sDraftDayOfMonth.set("1");
    this.sDraftTz.set("UTC");
    this.sDraftTriggerWorkflow.set("");
    this.sDraftTriggerConclusion.set("failure");
    this.sDraftTriggerBranch.set("");
    this.sDraftGitRefRepo.set("");
    this.sDraftGitRef.set("refs/heads/main");
    this.sDraftOverlap.set("skip");
    this.draftSchedComposition.set(null);
    this.schedTouched.set(new Set());
    this.schedSubmitted.set(false);
    this.schedSubmitError.set(null);
    this.store.actionError.set(null);
  }

  protected schedVisibleError(field: SchedFieldKey): string | null {
    if (!this.schedSubmitted() && !this.schedTouched().has(field)) {
      return null;
    }
    return this.schedFieldErrors()[field] ?? null;
  }

  protected markSchedTouched(field: SchedFieldKey): void {
    this.schedTouched.update((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }

  private markAllVisibleSchedTouched(): void {
    const visible = new Set<SchedFieldKey>();
    const editing = this.editingSchedule();
    if (!editing?.system) {
      const tk = this.schedTargetKind();
      if (tk === "template") visible.add("templateId");
      else if (tk === "suite") visible.add("suiteId");
      else visible.add("title");
      visible.add("repo");
      visible.add("base");
    }
    const kind = this.sDraftKind();
    if (kind === "everyNMinutes") {
      visible.add("everyNMinutes");
    } else if (kind === "everyNHours") {
      visible.add("everyNHours");
    } else if (kind === "daily" || kind === "weekly" || kind === "monthly") {
      visible.add("timeOfDay");
      visible.add("timeZone");
      if (kind === "monthly") visible.add("dayOfMonth");
    } else if (kind === "github_workflow_run") {
      visible.add("triggerWorkflow");
    } else if (kind === "git_ref") {
      visible.add("gitRefRepo");
      visible.add("gitRef");
    }
    this.schedTouched.set(visible);
  }

  protected onSchedFieldInput(field: SchedFieldKey, value: string): void {
    this.schedSubmitError.set(null);
    switch (field) {
      case "title":
        this.sDraftTitle.set(value);
        break;
      case "repo":
        this.sDraftRepo.set(value);
        break;
      case "base":
        this.sDraftBase.set(value);
        break;
      case "everyNMinutes":
        this.sDraftEveryMin.set(value);
        break;
      case "everyNHours":
        this.sDraftEveryHr.set(value);
        break;
      case "timeOfDay":
        this.sDraftTime.set(value);
        break;
      case "timeZone":
        this.sDraftTz.set(value);
        break;
      case "dayOfMonth":
        this.sDraftDayOfMonth.set(value);
        break;
      case "triggerWorkflow":
        this.sDraftTriggerWorkflow.set(value);
        break;
      case "gitRefRepo":
        this.sDraftGitRefRepo.set(value);
        break;
      case "gitRef":
        this.sDraftGitRef.set(value);
        break;
    }
  }

  protected onSchedRepoSelect(value: string): void {
    if (!value) return;
    this.schedSubmitError.set(null);
    this.sDraftRepo.set(value);
    this.markSchedTouched("repo");
  }

  protected selectSchedTemplate(id: string): void {
    this.schedSubmitError.set(null);
    this.sDraftTemplateId.set(id);
    this.openPicker.set(null);
    this.markSchedTouched("templateId");
  }

  protected selectSchedSuite(id: string): void {
    this.schedSubmitError.set(null);
    this.sDraftSuiteId.set(id);
    this.openPicker.set(null);
    this.markSchedTouched("suiteId");
  }

  protected setSchedKind(kind: string): void {
    if (this.sDraftKind() === kind) return;
    this.sDraftKind.set(kind);
    this.schedSubmitError.set(null);
    this.schedSubmitted.set(false);
    this.schedTouched.update((prev) => {
      const next = new Set(prev);
      for (const k of SCHED_CADENCE_FIELDS) next.delete(k);
      return next;
    });
  }

  protected setSchedTargetKind(k: "prompt" | "template" | "suite"): void {
    const editing = this.editingSchedule();
    if (editing) {
      if (editing.system) return;
      if (editing.suiteId && k !== "suite") return;
      if (!editing.suiteId && k === "suite") return;
    }
    if (this.schedTargetKind() !== k) {
      this.schedTargetKind.set(k);
      this.schedSubmitError.set(null);
      this.schedSubmitted.set(false);
      this.schedTouched.update((prev) => {
        const next = new Set(prev);
        for (const f of SCHED_TARGET_FIELDS) next.delete(f);
        return next;
      });
    }
    if (k === "template" && !this.sDraftTemplateId()) {
      this.sDraftTemplateId.set(this.schedulableTemplates()[0]?.id ?? "");
    }
    if (k === "suite" && !this.sDraftSuiteId()) {
      this.sDraftSuiteId.set(this.store.suites()[0]?.id ?? "");
    }
  }

  protected openScheduleDialog(existing: Schedule | null): void {
    this.schedDialogGen++;
    this.resetScheduleDialogState();
    this.editingSchedule.set(existing);
    if (existing) {
      const rec = existing.recurrence;
      const kind = rec?.kind || "daily";
      this.schedTargetKind.set(
        existing.suiteId
          ? "suite"
          : existing.templateId
            ? "template"
            : "prompt",
      );
      this.sDraftTitle.set(existing.title || "");
      this.sDraftDesc.set(existing.description || "");
      this.sDraftTemplateId.set(existing.templateId || "");
      this.sDraftSuiteId.set(existing.suiteId || "");
      this.sDraftRepo.set(existing.repo || "");
      this.sDraftBase.set(existing.base ?? "");
      this.sDraftKind.set(kind);
      this.sDraftEveryMin.set(
        kind === "everyNMinutes" && rec?.everyNMinutes != null
          ? String(rec.everyNMinutes)
          : String(rec?.everyNMinutes || 15),
      );
      this.sDraftEveryHr.set(
        kind === "everyNHours" && rec?.everyNHours != null
          ? String(rec.everyNHours)
          : String(rec?.everyNHours || 6),
      );
      this.sDraftTime.set(rec?.timeOfDay || "09:00");
      this.sDraftWeekday.set(rec?.weekday || "monday");
      this.sDraftDayOfMonth.set(
        kind === "monthly" && rec?.dayOfMonth != null
          ? String(rec.dayOfMonth)
          : String(rec?.dayOfMonth || 1),
      );
      this.sDraftTz.set(existing.timeZone || rec?.timeZone || "UTC");
      this.sDraftTriggerWorkflow.set(rec?.githubWorkflowRun?.workflow ?? "");
      this.sDraftTriggerConclusion.set(
        (rec?.githubWorkflowRun?.conclusions ?? []).join(", "),
      );
      this.sDraftTriggerBranch.set(
        (rec?.githubWorkflowRun?.branches ?? []).join(", "),
      );
      this.sDraftGitRefRepo.set(rec?.gitRef?.repo ?? "");
      this.sDraftGitRef.set(rec?.gitRef?.ref ?? "refs/heads/main");
      this.sDraftOverlap.set(existing.overlap || "skip");
    } else {
      this.sDraftRepo.set(this.store.knownRepos()[0] || "");
    }
    this.schedDialogOpen.set(true);
  }

  private scheduleAccessTarget(): {
    route: "POST /api/schedules" | "PATCH /api/schedules/{id}";
    repo: string | undefined;
  } {
    const editing = this.editingSchedule();
    if (editing) {
      return { route: "PATCH /api/schedules/{id}", repo: undefined };
    }
    const tk = this.schedTargetKind();
    const chosenTmpl =
      tk === "template"
        ? this.store.templates().find((t) => t.id === this.sDraftTemplateId())
        : null;
    const targetRepo =
      this.sDraftRepo().trim() ||
      (tk === "template"
        ? chosenTmpl?.repo || chosenTmpl?.declaredIn?.repo || ""
        : "");
    return {
      route: "POST /api/schedules",
      repo: targetRepo || undefined,
    };
  }

  protected canAccessScheduleSave(): boolean {
    const { route, repo } = this.scheduleAccessTarget();
    return this.canRouteForRepo(route, repo);
  }

  protected scheduleSaveDeniedReason(): string {
    const { route, repo } = this.scheduleAccessTarget();
    return this.repoDeniedReason(
      route,
      repo,
      route === "PATCH /api/schedules/{id}"
        ? "Updating a schedule"
        : "Creating an unbound schedule",
    );
  }

  protected canSaveSchedule(): boolean {
    return (
      this.canAccessScheduleSave() &&
      Object.keys(this.schedFieldErrors()).length === 0
    );
  }

  private focusSchedField(field: SchedFieldKey): void {
    const testid = SCHED_FIELD_TESTIDS[field];
    queueMicrotask(() => {
      const dlg = this.schedDialogEl()?.nativeElement;
      if (!dlg?.isConnected) return;
      dlg.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.focus();
    });
  }

  private buildRecurrenceDraft(forPreview = false): Recurrence {
    const kind = this.sDraftKind();
    const tz = this.sDraftTz().trim() || undefined;
    switch (kind) {
      case "everyNMinutes": {
        const parsed = parseStrictInt(this.sDraftEveryMin());
        return {
          kind,
          everyNMinutes: forPreview ? (parsed ?? 15) : (parsed ?? 0),
          timeZone: tz,
        };
      }
      case "everyNHours": {
        const parsed = parseStrictInt(this.sDraftEveryHr());
        return {
          kind,
          everyNHours: forPreview ? (parsed ?? 6) : (parsed ?? 0),
          timeZone: tz,
        };
      }
      case "daily":
        return { kind, timeOfDay: this.sDraftTime().trim(), timeZone: tz };
      case "weekly":
        return {
          kind,
          timeOfDay: this.sDraftTime().trim(),
          weekday: this.sDraftWeekday(),
          timeZone: tz,
        };
      case "monthly": {
        const parsed = parseStrictInt(this.sDraftDayOfMonth());
        return {
          kind,
          timeOfDay: this.sDraftTime().trim(),
          dayOfMonth: forPreview ? (parsed ?? 1) : (parsed ?? 0),
          timeZone: tz,
        };
      }
      case "github_workflow_run": {
        const concls = this.sDraftTriggerConclusion()
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const branches = this.sDraftTriggerBranch()
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean);
        return {
          kind,
          githubWorkflowRun: {
            workflow: this.sDraftTriggerWorkflow().trim() || undefined,
            conclusions: concls.length ? concls : undefined,
            branches: branches.length ? branches : undefined,
          },
        };
      }
      case "git_ref":
        return {
          kind,
          gitRef: {
            repo: this.sDraftGitRefRepo().trim() || this.sDraftRepo().trim(),
            ref: this.sDraftGitRef().trim(),
          },
        };
      default:
        return { kind };
    }
  }

  private buildScheduleCreatePayload(
    forPreview = false,
  ): CreateScheduleRequest {
    const tk = this.schedTargetKind();
    const baseReq: CreateScheduleRequest = {
      repo: this.sDraftRepo().trim(),
      base: this.sDraftBase().trim() || undefined,
      recurrence: this.buildRecurrenceDraft(forPreview),
      timeZone: this.sDraftTz().trim() || undefined,
      overlap: this.sDraftOverlap(),
    };
    if (tk === "template") {
      baseReq.templateId = this.sDraftTemplateId();
    } else if (tk === "suite") {
      baseReq.suiteId = this.sDraftSuiteId();
    } else {
      baseReq.title = this.sDraftTitle().trim();
      baseReq.description = this.sDraftDesc().trim();
      baseReq.capabilities = [];
      baseReq.reads = [];
      baseReq.writes = [];
    }
    return baseReq;
  }

  private buildScheduleUpdatePayload(editing: Schedule): UpdateScheduleRequest {
    const tzTrimmed = this.sDraftTz().trim();
    const timeZone = tzTrimmed || (editing.timeZone ? "" : undefined);
    if (editing.system) {
      return {
        recurrence: this.buildRecurrenceDraft(),
        timeZone,
        overlap: this.sDraftOverlap(),
        revision: editing.revision,
      };
    }
    const tk = this.schedTargetKind();
    const patchReq: UpdateScheduleRequest = {
      repo: this.sDraftRepo().trim(),
      base: this.sDraftBase().trim(),
      recurrence: this.buildRecurrenceDraft(),
      timeZone,
      overlap: this.sDraftOverlap(),
      revision: editing.revision,
    };
    if (tk === "template") {
      patchReq.templateId = this.sDraftTemplateId();
    } else if (tk === "suite") {
      patchReq.suiteId = this.sDraftSuiteId();
    } else {
      patchReq.title = this.sDraftTitle().trim();
      patchReq.description = this.sDraftDesc().trim();
      if (editing.templateId) {
        patchReq.templateId = "";
      }
    }
    return patchReq;
  }

  protected async previewScheduleDraft(): Promise<void> {
    const gen = this.schedDialogGen;
    this.schedSubmitError.set(null);
    try {
      const comp = await this.store.previewDraftSchedule(
        this.buildScheduleCreatePayload(true),
      );
      if (gen === this.schedDialogGen) {
        this.draftSchedComposition.set(comp);
      }
    } catch (err) {
      if (gen === this.schedDialogGen) {
        this.schedSubmitError.set(errorText(err));
      }
    }
  }

  protected onScheduleFormSubmit(ev: Event): void {
    ev.preventDefault();
    void this.saveScheduleDialog();
  }

  protected async saveScheduleDialog(): Promise<void> {
    if (this.submitting()) return;
    this.schedSubmitError.set(null);
    this.schedSubmitted.set(true);
    this.markAllVisibleSchedTouched();
    if (!this.canAccessScheduleSave()) return;
    const errs = this.schedFieldErrors();
    const firstInvalid = SCHED_FIELD_ORDER.find((k) => Boolean(errs[k]));
    if (firstInvalid) {
      this.focusSchedField(firstInvalid);
      return;
    }
    const gen = this.schedDialogGen;
    this.submitting.set(true);
    try {
      const editing = this.editingSchedule();
      if (editing) {
        const saved = await this.store.updateSchedule(
          editing.id,
          this.buildScheduleUpdatePayload(editing),
        );
        if (gen !== this.schedDialogGen) return;
        this.selectSchedule(saved.id, false);
        this.snackbar.show("Schedule updated.");
      } else {
        const created = await this.store.createSchedule(
          this.buildScheduleCreatePayload(),
        );
        if (gen !== this.schedDialogGen) return;
        this.selectSchedule(created.id, false);
        this.snackbar.show("Schedule created.");
      }
      this.closeScheduleDialog();
    } catch (err) {
      if (gen === this.schedDialogGen) {
        this.schedSubmitError.set(errorText(err));
      }
    } finally {
      if (gen === this.schedDialogGen) {
        this.submitting.set(false);
      }
    }
  }

  // --- Template actions & dialogs ---

  protected openLaunchTemplateDialog(t: Template | null): void {
    this.openPicker.set(null);
    const chosen =
      t ??
      this.store.templates().find((x) => this.store.canLaunchTemplate(x)) ??
      this.store.templates()[0] ??
      null;
    this.launchTemplateId.set(chosen?.id ?? "");
    this.initLaunchFields(chosen);
    this.launchRepo.set(chosen?.repo || this.store.knownRepos()[0] || "");
    this.launchBase.set(chosen?.base || "main");
    this.launchApproved.set(this.store.approvedByDefault());
    this.launchDialogOpen.set(true);
  }

  protected pickLaunchTemplate(id: string): void {
    this.launchTemplateId.set(id);
    this.openPicker.set(null);
    const chosen = this.store.templates().find((t) => t.id === id) ?? null;
    this.initLaunchFields(chosen);
  }

  private initLaunchFields(t: Template | null): void {
    const init: Record<string, string> = {};
    for (const f of t?.fields ?? []) {
      init[f.name] = f.default || "";
    }
    this.launchFields.set(init);
  }

  protected setLaunchField(name: string, val: string): void {
    this.launchFields.update((m) => ({ ...m, [name]: val }));
  }

  protected async submitLaunchTemplate(): Promise<void> {
    const tmpl = this.launchSelectedTemplate();
    if (!tmpl || this.submitting() || !this.canSubmitLaunchTemplate()) return;
    this.submitting.set(true);
    try {
      const task = await this.store.launchTaskFromTemplate(tmpl, {
        repo: this.launchRepo(),
        base: this.launchBase(),
        approved: this.launchApproved(),
        fields: this.launchFields(),
      });
      this.closeLaunchDialog();
      if (task?.id) {
        this.snackbar.show(`Created task #${task.id} from template.`);
        await this.router.navigate(["/task", task.id]);
      } else {
        this.snackbar.show("Created task from template.");
      }
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected openTemplateDialog(existing: Template | null): void {
    this.editingTemplate.set(existing);
    if (existing) {
      this.tDraftName.set(existing.name);
      this.tDraftTitle.set(existing.title);
      this.tDraftDesc.set(existing.description);
      this.tDraftRepo.set(existing.repo || "");
      const clonedFields = structuredClone(existing.fields ?? []);
      this.tDraftFields.set(clonedFields);
      this.tDraftParamsCsv.set(clonedFields.map((f) => f.name).join(", "));
      this.tDraftAutoMerge.set(existing.autoMerge);
    } else {
      this.tDraftName.set("");
      this.tDraftTitle.set("");
      this.tDraftDesc.set("");
      this.tDraftRepo.set("");
      this.tDraftFields.set([]);
      this.tDraftParamsCsv.set("");
      this.tDraftAutoMerge.set(false);
    }
    this.tmplDialogOpen.set(true);
  }

  protected onTemplateParamsCsvInput(csv: string): void {
    this.tDraftParamsCsv.set(csv);
    const prevByName = new Map<string, TemplateField>();
    for (const f of this.editingTemplate()?.fields ?? []) {
      prevByName.set(f.name, f);
    }
    for (const f of this.tDraftFields()) {
      prevByName.set(f.name, f);
    }
    const seen = new Set<string>();
    const next: TemplateField[] = [];
    for (const raw of csv.split(",")) {
      const name = raw.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const existing = prevByName.get(name);
      next.push(
        existing ? structuredClone(existing) : { name, required: true },
      );
    }
    this.tDraftFields.set(next);
  }

  protected updateTemplateFieldMeta(
    name: string,
    key: "label" | "default",
    val: string,
  ): void {
    this.tDraftFields.update((list) =>
      list.map((f) =>
        f.name === name ? { ...f, [key]: val || undefined } : f,
      ),
    );
  }

  protected toggleTemplateFieldRequired(name: string): void {
    this.tDraftFields.update((list) =>
      list.map((f) => (f.name === name ? { ...f, required: !f.required } : f)),
    );
  }

  protected canSaveTemplate(): boolean {
    if (!this.tDraftName().trim() || !this.tDraftTitle().trim()) return false;
    const editing = this.editingTemplate();
    if (editing) {
      return this.canGlobalRoute("PATCH /api/templates/{id}");
    }
    return this.canRouteForRepo("POST /api/templates", this.tDraftRepo());
  }

  protected templateSaveDeniedReason(): string {
    const editing = this.editingTemplate();
    if (editing) {
      return this.globalDeniedReason(
        "PATCH /api/templates/{id}",
        "Updating a template",
      );
    }
    return this.repoDeniedReason(
      "POST /api/templates",
      this.tDraftRepo(),
      "Creating an unbound template",
    );
  }

  protected async saveTemplateDialog(): Promise<void> {
    if (this.submitting() || !this.canSaveTemplate()) return;
    this.submitting.set(true);
    const fields = structuredClone(this.tDraftFields());
    try {
      const editing = this.editingTemplate();
      if (editing) {
        const updated = await this.store.updateTemplate(editing.id, {
          name: this.tDraftName().trim(),
          title: this.tDraftTitle().trim(),
          description: this.tDraftDesc(),
          repo: this.tDraftRepo().trim(),
          fields,
          autoMerge: this.tDraftAutoMerge(),
          revision: editing.revision,
        });
        this.selectTemplate(updated.id, false);
        this.snackbar.show("Template updated.");
      } else {
        const created = await this.store.createTemplate({
          name: this.tDraftName().trim(),
          title: this.tDraftTitle().trim(),
          description: this.tDraftDesc(),
          repo: this.tDraftRepo().trim(),
          fields: fields.length ? fields : undefined,
          autoMerge: this.tDraftAutoMerge(),
          capabilities: [],
          reads: [],
          writes: [],
          customFields: {},
        });
        this.selectTemplate(created.id, false);
        this.snackbar.show("Template created.");
      }
      this.tmplDialogOpen.set(false);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected confirmDeleteTemplate(t: Template): void {
    this.confirming.set({
      title: "Delete template?",
      message: `Delete template "${t.name || t.id}"?`,
      accept: "Delete template",
      destructive: true,
      run: async () => {
        await this.store.deleteTemplate(t.id);
        if (this.selectedTemplateId() === t.id) {
          this.selectedTemplateId.set(null);
        }
        this.snackbar.show("Template deleted.");
      },
    });
  }

  // --- Suite & Suite Run actions ---

  protected openSuiteDialog(existing: Suite | null): void {
    this.editingSuite.set(existing);
    this.draftSuiteComposition.set(null);
    if (existing) {
      this.stDraftName.set(existing.name);
      this.stDraftMode.set(existing.mode || "count");
      this.stDraftCount.set(existing.count || 1);
      this.stDraftMaxPasses.set(existing.maxPasses || 3);
      this.stDraftTemplateIds.set(
        (existing.items ?? []).map((i) => i.templateId),
      );
      this.stDraftRequireApproval.set(!!existing.requireApproval);
      this.stDraftAutoMerge.set(!!existing.autoMerge);
    } else {
      this.stDraftName.set("");
      this.stDraftMode.set("count");
      this.stDraftCount.set(1);
      this.stDraftMaxPasses.set(3);
      const firstId = this.schedulableTemplates()[0]?.id;
      this.stDraftTemplateIds.set(firstId ? [firstId] : []);
      this.stDraftRequireApproval.set(false);
      this.stDraftAutoMerge.set(true);
    }
    this.suiteDialogOpen.set(true);
  }

  protected toggleSuiteTemplateId(id: string): void {
    this.stDraftTemplateIds.update((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  protected canSaveSuite(): boolean {
    if (!this.stDraftName().trim() || this.stDraftTemplateIds().length === 0) {
      return false;
    }
    const editing = this.editingSuite();
    return this.canGlobalRoute(
      editing ? "PATCH /api/suites/{id}" : "POST /api/suites",
    );
  }

  protected suiteSaveDeniedReason(): string {
    const editing = this.editingSuite();
    return editing
      ? this.globalDeniedReason("PATCH /api/suites/{id}", "Updating a suite")
      : this.globalDeniedReason("POST /api/suites", "Creating a suite");
  }

  private buildSuiteCreatePayload(): CreateSuiteRequest {
    return {
      name: this.stDraftName().trim(),
      templateIds: this.stDraftTemplateIds(),
      mode: this.stDraftMode(),
      count: this.stDraftCount(),
      maxPasses: this.stDraftMaxPasses(),
      requireApproval: this.stDraftRequireApproval(),
      autoMerge: this.stDraftAutoMerge(),
    };
  }

  protected async previewSuiteDraft(): Promise<void> {
    try {
      const comp = await this.store.previewDraftSuite(
        this.buildSuiteCreatePayload(),
      );
      this.draftSuiteComposition.set(comp);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }

  protected async saveSuiteDialog(): Promise<void> {
    if (this.submitting() || !this.canSaveSuite()) return;
    this.submitting.set(true);
    try {
      const editing = this.editingSuite();
      const payload = this.buildSuiteCreatePayload();
      if (editing) {
        const updated = await this.store.updateSuite(editing.id, {
          ...payload,
          revision: editing.revision,
        });
        this.selectSuite(updated.id, false);
        this.snackbar.show("Suite updated.");
      } else {
        const created = await this.store.createSuite(payload);
        this.selectSuite(created.id, false);
        this.snackbar.show("Suite created.");
      }
      this.suiteDialogOpen.set(false);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected confirmDeleteSuite(st: Suite): void {
    this.confirming.set({
      title: "Delete suite?",
      message: `Delete suite "${st.name}"? Past suite runs keep their snapshots.`,
      accept: "Delete suite",
      destructive: true,
      run: async () => {
        await this.store.deleteSuite(st.id);
        if (this.selectedSuiteId() === st.id) this.selectedSuiteId.set(null);
        this.snackbar.show("Suite deleted.");
      },
    });
  }

  protected openRunSuiteDialog(st: Suite | null): void {
    this.openPicker.set(null);
    const chosen =
      (st && this.canRunSuite(st) ? st : null) ??
      this.runnableSuites()[0] ??
      st ??
      this.store.suites()[0] ??
      null;
    const bound = chosen ? this.suiteBoundRepos(chosen) : [];
    this.runSuiteId.set(chosen?.id ?? "");
    this.runSuiteRepo.set(
      chosen?.declaredIn?.repo ||
        (bound.length === 1 ? bound[0] : "") ||
        this.store.knownRepos()[0] ||
        "",
    );
    this.runSuiteBase.set("main");
    this.runSuiteDialogOpen.set(true);
  }

  protected canSubmitRunSuite(): boolean {
    const repo = this.runSuiteRepo().trim();
    if (!this.runSuiteId() || !repo || !this.runSuiteBase().trim()) {
      return false;
    }
    const chosen = this.store.suites().find((s) => s.id === this.runSuiteId());
    if (!this.canRunSuite(chosen)) return false;
    return this.access.can("POST /api/suite-runs", repo);
  }

  protected runSuiteSubmitDeniedReason(): string {
    const chosen = this.store.suites().find((s) => s.id === this.runSuiteId());
    if (chosen && !this.canRunSuite(chosen)) {
      return this.runSuiteDeniedReason(chosen);
    }
    const repo = this.runSuiteRepo().trim();
    if (!repo) return "";
    return this.access.deniedReason("POST /api/suite-runs", repo);
  }

  protected async submitRunSuite(): Promise<void> {
    if (this.submitting() || !this.canSubmitRunSuite()) return;
    this.submitting.set(true);
    try {
      const run = await this.store.startSuiteRun(
        this.runSuiteId(),
        this.runSuiteRepo(),
        this.runSuiteBase(),
      );
      this.closeRunSuiteDialog();
      this.suitesView.set("runs");
      this.selectSuiteRun(run.id, true);
      this.snackbar.show(`Started suite run #${run.id}.`);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected confirmCancelSuiteRun(sr: SuiteRun): void {
    this.confirming.set({
      title: "Cancel active suite run?",
      message: `Stop and close all open pass tasks in suite run #${sr.id} (${sr.repo})?`,
      accept: "Stop suite tasks",
      destructive: true,
      run: async () => {
        const stopped = await this.store.cancelSuiteRunTasks(sr);
        this.snackbar.show(`Closed ${stopped} active suite task(s).`);
      },
    });
  }

  // --- Repo Declarations & Workflows actions ---

  protected async toggleRepoDeclarations(
    repo: string,
    enabled: boolean,
  ): Promise<void> {
    try {
      await this.store.setRepoDeclarationsEnabled(repo, enabled);
      this.snackbar.show(
        enabled
          ? `Enabled .grain/ declarations for ${repo}.`
          : `Disabled .grain/ declarations for ${repo}.`,
      );
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }

  protected async acceptRepoDeclaration(
    acc: DeclarationAcceptanceView,
  ): Promise<void> {
    if (!this.canAcceptDeclaration(acc)) return;
    try {
      await this.store.acceptDeclaration(acc.id, acc.requested ?? []);
      this.snackbar.show(`Accepted declaration ${acc.id}.`);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }

  protected openWorkflowEditor(repo: string, wf: RepoWorkflow | null): void {
    this.wfEditorRepo.set(repo);
    this.wfEditorOriginalPath.set(wf?.path ?? "");
    this.wfEditorPath.set(wf?.path ?? ".grain/workflows/ci.yml");
    this.wfEditorText.set(
      wf?.text ??
        "name: CI\non:\n  - push\n  - pull_request\njobs:\n  test:\n    steps:\n      - name: Run tests\n        run: go test ./...\n",
    );
    this.wfEditorOpen.set(true);
  }

  protected async saveWorkflowEditor(): Promise<void> {
    if (this.submitting() || !this.canEditWorkflow()) return;
    this.submitting.set(true);
    const repo = this.wfEditorRepo();
    const existing = this.store.repoWorkflows()[repo]?.workflows ?? [];
    const orig = this.wfEditorOriginalPath();
    const updatedList = existing.filter(
      (w) => w.path !== orig && w.path !== this.wfEditorPath().trim(),
    );
    updatedList.push({
      path: this.wfEditorPath().trim(),
      text: this.wfEditorText(),
    });
    try {
      await this.store.saveRepoWorkflows(repo, updatedList);
      this.wfEditorOpen.set(false);
      this.snackbar.show(`Saved workflow ${this.wfEditorPath().trim()}.`);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected async deleteWorkflowOverride(): Promise<void> {
    const orig = this.wfEditorOriginalPath();
    if (!orig || this.submitting() || !this.canEditWorkflow()) return;
    this.submitting.set(true);
    const repo = this.wfEditorRepo();
    const existing = this.store.repoWorkflows()[repo]?.workflows ?? [];
    const remaining = existing.filter((w) => w.path !== orig);
    try {
      await this.store.saveRepoWorkflows(repo, remaining);
      this.wfEditorOpen.set(false);
      this.snackbar.show(`Removed workflow override ${orig}.`);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected workflowRunQueryParams = runProviderQueryParams;

  protected async onConfirmDone(accepted: boolean): Promise<void> {
    const req = this.confirming();
    this.confirming.set(null);
    if (!accepted || !req) return;
    try {
      await req.run();
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }
}
