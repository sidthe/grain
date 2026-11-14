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

import { Injectable, NgZone, computed, inject, signal } from "@angular/core";
import type { Subscription } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import { AccessService } from "../services/access.service";
import { errorText } from "../sessions/session-helpers";
import { configuredInstanceRepos } from "../shared/instance-repos";
import {
  type ActionsCacheFlush,
  type CICacheResponse,
  type CIFault,
  type CIFaultsResponse,
  type CIProviderFilter,
  type CIRun,
  type CIRunArtifact,
  type CIRunArtifactsResponse,
  type CIRunLogResponse,
  type CIRunRequest,
  type CIRunsResponse,
  type CIWorkflowOption,
  type CIWorkflowsResponse,
  type PackageCacheFlush,
  type QuarantineTestRequest,
  type QuarantineTestResponse,
  GITHUB_ACTIONS_PROVIDER,
  GRAIN_PROVIDER,
  faultSourceOf,
  isRunActive,
  mergeRunArtifacts,
  providerOfRun,
  repoFromActionsRunId,
} from "./ci.models";

const POLL_MS = 5000;

export interface RunArtifactsState {
  loading: boolean;
  loaded: boolean;
  enabled: boolean;
  available: boolean;
  artifacts: CIRunArtifact[];
  total: number;
  truncated: boolean;
  nextCursor: string;
  error: string | null;
}

@Injectable({ providedIn: "root" })
export class CIStore {
  private readonly api = inject(GrainApi);
  private readonly events = inject(GrainEvents);
  private readonly access = inject(AccessService);
  private readonly zone = inject(NgZone);

  readonly loaded = signal(false);
  readonly enabled = signal(true);
  readonly runs = signal<CIRun[]>([]);
  readonly faults = signal<CIFault[]>([]);
  readonly matched = signal(0);
  readonly stored = signal(0);
  readonly actionsNote = signal("");
  readonly targetRepos = signal<string[]>([]);
  readonly hasTargetAllowlist = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  readonly queryRepo = signal("");
  readonly queryProvider = signal<CIProviderFilter>("all");

  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<CIRun | null>(null);
  readonly detailLoading = signal(false);
  readonly artifacts = signal<CIRunArtifact[]>([]);
  readonly artifactsEnabled = signal(true);
  readonly artifactsAvailable = signal(false);
  readonly artifactsLoaded = signal(false);
  readonly artifactsLoading = signal(false);
  readonly artifactsTotal = signal(0);
  readonly artifactsTruncated = signal(false);
  readonly artifactsNextCursor = signal("");
  readonly artifactsError = signal<string | null>(null);
  readonly runArtifactsById = signal<Record<string, RunArtifactsState>>({});
  readonly jobLogs = signal<Record<string, CIRunLogResponse>>({});
  readonly jobLogLoading = signal<string | null>(null);

