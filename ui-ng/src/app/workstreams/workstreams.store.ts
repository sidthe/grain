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
  Injectable,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { GrainApi, loadTaskSummaryBatches } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type {
  Task,
  TaskDetail,
  TaskListPage,
  TaskSummariesResponse,
  TreeNode,
  WorkTree,
} from "../api/models";
import { InboxStore } from "../inbox/inbox.store";
import { AccessService } from "../services/access.service";
import { TaskFeedStore } from "../services/task-feed.service";
import type {
  ConfirmItem,
  ConfirmRequest,
} from "../shared/confirm-dialog.component";
import { type Scope, scopeOf } from "../shared/scope";
import {
  type ApprovalPlan,
  type ApprovalTarget,
  DONE_RETENTION_DAYS,
  type Workstream,
  type WorkstreamNode,
  classifyTaskState,
  collectTaskUpstreamApprovals,
  collectWorkstreamApprovals,
  deriveWorkstreams,
  orderApprovalTargets,
} from "./workstream-model";

export const STARTED_STORAGE_KEY = "grain.ws.started";
export const ACTIVE_POLL_MS = 3000;
export const IDLE_POLL_MS = 15000;
export const CLOSED_PAGE_LIMIT = 100;
export const MAX_CLOSED_PAGES = 4;
const MAX_STARTED_IDS = 64;

