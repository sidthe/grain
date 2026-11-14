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
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { Subscription } from "rxjs";
import { routePath } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { ViewFilter } from "../services/view-filter.service";
import { errorText } from "../sessions/session-helpers";
import { ActorChipComponent } from "../shared/actor-chip.component";
import {
  ConfirmDialogComponent,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import { DialogTrapDirective } from "../shared/dialog-trap.directive";
import { SplitController } from "../shared/split-controller";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import {
  type CIFault,
  type CIFaultRun,
  type CIFilterId,
  type CIJobRun,
  type CIProviderFilter,
  type CIRun,
  type CIRunArtifact,
  type CIWorkflowOption,
  type QuarantineTestResponse,
  GITHUB_ACTIONS_PROVIDER,
  artifactDownloadable,
  cleanRef,
  extractFailedTests,
  faultFixWhere,
  faultRefCount,
  faultRunCommit,
  faultRunCount,
  faultSourceLabel,
  faultSourceOf,
  faultTitle,
  faultsForRun,
  formatBytes,
  formatDuration,
  isActionsRunId,
  isRunActive,
  parseProviderQueryParam,
  providerOfRun,
  providerQueryParam,
  pullRequestExternalUrl,
  runBadge,
  runBranch,
  runBucket,
  runTaskId,
  runTitle,
  safeExternalUrl,
  stepBadge,
} from "./ci.models";
import { CIStore, type RunArtifactsState } from "./ci.store";

const FILTERS: readonly { id: CIFilterId; label: string; tip: string }[] = [
  { id: "all", label: "All", tip: "Every recorded CI run." },
  {
    id: "running",
    label: "Running",
    tip: "Checks currently executing or queued.",
  },
  {
    id: "failed",
    label: "Failed",
    tip: "Code or test failures attributed to a single branch.",
  },
  {
    id: "errored",
    label: "Errored",
    tip: "Infrastructure or shared deployment faults across branches.",
  },
  { id: "passed", label: "Passed", tip: "Completed green runs." },
  { id: "cancelled", label: "Cancelled", tip: "Stopped or interrupted runs." },
];

const PROVIDERS: readonly { id: CIProviderFilter; label: string }[] = [
  { id: "all", label: "All providers" },
  { id: "grain", label: "Grain CI" },
  { id: "github", label: "GitHub Actions" },
];

@Component({
  selector: "g-ci-page",
  imports: [
    RouterLink,
    TipDirective,
    StatusIconComponent,
    ActorChipComponent,
    ConfirmDialogComponent,
    DialogTrapDirective,
  ],
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    "../shared/work-surface.css",
    "../inbox/inbox-queue.css",
    "./ci-list.css",
    "./ci-detail.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="view-panel is-active"
      aria-labelledby="ci-headline"
      [attr.inert]="modalOpen() ? '' : null"
    >
      <div class="stage-header">
        <div class="view-headline-row">
          <div class="headline-cluster">
            <h1
              class="view-headline"
              id="ci-headline"
              data-testid="ci-headline"
            >
              CI
            </h1>
            @if (store.loaded()) {
              <span class="muted tabular"
                >· {{ filteredRuns().length }} of
                {{ store.runs().length }}</span
              >
            }
          </div>
          @if (
            access.configLoaded() &&
            (access.can("POST /api/ci/runs") || canFlushAnyCache())
          ) {
            <div class="headline-actions">
              @if (access.can("POST /api/ci/runs")) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="ci-open-run-dialog"
                  (click)="openRunWorkflowDialog()"
                >
                  Run workflow
                </button>
              }
              @if (canFlushAnyCache()) {
                <div class="pill-dropdown">
                  <button
                    type="button"
                    class="btn-tonal"
                    data-testid="ci-caches-menu-btn"
                    aria-haspopup="menu"
                    [attr.aria-expanded]="openMenu() === 'caches'"
                    (click)="toggleMenu('caches', $event)"
                  >
                    Flush cache ▾
                  </button>
                  @if (openMenu() === "caches") {
                    <ul
                      class="pop-menu"
                      [class.align-right]="menuAlignRight()"
                      role="menu"
                      data-testid="ci-caches-menu"
                    >
                      @if (access.can("DELETE /api/ci/cache")) {
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="ci-flush-job-cache"
                            (click)="confirmFlushCache('ci')"
                          >
                            Flush Grain CI job cache
                          </button>
                        </li>
                      }
                      @if (
                        access.can(
                          "POST /api/actions-cache/flush",
                          repoFilter() || undefined
                        )
                      ) {
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="ci-flush-actions-cache"
                            (click)="confirmFlushCache('actions')"
                          >
                            Flush Actions cache{{
                              repoFilter() ? " (" + repoFilter() + ")" : ""
                            }}
                          </button>
                        </li>
                      }
                      @if (access.can("POST /api/package-cache/flush")) {
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="ci-flush-package-cache"
                            (click)="confirmFlushCache('package')"
                          >
                            Flush proxy package cache
                          </button>
                        </li>
                      }
                    </ul>
                  }
                </div>
              }
            </div>
          }
        </div>
        <p class="view-subtitle">
          Grain CI and external checks: shared infrastructure faults (Errored)
          are separated from branch code failures (Failed) so nobody debugs an
          outage as their own bug.
        </p>

        <div
          class="filter-strip"
          role="toolbar"
          aria-label="CI conclusion filter"
        >
          @for (f of filters; track f.id) {
            <button
              type="button"
              class="filter-chip"
              [attr.aria-pressed]="bucketFilter() === f.id"
              [attr.data-testid]="'ci-filter-' + f.id"
              [gTip]="f.tip"
              (click)="setBucketFilter(f.id)"
            >
              {{ f.label }}
              <span class="tabular">{{ counts()[f.id] }}</span>
            </button>
          }
        </div>

        <div class="ci-toolbar" role="toolbar" aria-label="CI scope filters">
          <div class="pill-dropdown">
            <button
              type="button"
              class="pill-trigger"
              [class.is-filtered]="!!repoFilter()"
              data-testid="ci-repo-pill"
              aria-haspopup="listbox"
              [attr.aria-expanded]="openMenu() === 'repo'"
              [gTip]="repoFilter() ? 'Repo: ' + repoFilter() : null"
              (click)="toggleMenu('repo', $event)"
            >
              <span>Repo: {{ repoFilter() || "All" }}</span>
              <span aria-hidden="true">▾</span>
            </button>
            @if (openMenu() === "repo") {
              <ul
                class="pop-menu"
                [class.align-right]="menuAlignRight()"
                role="listbox"
                aria-label="Repository filter"
                data-testid="ci-repo-menu"
              >
                <li role="none">
                  <button
                    type="button"
                    role="option"
                    [attr.aria-selected]="!repoFilter()"
                    (click)="pickRepo('')"
                  >
                    All repositories
                  </button>
                </li>
                @for (r of availableRepos(); track r) {
                  <li role="none">
                    <button
                      type="button"
                      role="option"
                      [attr.aria-selected]="repoFilter() === r"
                      (click)="pickRepo(r)"
                    >
                      {{ r }}
                    </button>
                  </li>
                }
              </ul>
            }
          </div>

          <div class="pill-dropdown">
            <button
              type="button"
              class="pill-trigger"
              [class.is-filtered]="!!branchFilter()"
              data-testid="ci-branch-pill"
              aria-haspopup="listbox"
              [attr.aria-expanded]="openMenu() === 'branch'"
              [gTip]="branchFilter() ? 'Branch: ' + branchFilter() : null"
              (click)="toggleMenu('branch', $event)"
            >
              <span>Branch: {{ branchFilter() || "All" }}</span>
              <span aria-hidden="true">▾</span>
            </button>
            @if (openMenu() === "branch") {
              <ul
                class="pop-menu"
                [class.align-right]="menuAlignRight()"
                role="listbox"
                aria-label="Branch filter"
                data-testid="ci-branch-menu"
              >
                <li role="none">
                  <button
                    type="button"
                    role="option"
                    [attr.aria-selected]="!branchFilter()"
                    (click)="pickBranch('')"
                  >
                    All branches
                  </button>
                </li>
                @for (b of availableBranches(); track b) {
                  <li role="none">
                    <button
                      type="button"
                      role="option"
                      [attr.aria-selected]="branchFilter() === b"
                      (click)="pickBranch(b)"
                    >
                      {{ b }}
                    </button>
                  </li>
                }
              </ul>
            }
          </div>

          <div class="segmented" role="group" aria-label="CI provider">
            @for (p of providers; track p.id) {
              <button
                type="button"
                [attr.aria-pressed]="providerFilter() === p.id"
                [attr.data-testid]="'ci-provider-' + p.id"
                (click)="setProviderFilter(p.id)"
              >
                {{ p.label }}
              </button>
            }
          </div>

          @if (faultDigestFilter()) {
            <button
              type="button"
              class="pill-trigger is-filtered"
              data-testid="ci-clear-fault-filter"
              (click)="faultDigestFilter.set('')"
            >
              Filtered to fault cluster · Clear ✕
            </button>
          }

          <span class="split-controls">
            <button
              type="button"
              class="btn-text"
              [attr.aria-pressed]="sp.collapsed()"
              (click)="sp.toggleCollapsed()"
            >
              {{ sp.collapsed() ? "Show list" : "Hide list" }}
            </button>
          </span>
        </div>
      </div>

      @if (store.loadError(); as err) {
        <p class="banner banner-error" role="alert" data-testid="ci-load-error">
          {{ err }}
        </p>
      }
      @if (store.actionError(); as err) {
        <p
          class="banner banner-error"
          role="alert"
          data-testid="ci-action-error"
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
      @if (store.actionsNote(); as note) {
        <p class="banner banner-info" data-testid="ci-actions-note">
          {{ note }}
        </p>
      }

      @if (sharedFaults().length > 0 || counts().errored > 0) {
        <section
          class="ci-faults-banner"
          aria-label="Shared infrastructure faults"
          data-testid="ci-faults-banner"
        >
          <div class="ci-faults-head">
            <div class="ci-faults-title">
              <span class="status-pill blast">
                <g-status-icon tone="blast" kind="blast" />
                Shared infrastructure fault
              </span>
              <span>
                @if (sharedFaults().length > 0) {
                  {{ sharedFaults().length }} active fault
                  {{ sharedFaults().length === 1 ? "cluster" : "clusters" }}
                  across branches
                } @else {
                  {{ counts().errored }}
                  {{ counts().errored === 1 ? "run" : "runs" }} errored on
                  sandbox or runner setup
                }
              </span>
            </div>
            @if (sharedFaults().length > 0) {
              <button
                type="button"
                class="btn-text"
                data-testid="ci-faults-toggle"
                [attr.aria-expanded]="faultsExpanded()"
                (click)="faultsExpanded.set(!faultsExpanded())"
              >
                {{
                  faultsExpanded() ? "Collapse clusters" : "Inspect clusters"
                }}
              </button>
            }
          </div>
          <p class="ci-faults-sub">
            <strong>Errored</strong> runs hit a shared deployment, sandbox,
            cache, or base-branch fault — distinct from
            <strong>Failed</strong> runs ({{ counts().failed }}), which are
            isolated code/test failures on one branch.
          </p>
          @if (faultsExpanded() && sharedFaults().length > 0) {
            <div class="ci-faults-grid" data-testid="ci-faults-clusters">
              @for (f of sharedFaults(); track $index) {
                <article class="ci-fault-card" data-testid="ci-fault-card">
                  <div class="ci-fault-card-top">
                    <div class="ci-fault-card-head-left">
                      <span
                        class="ci-provider-tag"
                        [attr.data-testid]="'ci-fault-source-' + faultSource(f)"
                        >{{ faultSourceText(f) }}</span
                      >
                      <span class="ci-fault-summary">{{ faultLabel(f) }}</span>
                    </div>
                    <span class="status-pill blast tabular">
                      <g-status-icon tone="blast" kind="blast" />
                      {{ faultRuns(f) }}
                      {{ faultRuns(f) === 1 ? "run" : "runs" }}
                    </span>
                  </div>
                  <div class="ci-fault-meta">
                    @if (f.repo) {
                      <span class="tabular">{{ f.repo }}</span>
                    }
                    @if (f.summary && f.step) {
                      <span>step {{ f.step }}</span>
                    }
                    @if (faultRefs(f) > 0) {
                      <span class="tabular"
                        >{{ faultRefs(f) }}
                        {{ faultRefs(f) === 1 ? "branch" : "branches" }}</span
                      >
                    }
                    @if (f.paths?.length) {
                      <span class="tabular" data-testid="ci-fault-paths"
                        >Files: {{ f.paths!.join(", ") }}</span
                      >
                    }
                    @if (f.ownerTaskId) {
                      <a
                        [routerLink]="['/task', f.ownerTaskId]"
                        data-testid="ci-fault-owner"
                        >Assigned fix #{{ f.ownerTaskId }}
                        @if (f.ownerRef) {
                          ({{ cleanRefOf(f.ownerRef) }})
                        }
                      </a>
                    }
                    @for (fix of f.fixes ?? []; track fix.pullRequest) {
                      @let prHref = prUrlOf(fix.pullRequest);
                      @if (fix.task && prHref) {
                        <a
                          [href]="prHref"
                          target="_blank"
                          rel="noopener noreferrer"
                          [attr.title]="fix.title || null"
                          >Fix PR {{ fix.pullRequest }}</a
                        >
                        <a [routerLink]="['/task', fix.task]"
                          >(#{{ fix.task }})</a
                        >
                        <span>{{ fixWhereOf(fix) }}</span>
                      } @else if (fix.task) {
                        <a
                          [routerLink]="['/task', fix.task]"
                          [attr.title]="fix.title || null"
                          >Fix PR {{ fix.pullRequest }} (#{{ fix.task }})</a
                        >
                        <span>{{ fixWhereOf(fix) }}</span>
                      } @else if (prHref) {
                        <a
                          [href]="prHref"
                          target="_blank"
                          rel="noopener noreferrer"
                          [attr.title]="fix.title || null"
                          >Fix PR {{ fix.pullRequest }}</a
                        >
                        <span>{{ fixWhereOf(fix) }}</span>
                      } @else {
                        <span class="tabular"
                          >Fix PR {{ fix.pullRequest }}
                          {{ fixWhereOf(fix) }}</span
                        >
                      }
                    }
                  </div>
                  @if (f.runs?.length) {
                    <ul
                      class="ci-fault-runs"
                      aria-label="Affected runs"
                      data-testid="ci-fault-runs"
                    >
                      @for (fr of f.runs!; track fr.runId + ":" + $index) {
                        @let targetId = resolveFaultRunId(f, fr);
                        @let artOpen = isFaultRunArtifactsOpen(f, fr);
                        @let artState = faultRunArtifacts(targetId);
                        <li
                          class="ci-fault-run-item"
                          [attr.data-testid]="'ci-fault-run-' + fr.runId"
                        >
                          <div class="ci-fault-run-row">
                            <a
                              class="ci-fault-run-link"
                              [routerLink]="['/ci', 'runs', targetId]"
                              [queryParams]="faultRunQueryParams(f, targetId)"
                              queryParamsHandling="merge"
                              [attr.data-testid]="
                                'ci-fault-run-link-' + fr.runId
                              "
                              (click)="onFaultRunOpen(targetId)"
                              ><code class="ci-sha">{{ fr.runId }}</code></a
                            >
                            @if (fr.ref) {
                              <span class="muted">{{
                                cleanRefOf(fr.ref)
                              }}</span>
                            }
                            @if (faultCommitOf(fr); as c) {
                              <code class="ci-sha">{{ c.slice(0, 7) }}</code>
                            }
                            @if (fr.taskId) {
                              <a
                                [routerLink]="['/task', fr.taskId]"
                                [attr.data-testid]="
                                  'ci-fault-run-task-' + fr.runId
                                "
                                >#{{ fr.taskId }}</a
                              >
                            }
                            <button
                              type="button"
                              class="btn-text ci-fault-art-btn"
                              [attr.aria-expanded]="artOpen"
                              [attr.data-testid]="
                                'ci-fault-run-artifacts-btn-' + fr.runId
                              "
                              (click)="toggleFaultRunArtifacts(f, fr)"
                            >
                              {{ artOpen ? "Hide artifacts" : "Artifacts" }}
                            </button>
                          </div>
                          @if (artOpen) {
                            <div
                              class="ci-fault-run-artifacts"
                              [attr.data-testid]="
                                'ci-fault-run-artifacts-' + fr.runId
                              "
                            >
                              @if (artState?.loading) {
                                <span class="muted"
                                  >Loading artifacts for {{ targetId }}…</span
                                >
                              } @else if (
                                !access.can(
                                  "GET /api/ci/runs/{id}/artifacts",
                                  f.repo
                                )
                              ) {
                                <span
                                  class="muted"
                                  [attr.data-testid]="
                                    'ci-fault-art-denied-' + fr.runId
                                  "
                                >
                                  {{
                                    access.deniedReason(
                                      "GET /api/ci/runs/{id}/artifacts",
                                      f.repo
                                    )
                                  }}
                                </span>
                              } @else if (artState?.error) {
                                <span class="ci-fault-art-err" role="alert">{{
                                  artState!.error
                                }}</span>
                              } @else if (
                                artState &&
                                !artState.enabled &&
                                faultSource(f) !== "github"
                              ) {
                                <span class="muted"
                                  >Grain CI is not enabled on this
                                  deployment.</span
                                >
                              } @else if (
                                artState &&
                                !artState.available &&
                                !artState.artifacts.length &&
                                faultSource(f) !== "github"
                              ) {
                                <span class="muted"
                                  >This deployment keeps no CI artifacts.</span
                                >
                              } @else if (
                                !artState || artState.artifacts.length === 0
                              ) {
                                <span class="muted"
                                  >No stored artifacts for run
                                  <code>{{ targetId }}</code
                                  >.</span
                                >
                              } @else {
                                <ul class="ci-fault-art-list">
                                  @for (
                                    art of artState.artifacts;
                                    track (art.job || "") +
                                      ":" +
                                      art.name +
                                      ":" +
                                      $index
                                  ) {
                                    <li class="ci-fault-art-row">
                                      <span>
                                        <strong>{{ art.name }}</strong>
                                        @if (art.job) {
                                          <span class="muted">
                                            · job {{ art.job }}</span
                                          >
                                        }
                                        @if (art.bytes || art.size; as sz) {
                                          <span class="tabular muted">
                                            · {{ bytesOf(sz) }}</span
                                          >
                                        }
                                        @if (art.note) {
                                          <span class="muted">
                                            — {{ art.note }}</span
                                          >
                                        }
                                      </span>
                                      @if (
                                        canDownloadArtifactFor(
                                          targetId,
                                          f.repo,
                                          art
                                        )
                                      ) {
                                        <a
                                          [href]="
                                            artifactHref(
                                              art.run || targetId,
                                              art
                                            )
                                          "
                                          download
                                          [attr.data-testid]="
                                            'ci-fault-artifact-download-' +
                                            fr.runId +
                                            '-' +
                                            art.name
                                          "
                                          >Download .tar.gz</a
                                        >
                                      }
                                    </li>
                                  }
                                </ul>
                                @if (
                                  artState.truncated && artState.nextCursor
                                ) {
                                  <button
                                    type="button"
                                    class="btn-text ci-fault-art-btn"
                                    (click)="
                                      loadMoreFaultArtifacts(
                                        targetId,
                                        f.repo,
                                        artState.nextCursor
                                      )
                                    "
                                  >
                                    Load more ({{
                                      artState.artifacts.length
                                    }}
                                    of {{ artState.total }})
                                  </button>
                                }
                              }
                            </div>
                          }
                        </li>
                      }
                    </ul>
                    @if (faultRuns(f) > f.runs!.length) {
                      <span class="muted" style="font-size: 12px"
                        >Showing {{ f.runs!.length }} of
                        {{ faultRuns(f) }} affected runs</span
                      >
                    }
                  }
                  <div>
                    <button
                      type="button"
                      class="btn-text"
                      data-testid="ci-fault-inspect-runs"
                      (click)="inspectFault(f)"
                    >
                      Inspect affected runs →
                    </button>
                  </div>
                </article>
              }
            </div>
          }
        </section>
      }

      <div
        class="inbox-split ci-split"
        #split
        [class.is-collapsed]="sp.collapsed()"
        [class.is-dragging]="sp.dragging()"
        [class.has-mobile-detail]="mobileDetailOpen()"
        [style.--queue-w.%]="sp.ratioExact()"
      >
        <section
          class="queue-pane"
          aria-label="CI runs"
          data-testid="ci-runs-list"
        >
          @if (!store.enabled()) {
            <div class="empty-state" data-testid="ci-disabled">
              <p>Grain CI is not enabled on this deployment.</p>
            </div>
          } @else if (store.loaded() && filteredRuns().length === 0) {
            <div class="empty-state" data-testid="ci-empty">
              <p>No CI runs match the current filters.</p>
              @if (hasActiveFilters()) {
                <button
                  type="button"
                  class="btn-tonal"
                  (click)="resetFilters()"
                >
                  Clear filters
                </button>
              }
            </div>
          } @else {
            <ul class="ci-run-list">
              @for (r of filteredRuns(); track r.id) {
                @let badge = badgeOf(r);
                <li
                  class="ci-run-row"
                  [class.is-selected]="store.selectedId() === r.id"
                  [attr.data-testid]="'ci-run-row-' + r.id"
                  tabindex="0"
                  role="button"
                  [attr.aria-current]="
                    store.selectedId() === r.id ? 'true' : null
                  "
                  (click)="openRun(r.id, true)"
                  (keydown.enter)="openRun(r.id, true)"
                  (keydown.space)="openRun(r.id, true); $event.preventDefault()"
                >
                  <div class="ci-run-row-top">
                    <span [class]="'status-pill ' + badge.tone">
                      <g-status-icon
                        [tone]="badge.tone"
                        [kind]="badge.iconKind"
                      />
                      {{ badge.label }}
                    </span>
                    <span class="ci-run-title">{{ titleOf(r) }}</span>
                    <span class="ci-provider-tag">{{
                      providerOf(r) === "github" ? "GitHub" : "Grain"
                    }}</span>
                  </div>
                  <div class="ci-run-sub">
                    <span class="tabular">{{ r.repo }}</span>
                    @if (branchOf(r); as br) {
                      <span class="tabular">· {{ br }}</span>
                    }
                    @if (r.commit) {
                      <span class="tabular"
                        >&#64; {{ r.commit.slice(0, 7) }}</span
                      >
                    }
                    @if (
                      durationOf(r.startedAt, r.finishedAt, nowMs());
                      as dur
                    ) {
                      <span class="tabular">· {{ dur }}</span>
                    }
                    @if (taskIdOf(r); as tid) {
                      <span class="tabular">· #{{ tid }}</span>
                    }
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        <div
          class="inbox-resizer"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Resize CI run list and inspector"
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

        <section
          class="ci-inspector"
          aria-label="CI run inspector"
          data-testid="ci-inspector"
        >
          @if (store.activeRun(); as run) {
            @let badge = badgeOf(run);
            @let runFaults = faultsOf(run);
            <div class="ci-insp-head">
              <div class="ci-insp-top">
                <div class="headline-cluster">
                  <button
                    type="button"
                    class="btn-text ci-mobile-back"
                    data-testid="ci-mobile-back"
                    (click)="closeMobileDetail()"
                  >
                    ← All runs
                  </button>
                  <span
                    [class]="'status-pill ' + badge.tone"
                    data-testid="ci-detail-status"
                  >
                    <g-status-icon
                      [tone]="badge.tone"
                      [kind]="badge.iconKind"
                    />
                    {{ badge.label }}
                  </span>
                  <h2 class="ci-insp-title" data-testid="ci-detail-title">
                    {{ titleOf(run) }}
                  </h2>
                </div>

                @let canCancelRun =
                  isActive(run) &&
                  access.configLoaded() &&
                  access.can("DELETE /api/ci/runs/{id}", run.repo);
                @let canRerunRun =
                  providerOf(run) === "grain" &&
                  access.configLoaded() &&
                  access.can("POST /api/ci/runs", run.repo);
                @let canQuarantineTest =
                  access.configLoaded() &&
                  access.can("POST /api/tests/quarantine", run.repo);
                @if (canCancelRun || canRerunRun || canQuarantineTest) {
                  <div class="headline-actions">
                    @if (canCancelRun) {
                      <button
                        type="button"
                        class="btn-tonal danger"
                        data-testid="ci-cancel-run-btn"
                        gTip="Stop this running CI check."
                        (click)="confirmCancelRun(run)"
                      >
                        Cancel run
                      </button>
                    }
                    @if (canRerunRun) {
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="ci-rerun-btn"
                        gTip="Re-run checks bypassing cached job verdicts."
                        (click)="rerunSelected(run, false)"
                      >
                        Re-run all
                      </button>
                      @if (
                        badge.bucket === "failed" || badge.bucket === "errored"
                      ) {
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="ci-rerun-failed-btn"
                          (click)="rerunSelected(run, true)"
                        >
                          Re-run failed
                        </button>
                      }
                    }
                    @if (canQuarantineTest) {
                      <button
                        type="button"
                        class="btn-outlined"
                        data-testid="ci-open-quarantine-btn"
                        gTip="Quarantine a flaky test with TTL and optional repair task."
                        (click)="openQuarantineDialog(run)"
                      >
                        Quarantine test
                      </button>
                    }
                  </div>
                }
              </div>

              <div class="ci-insp-meta">
                <g-actor-chip
                  [label]="actorLabel(run)"
                  [kind]="actorKind(run)"
                />
                <code class="ci-sha" data-testid="ci-detail-run-id">{{
                  run.id
                }}</code>
                <span class="tabular">{{ run.repo }}</span>
                @if (branchOf(run); as br) {
                  <span class="tabular"
                    >branch <strong>{{ br }}</strong></span
                  >
                }
                @if (run.commit) {
                  <code class="ci-sha" data-testid="ci-detail-sha">{{
                    run.commit.slice(0, 12)
                  }}</code>
                }
                @if (taskIdOf(run); as tid) {
                  <a
                    class="part-of-link"
                    [routerLink]="['/task', tid]"
                    data-testid="ci-detail-task-link"
                    >Task #{{ tid }}</a
                  >
                }
                @if (
                  durationOf(run.startedAt, run.finishedAt, nowMs());
                  as dur
                ) {
                  <span class="tabular" data-testid="ci-detail-duration"
                    >Duration {{ dur }}</span
                  >
                }
                @if (safeUrl(run.actions?.url || run.url); as extUrl) {
                  <a
                    [href]="extUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="ci-external-link"
                    >Open on GitHub ↗</a
                  >
                }
              </div>

              @if (badge.bucket === "errored" || runFaults.length > 0) {
                <div
                  class="ci-verdict-callout is-errored"
                  data-testid="ci-errored-callout"
                >
                  <strong
                    >Shared deployment / infrastructure fault — do not blame
                    branch code</strong
                  >
                  @if (run.error) {
                    <span>{{ run.error }}</span>
                  }
                  @for (f of runFaults; track $index) {
                    <span>
                      Seen across {{ faultRuns(f) }} runs /
                      {{ faultRefs(f) }} branches: {{ faultLabel(f) }}
                      @if (f.ownerTaskId) {
                        —
                        <a [routerLink]="['/task', f.ownerTaskId]"
                          >assigned to #{{ f.ownerTaskId }}</a
                        >
                      }
                    </span>
                    @if (f.paths?.length) {
                      <span>Common files: {{ f.paths!.join(", ") }}</span>
                    }
                    @if (f.runs?.length) {
                      <span
                        class="ci-fault-callout-runs"
                        data-testid="ci-errored-callout-runs"
                      >
                        Affected runs:
                        @for (
                          fr of f.runs!;
                          track fr.runId + ":" + $index;
                          let last = $last
                        ) {
                          @let targetId = resolveFaultRunId(f, fr);
                          @if (targetId === run.id || fr.runId === run.id) {
                            <code
                              class="ci-sha"
                              [attr.data-testid]="'ci-callout-run-' + fr.runId"
                              >{{ fr.runId }}</code
                            >
                          } @else {
                            <a
                              [routerLink]="['/ci', 'runs', targetId]"
                              [queryParams]="faultRunQueryParams(f, targetId)"
                              queryParamsHandling="merge"
                              [attr.data-testid]="
                                'ci-callout-run-link-' + fr.runId
                              "
                              (click)="onFaultRunOpen(targetId)"
                              ><code class="ci-sha">{{ fr.runId }}</code></a
                            >
                          }
                          @if (fr.ref) {
                            <span>({{ cleanRefOf(fr.ref) }})</span>
                          }
                          @if (!last) {
                            <span>·</span>
                          }
                        }
                      </span>
                    }
                  }
                </div>
              } @else if (badge.bucket === "failed") {
                <div
                  class="ci-verdict-callout is-failed"
                  data-testid="ci-failed-callout"
                >
                  <strong>Branch code / test failure</strong>
                  <span>
                    Isolated to {{ branchOf(run) || run.repo }} — no matching
                    cross-branch fault cluster detected.
                  </span>
                </div>
              }
              @if (run.cancelReason) {
                <p class="muted" data-testid="ci-cancel-reason">
                  Cancel note: {{ run.cancelReason }}
                </p>
              }
            </div>

            <div class="ci-jobs-section">
              <h3 class="section-title">
                Jobs & steps
                <span class="muted tabular"
                  >({{ (run.jobs ?? []).length }})</span
                >
              </h3>

              @if (store.detailLoading() && !(run.jobs ?? []).length) {
                <p class="muted">Loading run jobs and step logs…</p>
              } @else if (!(run.jobs ?? []).length) {
                <p class="muted">
                  {{ run.error || "No jobs recorded on this run." }}
                </p>
              }

              @for (job of run.jobs ?? []; track job.jobId || job.name) {
                @let jBadge =
                  stepBadgeOf(job.conclusion, job.startedAt, job.finishedAt);
                @let jOpen = isJobOpen(run.id, job);
                <div
                  class="ci-job-card"
                  [attr.data-testid]="'ci-job-' + (job.jobId || job.name)"
                >
                  <button
                    type="button"
                    class="ci-job-head"
                    [attr.aria-expanded]="jOpen"
                    (click)="toggleJob(run, job)"
                  >
                    <span [class]="'status-pill ' + jBadge.tone">
                      <g-status-icon
                        [tone]="jBadge.tone"
                        [kind]="jBadge.iconKind"
                      />
                      {{ jBadge.label }}
                    </span>
                    <span class="ci-job-name">
                      {{ job.name || job.jobId }}
                      @if (job.workflow) {
                        <span class="muted"> · {{ job.workflow }}</span>
                      }
                    </span>
                    @if (job.cached) {
                      <span class="ci-provider-tag">Cached</span>
                    }
                    @if (job.flake || job.retried) {
                      <span class="ci-provider-tag">Retried</span>
                    }
                    @if (
                      durationOf(job.startedAt, job.finishedAt, nowMs());
                      as jDur
                    ) {
                      <span class="tabular muted">{{ jDur }}</span>
                    }
                    <span aria-hidden="true">{{ jOpen ? "▾" : "▸" }}</span>
                  </button>

                  @if (jOpen) {
                    <div class="ci-steps-list">
                      @let jArts = jobArtifacts(job);
                      @if (jArts.length > 0) {
                        <ul
                          class="ci-job-artifacts"
                          aria-label="Job artifacts"
                          data-testid="ci-job-artifacts"
                        >
                          @for (
                            art of jArts;
                            track (art.job || "") +
                              ":" +
                              art.name +
                              ":" +
                              $index
                          ) {
                            <li
                              class="ci-job-artifact-row"
                              data-testid="ci-job-artifact-row"
                            >
                              <span class="muted">Artifact</span>
                              @if (
                                canDownloadArtifactFor(run.id, run.repo, art)
                              ) {
                                <a
                                  [href]="artifactHref(art.run || run.id, art)"
                                  download
                                  data-testid="ci-job-artifact-download"
                                  ><strong>{{ art.name }}</strong></a
                                >
                              } @else {
                                <strong>{{ art.name }}</strong>
                              }
                              @if (art.bytes || art.size; as sz) {
                                <span class="tabular muted"
                                  >({{ bytesOf(sz)
                                  }}{{ art.stored ? ", .tar.gz" : "" }})</span
                                >
                              }
                              @if (art.note) {
                                <span class="muted">— {{ art.note }}</span>
                              }
                            </li>
                          }
                        </ul>
                      }
                      @if (job.error) {
                        <p class="banner banner-error">{{ job.error }}</p>
                      }
                      @if (providerOf(run) === "github") {
                        <div style="padding: 8px 14px">
                          <button
                            type="button"
                            class="btn-tonal"
                            data-testid="ci-fetch-gha-log"
                            (click)="
                              loadExternalJobLog(run.id, job.name || job.jobId)
                            "
                          >
                            {{
                              jobLogFor(run.id, job.name || job.jobId)
                                ? "Refresh GitHub job log"
                                : "Load GitHub job log"
                            }}
                          </button>
                        </div>
                        @if (
                          jobLogFor(run.id, job.name || job.jobId);
                          as ghaLog
                        ) {
                          @let lines = filterLogLines(ghaLog.log);
                          <div class="ci-log-well" data-testid="ci-log-viewer">
                            <div class="ci-log-bar">
                              <span class="tabular"
                                >{{ ghaLog.job }} ({{
                                  bytesOf(ghaLog.bytes)
                                }})</span
                              >
                              <form
                                role="search"
                                autocomplete="off"
                                style="display: contents"
                                (submit)="$event.preventDefault()"
                              >
                                <input
                                  type="search"
                                  name="grain-ci-log-search"
                                  autocomplete="off"
                                  spellcheck="false"
                                  data-lpignore="true"
                                  data-1p-ignore="true"
                                  class="ci-log-search"
                                  placeholder="Search log…"
                                  aria-label="Search log lines"
                                  data-testid="ci-log-search"
                                  [value]="logSearch()"
                                  (input)="
                                    logSearch.set($any($event.target).value)
                                  "
                                />
                              </form>
                              <button
                                type="button"
                                class="btn-text"
                                (click)="copyText(ghaLog.log, 'Copied job log')"
                              >
                                Copy
                              </button>
                            </div>
                            <div class="ci-log-lines">
                              @for (ln of lines; track ln.num) {
                                <div
                                  class="ci-log-line"
                                  [class.is-match]="ln.match"
                                >
                                  <span class="ci-log-ln">{{ ln.num }}</span>
                                  <span class="ci-log-txt">{{ ln.text }}</span>
                                </div>
                              }
                            </div>
                          </div>
                        }
                      }

                      @for (step of job.steps ?? []; track $index) {
                        @let sBadge =
                          stepBadgeOf(
                            step.conclusion,
                            step.startedAt,
                            step.finishedAt
                          );
                        @let sOpen = isStepOpen(run.id, job, step, $index);
                        <div class="ci-step-item">
                          <button
                            type="button"
                            class="ci-step-btn"
                            [attr.aria-expanded]="sOpen"
                            [attr.data-testid]="'ci-step-btn-' + $index"
                            (click)="toggleStep(run.id, job, $index)"
                          >
                            <span [class]="'status-pill ' + sBadge.tone">
                              <g-status-icon
                                [tone]="sBadge.tone"
                                [kind]="sBadge.iconKind"
                              />
                              {{ sBadge.label }}
                            </span>
                            <span class="ci-job-name">{{ step.name }}</span>
                            @if (
                              step.exitCode !== undefined &&
                              step.exitCode >= 0 &&
                              step.exitCode !== 0
                            ) {
                              <span class="tabular muted"
                                >exit {{ step.exitCode }}</span
                              >
                            }
                            @if (
                              durationOf(
                                step.startedAt,
                                step.finishedAt,
                                nowMs()
                              );
                              as sDur
                            ) {
                              <span class="tabular muted">{{ sDur }}</span>
                            }
                            <span aria-hidden="true">{{
                              sOpen ? "▾" : "▸"
                            }}</span>
                          </button>

                          @if (sOpen && (step.output || step.error)) {
                            @let rawOut =
                              (step.output || "") +
                              (step.error
                                ? "
" + step.error
                                : "");
                            @let lines = filterLogLines(rawOut);
                            <div
                              class="ci-log-well"
                              data-testid="ci-log-viewer"
                            >
                              <div class="ci-log-bar">
                                <span class="tabular">{{ step.name }}</span>
                                <form
                                  role="search"
                                  autocomplete="off"
                                  style="display: contents"
                                  (submit)="$event.preventDefault()"
                                >
                                  <input
                                    type="search"
                                    name="grain-ci-step-log-search"
                                    autocomplete="off"
                                    spellcheck="false"
                                    data-lpignore="true"
                                    data-1p-ignore="true"
                                    class="ci-log-search"
                                    placeholder="Search log…"
                                    aria-label="Search log lines"
                                    data-testid="ci-log-search"
                                    [value]="logSearch()"
                                    (input)="
                                      logSearch.set($any($event.target).value)
                                    "
                                  />
                                </form>
                                @if (isActive(run)) {
                                  <button
                                    type="button"
                                    class="btn-text"
                                    [attr.aria-pressed]="tailFollow()"
                                    data-testid="ci-tail-follow"
                                    (click)="tailFollow.set(!tailFollow())"
                                  >
                                    Tail follow:
                                    {{ tailFollow() ? "on" : "off" }}
                                  </button>
                                }
                                <button
                                  type="button"
                                  class="btn-text"
                                  data-testid="ci-copy-log"
                                  (click)="
                                    copyText(rawOut, 'Copied step output')
                                  "
                                >
                                  Copy
                                </button>
                              </div>
                              <div class="ci-log-lines" #logContainer>
                                @for (ln of lines; track ln.num) {
                                  <div
                                    class="ci-log-line"
                                    [class.is-match]="ln.match"
                                  >
                                    <span class="ci-log-ln">{{ ln.num }}</span>
                                    <span class="ci-log-txt">{{
                                      ln.text
                                    }}</span>
                                  </div>
                                }
                              </div>
                            </div>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </div>

            <div class="ci-jobs-section" data-testid="ci-artifacts-section">
              <h3 class="section-title">
                Artifacts
                <span class="muted tabular"
                  >({{
                    store.artifactsTotal() || store.artifacts().length
                  }})</span
                >
              </h3>
              @if (store.artifactsLoading() && store.artifacts().length === 0) {
                <p class="muted">Loading artifacts…</p>
              } @else if (
                !access.can("GET /api/ci/runs/{id}/artifacts", run.repo)
              ) {
                <p class="muted" data-testid="ci-artifacts-denied">
                  {{
                    access.deniedReason(
                      "GET /api/ci/runs/{id}/artifacts",
                      run.repo
                    )
                  }}
                </p>
              } @else if (store.artifactsError()) {
                <p
                  class="banner banner-error"
                  role="alert"
                  data-testid="ci-artifacts-error"
                >
                  {{ store.artifactsError() }}
                </p>
              } @else if (store.artifacts().length === 0) {
                @if (providerOf(run) === "github") {
                  <p class="muted" data-testid="ci-artifacts-empty">
                    No artifacts listed for this GitHub Actions run.
                  </p>
                } @else if (
                  store.artifactsLoaded() && !store.artifactsEnabled()
                ) {
                  <p class="muted" data-testid="ci-artifacts-disabled">
                    Grain CI is not enabled on this deployment.
                  </p>
                } @else if (
                  store.artifactsLoaded() && !store.artifactsAvailable()
                ) {
                  <p class="muted" data-testid="ci-artifacts-unavailable">
                    This deployment keeps no CI artifacts.
                  </p>
                } @else {
                  <p class="muted" data-testid="ci-artifacts-empty">
                    No stored artifacts for this run.
                  </p>
                }
              } @else {
                <ul class="ci-artifacts-list">
                  @for (
                    art of store.artifacts();
                    track (art.job || "") + ":" + art.name + ":" + $index
                  ) {
                    <li
                      class="ci-artifact-row"
                      data-testid="ci-artifact-row"
                      [attr.title]="art.collectedAt || null"
                    >
                      <div>
                        <strong>{{ art.name }}</strong>
                        @if (art.job) {
                          <span class="muted"> · job {{ art.job }}</span>
                        }
                        @if (art.bytes || art.size; as sz) {
                          <span class="tabular muted">
                            · {{ bytesOf(sz) }}</span
                          >
                        }
                        @if (art.note) {
                          <span class="muted"> — {{ art.note }}</span>
                        }
                      </div>
                      @let extArtUrl = safeUrl(run.actions?.url || run.url);
                      @if (canDownloadArtifactFor(run.id, run.repo, art)) {
                        <a
                          class="btn-tonal"
                          [href]="artifactHref(art.run || run.id, art)"
                          download
                          data-testid="ci-artifact-download"
                          >Download .tar.gz</a
                        >
                      } @else if (providerOf(run) === "github" && extArtUrl) {
                        <a
                          class="btn-text"
                          [href]="extArtUrl"
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="ci-artifact-external"
                          >Open on GitHub ↗</a
                        >
                      }
                    </li>
                  }
                </ul>
                @if (
                  store.artifactsTruncated() && store.artifactsNextCursor()
                ) {
                  <div>
                    <button
                      type="button"
                      class="btn-text"
                      data-testid="ci-artifacts-load-more"
                      (click)="
                        loadMoreFaultArtifacts(
                          run.id,
                          run.repo,
                          store.artifactsNextCursor()
                        )
                      "
                    >
                      Load more artifacts ({{ store.artifacts().length }} of
                      {{ store.artifactsTotal() }})
                    </button>
                  </div>
                }
              }
            </div>
          } @else {
            <div class="empty-state">
              <p>
                Select a CI run on the left to inspect its jobs, logs, and
                artifacts.
              </p>
            </div>
          }
        </section>
      </div>
    </section>

    @if (runDialogOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="runDialogOpen.set(false)"
      ></div>
      <div
        class="g-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ci-run-dialog-title"
        data-testid="ci-run-dialog"
        gDialogTrap
        (gDialogClose)="runDialogOpen.set(false)"
      >
        <h2 id="ci-run-dialog-title">Run workflow</h2>
        <label class="field">
          <span>Repository (owner/name)</span>
          <input
            type="text"
            data-testid="ci-run-repo-input"
            placeholder="acme/widgets"
            [value]="draftRepo()"
            (input)="onDraftRepoInput($any($event.target).value)"
          />
        </label>
        <label class="field">
          <span>Branch / ref</span>
          <input
            type="text"
            data-testid="ci-run-ref-input"
            placeholder="main"
            [value]="draftRef()"
            (input)="onDraftRefInput($any($event.target).value)"
          />
        </label>
        <div class="field">
          <span>Workflow</span>
          <div
            class="segmented ci-workflow-segmented"
            role="group"
            aria-label="Workflow selection"
          >
            <button
              type="button"
              [attr.aria-pressed]="!draftWorkflow()"
              (click)="draftWorkflow.set('')"
            >
              All matching workflows
            </button>
            @for (wf of discoveredWorkflows(); track wf.path) {
              <button
                type="button"
                [attr.aria-pressed]="draftWorkflow() === wf.path"
                [attr.data-testid]="'ci-wf-opt-' + wf.path"
                (click)="draftWorkflow.set(wf.path)"
              >
                {{ wf.name || wf.path }}
              </button>
            }
          </div>
        </div>
        <div class="switch-row" style="margin-top: 14px">
          <button
            type="button"
            role="switch"
            class="g-switch"
            aria-label="Bypass job cache (fresh recheck)"
            data-testid="ci-run-recheck-switch"
            [attr.aria-checked]="draftRecheck()"
            (click)="draftRecheck.set(!draftRecheck())"
          ></button>
          <span>Bypass job cache (fresh recheck)</span>
        </div>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn-text"
            (click)="runDialogOpen.set(false)"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="ci-run-submit"
            [disabled]="
              submitting() ||
              !draftRepo().trim() ||
              !draftRef().trim() ||
              !access.can('POST /api/ci/runs', draftRepo().trim())
            "
            [gTip]="
              draftRepo().trim()
                ? access.deniedReason('POST /api/ci/runs', draftRepo().trim())
                : ''
            "
            (click)="submitRunWorkflow()"
          >
            {{ submitting() ? "Starting…" : "Start CI run" }}
          </button>
        </div>
      </div>
    }

    @if (quarantineDialogOpen()) {
      <div
        class="scrim"
        aria-hidden="true"
        (click)="quarantineDialogOpen.set(false)"
      ></div>
      <div
        class="g-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ci-quarantine-title"
        data-testid="ci-quarantine-dialog"
        gDialogTrap
        (gDialogClose)="quarantineDialogOpen.set(false)"
      >
        <h2 id="ci-quarantine-title">Quarantine flaky test</h2>
        @if (detectedFailedTests().length > 0) {
          <div class="field">
            <span>Detected failing tests</span>
            <div class="filter-strip" style="margin-top: 4px">
              @for (t of detectedFailedTests(); track t) {
                <button
                  type="button"
                  class="filter-chip"
                  [attr.aria-pressed]="qTestName() === t"
                  (click)="qTestName.set(t)"
                >
                  {{ t }}
                </button>
              }
            </div>
          </div>
        }
        <label class="field">
          <span>Test name</span>
          <input
            type="text"
            data-testid="ci-quarantine-test-input"
            placeholder="TestFlakySuite/Subcase"
            [value]="qTestName()"
            (input)="qTestName.set($any($event.target).value)"
          />
        </label>
        <label class="field">
          <span>Reason</span>
          <textarea
            rows="2"
            data-testid="ci-quarantine-reason-input"
            placeholder="Intermittent port bind race on CI runners"
            [value]="qReason()"
            (input)="qReason.set($any($event.target).value)"
          ></textarea>
        </label>
        <div class="field">
          <span>Expiration TTL</span>
          <div class="segmented" role="group" aria-label="Quarantine TTL">
            @for (ttl of ttlOptions; track ttl) {
              <button
                type="button"
                [attr.aria-pressed]="qTtl() === ttl"
                (click)="qTtl.set(ttl)"
              >
                {{ ttl }}
              </button>
            }
          </div>
        </div>
        <div class="switch-row" style="margin-top: 14px">
          <button
            type="button"
            role="switch"
            class="g-switch"
            aria-label="File a held follow-up task to fix and unquarantine"
            [attr.aria-checked]="qFollowUp()"
            (click)="qFollowUp.set(!qFollowUp())"
          ></button>
          <span>File a held follow-up task to fix and unquarantine</span>
        </div>

        @if (quarantineResult(); as qr) {
          <div
            class="banner banner-info"
            style="margin: 12px 0 0"
            data-testid="ci-quarantine-result"
          >
            <span>
              Quarantined <strong>{{ qr.testName }}</strong> ({{ qr.ttl }}).
              @if (qr.followUpTaskId) {
                Follow-up task:
                <a
                  [routerLink]="['/task', qr.followUpTaskId]"
                  (click)="quarantineDialogOpen.set(false)"
                  >#{{ qr.followUpTaskId }}</a
                >
              }
            </span>
          </div>
          <pre class="ci-yaml-preview">{{ qr.quarantineYaml }}</pre>
        }

        <div class="dialog-actions">
          <button
            type="button"
            class="btn-text"
            (click)="quarantineDialogOpen.set(false)"
          >
            {{ quarantineResult() ? "Done" : "Cancel" }}
          </button>
          @if (!quarantineResult()) {
            <button
              type="button"
              class="btn-primary"
              data-testid="ci-quarantine-submit"
              [disabled]="
                submitting() ||
                !qTestName().trim() ||
                !qReason().trim() ||
                !access.can(
                  'POST /api/tests/quarantine',
                  store.activeRun()?.repo
                )
              "
              (click)="submitQuarantine()"
            >
              {{ submitting() ? "Saving…" : "Quarantine test" }}
            </button>
          }
        </div>
      </div>
    }

    @if (cancelDialogRun(); as run) {
      <div class="scrim" aria-hidden="true" (click)="closeCancelDialog()"></div>
      <div
        class="g-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ci-cancel-dialog-title"
        aria-describedby="ci-cancel-dialog-desc"
        data-testid="ci-cancel-dialog"
        gDialogTrap
        (gDialogClose)="closeCancelDialog()"
      >
        <h2 id="ci-cancel-dialog-title">Cancel CI run?</h2>
        <p id="ci-cancel-dialog-desc" class="ci-cancel-desc">
          Stop <strong>{{ titleOf(run) }}</strong> on
          <strong>{{ run.repo }}</strong> ({{ branchOf(run) || run.id }})? Jobs
          in flight are told to stop and their sandboxes are destroyed.
        </p>
        <label class="field">
          <span>Reason (optional)</span>
          <textarea
            rows="2"
            class="ci-cancel-reason-input"
            data-testid="ci-cancel-reason-input"
            placeholder="Optional — shown to readers and any agent waiting on this branch"
            [value]="cancelReason()"
            (input)="cancelReason.set($any($event.target).value)"
          ></textarea>
        </label>
        @if (cancelError(); as err) {
          <p
            class="banner banner-error ci-cancel-error"
            role="alert"
            data-testid="ci-cancel-error"
          >
            {{ err }}
          </p>
        }
        <div class="dialog-actions ci-cancel-actions">
          <button
            type="button"
            class="btn-text"
            data-testid="ci-cancel-dismiss"
            [disabled]="submitting()"
            (click)="closeCancelDialog()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary is-destructive"
            data-testid="ci-cancel-confirm"
            [disabled]="
              submitting() || !access.can('DELETE /api/ci/runs/{id}', run.repo)
            "
            [gTip]="
              access.deniedReason('DELETE /api/ci/runs/{id}', run.repo) || ''
            "
            (click)="submitCancelRun()"
          >
            {{ submitting() ? "Stopping…" : "Stop run" }}
          </button>
        </div>
      </div>
    }

    @if (confirming(); as req) {
      <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
    }
  `,
})
export class CIPageComponent implements OnInit, OnDestroy {
  readonly id = input<string | undefined>(undefined);

  protected readonly store = inject(CIStore);
  protected readonly access = inject(AccessService);
  protected readonly filter = inject(ViewFilter);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackbar = inject(SnackbarService);
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private querySub: Subscription | null = null;

  protected readonly filters = FILTERS;
  protected readonly providers = PROVIDERS;
  protected readonly ttlOptions = ["72h", "7d", "14d", "30d"] as const;

  protected readonly nowMs = signal(Date.now());
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onCaptureKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && this.openMenu()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.zone.run(() => this.openMenu.set(null));
    }
  };

  protected readonly bucketFilter = signal<CIFilterId>("all");
  protected readonly repoFilter = signal("");
  protected readonly branchFilter = signal("");
  protected readonly providerFilter = signal<CIProviderFilter>("all");
  protected readonly faultDigestFilter = signal("");
  protected readonly openMenu = signal<"repo" | "branch" | "caches" | null>(
    null,
  );
  protected readonly menuAlignRight = signal(false);
  protected readonly faultsExpanded = signal(true);
  protected readonly mobileDetailOpen = signal(false);

  protected readonly expandedJobs = signal<Record<string, boolean>>({});
  protected readonly expandedSteps = signal<Record<string, boolean>>({});
  protected readonly expandedFaultRunArtifacts = signal<
    Record<string, boolean>
  >({});
  protected readonly logSearch = signal("");
  protected readonly tailFollow = signal(true);

  protected readonly runDialogOpen = signal(false);
  protected readonly draftRepo = signal("");
  protected readonly draftRef = signal("main");
  protected readonly draftWorkflow = signal("");
  protected readonly draftRecheck = signal(false);
  protected readonly discoveredWorkflows = signal<CIWorkflowOption[]>([]);

  protected readonly quarantineDialogOpen = signal(false);
  protected readonly qTestName = signal("");
  protected readonly qReason = signal("");
  protected readonly qTtl = signal("30d");
  protected readonly qFollowUp = signal(true);
  protected readonly quarantineResult = signal<QuarantineTestResponse | null>(
    null,
  );

  protected readonly cancelDialogRun = signal<CIRun | null>(null);
  protected readonly cancelReason = signal("");
  protected readonly cancelError = signal<string | null>(null);

  protected readonly submitting = signal(false);
  protected readonly confirming = signal<ConfirmRequest | null>(null);

  protected readonly modalOpen = computed(
    () =>
      this.runDialogOpen() ||
      this.quarantineDialogOpen() ||
      !!this.cancelDialogRun() ||
      !!this.confirming(),
  );

  private readonly splitEl = viewChild<ElementRef<HTMLElement>>("split");
  private readonly logEl = viewChild<ElementRef<HTMLElement>>("logContainer");

  protected readonly sp = new SplitController({
    ratioKey: "grain-ng.ci.split-ratio",
    collapsedKey: "grain-ng.ci.split-collapsed",
    defaultRatio: 0.35,
    element: () => this.splitEl()?.nativeElement,
  });

  protected readonly sharedFaults = computed(() => this.store.combinedFaults());

  protected readonly availableRepos = computed(() => {
    const configured = this.store.targetRepos();
    if (this.store.hasTargetAllowlist() && configured.length > 0) {
      return [...configured].sort();
    }
    const set = new Set<string>(configured);
    for (const r of this.store.runs()) {
      if (r.repo) set.add(r.repo);
    }
    return [...set].sort();
  });

  protected readonly availableBranches = computed(() => {
    const repo = this.repoFilter();
    const set = new Set<string>();
    for (const r of this.store.runs()) {
      if (repo && r.repo !== repo) continue;
      const b = runBranch(r);
      if (b) set.add(b);
    }
    return [...set].sort();
  });

  protected readonly counts = computed(() => {
    const out: Record<CIFilterId, number> = {
      all: 0,
      running: 0,
      failed: 0,
      errored: 0,
      passed: 0,
      cancelled: 0,
    };
    const faults = this.sharedFaults();
    for (const r of this.store.runs()) {
      if (!this.matchesScopeFilters(r)) continue;
      out.all++;
      out[runBucket(r, faults)]++;
    }
    return out;
  });

  protected readonly filteredRuns = computed(() => {
    const bucket = this.bucketFilter();
    const faults = this.sharedFaults();
    return this.store.runs().filter((r) => {
      if (!this.matchesScopeFilters(r)) return false;
      if (bucket !== "all" && runBucket(r, faults) !== bucket) return false;
      return true;
    });
  });

  protected readonly detectedFailedTests = computed(() =>
    extractFailedTests(this.store.activeRun()),
  );

  protected readonly hasActiveFilters = computed(
    () =>
      this.bucketFilter() !== "all" ||
      !!this.repoFilter() ||
      !!this.branchFilter() ||
      this.providerFilter() !== "all" ||
      !!this.faultDigestFilter() ||
      !!this.filter.query().trim(),
  );

  protected readonly canFlushAnyCache = computed(() => {
    if (!this.access.configLoaded()) return false;
    const repo = this.repoFilter() || undefined;
    return (
      this.access.can("DELETE /api/ci/cache") ||
      this.access.can("POST /api/actions-cache/flush", repo) ||
      this.access.can("POST /api/package-cache/flush")
    );
  });

  protected readonly hasInFlight = computed(() => {
    if (this.filteredRuns().some((r) => isRunActive(r))) return true;
    const active = this.store.activeRun();
    if (!active) return false;
    if (isRunActive(active)) return true;
    return (active.jobs ?? []).some((j) => !!j.startedAt && !j.finishedAt);
  });

  constructor() {
    afterNextRender(() => this.sp.attach());

    // Keep CIStore's GitHub Actions query scope synced with repo & provider filters.
    effect(() => {
      const repo = this.repoFilter();
      const prov = this.providerFilter();
      untracked(() => this.store.setQueryScope(repo, prov));
    });

    // Tick nowMs() every second while any visible run/job is in-flight so durations advance across 304 responses.
    effect(() => {
      const active = this.hasInFlight();
      if (active && !this.clockTimer) {
        this.nowMs.set(Date.now());
        this.zone.runOutsideAngular(() => {
          this.clockTimer = setInterval(() => {
            this.zone.run(() => this.nowMs.set(Date.now()));
          }, 1000);
        });
      } else if (!active && this.clockTimer) {
        clearInterval(this.clockTimer);
        this.clockTimer = null;
      }
    });

    // Sync deep-linked /ci/runs/:id route parameter or auto-select top run on desktop.
    effect(() => {
      const routeId = this.id();
      const runs = this.filteredRuns();
      const loaded = this.store.loaded();
      untracked(() => {
        if (routeId) {
          this.mobileDetailOpen.set(true);
          void this.store.selectRun(routeId);
          return;
        }
        const cur = this.store.selectedId();
        if (
          loaded &&
          runs.length > 0 &&
          (!cur || !runs.some((r) => r.id === cur))
        ) {
          const isDesktop = (this.doc.defaultView?.innerWidth ?? 1280) >= 600;
          if (isDesktop) {
            void this.store.selectRun(runs[0].id);
          }
        }
      });
    });

    // Tail-follow active run logs when new output arrives.
    effect(() => {
      const run = this.store.detail();
      const follow = this.tailFollow();
      if (run && follow && isRunActive(run)) {
        queueMicrotask(() => {
          const el = this.logEl()?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    });
  }

  ngOnInit(): void {
    this.querySub = this.route.queryParamMap.subscribe((qp) => {
      this.providerFilter.set(parseProviderQueryParam(qp.get("provider")));
      this.repoFilter.set((qp.get("repo") ?? "").trim());
      this.branchFilter.set((qp.get("branch") ?? "").trim());
    });
    this.store.setQueryScope(this.repoFilter(), this.providerFilter());
    this.zone.runOutsideAngular(() => {
      this.doc.addEventListener("keydown", this.onCaptureKeydown, true);
    });
    this.store.start();
  }

  ngOnDestroy(): void {
    this.querySub?.unsubscribe();
    this.querySub = null;
    this.doc.removeEventListener("keydown", this.onCaptureKeydown, true);
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    this.sp.detach();
    this.store.stop();
  }

  @HostListener("document:click", ["$event"])
  protected onDocClick(ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (this.openMenu() && !t?.closest(".pill-dropdown")) {
      this.openMenu.set(null);
    }
  }

  private matchesScopeFilters(r: CIRun): boolean {
    const repo = this.repoFilter();
    if (repo && r.repo !== repo) return false;
    const branch = this.branchFilter();
    if (branch && runBranch(r) !== branch) return false;
    const prov = this.providerFilter();
    if (prov !== "all" && providerOfRun(r) !== prov) return false;
    const digest = this.faultDigestFilter();
    if (digest) {
      const rf = faultsForRun(r, this.sharedFaults());
      if (!rf.some((f) => (f.digest || faultTitle(f)) === digest)) return false;
    }
    const q = this.filter.query().trim().toLowerCase();
    if (q) {
      const hay = [
        r.id,
        r.repo,
        runBranch(r),
        r.commit ?? "",
        runTitle(r),
        runTaskId(r) ?? "",
        r.conclusion ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  protected toggleMenu(which: "repo" | "branch" | "caches", ev: Event): void {
    ev.stopPropagation();
    if (this.openMenu() === which) {
      this.openMenu.set(null);
      return;
    }
    const btn = ev.currentTarget as HTMLElement | null;
    const vw = this.doc.defaultView?.innerWidth ?? 1280;
    const rect = btn?.getBoundingClientRect();
    if (which === "caches") {
      this.menuAlignRight.set(!rect || rect.width === 0 || rect.right >= 216);
    } else {
      this.menuAlignRight.set(
        !!rect && rect.left + 200 > vw - 16 && rect.right >= 216,
      );
    }
    this.openMenu.set(which);
  }

  protected setBucketFilter(id: CIFilterId): void {
    this.bucketFilter.set(id);
  }

  protected setProviderFilter(id: CIProviderFilter): void {
    this.providerFilter.set(id);
    this.syncQueryParams();
  }

  protected pickRepo(repo: string): void {
    this.repoFilter.set(repo);
    this.branchFilter.set("");
    this.openMenu.set(null);
    this.syncQueryParams();
  }

  protected pickBranch(branch: string): void {
    this.branchFilter.set(branch);
    this.openMenu.set(null);
    this.syncQueryParams();
  }

  protected resetFilters(): void {
    this.bucketFilter.set("all");
    this.repoFilter.set("");
    this.branchFilter.set("");
    this.providerFilter.set("all");
    this.faultDigestFilter.set("");
    this.filter.query.set("");
    this.syncQueryParams();
  }

  protected inspectFault(f: CIFault): void {
    this.bucketFilter.set("errored");
    const src = faultSourceOf(f.source);
    if (this.providerFilter() !== "all" && this.providerFilter() !== src) {
      this.providerFilter.set("all");
    }
    this.faultDigestFilter.set(f.digest || faultTitle(f));
    const firstRun = f.runs?.[0];
    const firstRunId = firstRun ? this.resolveFaultRunId(f, firstRun) : "";
    const navigated = firstRunId ? this.openRun(firstRunId, true) : false;
    if (!navigated) {
      this.syncQueryParams();
    }
  }

  protected resolveFaultRunId(f: CIFault, fr: CIFaultRun): string {
    const rawId = fr.runId;
    if (faultSourceOf(f.source) !== "github" || isActionsRunId(rawId)) {
      return rawId;
    }
    const wantRepo = (f.repo ?? "").toLowerCase();
    const wantRef = cleanRef(fr.ref);
    const wantCommit = faultRunCommit(fr);
    const matched = this.store.runs().find((r) => {
      if (r.id === rawId) return true;
      if (providerOfRun(r) !== "github") return false;
      if (String(r.actions?.runId ?? "") === rawId) return true;
      if (wantRepo && r.repo.toLowerCase() !== wantRepo) return false;
      if (wantRef && runBranch(r) !== wantRef) return false;
      if (wantCommit && r.commit && r.commit !== wantCommit) return false;
      return !!(wantRef || wantCommit);
    });
    return matched?.id ?? rawId;
  }

  protected faultRunQueryParams(f: CIFault, targetId: string) {
    if (faultSourceOf(f.source) === "github" || this.isGitHubRun(targetId)) {
      return { provider: GITHUB_ACTIONS_PROVIDER };
    }
    return {
      provider:
        this.providerFilter() === "github"
          ? null
          : providerQueryParam(this.providerFilter()),
    };
  }

  protected onFaultRunOpen(runId: string): void {
    this.mobileDetailOpen.set(true);
    if (this.id() === runId) {
      void this.store.selectRun(runId);
    }
  }

  private faultArtKey(f: CIFault, fr: CIFaultRun): string {
    return `${faultSourceOf(f.source)}:${f.digest || faultTitle(f)}:${fr.runId}`;
  }

  protected isFaultRunArtifactsOpen(f: CIFault, fr: CIFaultRun): boolean {
    return !!this.expandedFaultRunArtifacts()[this.faultArtKey(f, fr)];
  }

  protected toggleFaultRunArtifacts(f: CIFault, fr: CIFaultRun): void {
    const key = this.faultArtKey(f, fr);
    const next = !this.expandedFaultRunArtifacts()[key];
    this.expandedFaultRunArtifacts.update((m) => ({ ...m, [key]: next }));
    if (next) {
      const targetId = this.resolveFaultRunId(f, fr);
      const state = this.store.runArtifactsById()[targetId];
      if (!state || (!state.loaded && !state.loading)) {
        void this.store.loadRunArtifacts(targetId, f.repo);
      }
    }
  }

  protected faultRunArtifacts(runId: string): RunArtifactsState | null {
    return this.store.runArtifactsById()[runId] ?? null;
  }

  protected loadMoreFaultArtifacts(
    runId: string,
    repo: string | undefined,
    cursor: string,
  ): void {
    void this.store.loadRunArtifacts(runId, repo, cursor);
  }

  protected openRun(runId: string, fromUserClick = false): boolean {
    if (fromUserClick) this.mobileDetailOpen.set(true);
    void this.store.selectRun(runId);
    if (this.id() && this.id() !== runId) {
      void this.router.navigate(["/ci", "runs", runId], {
        queryParams: this.runNavigationQueryParams(runId),
        queryParamsHandling: "merge",
      });
      return true;
    }
    return false;
  }

  protected closeMobileDetail(): void {
    this.mobileDetailOpen.set(false);
    if (this.id()) {
      void this.router.navigate(["/ci"], {
        queryParams: this.filterQueryParams(),
        queryParamsHandling: "merge",
      });
    }
  }

  private filterQueryParams() {
    return {
      provider: providerQueryParam(this.providerFilter()),
      repo: this.repoFilter().trim() || null,
      branch: this.branchFilter().trim() || null,
    };
  }

  private runNavigationQueryParams(runId: string) {
    const params = this.filterQueryParams();
    if (!params.provider && this.isGitHubRun(runId)) {
      params.provider = GITHUB_ACTIONS_PROVIDER;
    }
    return params;
  }

  private isGitHubRun(runId: string): boolean {
    if (isActionsRunId(runId)) return true;
    const found =
      this.store.runs().find((r) => r.id === runId) ??
      (this.store.detail()?.id === runId ? this.store.detail() : null);
    return !!found && providerOfRun(found) === "github";
  }

  private syncQueryParams(): void {
    const desired = this.filterQueryParams();
    const cur = this.route.snapshot.queryParamMap;
    if (
      (cur.get("provider") ?? null) === desired.provider &&
      (cur.get("repo") ?? null) === desired.repo &&
      (cur.get("branch") ?? null) === desired.branch
    ) {
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: desired,
      queryParamsHandling: "merge",
    });
  }

  protected badgeOf(run: CIRun) {
    return runBadge(run, this.sharedFaults());
  }

  protected faultsOf(run: CIRun): CIFault[] {
    return faultsForRun(run, this.sharedFaults());
  }

  protected stepBadgeOf(
    conclusion?: string,
    startedAt?: string,
    finishedAt?: string,
  ) {
    return stepBadge(conclusion, startedAt, finishedAt);
  }

  protected titleOf = runTitle;
  protected branchOf = runBranch;
  protected providerOf = providerOfRun;
  protected taskIdOf = runTaskId;
  protected isActive = isRunActive;
  protected durationOf = formatDuration;
  protected bytesOf = formatBytes;
  protected safeUrl = safeExternalUrl;
  protected faultLabel = faultTitle;
  protected faultRuns = faultRunCount;
  protected faultRefs = faultRefCount;
  protected cleanRefOf = cleanRef;
  protected faultCommitOf = faultRunCommit;
  protected fixWhereOf = faultFixWhere;
  protected prUrlOf = pullRequestExternalUrl;

  protected faultSource(f: CIFault): "grain" | "github" {
    return faultSourceOf(f.source);
  }

  protected faultSourceText(f: CIFault): string {
    return faultSourceLabel(f.source);
  }

  protected jobArtifacts(job: CIJobRun): CIRunArtifact[] {
    const id = job.jobId || "";
    const name = job.name || "";
    return this.store
      .artifacts()
      .filter((a) => !!a.job && (a.job === id || (!!name && a.job === name)));
  }

  protected canDownloadArtifactFor(
    runId: string,
    repo: string | undefined,
    art: CIRunArtifact,
  ): boolean {
    return (
      artifactDownloadable(runId, art) &&
      this.access.can("GET /api/ci/runs/{id}/artifacts/{job}/{name}", repo)
    );
  }

  protected actorLabel(run: CIRun): string {
    const tid = runTaskId(run);
    if (tid && run.requestedBy === tid) return `Task #${tid}`;
    return run.requestedBy || "grain";
  }

  protected actorKind(run: CIRun): string {
    if (!run.requestedBy || run.requestedBy === "grain") return "grain";
    if (/^\d+$/.test(run.requestedBy)) return "agent";
    return "human";
  }

  protected isJobOpen(runId: string, job: CIJobRun): boolean {
    const key = `${runId}:${job.jobId || job.name}`;
    const explicit = this.expandedJobs()[key];
    if (explicit !== undefined) return explicit;
    const c = (job.conclusion || "").toLowerCase();
    return c === "failure" || c === "errored" || (!c && !!job.startedAt);
  }

  protected toggleJob(run: CIRun, job: CIJobRun): void {
    const key = `${run.id}:${job.jobId || job.name}`;
    const next = !this.isJobOpen(run.id, job);
    this.expandedJobs.update((m) => ({ ...m, [key]: next }));
    if (next && providerOfRun(run) === "github") {
      const jobKey = job.name || job.jobId;
      if (!this.jobLogFor(run.id, jobKey)) {
        void this.store.fetchJobLog(run.id, jobKey);
      }
    }
  }

  protected isStepOpen(
    runId: string,
    job: CIJobRun,
    step: { conclusion?: string; output?: string; error?: string },
    idx: number,
  ): boolean {
    const key = `${runId}:${job.jobId || job.name}:${idx}`;
    const explicit = this.expandedSteps()[key];
    if (explicit !== undefined) return explicit;
    const c = (step.conclusion || "").toLowerCase();
    return c === "failure" || c === "errored";
  }

  protected toggleStep(runId: string, job: CIJobRun, idx: number): void {
    const key = `${runId}:${job.jobId || job.name}:${idx}`;
    const step = job.steps?.[idx] ?? {};
    const next = !this.isStepOpen(runId, job, step, idx);
    this.expandedSteps.update((m) => ({ ...m, [key]: next }));
  }

  protected loadExternalJobLog(runId: string, jobName: string): void {
    void this.store.fetchJobLog(runId, jobName);
  }

  protected jobLogFor(runId: string, jobName: string) {
    return this.store.jobLogs()[`${runId}:${jobName}`] ?? null;
  }

  protected filterLogLines(
    raw: string,
  ): { num: number; text: string; match: boolean }[] {
    const q = this.logSearch().trim().toLowerCase();
    const all = (raw || "").split("\n").map((text, i) => ({
      num: i + 1,
      text,
      match: !!q && text.toLowerCase().includes(q),
    }));
    if (!q) return all;
    return all.filter((l) => l.match);
  }

  protected artifactHref(runId: string, art: CIRunArtifact): string {
    return routePath("GET /api/ci/runs/{id}/artifacts/{job}/{name}", {
      id: runId,
      job: art.job,
      name: art.name,
    });
  }

  protected copyText(text: string, msg: string): void {
    void this.doc.defaultView?.navigator?.clipboard?.writeText(text);
    this.snackbar.show(msg);
  }

  protected openRunWorkflowDialog(): void {
    if (!this.access.configLoaded() || !this.access.can("POST /api/ci/runs")) {
      return;
    }
    const active = this.store.activeRun();
    const repo =
      this.repoFilter() || active?.repo || this.availableRepos()[0] || "";
    const ref =
      this.branchFilter() ||
      (active ? cleanRef(active.branch || active.ref) : "") ||
      "main";
    this.draftRepo.set(repo);
    this.draftRef.set(ref);
    this.draftWorkflow.set("");
    this.draftRecheck.set(false);
    this.runDialogOpen.set(true);
    void this.refreshWorkflowOptions(repo, ref);
  }

  protected onDraftRepoInput(val: string): void {
    this.draftRepo.set(val);
    void this.refreshWorkflowOptions(val, this.draftRef());
  }

  protected onDraftRefInput(val: string): void {
    this.draftRef.set(val);
    void this.refreshWorkflowOptions(this.draftRepo(), val);
  }

  private async refreshWorkflowOptions(
    repo: string,
    ref: string,
  ): Promise<void> {
    if (!repo.trim()) {
      this.discoveredWorkflows.set([]);
      return;
    }
    try {
      const list = await this.store.fetchWorkflows(repo, ref);
      this.discoveredWorkflows.set(list);
    } catch {
      this.discoveredWorkflows.set([]);
    }
  }

  protected async submitRunWorkflow(): Promise<void> {
    const repo = this.draftRepo().trim();
    const ref = this.draftRef().trim();
    if (
      !repo ||
      !ref ||
      this.submitting() ||
      !this.access.configLoaded() ||
      !this.access.can("POST /api/ci/runs", repo)
    ) {
      return;
    }
    this.submitting.set(true);
    try {
      const created = await this.store.triggerRun({
        repo,
        ref,
        branch: ref,
        workflow: this.draftWorkflow() || undefined,
        recheck: this.draftRecheck() || undefined,
      });
      this.runDialogOpen.set(false);
      if (created?.id) this.openRun(created.id);
      this.snackbar.show(`Started CI run ${created?.id ?? ""}`.trim());
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected async rerunSelected(
    run: CIRun,
    failedOnly: boolean,
  ): Promise<void> {
    if (
      !this.access.configLoaded() ||
      !this.access.can("POST /api/ci/runs", run.repo)
    ) {
      return;
    }
    const tid = runTaskId(run);
    try {
      const created = await this.store.triggerRun(
        tid
          ? {
              taskId: tid,
              repo: run.repo,
              ref: runBranch(run) || "main",
              recheck: true,
              recheckFailed: failedOnly || undefined,
            }
          : {
              repo: run.repo,
              ref: runBranch(run) || "main",
              commit: run.commit || undefined,
              recheck: true,
              recheckFailed: failedOnly || undefined,
            },
      );
      // Follow to the run it started: on /ci/runs/<id> the route's id
      // would otherwise pull the inspector back to the run just retried.
      if (created?.id) this.openRun(created.id);
      this.snackbar.show(
        failedOnly
          ? `Re-running failed jobs (${created?.id ?? "started"})`
          : `Started fresh CI run (${created?.id ?? "started"})`,
      );
    } catch (err) {
      this.store.actionError.set(errorText(err));
    }
  }

  protected confirmCancelRun(run: CIRun): void {
    if (
      !this.access.configLoaded() ||
      !this.access.can("DELETE /api/ci/runs/{id}", run.repo)
    ) {
      return;
    }
    this.cancelError.set(null);
    this.cancelReason.set("");
    this.cancelDialogRun.set(run);
  }

  protected closeCancelDialog(): void {
    if (this.submitting()) return;
    this.cancelDialogRun.set(null);
    this.cancelReason.set("");
    this.cancelError.set(null);
  }

  protected async submitCancelRun(): Promise<void> {
    const run = this.cancelDialogRun();
    if (
      !run ||
      this.submitting() ||
      !this.access.configLoaded() ||
      !this.access.can("DELETE /api/ci/runs/{id}", run.repo)
    ) {
      return;
    }
    this.submitting.set(true);
    this.cancelError.set(null);
    try {
      const reason = this.cancelReason().trim();
      await this.store.cancelRun(run.id, reason || undefined);
      this.cancelDialogRun.set(null);
      this.cancelReason.set("");
      this.snackbar.show("CI run cancelled.");
    } catch (err) {
      this.cancelError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

  protected confirmFlushCache(kind: "ci" | "actions" | "package"): void {
    this.openMenu.set(null);
    const repo = this.repoFilter();
    const routeByKind = {
      ci: "DELETE /api/ci/cache",
      actions: "POST /api/actions-cache/flush",
      package: "POST /api/package-cache/flush",
    } as const;
    if (
      !this.access.configLoaded() ||
      !this.access.can(
        routeByKind[kind],
        kind === "actions" ? repo || undefined : undefined,
      )
    ) {
      return;
    }
    const labels = {
      ci: {
        title: "Flush Grain CI job cache?",
        msg: "Every cached job verdict will be cleared so subsequent runs execute cold.",
      },
      actions: {
        title: "Flush Actions cache?",
        msg: repo
          ? `Remove cached Actions archives for ${repo}?`
          : "Remove cached Actions archives across all repositories?",
      },
      package: {
        title: "Flush proxy package cache?",
        msg: "Clear cached OS/language packages on the controller? Future builds will re-fetch upstream.",
      },
    }[kind];

    this.confirming.set({
      title: labels.title,
      message: labels.msg,
      accept: "Flush cache",
      destructive: true,
      run: async () => {
        if (kind === "ci") {
          const res = await this.store.flushCICache();
          this.snackbar.show(
            `Cleared Grain CI job cache (${res.removed ?? 0} entries).`,
          );
        } else if (kind === "actions") {
          const res = await this.store.flushActionsCache(repo || undefined);
          this.snackbar.show(
            `Flushed Actions cache (${res.entries} entries, ${formatBytes(res.bytes)}).`,
          );
        } else {
          const res = await this.store.flushPackageCache();
          this.snackbar.show(
            `Flushed proxy package cache (${res.entries} entries, ${formatBytes(res.bytes)}).`,
          );
        }
      },
    });
  }

  protected openQuarantineDialog(run: CIRun): void {
    if (
      !this.access.configLoaded() ||
      !this.access.can("POST /api/tests/quarantine", run.repo)
    ) {
      return;
    }
    const failed = extractFailedTests(run);
    this.qTestName.set(failed[0] ?? "");
    this.qReason.set("");
    this.qTtl.set("30d");
    this.qFollowUp.set(true);
    this.quarantineResult.set(null);
    this.quarantineDialogOpen.set(true);
  }

  protected async submitQuarantine(): Promise<void> {
    const run = this.store.activeRun();
    if (
      !run ||
      this.submitting() ||
      !this.access.configLoaded() ||
      !this.access.can("POST /api/tests/quarantine", run.repo)
    ) {
      return;
    }
    this.submitting.set(true);
    try {
      const res = await this.store.quarantineTest({
        repo: run.repo,
        branch: runBranch(run) || undefined,
        testName: this.qTestName().trim(),
        reason: this.qReason().trim(),
        ttl: this.qTtl(),
        fileFollowUp: this.qFollowUp(),
      });
      this.quarantineResult.set(res);
      this.snackbar.show(`Quarantined ${res.testName}.`);
    } catch (err) {
      this.store.actionError.set(errorText(err));
    } finally {
      this.submitting.set(false);
    }
  }

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
