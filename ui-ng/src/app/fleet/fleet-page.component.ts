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
  DestroyRef,
  type OnInit,
  ViewEncapsulation,
  computed,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { RouteKey } from "../api/generated-routes";
import { GrainApi, routeScope } from "../api/grain-api.service";
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
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import { FleetMobileDirective, FleetMobileTracker } from "./fleet-mobile";
import {
  type ActionsCacheState,
  type AgentPauseEntry,
  type AgentPauseResponse,
  type DeleteRevokedHostdsResult,
  type FleetTab,
  type HostEnrollmentCodeView,
  type HostTopResponse,
  type HostdView,
  type IssuedHostdToken,
  type LogLinesResponse,
  type LogSourcesResponse,
  type LogUnit,
  type PackageCacheState,
  type PendingHostJoinView,
  type PersistentAction,
  type PersistentSandboxStatus,
  type PipelinePauseResponse,
  type PipelinePauseStatus,
  type SandboxHealthResponse,
  type SandboxProbeResult,
  type SandboxSnapshot,
  effectivePersistentState,
  extractTaskIdFromSandbox,
  formatBytes,
  formatHostdLabels,
  formatIssuedHostdSecret,
  formatMB,
  formatRelativeAge,
  isPersistentActionAllowed,
  parseArgv,
  parseHostdLabels,
} from "./fleet.models";

const TABS: readonly { id: FleetTab; label: string }[] = [
  { id: "sandboxes", label: "Sandboxes" },
  { id: "hostds", label: "Hosts" },
  { id: "controls", label: "Pauses & Controls" },
  { id: "logs", label: "Daemon Logs" },
];

const PERSISTENT_ACTIONS: readonly {
  action: PersistentAction;
  label: string;
}[] = [
  { action: "start", label: "Start" },
  { action: "restart", label: "Restart" },
  { action: "rebuild", label: "Rebuild" },
  { action: "stop", label: "Stop" },
];

type DestructivePersistentAction = Exclude<PersistentAction, "start">;

const PERSISTENT_CONFIRM: Record<
  DestructivePersistentAction,
  { title: (name: string) => string; message: string; accept: string }
> = {
  restart: {
    title: (name) => `Restart persistent sandbox ${name}?`,
    message:
      "Restarts the running persistent sandbox service, briefly interrupting any active preview or connections to it.",
    accept: "Restart sandbox",
  },
  rebuild: {
    title: (name) => `Rebuild persistent sandbox ${name}?`,
    message:
      "Tears down the current persistent sandbox, discards ephemeral state inside it, and rebuilds it from its repository.",
    accept: "Rebuild sandbox",
  },
  stop: {
    title: (name) => `Stop persistent sandbox ${name}?`,
    message:
      "Stops the running persistent sandbox so any active preview or connections to it are disconnected.",
    accept: "Stop sandbox",
  },
};