function loadStarted(): Set<string> {
  try {
    const raw = localStorage.getItem(STARTED_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveStarted(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(
      STARTED_STORAGE_KEY,
      JSON.stringify([...ids].slice(-MAX_STARTED_IDS)),
    );
  } catch {
    // Storage disabled: keep started IDs in memory only.
  }
}

function errorText(err: unknown): string {
  const e = err as { error?: unknown; message?: string };
  if (e && typeof e.error === "string" && e.error) return e.error;
  if (e && e.error && typeof e.error === "object") {
    const nested = e.error as { error?: string; message?: string };
    if (nested.error) return nested.error;
    if (nested.message) return nested.message;
  }
  return e?.message || "The request failed.";
}

export interface StreamBatchPreview {
  nodes: WorkstreamNode[];
  scope: Scope;
}

export interface StreamApprovePreview extends StreamBatchPreview {
  tasks: Task[];
  targets: ApprovalTarget[];
  waves: ApprovalTarget[][];
  directCount: number;
  upstreamCount: number;
}

export interface BatchResult {
  succeeded: number;
  failed: number;
}

export interface ApproveBatchResult extends BatchResult {
  approvedIds: string[];
  approvedTasks: Task[];
}

export const EMPTY_APPROVE_PREVIEW: StreamApprovePreview = {
  nodes: [],
  tasks: [],
  targets: [],
  waves: [],
  directCount: 0,
  upstreamCount: 0,
  scope: {
    total: 0,
    repos: [],
    owners: [],
    multiRepo: false,
    otherOwner: false,
  },
};

const MAX_CONFIRM_ITEMS = 12;

@Injectable({ providedIn: "root" })
export class WorkstreamsStore implements OnDestroy {
  private readonly api = inject(GrainApi);
  private readonly events = inject(GrainEvents);
  private readonly access = inject(AccessService);
  private readonly inbox = inject(InboxStore);
  private readonly feed = inject(TaskFeedStore);
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);

  readonly openTasks = this.feed.tasks;
  readonly closedTasks = signal<Task[]>([]);
  readonly extraTasks = signal<Record<string, TaskDetail>>({});
  readonly loaded = signal(false);
  readonly closedLoading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  readonly startedIds = signal<ReadonlySet<string>>(loadStarted());
  readonly selectedKey = signal<string | null>(null);

  readonly allTasks = computed<Task[]>(() => {
    const open =
      this.openTasks().length > 0 ? this.openTasks() : this.inbox.tasks();
    const closed = this.closedTasks();
    const extra = this.extraTasks();

    const byId = new Map<string, Task>();
    for (const t of open) {
      if (!t?.id) continue;
      const d = extra[t.id];
      byId.set(
        t.id,
        d ? { ...d, ...t, description: t.description || d.description } : t,
      );
    }
    for (const t of closed) {
      if (!t?.id || byId.has(t.id)) continue;
      const d = extra[t.id];
      byId.set(
        t.id,
        d ? { ...d, ...t, description: t.description || d.description } : t,
      );
    }
    for (const [id, d] of Object.entries(extra)) {
      if (id && !byId.has(id)) byId.set(id, d);
    }
    return [...byId.values()];
  });

  readonly derivation = computed(() =>
    deriveWorkstreams(this.allTasks(), {
      startedIds: this.startedIds(),
      selectedKey: this.selectedKey(),
      viewer: this.access.viewer(),
    }),
  );

  readonly streams = computed(() => this.derivation().streams);
  readonly byKey = computed(() => this.derivation().byKey);
  readonly taskToStream = computed(() => this.derivation().taskToStream);

  readonly allTasksById = computed<ReadonlyMap<string, Task>>(() => {
    const map = new Map<string, Task>();
    for (const t of this.allTasks()) {
      if (t?.id && !map.has(t.id)) map.set(t.id, t);
    }
    return map;
  });

  readonly allNodesById = computed<ReadonlyMap<string, WorkstreamNode>>(() => {
    const map = new Map<string, WorkstreamNode>();
    for (const s of this.streams()) {
      for (const n of s.nodes) {
        if (!n.virtual && !map.has(n.id)) map.set(n.id, n);
      }
    }
    return map;
  });

  readonly hasLiveStreams = computed(() =>
    this.streams().some(
      (s) =>
        s.state === "active" ||
        s.state === "planning" ||
        s.runningNodes.length > 0,
    ),
  );

  private active = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private eventSub: { unsubscribe(): void } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private queuedRefresh: Promise<void> | null = null;
  private configInFlight: Promise<void> | null = null;
  private forceClosedPending = false;
  private pollCount = 0;
  private closedFetchedOnce = false;
  private lastSeenRevision = -1;
  private readonly detailInFlight = new Set<string>();
  private readonly onVisibility = (): void => {
    if (!this.active) return;
    if (this.doc.hidden) {
      this.clearPoll();
    } else {
      void this.refresh(true);
      this.scheduleNextPoll();
    }
  };

  constructor() {
    effect(() => {
      const rev = this.feed.revision();
      untracked(() => {
        if (
          this.active &&
          rev > 0 &&
          rev !== this.lastSeenRevision &&
          !this.refreshing
        ) {
          this.lastSeenRevision = rev;
          void this.loadClosedPages();
        }
      });
    });
  }

  ensureLoaded(forceClosed = false): void {
    if (
      !this.refreshing &&
      (!this.loaded() || (forceClosed && !this.closedFetchedOnce))
    ) {
      void this.refresh(forceClosed, true);
    }
  }

  start(): void {
    if (!this.active) {
      this.active = true;
      this.feed.start(false);
      this.feed.acquireFast();
    }
    void this.refresh(!this.closedFetchedOnce);
    if (!this.eventSub) {
      this.eventSub = this.events.events().subscribe((ev) => {
        if (ev.type && !ev.type.startsWith("task.")) {
          this.scheduleEventRefresh();
        }
      });
    }
    this.doc.addEventListener("visibilitychange", this.onVisibility);
    this.scheduleNextPoll();
  }

  stop(): void {
    if (this.active) {
      this.active = false;
      this.feed.releaseFast();
      this.feed.stop(false);
    }
    this.eventSub?.unsubscribe();
    this.eventSub = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.clearPoll();
    this.doc.removeEventListener("visibilitychange", this.onVisibility);
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(): void {
    this.clearPoll();
    if (!this.active || this.doc.hidden) return;
    this.zone.runOutsideAngular(() => {
      this.pollTimer = setTimeout(() => {
        this.zone.run(() => {
          void this.loadClosedPages().finally(() => this.scheduleNextPoll());
        });
      }, IDLE_POLL_MS);
    });
  }

  private scheduleEventRefresh(): void {
    if (this.debounceTimer || this.doc.hidden) return;
    const contextOnly = !this.active;
    this.zone.runOutsideAngular(() => {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.zone.run(() => void this.refresh(!contextOnly, contextOnly));
      }, 250);
    });
  }

  refresh(forceClosed = false, contextOnly = false): Promise<void> {
    if (forceClosed) this.forceClosedPending = true;
    if (!this.refreshing) {
      const fetchClosed =
        this.forceClosedPending || (!contextOnly && !this.closedFetchedOnce);
      this.forceClosedPending = false;
      this.refreshing = this.load(fetchClosed, contextOnly).finally(() => {
        this.refreshing = null;
      });
      return this.refreshing;
    }
    return (this.queuedRefresh ??= this.refreshing
      .catch(() => undefined)
      .then(() => {
        this.queuedRefresh = null;
        return this.refresh(forceClosed, contextOnly);
      }));
  }

  private hasMissingAncestor(open: readonly Task[]): boolean {
    const ids = new Set(open.map((t) => t.id));
    return open.some((t) => {
      if (t.generatedFrom && !ids.has(t.generatedFrom)) return true;
      if (t.origin?.startsWith("task:") && !ids.has(t.origin.slice(5))) {
        return true;
      }
      return false;
    });
  }

  private async load(fetchClosed: boolean, contextOnly = false): Promise<void> {
    const ok = await this.feed.refresh();
    const rev = this.feed.revision();
    const openChanged = rev !== this.lastSeenRevision;
    const currentOpen = this.openTasks();
    if (ok) {
      this.loadError.set(null);
    } else if (!this.loaded()) {
      this.loadError.set(
        `Could not read workstreams: ${this.feed.loadError() ?? errorText(this.feed.lastError())}`,
      );
    }

    this.pollCount++;
    const needClosed =
      fetchClosed ||
      (contextOnly
        ? !this.closedFetchedOnce && this.hasMissingAncestor(currentOpen)
        : openChanged || !this.closedFetchedOnce || this.pollCount % 5 === 0);
    if (needClosed) {
      this.closedLoading.set(true);
      this.lastSeenRevision = rev;
    }
    this.loaded.set(true);
    if (needClosed) {
      await this.loadClosedPages();
    }
  }

  private async loadClosedPages(): Promise<void> {
    const collected: Task[] = [];
    let cursor = "";
    const cutoffMs = Date.now() - DONE_RETENTION_DAYS * 86_400_000;

    const closedSince = encodeURIComponent(new Date(cutoffMs).toISOString());

    this.closedLoading.set(true);
    try {
      for (let page = 0; page < MAX_CLOSED_PAGES; page++) {
        const q = `state=closed&closedSince=${closedSince}&limit=${CLOSED_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
        const res = await this.api.get<Task[] | TaskListPage>(
          "GET /api/tasks",
          undefined,
          q,
        );
        const batch = Array.isArray(res) ? res : (res?.tasks ?? []);
        if (batch.length === 0) break;
        collected.push(...batch);
        this.closedFetchedOnce = true;

        const next = Array.isArray(res) ? "" : (res?.nextCursor ?? "");
        if (!next) break;
        // Stop paging once we have >1 page and reached tasks closed well
        // beyond the 14-day Done window.
        if (page >= 1) {
          const newestInBatch = Math.max(
            ...batch.map(
              (t) =>
                Date.parse(t.closedAt || t.prMergedAt || t.updatedAt || "") ||
                0,
            ),
          );
          if (newestInBatch > 0 && newestInBatch < cutoffMs) break;
        }
        cursor = next;
      }
      if (collected.length > 0 || !this.closedFetchedOnce) {
        this.closedTasks.set(collected);
        this.closedFetchedOnce = true;
      }
    } catch {
      // Closed history failure is non-fatal when open tasks succeeded.
    } finally {
      this.closedLoading.set(false);
    }
  }

  private pendingRootDetails = new Set<string>();
  private rootFlushPromise: Promise<void> | null = null;

  private ensureConfig(): Promise<void> {
    if (this.access.configLoaded() || typeof this.api.config !== "function") {
      return Promise.resolve();
    }
    return (this.configInFlight ??= Promise.resolve()
      .then(() => this.api.config())
      .then((cfg) => {
        if (cfg && !this.access.configLoaded()) {
          this.access.setConfig(cfg);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.configInFlight = null;
      }));
  }

  ensureRootDetail(rootId: string): Promise<void> {
    if (!rootId || rootId.includes("/") || rootId.includes("#")) {
      return Promise.resolve();
    }
    this.pendingRootDetails.add(rootId);
    if (!this.rootFlushPromise) {
      this.rootFlushPromise = Promise.resolve().then(() => {
        const batch = [...this.pendingRootDetails];
        this.pendingRootDetails.clear();
        this.rootFlushPromise = null;
        return this.ensureRootDetails(batch);
      });
    }
    return this.rootFlushPromise;
  }

  async ensureRootDetails(rootIds: readonly string[]): Promise<void> {
    const candidates = rootIds.filter(
      (id) =>
        Boolean(id) &&
        !id.includes("/") &&
        !id.includes("#") &&
        !this.extraTasks()[id] &&
        !this.detailInFlight.has(id),
    );
    if (candidates.length === 0) return;
    await this.ensureConfig();
    const cached = this.extraTasks();
    const open = this.openTasks();
    const closed = this.closedTasks();
    const seen = new Set<string>();
    const todo: string[] = [];
    for (const rootId of candidates) {
      if (
        seen.has(rootId) ||
        cached[rootId] ||
        this.detailInFlight.has(rootId)
      ) {
        continue;
      }
      seen.add(rootId);
      const known =
        open.find((t) => t.id === rootId) ??
        closed.find((t) => t.id === rootId);
      const allowed = known
        ? this.access.canAccessTask("GET /api/tasks/{id}", known.repo ?? null)
        : this.access.can("GET /api/tasks/{id}");
      if (!allowed) continue;
      todo.push(rootId);
    }
    if (todo.length === 0) return;
    for (const id of todo) this.detailInFlight.add(id);
    try {
      const { tasks } = await loadTaskSummaryBatches(todo, 1, 1, (query) =>
        this.api
          .get<TaskSummariesResponse>(
            "GET /api/tasks/summaries",
            undefined,
            query,
          )
          .then((r) => r?.tasks),
      );
      if (Object.keys(tasks).length > 0) {
        this.extraTasks.update((m) => ({ ...m, ...tasks }));
      }
    } catch {
      // Fall back to list metadata cleanly if batch task summary fails.
    } finally {
      for (const id of todo) this.detailInFlight.delete(id);
    }
  }

  recordStartedWorkstream(taskId: string): void {
    const clean = String(taskId || "").trim();
    if (!clean) return;
    this.startedIds.update((prev) => {
      const next = new Set(prev);
      next.add(clean);
      saveStarted(next);
      return next;
    });
  }

  private canApproveTask(t: Task): boolean {
    return this.access.canAccessTask(
      "POST /api/tasks/{id}/approve",
      t.repo ?? null,
    );
  }

  private toApprovePreview(
    plan: ApprovalPlan,
    tasksById: ReadonlyMap<string, Task>,
  ): StreamApprovePreview {
    const knownNodes = this.allNodesById();
    const nodes: WorkstreamNode[] = plan.targets.map((entry) => {
      const existing = knownNodes.get(entry.id);
      if (existing) return existing;
      const cls = classifyTaskState(entry.task, tasksById);
      return {
        task: entry.task,
        id: entry.task.id,
        parentId: entry.task.generatedFrom ?? null,
        deps: [...(entry.task.dependsOn ?? [])],
        crossStreamDeps: [],
        foldedReviews: [],
        foldedTaskIds: [entry.task.id],
        category: cls.category,
        glyph: cls.glyph,
        waitingOnPerson: cls.waitingOnPerson,
        prNumber: null,
        title: entry.task.title || `Task #${entry.task.id}`,
        stateText:
          entry.task.state === "proposed" ? "Proposed" : entry.task.state,
        activityText: entry.task.activity || "",
        createdMs: entry.task.createdAt
          ? Date.parse(entry.task.createdAt) || 0
          : 0,
        updatedMs: entry.task.updatedAt
          ? Date.parse(entry.task.updatedAt) || 0
          : 0,
        closedMs: null,
      };
    });
    const tasks = plan.targets.map((entry) => entry.task);
    return {
      nodes,
      tasks,
      targets: plan.targets,
      waves: plan.waves,
      directCount: plan.directCount,
      upstreamCount: plan.upstreamCount,
      scope: scopeOf(tasks, this.access.viewer()),
    };
  }

  private mergedTasksById(
    extraTasks?: Iterable<Task>,
    preferExtra = false,
  ): ReadonlyMap<string, Task> {
    const base = this.allTasksById();
    if (!extraTasks) return base;
    let merged: Map<string, Task> | null = null;
    for (const t of extraTasks) {
      if (!t?.id || (!preferExtra && base.has(t.id))) continue;
      merged ??= new Map<string, Task>(base);
      merged.set(t.id, t);
    }
    return merged ?? base;
  }

  approvePreview(
    stream: Workstream,
    opts: {
      extraTasks?: Iterable<Task>;
      taskToStream?: ReadonlyMap<string, Workstream>;
    } = {},
  ): StreamApprovePreview {
    const tasksById = this.mergedTasksById(opts.extraTasks, false);
    const plan = collectWorkstreamApprovals(stream, tasksById, {
      canApprove: (t) => this.canApproveTask(t),
      taskToStream: opts.taskToStream ?? this.taskToStream(),
    });
    return this.toApprovePreview(plan, tasksById);
  }

  approveUpstreamPreview(
    taskId: string,
    opts: {
      includeSelf?: boolean;
      extraTasks?: Iterable<Task>;
      taskToStream?: ReadonlyMap<string, Workstream>;
    } = {},
  ): StreamApprovePreview {
    const tasksById = this.mergedTasksById(opts.extraTasks, true);
    const plan = collectTaskUpstreamApprovals(taskId, tasksById, {
      canApprove: (t) => this.canApproveTask(t),
      includeSelf: opts.includeSelf,
      taskToStream: opts.taskToStream ?? this.taskToStream(),
    });
    return this.toApprovePreview(plan, tasksById);
  }

  approveTreePreview(
    tree: WorkTree | null | undefined,
    fallbackRepo?: string,
  ): StreamApprovePreview {
    if (!tree?.nodes?.length) {
      return EMPTY_APPROVE_PREVIEW;
    }
    const base = this.allTasksById();
    const lookup = new Map<string, Task>(base);
    const taskToStream = this.taskToStream();
    const selected = new Map<string, ApprovalTarget>();
    const walked = new Set<string>();
    const depQueue: string[] = [];
    const inTreeIds = new Set<string>();

    const walk = (nodes: readonly TreeNode[]) => {
      for (const n of nodes) {
        inTreeIds.add(n.id);
        const known = lookup.get(n.id);
        const isTreeProposed =
          n.status === "planned" || n.status === "proposed";
        const task: Task = known ?? {
          id: n.id,
          title: n.title,
          state: isTreeProposed ? "proposed" : n.status,
          repo: fallbackRepo,
        };
        if (!known) lookup.set(n.id, task);
        const isProposed = task.state === "proposed" || isTreeProposed;
        if (isProposed && !task.consoleSession && this.canApproveTask(task)) {
          const ws = taskToStream.get(task.id);
          selected.set(task.id, {
            id: task.id,
            task,
            upstream: false,
            streamKey: ws?.key ?? null,
            streamTitle: ws?.title ?? null,
          });
        }
        if (!n.done || isProposed) {
          walked.add(task.id);
          for (const depId of task.dependsOn ?? []) {
            if (depId && !walked.has(depId)) depQueue.push(depId);
          }
        }
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree.nodes);

    while (depQueue.length > 0) {
      const depId = depQueue.shift()!;
      if (!depId || walked.has(depId)) continue;
      walked.add(depId);
      const dep = lookup.get(depId);
      if (
        !dep ||
        dep.consoleSession ||
        dep.state === "closed" ||
        (dep.state === "completed" && !dep.pullRequest) ||
        dep.merged ||
        dep.prMergedAt
      ) {
        continue;
      }
      if (
        dep.state === "proposed" &&
        !inTreeIds.has(dep.id) &&
        this.canApproveTask(dep)
      ) {
        const ws = taskToStream.get(dep.id);
        selected.set(dep.id, {
          id: dep.id,
          task: dep,
          upstream: true,
          streamKey: ws?.key ?? null,
          streamTitle: ws?.title ?? null,
        });
      }
      for (const next of dep.dependsOn ?? []) {
        if (next && !walked.has(next)) depQueue.push(next);
      }
    }

    const { targets, waves } = orderApprovalTargets(selected, lookup);
    let directCount = 0;
    let upstreamCount = 0;
    for (const x of targets) {
      if (x.upstream) upstreamCount++;
      else directCount++;
    }
    return this.toApprovePreview(
      { targets, waves, directCount, upstreamCount },
      lookup,
    );
  }

  buildApproveConfirm(opts: {
    subjectTitle: string;
    preview: StreamApprovePreview;
    forTaskId?: string;
    run: (snapshot: StreamApprovePreview) => Promise<unknown>;
  }): ConfirmRequest | null {
    const { preview, subjectTitle, forTaskId } = opts;
    const total = preview.targets.length;
    if (total === 0) return null;

    const snapshot: StreamApprovePreview = {
      ...preview,
      nodes: [...preview.nodes],
      tasks: [...preview.tasks],
      targets: [...preview.targets],
      waves: preview.waves.map((w) => [...w]),
    };

    const { directCount, upstreamCount } = snapshot;
    let title: string;
    let message: string;
    if (forTaskId) {
      if (directCount > 0 && upstreamCount > 0) {
        title = `Approve #${forTaskId} and ${upstreamCount} upstream ${upstreamCount === 1 ? "task" : "tasks"}?`;
        message = `Queue ${upstreamCount} upstream ${upstreamCount === 1 ? "dependency" : "dependencies"} and #${forTaskId} (${subjectTitle}) in dependency order.`;
      } else {
        title = `Approve ${upstreamCount} upstream ${upstreamCount === 1 ? "task" : "tasks"}?`;
        message = `Queue ${upstreamCount} upstream ${upstreamCount === 1 ? "dependency" : "dependencies"} blocking #${forTaskId} (${subjectTitle}) in dependency order.`;
      }
    } else if (directCount === 0 && upstreamCount > 0) {
      title = `Approve ${upstreamCount} upstream ${upstreamCount === 1 ? "task" : "tasks"}?`;
      message = `Queue ${upstreamCount} upstream ${upstreamCount === 1 ? "dependency" : "dependencies"} blocking "${subjectTitle}" in dependency order.`;
    } else if (upstreamCount > 0) {
      title = `Approve all ${total} tasks?`;
      message = `Queue ${directCount} proposed ${directCount === 1 ? "task" : "tasks"} in "${subjectTitle}" and ${upstreamCount} upstream ${upstreamCount === 1 ? "dependency" : "dependencies"} in dependency order.`;
    } else {
      title = `Approve ${total} ${total === 1 ? "proposal" : "proposals"}?`;
      message = `Queue all proposed tasks in "${subjectTitle}" to run in dependency order.`;
    }

    const items: ConfirmItem[] = snapshot.targets
      .slice(0, MAX_CONFIRM_ITEMS)
      .map((entry) => ({
        key: entry.id,
        label: `#${entry.id} ${entry.task.title || `Task #${entry.id}`}`,
        route: ["/task", entry.id],
        detail: entry.upstream
          ? entry.streamTitle
            ? `Upstream · ${entry.streamTitle}`
            : "Upstream dependency"
          : undefined,
      }));
    if (snapshot.targets.length > MAX_CONFIRM_ITEMS) {
      const more = snapshot.targets.length - MAX_CONFIRM_ITEMS;
      items.push({
        key: "__more__",
        label: `+${more} more ${more === 1 ? "task" : "tasks"}`,
      });
    }

    return {
      title,
      message,
      accept: `Approve (${total})`,
      destructive: false,
      scope: snapshot.scope,
      items,
      itemsLabel: "Tasks to approve (upstream first)",
      run: () => opts.run(snapshot),
    };
  }

  pausePreview(stream: Workstream): StreamBatchPreview {
    const pool = stream.planning
      ? [stream.root]
      : stream.nodes.filter((n) => !n.virtual && n.id !== stream.root.id);
    // Go Client.Defer strictly accepts proposed or queued (not running/failed/completed).
    const nodes = pool.filter(
      (n) =>
        (n.task.state === "proposed" || n.task.state === "queued") &&
        this.access.canAccessTask(
          "POST /api/tasks/{id}/defer",
          n.task.repo ?? null,
        ),
    );
    return {
      nodes,
      scope: scopeOf(
        nodes.map((n) => n.task),
        this.access.viewer(),
      ),
    };
  }

  resumePreview(stream: Workstream): StreamBatchPreview {
    const pool = stream.planning
      ? [stream.root]
      : stream.nodes.filter((n) => !n.virtual && n.id !== stream.root.id);
    const nodes = pool.filter(
      (n) =>
        n.glyph === "deferred" &&
        this.access.canAccessTask(
          "POST /api/tasks/{id}/undefer",
          n.task.repo ?? null,
        ),
    );
    return {
      nodes,
      scope: scopeOf(
        nodes.map((n) => n.task),
        this.access.viewer(),
      ),
    };
  }

  async approveProposals(
    stream: Workstream,
    snapshot?: StreamApprovePreview,
  ): Promise<BatchResult> {
    const preview = snapshot ?? this.approvePreview(stream);
    const { succeeded, failed } = await this.approveWaves(preview.waves);
    return { succeeded, failed };
  }

  async approveTaskWithUpstream(
    taskId: string,
    snapshot?: StreamApprovePreview,
  ): Promise<ApproveBatchResult> {
    const preview = snapshot ?? this.approveUpstreamPreview(taskId);
    return this.approveWaves(preview.waves);
  }

  async approveWaves(
    waves: readonly (readonly ApprovalTarget[])[],
  ): Promise<ApproveBatchResult> {
    const flat = waves.flat();
    if (flat.length === 0) {
      return { succeeded: 0, failed: 0, approvedIds: [], approvedTasks: [] };
    }
    this.busy.set("approve");
    this.actionError.set(null);
    const approvedIds: string[] = [];
    const approvedTasks: Task[] = [];
    let failed = 0;
    try {
      for (const wave of waves) {
        if (wave.length === 0) continue;
        const results = await Promise.allSettled(
          wave.map((entry) =>
            Promise.resolve().then(() =>
              this.api.post("POST /api/tasks/{id}/approve", { id: entry.id }),
            ),
          ),
        );
        results.forEach((r, idx) => {
          if (r.status === "fulfilled") {
            approvedIds.push(wave[idx].id);
            approvedTasks.push(wave[idx].task);
          } else {
            failed++;
          }
        });
      }
      if (failed > 0) {
        this.actionError.set(
          `${failed} of ${flat.length} task updates failed.`,
        );
      }
      await this.refresh(true);
      return {
        succeeded: approvedIds.length,
        failed,
        approvedIds,
        approvedTasks,
      };
    } finally {
      this.busy.set(null);
    }
  }

  canWithdrawApprovals(tasks: readonly Task[]): boolean {
    return (
      tasks.length > 0 &&
      tasks.every((t) =>
        this.access.canAccessTask(
          "POST /api/tasks/{id}/withdraw-approval",
          t.repo ?? null,
        ),
      )
    );
  }

  async withdrawApprovals(ids: readonly string[]): Promise<BatchResult> {
    if (ids.length === 0) return { succeeded: 0, failed: 0 };
    this.busy.set("withdraw");
    this.actionError.set(null);
    let succeeded = 0;
    let failed = 0;
    try {
      // Withdraw downstream tasks first, then upstream dependencies.
      const reversed = [...ids].reverse();
      for (const id of reversed) {
        try {
          await this.api.post("POST /api/tasks/{id}/withdraw-approval", { id });
          succeeded++;
        } catch {
          failed++;
        }
      }
      if (failed > 0) {
        this.actionError.set(
          `${failed} of ${reversed.length} approval withdrawals failed.`,
        );
      }
      await this.refresh(true);
      return { succeeded, failed };
    } finally {
      this.busy.set(null);
    }
  }

  async pauseStream(stream: Workstream): Promise<BatchResult> {
    const targets = this.pausePreview(stream).nodes;
    return this.runBatch("pause", targets, (n) =>
      this.api.post(
        "POST /api/tasks/{id}/defer",
        { id: n.id },
        { deferredUntil: "" },
      ),
    );
  }

  async resumeStream(stream: Workstream): Promise<BatchResult> {
    const targets = this.resumePreview(stream).nodes;
    return this.runBatch("resume", targets, (n) =>
      this.api.post("POST /api/tasks/{id}/undefer", { id: n.id }),
    );
  }

  private async runBatch(
    action: string,
    targets: readonly WorkstreamNode[],
    call: (n: WorkstreamNode) => Promise<unknown>,
  ): Promise<BatchResult> {
    if (targets.length === 0) return { succeeded: 0, failed: 0 };
    this.busy.set(action);
    this.actionError.set(null);
    try {
      const results = await Promise.allSettled(
        targets.map((n) => Promise.resolve().then(() => call(n))),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;
      if (failed > 0) {
        this.actionError.set(
          `${failed} of ${results.length} task updates failed.`,
        );
      }
      await this.refresh(true);
      return { succeeded, failed };
    } finally {
      this.busy.set(null);
    }
  }
}