  readonly activeRun = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    const det = this.detail();
    if (det && det.id === id) return det;
    return this.runs().find((r) => r.id === id) ?? null;
  });

  readonly combinedFaults = computed(() => {
    const map = new Map<string, CIFault>();
    for (const f of this.faults()) {
      const src = faultSourceOf(f.source);
      const idPart =
        f.digest ||
        `${f.repo ?? ""}:${f.jobId ?? f.jobName ?? ""}:${f.kind}:${f.step ?? ""}:${f.summary ?? ""}`;
      map.set(`${src}:${idPart}`, f);
    }
    return [...map.values()];
  });

  private eventSub: Subscription | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;
  private sessionGen = 0;
  private bootstrapping = false;
  private inFlightDetailId: string | null = null;

  start(): void {
    this.actionError.set(null);
    this.activeCount++;
    if (this.activeCount > 1) return;
    const gen = ++this.sessionGen;
    this.bootstrapping = true;
    void this.bootstrap(gen);
    this.eventSub = this.events.events().subscribe((ev) => {
      if (ev.type === "task.ci" || ev.type === "task.state") {
        void this.refresh();
      }
    });
    this.zone.runOutsideAngular(() => {
      this.pollTimer = setInterval(() => {
        this.zone.run(() => void this.refresh());
      }, POLL_MS);
    });
  }

  stop(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount > 0) return;
    this.sessionGen++;
    this.bootstrapping = false;
    this.eventSub?.unsubscribe();
    this.eventSub = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  setQueryScope(repo: string, provider: CIProviderFilter): void {
    const cleanRepo = repo.trim();
    if (this.queryRepo() === cleanRepo && this.queryProvider() === provider) {
      return;
    }
    this.queryRepo.set(cleanRepo);
    this.queryProvider.set(provider);
    if (this.activeCount > 0 && !this.bootstrapping) {
      void this.refresh();
    }
  }

  private async bootstrap(gen: number): Promise<void> {
    try {
      await this.loadConfig();
    } finally {
      if (this.sessionGen === gen) {
        this.bootstrapping = false;
      }
    }
    if (this.sessionGen !== gen || this.activeCount === 0) return;
    await this.refresh();
  }

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await this.api.config();
      if (this.activeCount === 0) return;
      if (cfg) {
        this.access.setConfig(cfg);
        const scoped = configuredInstanceRepos(cfg);
        this.targetRepos.set(scoped.repos);
        this.hasTargetAllowlist.set(scoped.hasTargetAllowlist);
      }
    } catch {
      // Non-fatal: page still renders CI feed.
    }
  }

  private knownActionsRepos(
    extraRuns: readonly CIRun[],
    extraFaults: readonly CIFault[],
  ): string[] {
    const set = new Set<string>(this.targetRepos());
    const detRepo = this.detail()?.repo;
    if (detRepo) set.add(detRepo);
    const selRepo = repoFromActionsRunId(this.selectedId());
    if (selRepo) set.add(selRepo);
    for (const r of this.runs()) if (r.repo) set.add(r.repo);
    for (const r of extraRuns) if (r.repo) set.add(r.repo);
    for (const f of this.faults()) if (f.repo) set.add(f.repo);
    for (const f of extraFaults) if (f.repo) set.add(f.repo);
    return [...set].filter(Boolean).sort();
  }

  private fetchActionsRuns(repo?: string) {
    const params = new URLSearchParams({ provider: GITHUB_ACTIONS_PROVIDER });
    if (repo) params.set("repo", repo);
    return this.api
      .getIfChanged<CIRunsResponse>(
        "GET /api/ci/runs",
        undefined,
        params.toString(),
      )
      .catch(() => ({ body: null as CIRunsResponse | null, changed: false }));
  }

  async refresh(forceDetail = false): Promise<void> {
    if (this.activeCount === 0) return;
    if (!this.access.can("GET /api/ci/runs")) {
      this.loaded.set(true);
      this.loadError.set(this.access.deniedReason("GET /api/ci/runs"));
      return;
    }
    try {
      const repo = this.queryRepo();
      const prov = this.queryProvider();
      const selectedActionsRepo =
        repoFromActionsRunId(this.selectedId()) ||
        (this.detail() && providerOfRun(this.detail()!) === "github"
          ? (this.detail()?.repo ?? "")
          : "");
      let ghaRepos: string[] = [];
      if (repo && (prov === "all" || prov === "github")) {
        ghaRepos = [repo];
      } else if (!repo && prov === "github") {
        ghaRepos = this.knownActionsRepos([], []);
      } else if (prov === "all" && selectedActionsRepo) {
        ghaRepos = [selectedActionsRepo];
      }

      const grainQuery =
        prov === "grain" ? `provider=${GRAIN_PROVIDER}` : undefined;

      const [runsRes, faultsRes, initialGha] = await Promise.all([
        this.api.getIfChanged<CIRunsResponse>(
          "GET /api/ci/runs",
          undefined,
          grainQuery,
        ),
        this.access.can("GET /api/ci/faults")
          ? this.api
              .getIfChanged<CIFaultsResponse>("GET /api/ci/faults")
              .catch(() => ({
                body: null as CIFaultsResponse | null,
                changed: false,
              }))
          : Promise.resolve({
              body: null as CIFaultsResponse | null,
              changed: false,
            }),
        Promise.all(ghaRepos.map((r) => this.fetchActionsRuns(r))),
      ]);
      if (this.activeCount === 0) return;

      let ghaResults = initialGha;
      if (!repo && prov === "github") {
        const discovered = this.knownActionsRepos(runsRes.body?.runs ?? [], [
          ...(faultsRes.body?.faults ?? []),
          ...(runsRes.body?.faults ?? []),
        ]).filter((r) => !ghaRepos.includes(r));
        if (discovered.length > 0) {
          const extra = await Promise.all(
            discovered.map((r) => this.fetchActionsRuns(r)),
          );
          if (this.activeCount === 0) return;
          ghaResults = [...ghaResults, ...extra];
        } else if (ghaRepos.length === 0) {
          ghaResults = [await this.fetchActionsRuns()];
          if (this.activeCount === 0) return;
        }
      }

      const ghaBodies = ghaResults
        .map((res) => res.body)
        .filter((b): b is CIRunsResponse => b !== null);

      if (runsRes.body || ghaBodies.length > 0) {
        const body = runsRes.body;
        if (body) {
          this.enabled.set(
            body.enabled !== false ||
              ghaBodies.some((b) => b.enabled !== false),
          );
        } else if (ghaBodies.some((b) => b.enabled !== false)) {
          this.enabled.set(true);
        } else if (!this.loaded()) {
          this.enabled.set(false);
        }
        const byId = new Map<string, CIRun>();
        for (const r of body?.runs ?? []) {
          byId.set(r.id, r);
        }
        for (const gb of ghaBodies) {
          for (const r of gb.runs ?? []) {
            byId.set(r.id, r);
          }
        }
        const mergedRuns = [...byId.values()];
        this.runs.set(mergedRuns);
        this.matched.set(Math.max(body?.matched ?? 0, mergedRuns.length));
        this.stored.set(Math.max(body?.stored ?? 0, mergedRuns.length));

        const ghaNote = ghaBodies.map((b) => b.actionsNote ?? "").find(Boolean);
        this.actionsNote.set(ghaNote || body?.actionsNote || "");

        const dedicated = faultsRes.body?.faults;
        const mergedFaults = [
          ...(Array.isArray(dedicated) ? dedicated : []),
          ...(Array.isArray(body?.faults) ? body.faults : []),
          ...ghaBodies.flatMap((b) =>
            Array.isArray(b.faults) ? b.faults : [],
          ),
        ];
        this.faults.set(mergedFaults);
      } else if (faultsRes.body?.faults) {
        this.faults.set(faultsRes.body.faults);
      }

      this.loadError.set(null);
      this.loaded.set(true);

      const sel = this.selectedId();
      if (sel) {
        const cur = this.detail();
        if (forceDetail || !cur || cur.id !== sel || isRunActive(cur)) {
          await this.loadRunDetail(sel, false);
        }
      }
    } catch (err) {
      if (this.activeCount === 0) return;
      this.loaded.set(true);
      this.loadError.set(errorText(err));
    }
  }

  async selectRun(id: string | null): Promise<void> {
    if (
      this.selectedId() === id &&
      (this.detail()?.id === id ||
        (id !== null && this.inFlightDetailId === id))
    ) {
      return;
    }
    const switching = this.selectedId() !== id;
    this.selectedId.set(id);
    this.jobLogs.set({});
    if (!id) {
      this.detail.set(null);
      this.resetSelectedArtifacts();
      return;
    }
    if (switching) {
      this.resetSelectedArtifacts();
    }
    await this.loadRunDetail(id, true);
  }

  private resetSelectedArtifacts(): void {
    this.artifacts.set([]);
    this.artifactsEnabled.set(true);
    this.artifactsAvailable.set(false);
    this.artifactsLoaded.set(false);
    this.artifactsLoading.set(false);
    this.artifactsTotal.set(0);
    this.artifactsTruncated.set(false);
    this.artifactsNextCursor.set("");
    this.artifactsError.set(null);
  }

  private knownRepoForRun(id: string): string | undefined {
    return (
      this.runs().find((r) => r.id === id)?.repo ||
      (this.detail()?.id === id ? this.detail()?.repo : undefined) ||
      repoFromActionsRunId(id) ||
      undefined
    );
  }

  private applyRunArtifacts(
    id: string,
    state: RunArtifactsState,
    syncSelected = true,
  ): void {
    this.runArtifactsById.update((prev) => ({ ...prev, [id]: state }));
    if (syncSelected && this.selectedId() === id) {
      this.artifactsEnabled.set(state.enabled);
      this.artifactsAvailable.set(state.available);
      this.artifacts.set(state.artifacts);
      this.artifactsTotal.set(state.total);
      this.artifactsTruncated.set(state.truncated);
      this.artifactsNextCursor.set(state.nextCursor);
      this.artifactsError.set(state.error);
      this.artifactsLoaded.set(state.loaded);
      this.artifactsLoading.set(state.loading);
    }
  }

  async loadRunDetail(id: string, showSpinner = true): Promise<void> {
    const knownRepo = this.knownRepoForRun(id);
    if (!this.access.can("GET /api/ci/runs/{id}", knownRepo)) return;
    this.inFlightDetailId = id;
    if (showSpinner) {
      this.detailLoading.set(true);
      if (this.selectedId() === id) this.artifactsLoading.set(true);
    }
    try {
      const canArtifacts = this.access.can(
        "GET /api/ci/runs/{id}/artifacts",
        knownRepo,
      );
      const [run, artOutcome] = await Promise.all([
        this.api.get<CIRun>("GET /api/ci/runs/{id}", { id }),
        canArtifacts
          ? this.api
              .get<CIRunArtifactsResponse>("GET /api/ci/runs/{id}/artifacts", {
                id,
              })
              .then((res) => ({ res, error: null as string | null }))
              .catch((err) => ({
                res: null as CIRunArtifactsResponse | null,
                error: errorText(err),
              }))
          : Promise.resolve({
              res: null as CIRunArtifactsResponse | null,
              error: null as string | null,
            }),
      ]);
      if (this.activeCount === 0) return;
      if (this.selectedId() === id) {
        this.detail.set(run);
        const permitted = this.access.can(
          "GET /api/ci/runs/{id}/artifacts",
          run.repo || knownRepo,
        );
        if (!permitted) {
          this.applyRunArtifacts(id, {
            loading: false,
            loaded: true,
            enabled: true,
            available: false,
            artifacts: [],
            total: 0,
            truncated: false,
            nextCursor: "",
            error: this.access.deniedReason(
              "GET /api/ci/runs/{id}/artifacts",
              run.repo || knownRepo,
            ),
          });
        } else if (artOutcome.res) {
          const merged = mergeRunArtifacts(
            Array.isArray(artOutcome.res.artifacts)
              ? artOutcome.res.artifacts
              : [],
            run.jobs,
            run.id || id,
          );
          const enabled = artOutcome.res.enabled !== false;
          const available = !!artOutcome.res.available || merged.length > 0;
          this.applyRunArtifacts(id, {
            loading: false,
            loaded: true,
            enabled,
            available,
            artifacts: merged,
            total: Math.max(artOutcome.res.total ?? 0, merged.length),
            truncated: !!artOutcome.res.truncated,
            nextCursor: artOutcome.res.nextCursor ?? "",
            error: null,
          });
        } else {
          const fromJobs = mergeRunArtifacts([], run.jobs, run.id || id);
          this.applyRunArtifacts(id, {
            loading: false,
            loaded: true,
            enabled: true,
            available: fromJobs.length > 0,
            artifacts: fromJobs,
            total: fromJobs.length,
            truncated: false,
            nextCursor: "",
            error: fromJobs.length > 0 ? null : artOutcome.error,
          });
        }
      }
    } catch (err) {
      if (this.activeCount === 0) return;
      if (this.selectedId() === id) {
        this.actionError.set(errorText(err));
        this.artifactsLoading.set(false);
      }
    } finally {
      if (this.inFlightDetailId === id) {
        this.inFlightDetailId = null;
      }
      if (showSpinner && this.activeCount > 0) {
        this.detailLoading.set(false);
      }
    }
  }

  async loadRunArtifacts(
    runId: string,
    repo?: string,
    cursor = "",
  ): Promise<void> {
    const scopeRepo = repo || this.knownRepoForRun(runId);
    if (!this.access.can("GET /api/ci/runs/{id}/artifacts", scopeRepo)) {
      this.applyRunArtifacts(runId, {
        loading: false,
        loaded: true,
        enabled: true,
        available: false,
        artifacts: [],
        total: 0,
        truncated: false,
        nextCursor: "",
        error: this.access.deniedReason(
          "GET /api/ci/runs/{id}/artifacts",
          scopeRepo,
        ),
      });
      return;
    }
    const prev = this.runArtifactsById()[runId];
    if (!cursor && prev?.loading) return;
    this.applyRunArtifacts(runId, {
      loading: true,
      loaded: prev?.loaded ?? false,
      enabled: prev?.enabled ?? true,
      available: prev?.available ?? false,
      artifacts: prev?.artifacts ?? [],
      total: prev?.total ?? 0,
      truncated: prev?.truncated ?? false,
      nextCursor: prev?.nextCursor ?? "",
      error: null,
    });
    try {
      const q = cursor ? new URLSearchParams({ cursor }).toString() : undefined;
      const res = await this.api.get<CIRunArtifactsResponse>(
        "GET /api/ci/runs/{id}/artifacts",
        { id: runId },
        q,
      );
      if (this.activeCount === 0) return;
      const runObj =
        this.detail()?.id === runId
          ? this.detail()
          : (this.runs().find((r) => r.id === runId) ?? null);
      const pageItems = Array.isArray(res?.artifacts) ? res.artifacts : [];
      const baseItems = cursor
        ? [...(prev?.artifacts ?? []), ...pageItems]
        : pageItems;
      const merged = mergeRunArtifacts(baseItems, runObj?.jobs, runId);
      this.applyRunArtifacts(runId, {
        loading: false,
        loaded: true,
        enabled: res?.enabled !== false,
        available: !!res?.available || merged.length > 0,
        artifacts: merged,
        total: Math.max(res?.total ?? 0, merged.length),
        truncated: !!res?.truncated,
        nextCursor: res?.nextCursor ?? "",
        error: null,
      });
    } catch (err) {
      if (this.activeCount === 0) return;
      this.applyRunArtifacts(runId, {
        loading: false,
        loaded: true,
        enabled: prev?.enabled ?? true,
        available: prev?.available ?? false,
        artifacts: prev?.artifacts ?? [],
        total: prev?.total ?? 0,
        truncated: prev?.truncated ?? false,
        nextCursor: prev?.nextCursor ?? "",
        error: errorText(err),
      });
    }
  }

  async fetchJobLog(
    runId: string,
    jobNameOrId: string,
    tail?: number,
  ): Promise<void> {
    if (!this.access.can("GET /api/ci/runs/{id}/log")) return;
    const key = `${runId}:${jobNameOrId}`;
    this.jobLogLoading.set(key);
    try {
      const params = new URLSearchParams({ job: jobNameOrId });
      if (tail && tail > 0) params.set("tail", String(tail));
      const res = await this.api.get<CIRunLogResponse>(
        "GET /api/ci/runs/{id}/log",
        { id: runId },
        params.toString(),
      );
      if (this.activeCount === 0) return;
      this.jobLogs.update((prev) => ({ ...prev, [key]: res }));
    } catch (err) {
      if (this.activeCount === 0) return;
      this.actionError.set(errorText(err));
    } finally {
      if (this.activeCount > 0 && this.jobLogLoading() === key) {
        this.jobLogLoading.set(null);
      }
    }
  }

  async fetchWorkflows(repo: string, ref: string): Promise<CIWorkflowOption[]> {
    if (!repo.trim() || !this.access.can("GET /api/ci/workflows", repo)) {
      return [];
    }
    const q = new URLSearchParams({ repo: repo.trim() });
    if (ref.trim()) q.set("ref", ref.trim());
    const res = await this.api.get<CIWorkflowsResponse>(
      "GET /api/ci/workflows",
      undefined,
      q.toString(),
    );
    return Array.isArray(res?.workflows) ? res.workflows : [];
  }

  async triggerRun(req: CIRunRequest): Promise<CIRun> {
    this.actionError.set(null);
    const created = await this.api.post<CIRun>(
      "POST /api/ci/runs",
      undefined,
      req,
    );
    this.api.clearConditionalCache();
    if (this.activeCount > 0) {
      await this.refresh(true);
      if (created?.id && this.activeCount > 0) {
        await this.selectRun(created.id);
      }
    }
    return created;
  }

  async cancelRun(id: string, reason?: string): Promise<void> {
    this.actionError.set(null);
    const body = reason?.trim() ? { reason: reason.trim() } : undefined;
    await this.api.delete("DELETE /api/ci/runs/{id}", { id }, body);
    this.api.clearConditionalCache();
    if (this.activeCount > 0) {
      await this.refresh(true);
    }
  }

  async flushCICache(): Promise<CICacheResponse> {
    this.actionError.set(null);
    return this.api.delete<CICacheResponse>("DELETE /api/ci/cache");
  }

  async flushActionsCache(repo?: string): Promise<ActionsCacheFlush> {
    this.actionError.set(null);
    const q = repo?.trim()
      ? new URLSearchParams({ repo: repo.trim() }).toString()
      : undefined;
    return this.api.post<ActionsCacheFlush>(
      "POST /api/actions-cache/flush",
      undefined,
      {},
      q,
    );
  }

  async flushPackageCache(kind?: string): Promise<PackageCacheFlush> {
    this.actionError.set(null);
    const q = kind?.trim()
      ? new URLSearchParams({ kind: kind.trim() }).toString()
      : undefined;
    return this.api.post<PackageCacheFlush>(
      "POST /api/package-cache/flush",
      undefined,
      {},
      q,
    );
  }

  async quarantineTest(
    req: QuarantineTestRequest,
  ): Promise<QuarantineTestResponse> {
    this.actionError.set(null);
    const res = await this.api.post<QuarantineTestResponse>(
      "POST /api/tests/quarantine",
      undefined,
      req,
    );
    this.api.clearConditionalCache();
    if (this.activeCount > 0) {
      await this.refresh(true);
    }
    return res;
  }
}