@Component({
  selector: "g-fleet-page",
  providers: [FleetMobileTracker],
  imports: [
    RouterLink,
    TipDirective,
    StatusIconComponent,
    ActorChipComponent,
    ConfirmDialogComponent,
    FleetMobileDirective,
  ],
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    "../shared/work-surface.css",
    "../shared/ops-surface.css",
    "./fleet-page.component.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(document:click)": "onDocClick()",
  },
  template: `
    <section
      class="view-panel is-active"
      gFleetMobile
      aria-labelledby="fleet-headline"
      [attr.inert]="confirmReq() ? '' : null"
      data-testid="fleet-page"
    >
      <div class="stage-header">
        <div class="view-headline-row">
          <div class="headline-cluster">
            <h1
              class="view-headline"
              id="fleet-headline"
              tabindex="-1"
              data-testid="fleet-headline"
            >
              Fleet &amp; Host Operations
            </h1>
            <span
              class="status-pill neutral tabular"
              data-testid="fleet-backend-pill"
            >
              <g-status-icon tone="neutral" kind="progress" />
              Backend: {{ effectiveSandboxBackend() }}
            </span>
            @if (pipelinePause()?.paused) {
              <span class="status-pill blast" data-testid="fleet-paused-pill">
                <g-status-icon tone="blast" kind="warning" />
                Pipeline paused
              </span>
            }
          </div>
          <div class="headline-actions">
            <button
              type="button"
              class="btn-tonal"
              data-testid="fleet-top-toggle"
              [disabled]="!canReadSandboxes()"
              [gTip]="
                canReadSandboxes()
                  ? 'Inspect live host process snapshot'
                  : access.deniedReason('GET /api/host/top')
              "
              (click)="toggleHostTop()"
            >
              {{ topOpen() ? "Hide host top" : "Host top" }}
            </button>
            <button
              type="button"
              class="btn-tonal"
              data-testid="fleet-refresh"
              [disabled]="loading()"
              (click)="refreshAll()"
            >
              Refresh
            </button>
          </div>
        </div>
        <p class="view-subtitle">
          Live sandboxes, persistent staging environments, token-landing host
          daemons, dispatch gates, caches, and daemon journals.
        </p>

        <div
          class="tab-strip"
          role="tablist"
          aria-label="Fleet sections"
          data-testid="fleet-tabs"
        >
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              class="tab-link fleet-tab-btn"
              [id]="'fleet-tab-btn-' + t.id"
              [attr.aria-selected]="tab() === t.id"
              [attr.aria-controls]="'fleet-panel-' + t.id"
              [attr.tabindex]="tab() === t.id ? 0 : -1"
              [attr.data-testid]="'fleet-tab-' + t.id"
              (click)="pickTab(t.id)"
              (keydown)="onTabKeydown($event, t.id)"
            >
              <span>{{ t.label }}</span>
              @if (t.id === "sandboxes") {
                <span class="tab-count tabular">{{
                  (sandboxes()?.sandboxes?.length ?? 0) +
                    persistentSandboxes().length
                }}</span>
              } @else if (t.id === "hostds") {
                <span class="tab-count tabular">{{ hostds().length }}</span>
              }
            </button>
          }
        </div>
      </div>

      @if (loadError(); as err) {
        <p class="banner banner-error" role="alert" data-testid="fleet-error">
          {{ err }}
        </p>
      }

      <div class="ops-scroll" gFleetMobile data-testid="fleet-scroll">
        <!-- Dispatch Blocked Alert (pkg/ui/dispatch_conditions.go) -->
        @for (blk of sandboxes()?.dispatchBlocked ?? []; track $index) {
          <div
            class="banner banner-error"
            style="margin: 0"
            role="alert"
            data-testid="fleet-dispatch-blocked"
          >
            <strong
              >Dispatch blocked{{
                blk.name ? " (" + blk.name + ")" : ""
              }}:</strong
            >
            {{ blk.error || blk.name }}
            @if (blk.since) {
              <span class="tabular"> · since {{ fmtAge(blk.since) }} ago</span>
            }
            @if (blk.remedy) {
              <span> — Remedy: {{ blk.remedy }}</span>
            }
          </div>
        }

        <!-- Host & Capacity Strip -->
        @if (canReadSandboxes()) {
          <div class="fleet-host-strip" data-testid="fleet-host-strip">
            <article class="ops-kpi-card" data-testid="meter-cpu">
              <div class="ops-kpi-top">
                <span class="ops-kpi-label">Host CPU &amp; Load</span>
                <span class="status-pill neutral tabular">
                  <g-status-icon tone="neutral" kind="progress" />
                  {{ sandboxes()?.host?.cpus ?? "—" }} cores
                </span>
              </div>
              <div class="ops-kpi-value tabular">
                {{
                  ((sandboxes()?.host?.cpuUtilization ?? 0) * 100).toFixed(0)
                }}%
              </div>
              <div class="meter-track">
                <div
                  [class]="
                    (sandboxes()?.host?.cpuUtilization ?? 0) >= 0.9
                      ? 'meter-fill is-error'
                      : (sandboxes()?.host?.cpuUtilization ?? 0) >= 0.75
                        ? 'meter-fill is-warn'
                        : 'meter-fill is-healthy'
                  "
                  [style.width.%]="
                    Math.min(
                      100,
                      (sandboxes()?.host?.cpuUtilization ?? 0) * 100
                    )
                  "
                ></div>
              </div>
              <div class="fleet-meter-meta tabular">
                <span
                  >Load 1/5/15m:
                  {{ (sandboxes()?.host?.loadAverage1 ?? 0).toFixed(2) }} /
                  {{ (sandboxes()?.host?.loadAverage5 ?? 0).toFixed(2) }} /
                  {{ (sandboxes()?.host?.loadAverage15 ?? 0).toFixed(2) }}</span
                >
              </div>
            </article>

            <article class="ops-kpi-card" data-testid="meter-vcpu">
              <div class="ops-kpi-top">
                <span class="ops-kpi-label">vCPU Allocation</span>
                <span
                  [class]="
                    sandboxes()?.budget?.withinCap === false
                      ? 'status-pill blast'
                      : 'status-pill healthy'
                  "
                >
                  <g-status-icon
                    [tone]="
                      sandboxes()?.budget?.withinCap === false
                        ? 'blast'
                        : 'healthy'
                    "
                    [kind]="
                      sandboxes()?.budget?.withinCap === false
                        ? 'warning'
                        : 'healthy'
                    "
                  />
                  {{
                    sandboxes()?.budget?.withinCap === false
                      ? "Over cap"
                      : "Within cap"
                  }}
                </span>
              </div>
              <div class="ops-kpi-value tabular">
                {{ sandboxes()?.budget?.committedCPUs ?? 0 }} /
                {{
                  sandboxes()?.budget?.budgetCPUs ??
                    sandboxes()?.host?.cpus ??
                    "—"
                }}
                vCPU
              </div>
              <div class="meter-track">
                <div class="meter-fill" [style.width.%]="vcpuPct()"></div>
              </div>
              <div class="fleet-meter-meta tabular">
                <span
                  >{{ sandboxes()?.budget?.committedCount ?? 0 }} committed
                  sandboxes</span
                >
              </div>
            </article>

            <article class="ops-kpi-card" data-testid="meter-memory">
              <div class="ops-kpi-top">
                <span class="ops-kpi-label">Host Memory</span>
                <span class="status-pill neutral tabular">
                  <g-status-icon tone="neutral" kind="progress" />
                  {{ fmtMB(sandboxes()?.host?.memoryTotalMB) }}
                </span>
              </div>
              <div class="ops-kpi-value tabular">
                {{ fmtMB(sandboxes()?.host?.memoryUsedMB) }}
              </div>
              <div class="meter-track">
                <div
                  [class]="
                    memPct() >= 90
                      ? 'meter-fill is-error'
                      : memPct() >= 75
                        ? 'meter-fill is-warn'
                        : 'meter-fill is-healthy'
                  "
                  [style.width.%]="memPct()"
                ></div>
              </div>
              <div class="fleet-meter-meta tabular">
                <span
                  >Swap: {{ fmtMB(sandboxes()?.host?.swapUsedMB) }} /
                  {{ fmtMB(sandboxes()?.host?.swapTotalMB) }}</span
                >
              </div>
            </article>

            <article class="ops-kpi-card" data-testid="meter-disk">
              <div class="ops-kpi-top">
                <span class="ops-kpi-label">Primary Disk</span>
                <span class="status-pill neutral tabular">
                  <g-status-icon tone="neutral" kind="progress" />
                  {{ primaryDisk()?.path || "/" }}
                </span>
              </div>
              <div class="ops-kpi-value tabular">
                {{ fmtMB(primaryDisk()?.usedMB) }} /
                {{ fmtMB(primaryDisk()?.totalMB) }}
              </div>
              <div class="meter-track">
                <div
                  [class]="
                    diskPct() >= 90
                      ? 'meter-fill is-error'
                      : diskPct() >= 75
                        ? 'meter-fill is-warn'
                        : 'meter-fill is-healthy'
                  "
                  [style.width.%]="diskPct()"
                ></div>
              </div>
              <div class="fleet-meter-meta tabular">
                <span>
                  {{ (primaryDisk()?.holds ?? []).join(", ") || "host volume" }}
                  @if (primaryDisk()?.floorMB) {
                    · floor {{ fmtMB(primaryDisk()?.floorMB) }}
                  }
                </span>
              </div>
            </article>
          </div>
        }

        <!-- Expandable Host Top Snapshot -->
        @if (topOpen()) {
          <article class="ops-card" data-testid="fleet-host-top">
            <div class="ops-card-head">
              <div>
                <h2 class="ops-card-title">Host Process Snapshot (top)</h2>
                <p class="ops-card-sub">
                  Live process utilization on the daemon host (GET
                  /api/host/top)
                </p>
              </div>
              <button type="button" class="btn-tonal" (click)="loadHostTop()">
                Refresh top
              </button>
            </div>
            @if (!hostTop()?.enabled) {
              <p class="muted" style="margin: 0">
                Host process snapshot is not enabled on this deployment.
              </p>
            } @else {
              <pre
                class="dark-well"
                tabindex="0"
                aria-label="Host top output"
                >{{
                  (hostTop()?.lines ?? []).join(
                    "
"
                  )
                }}</pre>
            }
          </article>
        }

        <!-- TAB 1: SANDBOXES -->
        @if (tab() === "sandboxes") {
          <div
            id="fleet-panel-sandboxes"
            role="tabpanel"
            aria-labelledby="fleet-tab-btn-sandboxes"
            style="display: flex; flex-direction: column; gap: 20px"
          >
            @if (!canReadSandboxes() && !canReadPersistent()) {
              <p class="empty-state" data-testid="fleet-sandboxes-denied">
                {{
                  access.deniedReason("GET /api/sandboxes") ||
                    deniedScopeFallback("deployment:read")
                }}
              </p>
            } @else {
              <article class="ops-card" data-testid="fleet-live-sandboxes">
                <div class="ops-card-head">
                  <div>
                    <h2 class="ops-card-title">Live Task Sandboxes</h2>
                    <p class="ops-card-sub">
                      Active isolated execution guests running in-flight tasks
                      and standing services
                    </p>
                  </div>
                </div>

                @if (!canReadSandboxes()) {
                  <p class="empty-state" data-testid="fleet-sandboxes-denied">
                    {{
                      access.deniedReason("GET /api/sandboxes") ||
                        deniedScopeFallback("deployment:read")
                    }}
                  </p>
                } @else if (filteredSandboxes().length === 0) {
                  <p
                    class="muted"
                    style="margin: 0"
                    data-testid="sandboxes-empty"
                  >
                    No active task sandboxes right now.
                  </p>
                } @else {
                  <div
                    class="ops-table-wrap"
                    tabindex="0"
                    role="region"
                    aria-label="Fleet table"
                  >
                    <table class="ops-table">
                      <thead>
                        <tr>
                          <th scope="col">Sandbox</th>
                          <th scope="col">Status</th>
                          <th scope="col">Task</th>
                          <th scope="col">Backend</th>
                          <th scope="col">Shape &amp; Memory</th>
                          <th scope="col">Load</th>
                          <th scope="col">Age</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (sb of filteredSandboxes(); track sb.sandbox) {
                          @let tid = taskIdOf(sb);
                          <tr [attr.data-testid]="'sandbox-row-' + sb.sandbox">
                            <td class="tabular">
                              <strong>{{ sb.name || sb.sandbox }}</strong>
                              @if (sb.networkAccess) {
                                <span class="muted">
                                  · {{ sb.networkAccess }}</span
                                >
                              }
                            </td>
                            <td>
                              <span
                                [class]="
                                  sb.ready && !sb.error
                                    ? 'status-pill healthy'
                                    : 'status-pill error'
                                "
                              >
                                <g-status-icon
                                  [tone]="
                                    sb.ready && !sb.error ? 'healthy' : 'error'
                                  "
                                  [kind]="
                                    sb.ready && !sb.error ? 'healthy' : 'error'
                                  "
                                />
                                {{
                                  sb.ready && !sb.error
                                    ? "Ready"
                                    : sb.error ||
                                      sb.terminationReason ||
                                      "Not ready"
                                }}
                              </span>
                            </td>
                            <td class="tabular">
                              @if (tid) {
                                <a [routerLink]="['/task', tid]">#{{ tid }}</a>
                              } @else {
                                <span class="muted">{{ sb.kind || "—" }}</span>
                              }
                            </td>
                            <td class="tabular">{{ sb.backend }}</td>
                            <td class="tabular">
                              {{ sb.cpus ?? "—" }} vCPU ·
                              {{ fmtMB(sb.memoryUsedMB ?? sb.memoryMB) }}
                            </td>
                            <td class="tabular">{{ sb.loadAverage || "—" }}</td>
                            <td class="tabular">{{ fmtAge(sb.startedAt) }}</td>
                            <td>
                              @if (tid && canRecreateTaskSandbox()) {
                                <button
                                  type="button"
                                  class="btn-text danger"
                                  [attr.data-testid]="'sandbox-recreate-' + tid"
                                  [gTip]="
                                    'Destroy and rebuild sandbox for task #' +
                                    tid +
                                    ' (asks confirmation first)'
                                  "
                                  (click)="recreateTaskSandbox(tid)"
                                >
                                  Recreate
                                </button>
                              }
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }

                <!-- Sandbox Exec Probe -->
                <div
                  class="fleet-item-card"
                  data-testid="fleet-sandbox-probe"
                  style="margin-top: 6px"
                >
                  <div class="fleet-item-head">
                    <span class="fleet-item-title"
                      >Sandbox Diagnostic Probe</span
                    >
                    <span class="muted" style="font-size: 12px"
                      >Boots a throwaway sandbox, executes argv, and tears it
                      down</span
                    >
                  </div>
                  <div class="fleet-inline-bar">
                    <input
                      type="text"
                      class="ops-input tabular"
                      style="flex: 1 1 240px"
                      aria-label="Probe command argv"
                      data-testid="probe-cmd-input"
                      [value]="probeCmd()"
                      (input)="probeCmd.set($any($event.target).value)"
                    />
                    <button
                      type="button"
                      class="btn-tonal"
                      data-testid="probe-run-btn"
                      [disabled]="probing() || !canProbeSandboxes()"
                      [gTip]="probeTip()"
                      (click)="runSandboxProbe()"
                    >
                      {{ probing() ? "Probing…" : "Run probe" }}
                    </button>
                  </div>
                  @if (probeResult(); as pr) {
                    <pre
                      class="dark-well"
                      tabindex="0"
                      data-testid="probe-output"
                    >
sandbox={{ pr.sandbox }} pod={{ pr.pod }} exit={{ pr.exitCode }}
{{ pr.stdout }}{{ pr.stderr }}</pre>
                  }
                </div>
              </article>

              <!-- Persistent / Staging Sandboxes -->
              <article
                class="ops-card"
                data-testid="fleet-persistent-sandboxes"
              >
                <div class="ops-card-head">
                  <div>
                    <h2 class="ops-card-title">
                      Persistent &amp; Staging Sandboxes
                    </h2>
                    <p class="ops-card-sub">
                      Long-lived repository checkouts and staging servers
                      supervised outside worker slots
                    </p>
                  </div>
                </div>

                @if (!canReadPersistent()) {
                  <p class="empty-state" data-testid="fleet-persistent-denied">
                    {{
                      access.deniedReason("GET /api/persistent-sandboxes") ||
                        deniedScopeFallback("sandboxes:read")
                    }}
                  </p>
                } @else if (persistentSandboxes().length === 0) {
                  <p class="muted" style="margin: 0">
                    No persistent or staging sandboxes configured on this
                    deployment.
                  </p>
                } @else {
                  <div class="fleet-card-list">
                    @for (ps of persistentSandboxes(); track ps.name) {
                      <div
                        class="fleet-item-card"
                        [attr.data-testid]="'persistent-card-' + ps.name"
                      >
                        <div class="fleet-item-head">
                          <div class="fleet-item-title">
                            <span class="tabular">{{ ps.name }}</span>
                            <span
                              [class]="
                                ps.state === 'running'
                                  ? 'status-pill healthy'
                                  : ps.lastError
                                    ? 'status-pill error'
                                    : 'status-pill neutral'
                              "
                            >
                              <g-status-icon
                                [tone]="
                                  ps.state === 'running'
                                    ? 'healthy'
                                    : ps.lastError
                                      ? 'error'
                                      : 'neutral'
                                "
                                [kind]="
                                  ps.state === 'running'
                                    ? 'running'
                                    : ps.lastError
                                      ? 'error'
                                      : 'neutral'
                                "
                              />
                              {{
                                ps.state || (ps.enabled ? "idle" : "stopped")
                              }}
                            </span>
                            <span class="muted tabular">{{ ps.repo }}</span>
                            @if (ps.ref) {
                              <span class="fleet-tag">{{ ps.ref }}</span>
                            }
                          </div>

                          <div class="fleet-inline-bar">
                            @for (act of persistentActions; track act.action) {
                              <button
                                type="button"
                                class="btn-tonal"
                                [attr.data-testid]="
                                  'persistent-' + act.action + '-' + ps.name
                                "
                                [disabled]="
                                  isPersistentActionDisabled(ps, act.action)
                                "
                                [gTip]="
                                  persistentActionTip(ps, act.action, act.label)
                                "
                                (click)="controlPersistent(ps, act.action)"
                              >
                                {{ act.label }}
                              </button>
                            }
                            <button
                              type="button"
                              class="btn-text"
                              [attr.data-testid]="
                                'persistent-logs-btn-' + ps.name
                              "
                              [disabled]="!canReadPersistentLogs(ps)"
                              [gTip]="persistentLogsTip(ps)"
                              (click)="togglePersistentLogs(ps)"
                            >
                              {{
                                openPersistentLogName() === ps.name
                                  ? "Hide logs"
                                  : "Logs"
                              }}
                            </button>
                          </div>
                        </div>

                        <div class="fleet-item-meta tabular">
                          <span>cmd: {{ ps.command }}</span>
                          <span>restarts: {{ ps.restarts }}</span>
                          @if (ps.uiSubpath) {
                            <span>subpath: {{ ps.uiSubpath }}</span>
                          }
                          @if (ps.hostPort) {
                            <span>port: :{{ ps.hostPort }}</span>
                          }
                          @if (ps.lastError) {
                            <span style="color: var(--md-sys-color-error)">{{
                              ps.lastError
                            }}</span>
                          }
                        </div>

                        @if (
                          openPersistentLogName() === ps.name &&
                          canReadPersistentLogs(ps)
                        ) {
                          <pre
                            class="dark-well"
                            tabindex="0"
                            [attr.data-testid]="'persistent-logs-' + ps.name"
                            >{{
                              persistentLogsText() || "(no output recorded)"
                            }}</pre>
                        }
                      </div>
                    }
                  </div>
                }
              </article>
            }
          </div>
        }

        <!-- TAB 2: HOST DAEMONS (hostds) -->
        @if (tab() === "hostds") {
          <div
            id="fleet-panel-hostds"
            role="tabpanel"
            aria-labelledby="fleet-tab-btn-hostds"
            style="display: flex; flex-direction: column; gap: 20px"
          >
            <article class="ops-card" data-testid="fleet-hostds">
              <div class="ops-card-head">
                <div>
                  <h2 class="ops-card-title">Hosts</h2>
                  <p class="ops-card-sub">
                    Co-located and remote token-landing hosts executing CLI
                    turns and host capabilities
                  </p>
                </div>
                <div class="headline-actions">
                  @if (hasRevokedHostds() && canAdminHostds()) {
                    <button
                      type="button"
                      class="btn-tonal"
                      data-testid="hostds-delete-revoked"
                      (click)="confirmDeleteRevokedHostds()"
                    >
                      Delete all revoked
                    </button>
                  }
                  <a class="btn-tonal" routerLink="/settings/hostds">
                    Enrollment &amp; settings
                  </a>
                </div>
              </div>

              @if (issuedToken(); as issued) {
                <div
                  class="fleet-token-banner"
                  data-testid="hostd-issued-token"
                >
                  <div class="fleet-item-head">
                    <strong
                      >New token for {{ issued.hostd.name }} (shown
                      once)</strong
                    >
                    <div class="fleet-inline-bar">
                      <button
                        type="button"
                        class="btn-tonal"
                        (click)="copyText(issued.token, 'Copied host token.')"
                      >
                        Copy token
                      </button>
                      <button
                        type="button"
                        class="btn-text"
                        (click)="issuedToken.set(null)"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <code class="fleet-token-code">{{ issued.token }}</code>
                </div>
              }

              @if (!canReadHostds()) {
                <p class="empty-state" data-testid="fleet-hostds-denied">
                  {{
                    access.deniedReason("GET /api/hostds") ||
                      deniedScopeFallback("capabilities:read")
                  }}
                </p>
              } @else if (filteredHostds().length === 0) {
                <p class="muted" style="margin: 0">
                  No host daemons registered on this deployment.
                </p>
              } @else {
                <div class="fleet-card-list">
                  @for (h of filteredHostds(); track h.name) {
                    @let isLocal = h.name === "local";
                    <div
                      class="fleet-item-card"
                      [attr.data-testid]="'hostd-row-' + h.name"
                    >
                      <div class="fleet-item-head">
                        <div class="fleet-item-title">
                          <span class="tabular">{{ h.name }}</span>
                          <span
                            [class]="
                              h.state === 'connected'
                                ? 'status-pill healthy'
                                : h.state === 'revoked'
                                  ? 'status-pill error'
                                  : 'status-pill quiet'
                            "
                          >
                            <g-status-icon
                              [tone]="
                                h.state === 'connected'
                                  ? 'healthy'
                                  : h.state === 'revoked'
                                    ? 'error'
                                    : 'quiet'
                              "
                              [kind]="
                                h.state === 'connected'
                                  ? 'healthy'
                                  : h.state === 'revoked'
                                    ? 'error'
                                    : 'warning'
                              "
                            />
                            {{ h.state }}
                          </span>
                          @if (isLocal) {
                            <span class="fleet-tag">co-located</span>
                          }
                          @if (h.owner) {
                            <g-actor-chip [label]="h.owner" kind="human" />
                          }
                        </div>

                        @if (!isLocal && !h.shared && canAdminHostds()) {
                          <div class="fleet-inline-bar">
                            @if (h.state !== "revoked") {
                              <button
                                type="button"
                                class="btn-tonal"
                                [attr.data-testid]="'hostd-rotate-' + h.name"
                                (click)="rotateHostd(h.name)"
                              >
                                Rotate token
                              </button>
                              <button
                                type="button"
                                class="btn-tonal"
                                [attr.data-testid]="
                                  'hostd-rename-open-' + h.name
                                "
                                (click)="startRenameHostd(h.name)"
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                class="btn-text danger"
                                [attr.data-testid]="'hostd-revoke-' + h.name"
                                (click)="confirmRevokeHostd(h.name)"
                              >
                                Revoke
                              </button>
                            } @else {
                              <button
                                type="button"
                                class="btn-text danger"
                                [attr.data-testid]="'hostd-delete-' + h.name"
                                (click)="confirmDeleteHostd(h.name)"
                              >
                                Delete
                              </button>
                            }
                          </div>
                        }
                      </div>

                      @if (renamingHostd() === h.name) {
                        <div class="fleet-inline-bar">
                          <input
                            type="text"
                            class="ops-input tabular"
                            aria-label="New hostd name"
                            [attr.data-testid]="'hostd-rename-input-' + h.name"
                            [value]="renameDraft()"
                            (input)="renameDraft.set($any($event.target).value)"
                          />
                          <button
                            type="button"
                            class="btn-primary"
                            [attr.data-testid]="'hostd-rename-save-' + h.name"
                            (click)="submitRenameHostd(h.name)"
                          >
                            Save name
                          </button>
                          <button
                            type="button"
                            class="btn-text"
                            (click)="renamingHostd.set(null)"
                          >
                            Cancel
                          </button>
                        </div>
                      }

                      <div class="fleet-item-meta tabular">
                        @if (h.hostname) {
                          <span>host: {{ h.hostname }}</span>
                        }
                        @if (h.os || h.arch) {
                          <span>{{ h.os }}/{{ h.arch }}</span>
                        }
                        @if (h.version) {
                          <span>{{ h.version }}</span>
                        }
                        @if (h.capacity) {
                          <span>cap: {{ h.capacity }}</span>
                        }
                        @if (h.token_prefix) {
                          <span>token: {{ h.token_prefix }}…</span>
                        }
                        @if (h.last_seen_at) {
                          <span>seen {{ fmtAge(h.last_seen_at) }} ago</span>
                        }
                      </div>

                      @if (
                        (h.clis?.length ?? 0) > 0 || (h.logins?.length ?? 0) > 0
                      ) {
                        <div class="fleet-chip-list">
                          @for (cli of h.clis ?? []; track cli) {
                            <span class="fleet-tag">cli:{{ cli }}</span>
                          }
                          @for (login of h.logins ?? []; track login) {
                            <span class="fleet-tag">login:{{ login }}</span>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </article>

            <article class="ops-card" data-testid="fleet-hostds-enrollment">
              <div class="ops-card-head">
                <div>
                  <h2 class="ops-card-title">Host Enrollment Codes</h2>
                  <p class="ops-card-sub">
                    Reusable invite codes for remote hosts joining via grain
                    host --join (operator-only)
                  </p>
                </div>
              </div>

              @if (!canReadEnrollmentCodes()) {
                <p
                  class="empty-state"
                  data-testid="fleet-enrollment-restricted"
                >
                  {{ operatorDeniedReason("GET /api/hostds/enrollment-codes") }}
                </p>
              } @else {
                @if (issuedEnrollmentCode(); as issued) {
                  <div
                    class="fleet-token-banner"
                    data-testid="fleet-enrollment-issued"
                  >
                    <div class="fleet-item-head">
                      <strong>Issued enrollment code {{ issued.name }}</strong>
                      <div class="fleet-inline-bar">
                        <button
                          type="button"
                          class="btn-tonal"
                          (click)="
                            copyText(issued.text, 'Copied enrollment details.')
                          "
                        >
                          Copy
                        </button>
                        <button
                          type="button"
                          class="btn-text"
                          (click)="issuedEnrollmentCode.set(null)"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                    <pre class="fleet-token-code">{{ issued.text }}</pre>
                  </div>
                }

                @if (enrollmentCodes().length === 0) {
                  <p
                    class="muted"
                    style="margin: 0"
                    data-testid="fleet-enrollment-empty"
                  >
                    No host enrollment codes created yet.
                  </p>
                } @else {
                  <div class="fleet-card-list">
                    @for (c of enrollmentCodes(); track c.name) {
                      @let codeRevoked = !!c.revoked_at;
                      <div
                        class="fleet-item-card"
                        [attr.data-testid]="'fleet-enrollment-row-' + c.name"
                      >
                        <div class="fleet-item-head">
                          <div class="fleet-item-title">
                            <span class="tabular">{{ c.name }}</span>
                            <span
                              [class]="
                                codeRevoked
                                  ? 'status-pill error'
                                  : 'status-pill healthy'
                              "
                            >
                              <g-status-icon
                                [tone]="codeRevoked ? 'error' : 'healthy'"
                                [kind]="codeRevoked ? 'error' : 'healthy'"
                              />
                              {{ codeRevoked ? "revoked" : "active" }}
                            </span>
                          </div>
                          <div class="fleet-inline-bar">
                            <button
                              type="button"
                              class="btn-tonal"
                              [attr.data-testid]="
                                'fleet-enrollment-rotate-' + c.name
                              "
                              [disabled]="
                                !canRotateEnrollmentCode() || codeRevoked
                              "
                              [gTip]="
                                canRotateEnrollmentCode()
                                  ? codeRevoked
                                    ? 'Revoked codes cannot be rotated.'
                                    : 'Rotate enrollment code'
                                  : operatorDeniedReason(
                                      'POST /api/hostds/enrollment-codes/{name}/rotate'
                                    )
                              "
                              (click)="confirmRotateEnrollmentCode(c.name)"
                            >
                              Rotate
                            </button>
                            <button
                              type="button"
                              class="btn-text danger"
                              [attr.data-testid]="
                                'fleet-enrollment-revoke-' + c.name
                              "
                              [disabled]="
                                !canRevokeEnrollmentCode() || codeRevoked
                              "
                              [gTip]="
                                canRevokeEnrollmentCode()
                                  ? codeRevoked
                                    ? 'Enrollment code already revoked.'
                                    : 'Revoke enrollment code'
                                  : operatorDeniedReason(
                                      'POST /api/hostds/enrollment-codes/{name}/revoke'
                                    )
                              "
                              (click)="confirmRevokeEnrollmentCode(c.name)"
                            >
                              Revoke
                            </button>
                          </div>
                        </div>
                        <div class="fleet-item-meta tabular">
                          <span
                            >uses: {{ c.uses ?? 0 }} /
                            {{ c.max_uses || "∞" }}</span
                          >
                          <span>{{
                            codeRevoked
                              ? "revoked"
                              : c.expires_at
                                ? "expires " + c.expires_at
                                : "never expires"
                          }}</span>
                          @if (c.created_by) {
                            <span>by {{ c.created_by }}</span>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }

                <form
                  autocomplete="off"
                  class="fleet-inline-bar"
                  (submit)="$event.preventDefault(); createEnrollmentCode()"
                >
                  <input
                    type="text"
                    name="grain-fleet-enrollment-code"
                    autocomplete="off"
                    spellcheck="false"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    class="ops-input tabular"
                    aria-label="New enrollment code name"
                    data-testid="fleet-enrollment-name-input"
                    placeholder="team-workstations"
                    [value]="newEnrollmentCodeName()"
                    [disabled]="
                      !canCreateEnrollmentCode() || creatingEnrollmentCode()
                    "
                    (input)="
                      newEnrollmentCodeName.set($any($event.target).value)
                    "
                  />
                  <button
                    type="submit"
                    class="btn-primary"
                    data-testid="fleet-enrollment-create-btn"
                    [disabled]="
                      !canCreateEnrollmentCode() ||
                      !newEnrollmentCodeName().trim() ||
                      creatingEnrollmentCode()
                    "
                    [gTip]="
                      canCreateEnrollmentCode()
                        ? 'Create reusable enrollment code'
                        : operatorDeniedReason(
                            'POST /api/hostds/enrollment-codes'
                          )
                    "
                  >
                    Create enrollment code
                  </button>
                </form>
              }
            </article>

            <article class="ops-card" data-testid="fleet-hostds-pending">
              <div class="ops-card-head">
                <div>
                  <h2 class="ops-card-title">Pending Host Approvals</h2>
                  <p class="ops-card-sub">
                    Pending join requests awaiting operator verification of
                    enrolling identity and Ed25519 key fingerprint
                    (operator-only)
                  </p>
                </div>
                @if (canReadPendingHostds()) {
                  <span
                    class="status-pill neutral tabular"
                    data-testid="fleet-pending-count"
                  >
                    <g-status-icon tone="neutral" kind="progress" />
                    {{ pendingHostds().length }} pending
                  </span>
                }
              </div>

              @if (!canReadPendingHostds()) {
                <p class="empty-state" data-testid="fleet-pending-restricted">
                  {{ operatorDeniedReason("GET /api/hostds/pending") }}
                </p>
              } @else if (pendingHostds().length === 0) {
                <p
                  class="muted"
                  style="margin: 0"
                  data-testid="fleet-pending-empty"
                >
                  No pending host join requests.
                </p>
              } @else {
                <div class="fleet-card-list" data-testid="fleet-pending-list">
                  @for (p of pendingHostds(); track p.id) {
                    <div
                      class="fleet-item-card"
                      [attr.data-testid]="'fleet-pending-row-' + p.id"
                    >
                      <div class="fleet-item-head">
                        <div class="fleet-item-title">
                          <span class="tabular">{{
                            p.suggested_name || p.hostname || p.id
                          }}</span>
                          <span class="status-pill quiet">
                            <g-status-icon tone="quiet" kind="warning" />
                            pending
                          </span>
                          @if (p.enrolled_by) {
                            <g-actor-chip
                              [label]="p.enrolled_by"
                              kind="human"
                            />
                          }
                        </div>
                        <div class="fleet-inline-bar">
                          <button
                            type="button"
                            class="btn-primary"
                            [attr.data-testid]="'fleet-pending-accept-' + p.id"
                            [disabled]="
                              !canAcceptPendingHostd() ||
                              busyPendingId() === p.id
                            "
                            [gTip]="
                              canAcceptPendingHostd()
                                ? 'Approve join request and bind Ed25519 key'
                                : operatorDeniedReason(
                                    'POST /api/hostds/pending/{id}/accept'
                                  )
                            "
                            (click)="acceptPendingHostd(p)"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            class="btn-text danger"
                            [attr.data-testid]="'fleet-pending-reject-' + p.id"
                            [disabled]="
                              !canRejectPendingHostd() ||
                              busyPendingId() === p.id
                            "
                            [gTip]="
                              canRejectPendingHostd()
                                ? 'Reject pending join request'
                                : operatorDeniedReason(
                                    'POST /api/hostds/pending/{id}/reject'
                                  )
                            "
                            (click)="confirmRejectPendingHostd(p)"
                          >
                            Reject
                          </button>
                        </div>
                      </div>

                      <div class="fleet-item-meta tabular">
                        <span
                          class="fleet-fingerprint"
                          [attr.data-testid]="
                            'fleet-pending-fingerprint-' + p.id
                          "
                        >
                          key: {{ p.key_fingerprint || "—" }}
                        </span>
                        @if (p.hostname) {
                          <span>host: {{ p.hostname }}</span>
                        }
                        @if (p.os || p.arch) {
                          <span>{{ p.os || "?" }}/{{ p.arch || "?" }}</span>
                        }
                        @if (p.enrollment_code) {
                          <span>code: {{ p.enrollment_code }}</span>
                        }
                      </div>

                      <div class="fleet-inline-bar">
                        <input
                          type="text"
                          class="ops-input tabular"
                          [attr.aria-label]="
                            'Labels for ' + (p.hostname || p.id)
                          "
                          [attr.data-testid]="'fleet-pending-labels-' + p.id"
                          placeholder="k=v (optional)"
                          [value]="pendingLabelsValue(p)"
                          [disabled]="
                            !canAcceptPendingHostd() || busyPendingId() === p.id
                          "
                          (input)="
                            setPendingLabelDraft(
                              p.id,
                              $any($event.target).value
                            )
                          "
                        />
                      </div>
                    </div>
                  }
                </div>
              }
            </article>
          </div>
        }

        <!-- TAB 3: PAUSES, CACHES & DAEMON LIFECYCLE -->
        @if (tab() === "controls") {
          <div
            id="fleet-panel-controls"
            role="tabpanel"
            aria-labelledby="fleet-tab-btn-controls"
            style="display: flex; flex-direction: column; gap: 20px"
          >
            @if (
              !canReadDispatch() &&
              !canReadCaches() &&
              !canReadSandboxes() &&
              !canRestartDaemon()
            ) {
              <p class="empty-state" data-testid="fleet-controls-denied">
                {{
                  access.deniedReason("GET /api/pipeline-pause") ||
                    deniedScopeFallback("dispatch:read")
                }}
              </p>
            } @else {
              <div class="ops-grid-2">
                <!-- Pipeline Dispatch Gate -->
                <article class="ops-card" data-testid="fleet-pipeline-card">
                  <div class="ops-card-head">
                    <div>
                      <h2 class="ops-card-title">Pipeline Dispatch Gate</h2>
                      <p class="ops-card-sub">
                        Holds new task pickup while letting in-flight runs
                        finish
                      </p>
                    </div>
                    @if (canReadDispatch()) {
                      <span
                        [class]="
                          pipelinePause()?.paused
                            ? 'status-pill blast'
                            : 'status-pill healthy'
                        "
                        data-testid="pipeline-pause-state"
                      >
                        <g-status-icon
                          [tone]="pipelinePause()?.paused ? 'blast' : 'healthy'"
                          [kind]="
                            pipelinePause()?.paused ? 'warning' : 'healthy'
                          "
                        />
                        {{ pipelinePause()?.paused ? "Paused" : "Dispatching" }}
                      </span>
                    }
                  </div>

                  @if (!canReadDispatch()) {
                    <p class="empty-state">
                      {{
                        access.deniedReason("GET /api/pipeline-pause") ||
                          deniedScopeFallback("dispatch:read")
                      }}
                    </p>
                  } @else if (pipelinePause()?.paused) {
                    <div class="fleet-item-meta">
                      <span
                        >Reason: {{ pipelinePause()?.reason || "paused" }}</span
                      >
                      @if (pipelinePause()?.byLabel || pipelinePause()?.byId) {
                        <g-actor-chip
                          [label]="
                            pipelinePause()?.byLabel ||
                            pipelinePause()?.byId ||
                            'Operator'
                          "
                          [kind]="pipelinePause()?.byKind || 'human'"
                        />
                      }
                    </div>
                    <div>
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="pipeline-resume-btn"
                        [disabled]="!canWriteDispatch() || busyDispatch()"
                        [gTip]="
                          canWriteDispatch()
                            ? 'Resume dispatching queued tasks'
                            : access.deniedReason('DELETE /api/pipeline-pause')
                        "
                        (click)="resumePipeline()"
                      >
                        Resume pipeline
                      </button>
                    </div>
                  } @else {
                    <div class="fleet-inline-bar">
                      <input
                        type="text"
                        class="ops-input"
                        style="flex: 1 1 200px"
                        placeholder="Optional pause reason (e.g. maintenance window)"
                        aria-label="Pipeline pause reason"
                        data-testid="pipeline-pause-reason"
                        [value]="pauseReasonDraft()"
                        (input)="
                          pauseReasonDraft.set($any($event.target).value)
                        "
                      />
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="pipeline-pause-btn"
                        [disabled]="!canWriteDispatch() || busyDispatch()"
                        [gTip]="
                          canWriteDispatch()
                            ? 'Pause new task dispatch'
                            : access.deniedReason('POST /api/pipeline-pause')
                        "
                        (click)="pausePipeline()"
                      >
                        Pause pipeline
                      </button>
                    </div>
                  }
                </article>

                <!-- Usage-Limit Pauses -->
                <article class="ops-card" data-testid="fleet-usage-pauses-card">
                  <div class="ops-card-head">
                    <div>
                      <h2 class="ops-card-title">Model Usage-Limit Pauses</h2>
                      <p class="ops-card-sub">
                        Provider quota windows automatically holding affected
                        connections
                      </p>
                    </div>
                    @if (
                      (agentPause()?.pauses?.length ?? 0) > 1 &&
                      canWriteDispatch()
                    ) {
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="lift-all-pauses-btn"
                        (click)="liftAgentPause()"
                      >
                        Lift all
                      </button>
                    }
                  </div>

                  @if (!canReadDispatch()) {
                    <p class="empty-state">
                      {{
                        access.deniedReason("GET /api/pause") ||
                          deniedScopeFallback("dispatch:read")
                      }}
                    </p>
                  } @else if ((agentPause()?.pauses?.length ?? 0) === 0) {
                    <p class="muted" style="margin: 0">
                      No model connections are currently paused on quota limits.
                    </p>
                  } @else {
                    <div class="fleet-card-list">
                      @for (
                        p of agentPause()?.pauses ?? [];
                        track (p.connection || "") + ":" + (p.model || "")
                      ) {
                        <div class="fleet-item-card">
                          <div class="fleet-item-head">
                            <span class="tabular"
                              ><strong>{{
                                p.connectionName || p.connection || p.framework
                              }}</strong>
                              @if (p.model) {
                                · {{ p.model }}
                              }
                            </span>
                            @if (p.canLift && canWriteDispatch()) {
                              <button
                                type="button"
                                class="btn-tonal"
                                (click)="liftAgentPause(p)"
                              >
                                Lift pause
                              </button>
                            }
                          </div>
                          <div class="fleet-item-meta tabular">
                            <span>{{
                              p.reason || "provider rate/usage limit"
                            }}</span>
                            <span
                              >Resets in
                              {{ Math.ceil(p.secondsRemaining / 60) }}m</span
                            >
                          </div>
                        </div>
                      }
                    </div>
                  }
                </article>

                <!-- Package & Actions Caches -->
                <article class="ops-card" data-testid="fleet-caches-card">
                  <div class="ops-card-head">
                    <div>
                      <h2 class="ops-card-title">Proxy &amp; Actions Caches</h2>
                      <p class="ops-card-sub">
                        On-controller package proxy and GitHub Actions build
                        caches
                      </p>
                    </div>
                  </div>

                  @if (!canReadCaches()) {
                    <p class="empty-state">
                      {{
                        access.deniedReason("GET /api/package-cache") ||
                          deniedScopeFallback("caches:read")
                      }}
                    </p>
                  } @else {
                    <div class="fleet-item-card">
                      <div class="fleet-item-head">
                        <span class="fleet-item-title"
                          >Package Proxy Cache</span
                        >
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="flush-package-cache-btn"
                          [disabled]="
                            !canWriteCaches() || !packageCache()?.enabled
                          "
                          [gTip]="
                            canWriteCaches()
                              ? 'Flush cached packages'
                              : access.deniedReason(
                                  'POST /api/package-cache/flush'
                                )
                          "
                          (click)="confirmFlushPackageCache()"
                        >
                          Flush package cache
                        </button>
                      </div>
                      @if (packageCache()?.enabled) {
                        <div class="fleet-chip-list">
                          @for (
                            eco of packageCache()?.cache ?? [];
                            track eco.kind
                          ) {
                            <span class="fleet-tag"
                              >{{ eco.kind }}: {{ eco.entries }} ({{
                                fmtBytes(eco.bytes)
                              }})</span
                            >
                          }
                        </div>
                      } @else {
                        <span class="muted" style="font-size: 12px"
                          >Package proxy cache not enabled on this host.</span
                        >
                      }
                    </div>

                    <div class="fleet-item-card">
                      <div class="fleet-item-head">
                        <span class="fleet-item-title">Actions Cache</span>
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="flush-actions-cache-btn"
                          [disabled]="
                            !canWriteCaches() || !actionsCache()?.enabled
                          "
                          [gTip]="
                            canWriteCaches()
                              ? 'Flush GitHub Actions cache archives'
                              : access.deniedReason(
                                  'POST /api/actions-cache/flush'
                                )
                          "
                          (click)="confirmFlushActionsCache()"
                        >
                          Flush actions cache
                        </button>
                      </div>
                      @if (actionsCache()?.enabled) {
                        <div class="fleet-item-meta tabular">
                          <span
                            >{{ actionsCache()?.entries ?? 0 }} entries</span
                          >
                          <span
                            >{{ fmtBytes(actionsCache()?.bytes) }} /
                            {{ fmtBytes(actionsCache()?.maxBytes) }}</span
                          >
                        </div>
                      } @else {
                        <span class="muted" style="font-size: 12px"
                          >Actions cache not enabled on this host.</span
                        >
                      }
                    </div>
                  }
                </article>

                <!-- Daemon Lifecycle & Restart -->
                <article class="ops-card" data-testid="fleet-daemon-card">
                  <div class="ops-card-head">
                    <div>
                      <h2 class="ops-card-title">Daemon Lifecycle</h2>
                      <p class="ops-card-sub">
                        Service uptime, start history, and controlled service
                        restart
                      </p>
                    </div>
                    @if (sandboxes()?.daemon?.restarting || watchRestarting()) {
                      <span class="status-pill error">
                        <g-status-icon tone="error" kind="error" />
                        Restarting
                      </span>
                    } @else {
                      <span class="status-pill healthy">
                        <g-status-icon tone="healthy" kind="healthy" />
                        Up {{ fmtAge(sandboxes()?.daemon?.startedAt) }}
                      </span>
                    }
                  </div>

                  <div class="fleet-item-meta tabular">
                    @if (sandboxes()?.daemon?.starts) {
                      <span
                        >Starts: {{ sandboxes()?.daemon?.starts }}
                        {{ sandboxes()?.daemon?.startsScope || "" }}</span
                      >
                    }
                    @if (sandboxes()?.daemon?.logCommand) {
                      <span>{{ sandboxes()?.daemon?.logCommand }}</span>
                    }
                  </div>

                  <div class="fleet-inline-bar">
                    <button
                      type="button"
                      class="btn-primary is-destructive"
                      data-testid="daemon-restart-btn"
                      [disabled]="!canRestartDaemon()"
                      [gTip]="
                        canRestartDaemon()
                          ? 'Restart the grain daemon service (asks confirmation first)'
                          : restartDeniedReason()
                      "
                      (click)="confirmRestartDaemon()"
                    >
                      Restart daemon
                    </button>
                  </div>
                </article>
              </div>
            }
          </div>
        }

        <!-- TAB 4: DAEMON & UNIT LOGS -->
        @if (tab() === "logs") {
          <div
            id="fleet-panel-logs"
            role="tabpanel"
            aria-labelledby="fleet-tab-btn-logs"
            style="display: flex; flex-direction: column; gap: 20px"
          >
            @if (!canReadLogs()) {
              <p class="empty-state" data-testid="fleet-logs-denied">
                {{
                  access.deniedReason("GET /api/logs") ||
                    deniedScopeFallback("deployment:read")
                }}
              </p>
            } @else {
              <article class="ops-card" data-testid="fleet-logs-card">
                <div class="ops-card-head">
                  <div>
                    <h2 class="ops-card-title">Daemon &amp; Unit Logs</h2>
                    <p class="ops-card-sub">
                      Redacted journal and subsystem tails (GET
                      /api/logs/&#123;source&#125;)
                    </p>
                  </div>
                  <div class="headline-actions">
                    <span
                      class="status-pill neutral tabular"
                      data-testid="logs-line-count"
                    >
                      <g-status-icon tone="neutral" kind="progress" />
                      {{ filteredLogLines().length }} /
                      {{ logLines().length }} lines
                    </span>
                    <button
                      type="button"
                      class="btn-tonal"
                      data-testid="logs-refresh-btn"
                      (click)="loadLogLines()"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      class="btn-tonal"
                      data-testid="logs-copy-btn"
                      [disabled]="filteredLogLines().length === 0"
                      (click)="
                        copyText(
                          filteredLogLines().join(
                            '
'
                          ),
                          'Copied log lines.'
                        )
                      "
                    >
                      Copy
                    </button>
                  </div>
                </div>

                @if (!logSources()?.enabled) {
                  <p class="muted" style="margin: 0">
                    No log sources are configured on this deployment.
                  </p>
                } @else {
                  <div class="fleet-log-toolbar">
                    <div
                      class="fleet-log-pills"
                      role="group"
                      aria-label="Log source"
                    >
                      @for (src of logSources()?.sources ?? []; track src) {
                        <button
                          type="button"
                          class="filter-chip"
                          [attr.aria-pressed]="selectedLogSource() === src"
                          [attr.data-testid]="'log-source-' + src"
                          (click)="pickLogSource(src)"
                        >
                          {{ src }}
                        </button>
                      }
                    </div>

                    @if (logUnits().length > 1) {
                      <div
                        class="segmented"
                        role="group"
                        aria-label="Systemd unit"
                      >
                        @for (u of logUnits(); track u.unit) {
                          <button
                            type="button"
                            [attr.aria-pressed]="selectedLogUnit() === u.unit"
                            (click)="pickLogUnit(u.unit)"
                          >
                            {{ u.unit }} ({{ u.scope }})
                          </button>
                        }
                      </div>
                    }

                    <div class="segmented" role="group" aria-label="Tail lines">
                      @for (cnt of [200, 500, 1000]; track cnt) {
                        <button
                          type="button"
                          [attr.aria-pressed]="logLineLimit() === cnt"
                          (click)="pickLogLimit(cnt)"
                        >
                          {{ cnt }}
                        </button>
                      }
                    </div>

                    <form
                      role="search"
                      autocomplete="off"
                      style="display: contents"
                      (submit)="$event.preventDefault()"
                    >
                      <input
                        type="search"
                        name="grain-logs-filter"
                        autocomplete="off"
                        spellcheck="false"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        class="ops-input"
                        style="flex: 1 1 200px"
                        placeholder="Filter log lines…"
                        aria-label="Filter log lines"
                        data-testid="logs-search-input"
                        [value]="logQuery()"
                        (input)="logQuery.set($any($event.target).value)"
                      />
                    </form>
                  </div>

                  <pre
                    class="dark-well"
                    tabindex="0"
                    aria-label="Daemon log output"
                    data-testid="logs-viewer"
                    >{{
                      filteredLogLines().length > 0
                        ? filteredLogLines().join(
                            "
"
                          )
                        : "(no matching log lines)"
                    }}</pre>
                }
              </article>
            }
          </div>
        }
      </div>
    </section>

    @if (confirmReq(); as req) {
      <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
    }
  `,
})
export class FleetPageComponent implements OnInit {
  protected readonly api = inject(GrainApi);
  protected readonly access = inject(AccessService);
  protected readonly feed = inject(TaskFeedStore);
  protected readonly viewFilter = inject(ViewFilter);
  private readonly snackbar = inject(SnackbarService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly Math = Math;
  protected readonly tabs = TABS;
  protected readonly persistentActions = PERSISTENT_ACTIONS;
  protected readonly fmtBytes = formatBytes;
  protected readonly fmtMB = formatMB;
  protected readonly fmtAge = formatRelativeAge;
  protected readonly taskIdOf = extractTaskIdFromSandbox;

  protected readonly tab = signal<FleetTab>("sandboxes");
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly confirmReq = signal<ConfirmRequest | null>(null);

  protected readonly hostSandboxes = signal(false);
  protected readonly sandboxes = signal<SandboxHealthResponse | null>(null);
  protected readonly topOpen = signal(false);
  protected readonly hostTop = signal<HostTopResponse | null>(null);

  protected readonly persistentList = signal<PersistentSandboxStatus[] | null>(
    null,
  );
  protected readonly busyPersistent = signal<string | null>(null);
  protected readonly openPersistentLogName = signal<string | null>(null);
  protected readonly persistentLogsText = signal<string>("");

  protected readonly probeCmd = signal<string>("uname -a");
  protected readonly probing = signal(false);
  protected readonly probeResult = signal<SandboxProbeResult | null>(null);

  protected readonly hostds = signal<HostdView[]>([]);
  protected readonly issuedToken = signal<IssuedHostdToken | null>(null);
  protected readonly renamingHostd = signal<string | null>(null);
  protected readonly renameDraft = signal<string>("");
  protected readonly enrollmentCodes = signal<HostEnrollmentCodeView[]>([]);
  protected readonly issuedEnrollmentCode = signal<{
    name: string;
    text: string;
  } | null>(null);
  protected readonly newEnrollmentCodeName = signal<string>("");
  protected readonly creatingEnrollmentCode = signal<boolean>(false);
  protected readonly pendingHostds = signal<PendingHostJoinView[]>([]);
  protected readonly pendingLabelDrafts = signal<
    Partial<Record<string, string>>
  >({});
  protected readonly busyPendingId = signal<string | null>(null);

  protected readonly pipelinePause = signal<PipelinePauseStatus | null>(null);
  protected readonly pauseReasonDraft = signal<string>("");
  protected readonly busyDispatch = signal(false);
  protected readonly agentPause = signal<AgentPauseResponse["pause"] | null>(
    null,
  );
  protected readonly packageCache = signal<PackageCacheState | null>(null);
  protected readonly actionsCache = signal<ActionsCacheState | null>(null);
  protected readonly watchRestarting = signal(false);

  protected readonly logSources = signal<LogSourcesResponse | null>(null);
  protected readonly selectedLogSource = signal<string>("");
  protected readonly selectedLogUnit = signal<string>("");
  protected readonly logUnits = signal<LogUnit[]>([]);
  protected readonly logLineLimit = signal<number>(500);
  protected readonly logLines = signal<string[]>([]);
  protected readonly logQuery = signal<string>("");

  private isScopeRepoLimited(scope: string): boolean {
    return (
      !this.access.isFullAccess() &&
      Boolean(this.access.repoLimits()[scope]?.length)
    );
  }

  protected deniedScopeFallback(scope: string): string {
    return `Your role ${this.access.roleLabel() || "limited"} is repository-limited on ${scope} and cannot read deployment-wide fleet state.`;
  }

  protected readonly canReadSandboxes = computed(
    () =>
      this.access.can("GET /api/sandboxes") &&
      !this.isScopeRepoLimited("deployment:read"),
  );
  protected readonly canReadPersistent = computed(
    () =>
      this.access.can("GET /api/persistent-sandboxes") &&
      !this.isScopeRepoLimited("sandboxes:read"),
  );
  // Whether this deployment can restart grain at all (/api/config's
  // restartEnabled): a daemon started without a restart command answers
  // POST /api/host/restart with 404, so the button says so up front
  // rather than letting the request be made and refused.
  protected readonly restartEnabled = signal(true);
  protected readonly canRestartDaemon = computed(
    () =>
      this.restartEnabled() &&
      this.access.can("POST /api/host/restart") &&
      !this.isScopeRepoLimited("deployment:restart"),
  );
  protected readonly restartDeniedReason = computed(() =>
    this.restartEnabled()
      ? this.access.deniedReason("POST /api/host/restart")
      : "Restarting grain is not enabled for this deployment.",
  );
  protected readonly canRecreateTaskSandbox = computed(() =>
    this.access.can("POST /api/tasks/{id}/sandbox/recreate"),
  );
  protected readonly canReadHostds = computed(
    () =>
      this.access.can("GET /api/hostds") &&
      !this.isScopeRepoLimited("capabilities:read"),
  );
  protected readonly canAdminHostds = computed(
    () =>
      this.access.can("POST /api/hostds/{name}/revoke") &&
      !this.isScopeRepoLimited("capabilities:admin"),
  );

  private canOperatorRoute(route: RouteKey): boolean {
    const allowed = this.access.can(route);
    return (
      this.access.configLoaded() &&
      this.access.isFullAccess() &&
      routeScope(route) === null &&
      allowed
    );
  }

  protected operatorDeniedReason(route: RouteKey): string {
    if (this.canOperatorRoute(route)) return "";
    if (!this.access.configLoaded()) {
      return "Checking operator permissions…";
    }
    return (
      this.access.deniedReason(route) ||
      `Your role ${this.access.roleLabel() || "none"} cannot do this: it needs a role holding every scope (grain/operator).`
    );
  }

  protected readonly canReadEnrollmentCodes = computed(() =>
    this.canOperatorRoute("GET /api/hostds/enrollment-codes"),
  );
  protected readonly canCreateEnrollmentCode = computed(() =>
    this.canOperatorRoute("POST /api/hostds/enrollment-codes"),
  );
  protected readonly canRotateEnrollmentCode = computed(() =>
    this.canOperatorRoute("POST /api/hostds/enrollment-codes/{name}/rotate"),
  );
  protected readonly canRevokeEnrollmentCode = computed(() =>
    this.canOperatorRoute("POST /api/hostds/enrollment-codes/{name}/revoke"),
  );
  protected readonly canReadPendingHostds = computed(() =>
    this.canOperatorRoute("GET /api/hostds/pending"),
  );
  protected readonly canAcceptPendingHostd = computed(() =>
    this.canOperatorRoute("POST /api/hostds/pending/{id}/accept"),
  );
  protected readonly canRejectPendingHostd = computed(() =>
    this.canOperatorRoute("POST /api/hostds/pending/{id}/reject"),
  );
  protected readonly canReadDispatch = computed(
    () =>
      this.access.can("GET /api/pipeline-pause") &&
      !this.isScopeRepoLimited("dispatch:read"),
  );
  protected readonly canWriteDispatch = computed(
    () =>
      this.access.can("POST /api/pipeline-pause") &&
      !this.isScopeRepoLimited("dispatch:write"),
  );
  protected readonly canReadCaches = computed(
    () =>
      this.access.can("GET /api/package-cache") &&
      !this.isScopeRepoLimited("caches:read"),
  );
  protected readonly canWriteCaches = computed(
    () =>
      this.access.can("POST /api/package-cache/flush") &&
      !this.isScopeRepoLimited("caches:write"),
  );
  protected readonly canReadLogs = computed(
    () =>
      this.access.can("GET /api/logs") &&
      !this.isScopeRepoLimited("deployment:read"),
  );

  protected readonly effectiveSandboxBackend = computed<string>(() => {
    if (this.hostSandboxes()) return "host";
    const first = this.sandboxes()?.sandboxes?.[0]?.backend;
    if (first) return first;
    if (this.sandboxes()?.enabled === false) return "disabled";
    return "granule";
  });

  protected readonly canProbeSandboxes = computed(
    () =>
      !this.hostSandboxes() &&
      this.effectiveSandboxBackend() !== "host" &&
      this.sandboxes()?.enabled !== false &&
      !this.isScopeRepoLimited("deployment:restart") &&
      this.access.can("POST /api/sandbox-probe"),
  );

  protected readonly probeTip = computed<string>(() => {
    if (!this.access.can("POST /api/sandbox-probe")) {
      return this.access.deniedReason("POST /api/sandbox-probe");
    }
    if (this.isScopeRepoLimited("deployment:restart")) {
      return this.deniedScopeFallback("deployment:restart");
    }
    if (this.hostSandboxes() || this.effectiveSandboxBackend() === "host") {
      return "Sandbox diagnostic probe is unavailable when running host sandboxes.";
    }
    if (this.sandboxes()?.enabled === false) {
      return "Sandboxes are disabled on this deployment.";
    }
    return "Run diagnostic probe (POST /api/sandbox-probe)";
  });

  protected canControlPersistent(ps: PersistentSandboxStatus): boolean {
    const repo = ps.repo || undefined;
    if (!repo && this.isScopeRepoLimited("deployment:restart")) return false;
    return this.access.can(
      "POST /api/persistent-sandboxes/{name}/{action}",
      repo,
    );
  }

  protected isPersistentBusy(ps: PersistentSandboxStatus): boolean {
    const busy = this.busyPersistent();
    return busy !== null && busy.startsWith(`${ps.name}:`);
  }

  protected isPersistentActionDisabled(
    ps: PersistentSandboxStatus,
    action: PersistentAction,
  ): boolean {
    return (
      !this.canControlPersistent(ps) ||
      !isPersistentActionAllowed(ps, action) ||
      this.isPersistentBusy(ps)
    );
  }

  protected persistentActionTip(
    ps: PersistentSandboxStatus,
    action: PersistentAction,
    label: string,
  ): string {
    if (!this.canControlPersistent(ps)) {
      return (
        this.access.deniedReason(
          "POST /api/persistent-sandboxes/{name}/{action}",
          ps.repo || undefined,
        ) || this.deniedScopeFallback("deployment:restart")
      );
    }
    if (this.isPersistentBusy(ps)) {
      return `Action already in progress for ${ps.name}.`;
    }
    if (!isPersistentActionAllowed(ps, action)) {
      return `${label} is unavailable while ${ps.name} is ${effectivePersistentState(ps)}.`;
    }
    return `${label} persistent sandbox ${ps.name}`;
  }

  protected canReadPersistentLogs(ps: PersistentSandboxStatus): boolean {
    if (!this.access.configLoaded()) return false;
    const repo = ps.repo?.trim() || undefined;
    if (!repo) {
      return (
        this.access.canGlobalScope("deployment:read") &&
        this.access.can("GET /api/persistent-sandboxes/{name}/logs")
      );
    }
    return (
      this.access.canScope("deployment:read", repo) &&
      this.access.can("GET /api/persistent-sandboxes/{name}/logs", repo)
    );
  }

  protected persistentLogsTip(ps: PersistentSandboxStatus): string {
    if (this.canReadPersistentLogs(ps)) {
      return `View logs for ${ps.name}`;
    }
    if (!this.access.configLoaded()) {
      return "Checking deployment:read permissions…";
    }
    const repo = ps.repo?.trim() || undefined;
    return (
      this.access.deniedReason(
        "GET /api/persistent-sandboxes/{name}/logs",
        repo,
      ) || this.deniedScopeFallback("deployment:read")
    );
  }

  protected readonly vcpuPct = computed<number>(() => {
    const b = this.sandboxes()?.budget;
    const cap = b?.budgetCPUs || this.sandboxes()?.host?.cpus || 0;
    if (!cap) return 0;
    return Math.min(100, ((b?.committedCPUs ?? 0) / cap) * 100);
  });

  protected readonly memPct = computed<number>(() => {
    const h = this.sandboxes()?.host;
    if (!h?.memoryTotalMB) return 0;
    return Math.min(100, (h.memoryUsedMB / h.memoryTotalMB) * 100);
  });

  protected readonly primaryDisk = computed(
    () => this.sandboxes()?.host?.disks?.[0] ?? null,
  );

  protected readonly diskPct = computed<number>(() => {
    const d = this.primaryDisk();
    if (!d?.totalMB) return 0;
    return Math.min(100, (d.usedMB / d.totalMB) * 100);
  });

  protected readonly persistentSandboxes = computed<PersistentSandboxStatus[]>(
    () => this.persistentList() ?? this.sandboxes()?.persistentSandboxes ?? [],
  );

  protected readonly filteredSandboxes = computed<SandboxSnapshot[]>(() => {
    const q = this.viewFilter.query().trim().toLowerCase();
    const list = this.sandboxes()?.sandboxes ?? [];
    if (!q) return list;
    return list.filter(
      (s) =>
        s.sandbox.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.backend.toLowerCase().includes(q),
    );
  });

  protected readonly filteredHostds = computed<HostdView[]>(() => {
    const q = this.viewFilter.query().trim().toLowerCase();
    const list = this.hostds();
    if (!q) return list;
    return list.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.owner || "").toLowerCase().includes(q) ||
        (h.hostname || "").toLowerCase().includes(q),
    );
  });

  protected readonly hasRevokedHostds = computed<boolean>(() =>
    this.hostds().some((h) => h.state === "revoked"),
  );

  protected readonly filteredLogLines = computed<string[]>(() => {
    const q = (this.logQuery() || this.viewFilter.query()).trim().toLowerCase();
    const lines = this.logLines();
    if (!q) return lines;
    return lines.filter((line) => line.toLowerCase().includes(q));
  });

  ngOnInit(): void {
    // The tab follows ?tab= for as long as the page is open, not just on
    // the first render: each tab is a history entry (pickTab), so Back and
    // Forward move between tabs and have to be able to switch them.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const t = params.get("tab");
        const next: FleetTab =
          t === "hostds" || t === "controls" || t === "logs" ? t : "sandboxes";
        if (next === this.tab()) return;
        this.tab.set(next);
        if (
          next === "logs" &&
          this.selectedLogSource() &&
          !this.logLines().length
        ) {
          void this.loadLogLines();
        }
      });
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    await this.loadBootstrapConfig();
    await this.refreshAll();
  }

  private async loadBootstrapConfig(): Promise<void> {
    if (!this.access.can("GET /api/config")) return;
    try {
      const cfg = await this.api.config().catch(() => null);
      if (cfg) {
        this.access.setConfig(cfg);
        this.hostSandboxes.set(Boolean(cfg["hostSandboxes"]));
        this.restartEnabled.set(cfg["restartEnabled"] !== false);
      }
    } catch {
      // Non-fatal.
    }
  }

  async refreshAll(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      await Promise.all([
        this.loadSandboxes(),
        this.loadPersistentSandboxes(),
        this.loadHostds(),
        this.loadControls(),
        this.loadLogSources(),
      ]);
    } finally {
      this.loading.set(false);
    }
  }

  async loadSandboxes(): Promise<void> {
    if (!this.canReadSandboxes()) return;
    try {
      const res =
        await this.api.get<SandboxHealthResponse>("GET /api/sandboxes");
      this.sandboxes.set(res);
    } catch (err) {
      this.loadError.set(errorText(err));
    }
  }

  async loadPersistentSandboxes(): Promise<void> {
    if (!this.canReadPersistent()) return;
    try {
      const res = await this.api.get<
        | PersistentSandboxStatus[]
        | {
            items?: PersistentSandboxStatus[];
            sandboxes?: PersistentSandboxStatus[];
          }
      >("GET /api/persistent-sandboxes");
      const list = Array.isArray(res)
        ? res
        : (res?.items ?? res?.sandboxes ?? []);
      this.persistentList.set(list);
    } catch {
      // Falls back to sandboxes.persistentSandboxes.
    }
  }

  async loadHostds(): Promise<void> {
    await Promise.all([
      this.loadRegisteredHostds(),
      this.loadHostEnrollmentCodes(),
      this.loadPendingHostds(),
    ]);
  }

  private async loadRegisteredHostds(): Promise<void> {
    if (!this.canReadHostds()) {
      this.hostds.set([]);
      return;
    }
    try {
      const res = await this.api.get<
        HostdView[] | { items?: HostdView[]; hostds?: HostdView[] }
      >("GET /api/hostds");
      if (!this.canReadHostds()) {
        this.hostds.set([]);
        return;
      }
      this.hostds.set(
        Array.isArray(res) ? res : (res?.items ?? res?.hostds ?? []),
      );
    } catch {
      // Optional if caller lacks capabilities:read.
    }
  }

  async loadHostEnrollmentCodes(): Promise<void> {
    if (!this.canReadEnrollmentCodes()) {
      this.enrollmentCodes.set([]);
      this.issuedEnrollmentCode.set(null);
      return;
    }
    try {
      const res = await this.api.get<
        | HostEnrollmentCodeView[]
        | { codes?: HostEnrollmentCodeView[]; items?: HostEnrollmentCodeView[] }
      >("GET /api/hostds/enrollment-codes");
      if (!this.canReadEnrollmentCodes()) {
        this.enrollmentCodes.set([]);
        this.issuedEnrollmentCode.set(null);
        return;
      }
      this.enrollmentCodes.set(
        Array.isArray(res) ? res : (res?.codes ?? res?.items ?? []),
      );
    } catch {
      // Non-fatal.
    }
  }

  async loadPendingHostds(): Promise<void> {
    if (!this.canReadPendingHostds()) {
      this.pendingHostds.set([]);
      return;
    }
    try {
      const res = await this.api.get<
        | PendingHostJoinView[]
        | { pending?: PendingHostJoinView[]; items?: PendingHostJoinView[] }
      >("GET /api/hostds/pending");
      if (!this.canReadPendingHostds()) {
        this.pendingHostds.set([]);
        return;
      }
      this.pendingHostds.set(
        Array.isArray(res) ? res : (res?.pending ?? res?.items ?? []),
      );
    } catch {
      // Non-fatal.
    }
  }

  async loadControls(): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    if (this.canReadDispatch()) {
      jobs.push(
        this.api
          .get<PipelinePauseResponse>("GET /api/pipeline-pause")
          .then((r) => this.pipelinePause.set(r?.pause ?? null))
          .catch(() => undefined),
        this.api
          .get<AgentPauseResponse>("GET /api/pause")
          .then((r) => this.agentPause.set(r?.pause ?? null))
          .catch(() => undefined),
      );
    }
    if (this.canReadCaches()) {
      jobs.push(
        this.api
          .get<PackageCacheState>("GET /api/package-cache")
          .then((r) => this.packageCache.set(r))
          .catch(() => undefined),
        this.api
          .get<ActionsCacheState>("GET /api/actions-cache")
          .then((r) => this.actionsCache.set(r))
          .catch(() => undefined),
      );
    }
    await Promise.all(jobs);
  }

  async loadLogSources(): Promise<void> {
    if (!this.canReadLogs()) return;
    try {
      const res = await this.api.get<LogSourcesResponse>("GET /api/logs");
      this.logSources.set(res);
      const list = res?.sources ?? [];
      if (res?.enabled && list.length > 0 && !this.selectedLogSource()) {
        const chosen = list.includes("daemon") ? "daemon" : list[0];
        this.selectedLogSource.set(chosen);
        await this.loadLogLines();
      } else if (this.selectedLogSource()) {
        await this.loadLogLines();
      }
    } catch {
      // Optional when logs disabled.
    }
  }

  async loadLogLines(): Promise<void> {
    const src = this.selectedLogSource();
    if (!src || !this.canReadLogs()) return;
    const params = new URLSearchParams();
    params.set("lines", String(this.logLineLimit()));
    if (this.selectedLogUnit()) params.set("unit", this.selectedLogUnit());
    try {
      const res = await this.api.get<LogLinesResponse>(
        "GET /api/logs/{source}",
        { source: src },
        params.toString(),
      );
      this.logLines.set(res?.lines ?? []);
      this.logUnits.set(res?.units ?? []);
      if (res?.unit?.unit && !this.selectedLogUnit()) {
        this.selectedLogUnit.set(res.unit.unit);
      }
    } catch (err) {
      this.snackbar.show(errorText(err));
    }
  }

  protected pickTab(t: FleetTab): void {
    this.tab.set(t);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: t === "sandboxes" ? null : t },
      queryParamsHandling: "merge",
    });
    if (t === "logs" && this.selectedLogSource() && !this.logLines().length) {
      void this.loadLogLines();
    }
  }

  protected onTabKeydown(ev: KeyboardEvent, current: FleetTab): void {
    const idx = this.tabs.findIndex((t) => t.id === current);
    if (idx < 0) return;
    let nextIdx = -1;
    if (ev.key === "ArrowRight") nextIdx = (idx + 1) % this.tabs.length;
    else if (ev.key === "ArrowLeft") {
      nextIdx = (idx - 1 + this.tabs.length) % this.tabs.length;
    } else if (ev.key === "Home") nextIdx = 0;
    else if (ev.key === "End") nextIdx = this.tabs.length - 1;
    if (nextIdx < 0) return;
    ev.preventDefault();
    const nextTab = this.tabs[nextIdx].id;
    this.pickTab(nextTab);
    this.doc.getElementById(`fleet-tab-btn-${nextTab}`)?.focus();
  }

  protected toggleHostTop(): void {
    const next = !this.topOpen();
    this.topOpen.set(next);
    if (next) void this.loadHostTop();
  }

  async loadHostTop(): Promise<void> {
    if (!this.canReadSandboxes()) return;
    try {
      const res = await this.api.get<HostTopResponse>(
        "GET /api/host/top",
        undefined,
        "lines=100",
      );
      this.hostTop.set(res);
    } catch (err) {
      this.snackbar.show(errorText(err));
    }
  }

  protected recreateTaskSandbox(taskId: string): Promise<void> {
    if (!this.canRecreateTaskSandbox()) return Promise.resolve();
    this.confirmReq.set({
      title: `Recreate sandbox for task #${taskId}?`,
      message:
        "Destroys the task's current sandbox and builds a fresh one in its place. Any uncommitted work inside it is lost.",
      accept: "Recreate sandbox",
      destructive: true,
      run: async () => {
        if (!this.canRecreateTaskSandbox()) return;
        await this.api.post("POST /api/tasks/{id}/sandbox/recreate", {
          id: taskId,
        });
        this.snackbar.show(`Recreated sandbox for task #${taskId}.`);
        await this.loadSandboxes();
      },
    });
    return Promise.resolve();
  }

  protected async runSandboxProbe(): Promise<void> {
    if (!this.canProbeSandboxes() || this.probing()) return;
    const argv = parseArgv(this.probeCmd());
    if (argv.length === 0) return;
    this.probing.set(true);
    try {
      const res = await this.api.post<SandboxProbeResult>(
        "POST /api/sandbox-probe",
        undefined,
        { id: `ui-${Date.now()}`, argv },
      );
      this.probeResult.set(res);
    } catch (err) {
      this.snackbar.show(errorText(err));
    } finally {
      this.probing.set(false);
    }
  }

  protected async controlPersistent(
    ps: PersistentSandboxStatus,
    action: PersistentAction,
  ): Promise<void> {
    if (this.isPersistentActionDisabled(ps, action)) return;
    const runControl = async (
      target: PersistentSandboxStatus,
    ): Promise<void> => {
      if (this.isPersistentActionDisabled(target, action)) return;
      const key = `${target.name}:${action}`;
      this.busyPersistent.set(key);
      try {
        await this.api.post(
          "POST /api/persistent-sandboxes/{name}/{action}",
          { name: target.name, action },
          {},
        );
        this.snackbar.show(
          `Persistent sandbox ${target.name}: ${action} requested.`,
        );
        await this.loadPersistentSandboxes();
      } catch (err) {
        this.snackbar.show(errorText(err));
      } finally {
        this.busyPersistent.set(null);
      }
    };
    if (action === "start") {
      await runControl(ps);
      return;
    }
    const copy = PERSISTENT_CONFIRM[action];
    this.confirmReq.set({
      title: copy.title(ps.name),
      message: copy.message,
      accept: copy.accept,
      destructive: true,
      run: async () => {
        const latest =
          this.persistentSandboxes().find((item) => item.name === ps.name) ??
          ps;
        await runControl(latest);
      },
    });
  }

  protected async togglePersistentLogs(
    ps: PersistentSandboxStatus,
  ): Promise<void> {
    if (!this.canReadPersistentLogs(ps)) {
      if (this.openPersistentLogName() === ps.name) {
        this.openPersistentLogName.set(null);
        this.persistentLogsText.set("");
      }
      return;
    }
    if (this.openPersistentLogName() === ps.name) {
      this.openPersistentLogName.set(null);
      return;
    }
    this.openPersistentLogName.set(ps.name);
    this.persistentLogsText.set("Loading…");
    try {
      const txt = await this.api.getText(
        "GET /api/persistent-sandboxes/{name}/logs",
        { name: ps.name },
        "format=text",
      );
      if (this.openPersistentLogName() !== ps.name) return;
      if (!this.canReadPersistentLogs(ps)) {
        this.openPersistentLogName.set(null);
        this.persistentLogsText.set("");
        return;
      }
      this.persistentLogsText.set(txt ?? "");
    } catch (err) {
      if (this.openPersistentLogName() === ps.name) {
        this.persistentLogsText.set(errorText(err));
      }
    }
  }

  protected rotateHostd(name: string): Promise<void> {
    if (!this.canAdminHostds()) return Promise.resolve();
    this.confirmReq.set({
      title: `Rotate host ${name}'s token?`,
      message:
        "Its current token stops working at once, so the host is disconnected until the new token is installed on it.",
      accept: "Rotate token",
      destructive: true,
      run: async () => {
        if (!this.canAdminHostds()) return;
        const issued = await this.api.post<IssuedHostdToken>(
          "POST /api/hostds/{name}/rotate",
          { name },
          {},
        );
        this.issuedToken.set(issued);
        this.snackbar.show(`Rotated token for host ${name}.`);
        await this.loadHostds();
      },
    });
    return Promise.resolve();
  }

  protected startRenameHostd(name: string): void {
    this.renamingHostd.set(name);
    this.renameDraft.set(name);
  }

  protected async submitRenameHostd(oldName: string): Promise<void> {
    const next = this.renameDraft().trim();
    if (!next || next === oldName || !this.canAdminHostds()) return;
    try {
      await this.api.post(
        "POST /api/hostds/{name}/rename",
        { name: oldName },
        { name: next },
      );
      this.renamingHostd.set(null);
      this.snackbar.show(`Renamed host ${oldName} to ${next}.`);
      await this.loadHostds();
    } catch (err) {
      this.snackbar.show(errorText(err));
    }
  }

  protected confirmRevokeHostd(name: string): void {
    if (!this.canAdminHostds()) return;
    this.confirmReq.set({
      title: `Revoke host ${name}?`,
      message:
        "Revoking disconnects this host immediately and invalidates all of its tokens.",
      accept: "Revoke host",
      destructive: true,
      run: async () => {
        if (!this.canAdminHostds()) return;
        await this.api.post("POST /api/hostds/{name}/revoke", { name }, {});
        if (this.issuedToken()?.hostd?.name === name) {
          this.issuedToken.set(null);
        }
        this.snackbar.show(`Revoked host ${name}.`);
        await this.loadHostds();
      },
    });
  }

  protected confirmDeleteHostd(name: string): void {
    if (!this.canAdminHostds()) return;
    this.confirmReq.set({
      title: `Delete revoked host ${name}?`,
      message: `Removes ${name} from the hostd registry and clears any host-scoped quota pauses.`,
      accept: "Delete host",
      destructive: true,
      run: async () => {
        if (!this.canAdminHostds()) return;
        await this.api.delete("DELETE /api/hostds/{name}", { name });
        if (this.issuedToken()?.hostd?.name === name) {
          this.issuedToken.set(null);
        }
        this.snackbar.show(`Deleted host ${name}.`);
        await this.loadHostds();
      },
    });
  }

  protected confirmDeleteRevokedHostds(): void {
    if (!this.canAdminHostds()) return;
    this.confirmReq.set({
      title: "Delete all revoked hosts?",
      message:
        "Removes every revoked host not still referenced by model connections or capability servers.",
      accept: "Delete revoked",
      destructive: true,
      run: async () => {
        if (!this.canAdminHostds()) return;
        const res = await this.api.post<DeleteRevokedHostdsResult>(
          "POST /api/hostds/delete-revoked",
          undefined,
          {},
        );
        this.snackbar.show(
          `Deleted ${res?.deleted?.length ?? 0} revoked host(s).`,
        );
        await this.loadHostds();
      },
    });
  }

  protected async createEnrollmentCode(): Promise<void> {
    if (!this.canCreateEnrollmentCode() || this.creatingEnrollmentCode()) {
      return;
    }
    const name = this.newEnrollmentCodeName().trim();
    if (!name) return;
    this.creatingEnrollmentCode.set(true);
    try {
      const res = await this.api.post<HostEnrollmentCodeView>(
        "POST /api/hostds/enrollment-codes",
        undefined,
        { name },
      );
      this.newEnrollmentCodeName.set("");
      if (this.canReadEnrollmentCodes()) {
        const text = formatIssuedHostdSecret(`Enrollment code (${name})`, res);
        if (text) this.issuedEnrollmentCode.set({ name, text });
        await this.loadHostEnrollmentCodes();
      }
      this.snackbar.show(`Created enrollment code ${name}.`);
    } catch (err) {
      this.snackbar.show(errorText(err));
    } finally {
      this.creatingEnrollmentCode.set(false);
    }
  }

  protected confirmRotateEnrollmentCode(name: string): void {
    if (!this.canRotateEnrollmentCode()) return;
    this.confirmReq.set({
      title: `Rotate enrollment code ${name}?`,
      message:
        "Its invite command stops working at once, so hosts not yet joined with it need the new one. Hosts already joined keep their credentials.",
      accept: "Rotate code",
      destructive: true,
      run: async () => {
        if (!this.canRotateEnrollmentCode()) return;
        const res = await this.api.post<HostEnrollmentCodeView>(
          "POST /api/hostds/enrollment-codes/{name}/rotate",
          { name },
          {},
        );
        if (this.canReadEnrollmentCodes()) {
          const text = formatIssuedHostdSecret(
            `Rotated enrollment code (${name})`,
            res,
          );
          if (text) this.issuedEnrollmentCode.set({ name, text });
          await this.loadHostEnrollmentCodes();
        }
        this.snackbar.show(`Rotated enrollment code ${name}.`);
      },
    });
  }

  protected confirmRevokeEnrollmentCode(name: string): void {
    if (!this.canRevokeEnrollmentCode()) return;
    this.confirmReq.set({
      title: `Revoke enrollment code ${name}?`,
      message:
        "Its invite command stops working for good and the code cannot be restored. Hosts already joined keep their credentials.",
      accept: "Revoke code",
      destructive: true,
      run: async () => {
        if (!this.canRevokeEnrollmentCode()) return;
        await this.api.post(
          "POST /api/hostds/enrollment-codes/{name}/revoke",
          { name },
          {},
        );
        if (this.issuedEnrollmentCode()?.name === name) {
          this.issuedEnrollmentCode.set(null);
        }
        await this.loadHostEnrollmentCodes();
        this.snackbar.show(`Revoked enrollment code ${name}.`);
      },
    });
  }

  protected formatLabelsInput(labels?: Record<string, string> | null): string {
    return formatHostdLabels(labels);
  }

  protected pendingLabelsValue(p: PendingHostJoinView): string {
    return (
      this.pendingLabelDrafts()[p.id] ??
      this.formatLabelsInput(p.default_labels)
    );
  }

  protected setPendingLabelDraft(id: string, value: string): void {
    this.pendingLabelDrafts.update((prev) => ({ ...prev, [id]: value }));
  }

  protected async acceptPendingHostd(p: PendingHostJoinView): Promise<void> {
    if (!this.canAcceptPendingHostd() || this.busyPendingId() === p.id) return;
    const rawLabels = this.pendingLabelsValue(p);
    const parsed = parseHostdLabels(rawLabels);
    if (parsed.error) {
      this.snackbar.show(parsed.error);
      return;
    }
    const hostName = p.suggested_name || p.hostname || p.id;
    this.busyPendingId.set(p.id);
    try {
      await this.api.post(
        "POST /api/hostds/pending/{id}/accept",
        { id: p.id },
        {
          name: hostName,
          ...(Object.keys(parsed.labels).length > 0
            ? { labels: parsed.labels }
            : {}),
          ...(p.default_capacity && p.default_capacity > 0
            ? { capacity: p.default_capacity }
            : {}),
        },
      );
      this.snackbar.show(`Approved host ${hostName}.`);
      await this.loadHostds();
    } catch (err) {
      this.snackbar.show(errorText(err));
    } finally {
      this.busyPendingId.set(null);
    }
  }

  protected confirmRejectPendingHostd(p: PendingHostJoinView): void {
    if (!this.canRejectPendingHostd() || this.busyPendingId() === p.id) return;
    this.confirmReq.set({
      title: `Reject join request from ${p.hostname || p.id}?`,
      message:
        "It is discarded, and that host has to run its join command again to ask once more.",
      accept: "Reject request",
      destructive: true,
      run: async () => {
        if (!this.canRejectPendingHostd()) return;
        this.busyPendingId.set(p.id);
        try {
          await this.api.post(
            "POST /api/hostds/pending/{id}/reject",
            { id: p.id },
            {},
          );
          this.snackbar.show(`Rejected pending host ${p.hostname || p.id}.`);
          await this.loadPendingHostds();
        } finally {
          this.busyPendingId.set(null);
        }
      },
    });
  }

  protected pausePipeline(): Promise<void> {
    if (!this.canWriteDispatch() || this.busyDispatch()) {
      return Promise.resolve();
    }
    const reason = this.pauseReasonDraft().trim();
    this.confirmReq.set({
      title: "Pause the pipeline?",
      message: reason
        ? `Grain will stop starting new agent and CI runs (reason: "${reason}"). Runs already in flight will continue.`
        : "Grain will stop starting new agent and CI runs. Runs already in flight will continue.",
      accept: "Pause pipeline",
      destructive: true,
      run: async () => {
        if (!this.canWriteDispatch() || this.busyDispatch()) return;
        this.busyDispatch.set(true);
        try {
          const res = await this.api.post<PipelinePauseResponse>(
            "POST /api/pipeline-pause",
            undefined,
            { reason },
          );
          this.pipelinePause.set(res?.pause ?? { paused: true });
          this.pauseReasonDraft.set("");
          this.snackbar.show("Pipeline paused.");
        } finally {
          this.busyDispatch.set(false);
        }
      },
    });
    return Promise.resolve();
  }

  protected resumePipeline(): Promise<void> {
    if (!this.canWriteDispatch() || this.busyDispatch()) {
      return Promise.resolve();
    }
    const pause = this.pipelinePause();
    const upgradeHold =
      pause?.byKind === "automation" && pause?.byId === "upgrade-schedule";
    this.confirmReq.set({
      title: upgradeHold
        ? "Cancel scheduled upgrade and resume pipeline?"
        : "Resume the pipeline?",
      message: upgradeHold
        ? `This deployment is paused because it is waiting to upgrade${pause?.reason ? ` — ${pause.reason}` : ""}. Resuming cancels that upgrade: tasks start again and the upgrade will not be applied.`
        : "Grain will start dispatching queued agent and CI runs again.",
      accept: upgradeHold ? "Cancel upgrade & resume" : "Resume pipeline",
      destructive: upgradeHold,
      run: async () => {
        if (!this.canWriteDispatch() || this.busyDispatch()) return;
        this.busyDispatch.set(true);
        try {
          const res = await this.api.delete<PipelinePauseResponse>(
            "DELETE /api/pipeline-pause",
          );
          this.pipelinePause.set(res?.pause ?? { paused: false });
          this.snackbar.show("Pipeline resumed.");
        } finally {
          this.busyDispatch.set(false);
        }
      },
    });
    return Promise.resolve();
  }

  protected async liftAgentPause(entry?: AgentPauseEntry): Promise<void> {
    if (!this.canWriteDispatch()) return;
    const params = new URLSearchParams();
    if (entry?.connection) params.set("connection", entry.connection);
    if (entry?.model) params.set("model", entry.model);
    if (!entry?.connection && entry?.team) params.set("team", entry.team);
    if (!entry?.connection && entry?.framework) {
      params.set("framework", entry.framework);
    }
    try {
      const res = await this.api.delete<AgentPauseResponse>(
        "DELETE /api/pause",
        undefined,
        undefined,
        params.toString() || undefined,
      );
      this.agentPause.set(res?.pause ?? null);
      this.snackbar.show("Cleared usage-limit pause.");
    } catch (err) {
      this.snackbar.show(errorText(err));
    }
  }

  protected confirmFlushPackageCache(): void {
    if (!this.canWriteCaches() || !this.packageCache()?.enabled) return;
    this.confirmReq.set({
      title: "Flush package proxy cache?",
      message:
        "Deletes all cached packages across apt, npm, PyPI, Go, and Docker on this controller. Active runs remain safe and fetch from upstream on cache miss.",
      accept: "Flush cache",
      destructive: true,
      run: async () => {
        if (!this.canWriteCaches() || !this.packageCache()?.enabled) return;
        const res = await this.api.post<{
          entries: number;
          bytes: number;
          cache?: PackageCacheState["cache"];
        }>("POST /api/package-cache/flush", undefined, {});
        this.packageCache.set({ enabled: true, cache: res?.cache ?? [] });
        this.snackbar.show(
          `Flushed ${res?.entries ?? 0} cached package entries (${formatBytes(res?.bytes)}).`,
        );
      },
    });
  }

  protected confirmFlushActionsCache(): void {
    if (!this.canWriteCaches() || !this.actionsCache()?.enabled) return;
    this.confirmReq.set({
      title: "Flush GitHub Actions cache?",
      message:
        "Empties cached CI build archives across all repositories on this controller.",
      accept: "Flush cache",
      destructive: true,
      run: async () => {
        if (!this.canWriteCaches() || !this.actionsCache()?.enabled) return;
        const res = await this.api.post<{
          entries: number;
          bytes: number;
          cache: ActionsCacheState;
        }>("POST /api/actions-cache/flush", undefined, {});
        if (res?.cache) this.actionsCache.set(res.cache);
        this.snackbar.show(
          `Flushed ${res?.entries ?? 0} Actions cache archives (${formatBytes(res?.bytes)}).`,
        );
      },
    });
  }

  protected confirmRestartDaemon(): void {
    if (!this.canRestartDaemon()) return;
    this.confirmReq.set({
      title: "Restart grain daemon?",
      message:
        "Interrupts in-flight agent runs driven by this process and briefly disconnects the UI while the service restarts.",
      accept: "Restart daemon",
      destructive: true,
      run: async () => {
        if (!this.canRestartDaemon()) return;
        this.watchRestarting.set(true);
        try {
          await this.api.post("POST /api/host/restart", undefined, {});
        } catch (err) {
          // A dropped connection (status 0) is expected while the daemon
          // restarts; an answer is the daemon refusing, and nothing is
          // restarting.
          if ((err as { status?: number })?.status !== 0) {
            this.watchRestarting.set(false);
            this.snackbar.show(`Restart failed: ${errorText(err)}`);
            return;
          }
        }
        this.snackbar.show(
          "Restart requested. Waiting for grain to come back…",
        );
        try {
          const watch = await this.api.get<{ restarting: boolean }>(
            "GET /api/restart-watch",
            undefined,
            "quick=1",
          );
          this.watchRestarting.set(!!watch?.restarting);
        } catch {
          // Will clear on next refresh once reachable.
        }
      },
    });
  }

  protected async onConfirmDone(accepted: boolean): Promise<void> {
    const req = this.confirmReq();
    this.confirmReq.set(null);
    if (!accepted || !req) return;
    try {
      await req.run();
    } catch (err) {
      this.snackbar.show(errorText(err));
    }
  }

  protected pickLogSource(src: string): void {
    if (this.selectedLogSource() === src) return;
    this.selectedLogSource.set(src);
    this.selectedLogUnit.set("");
    this.logUnits.set([]);
    void this.loadLogLines();
  }

  protected pickLogUnit(unit: string): void {
    if (this.selectedLogUnit() === unit) return;
    this.selectedLogUnit.set(unit);
    void this.loadLogLines();
  }

  protected pickLogLimit(limit: number): void {
    if (this.logLineLimit() === limit) return;
    this.logLineLimit.set(limit);
    void this.loadLogLines();
  }

  protected copyText(text: string, notice: string): void {
    void this.doc.defaultView?.navigator?.clipboard
      ?.writeText(text)
      .then(() => this.snackbar.show(notice))
      .catch(() => this.snackbar.show(notice));
  }

  protected onDocClick(): void {
    // Reserved for future popovers on Fleet.
  }
}
