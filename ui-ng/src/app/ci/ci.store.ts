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
  CI_PROVIDER_GITHUB_ACTIONS,
  actionsRunRepo,
  faultSourceOf,
  isRunActive,
  mergeRunArtifacts,
  providerOfRun,
} from "./ci.models";

const POLL_MS = 5000;

export interface RunArtifactsState {
  loading: boolean;
  error: string | null;
  enabled: boolean;
  available: boolean;
  artifacts: CIRunArtifact[];
  total: number;
  truncated: boolean;
  nextCursor?: string;
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
  readonly artifactsLoading = signal(false);
  readonly artifactsError = signal<string | null>(null);
  readonly artifactsTotal = signal(0);
  readonly artifactsTruncated = signal(false);
  readonly artifactsNextCursor = signal("");
  readonly faultRunArtifacts = signal<Record<string, RunArtifactsState>>({});
  readonly jobLogs = signal<Record<string, CIRunLogResponse>>({});
  readonly jobLogLoading = signal<string | null>(null);

  readonly activeArtifactsState = computed<RunArtifactsState>(() => ({
    loading: this.artifactsLoading(),
    error: this.artifactsError(),
    enabled: this.artifactsEnabled(),
    available: this.artifactsAvailable(),
    artifacts: this.artifacts(),
    total: this.artifactsTotal(),
    truncated: this.artifactsTruncated(),
    nextCursor: this.artifactsNextCursor(),
  }));

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
  private detailReqSeq = 0;
  private readonly faultArtReqSeq = new Map<string, number>();

  start(): void {
    this.actionError.set(null);
    this.activeCount++;
    if (this.activeCount > 1) return;
    void this.bootstrap();
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
    this.eventSub?.unsubscribe();
    this.eventSub = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.faultArtReqSeq.clear();
    this.faultRunArtifacts.set({});
  }

  setQueryScope(repo: string, provider: CIProviderFilter): void {
    const cleanRepo = repo.trim();
    if (this.queryRepo() === cleanRepo && this.queryProvider() === provider) {
      return;
    }
    this.queryRepo.set(cleanRepo);
    this.queryProvider.set(provider);
    if (this.activeCount > 0) {
      void this.refresh();
    }
  }

  private async bootstrap(): Promise<void> {
    await this.loadConfig();
    if (this.activeCount === 0) return;
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

  private selectedActionsRepo(): string {
    const id = this.selectedId();
    const fromId = actionsRunRepo(id ?? undefined);
    if (fromId) return fromId;
    const det = this.detail();
    if (det && det.id === id && providerOfRun(det) === "github" && det.repo) {
      return det.repo;
    }
    return "";
  }

  private knownActionsRepos(
    extraRuns: readonly CIRun[],
    extraFaults: readonly CIFault[],
  ): string[] {
    const set = new Set<string>(this.targetRepos());
    const selGhaRepo = this.selectedActionsRepo();
    if (selGhaRepo) set.add(selGhaRepo);
    const detRepo = this.detail()?.repo;
    if (detRepo) set.add(detRepo);
    for (const r of this.runs()) if (r.repo) set.add(r.repo);
    for (const r of extraRuns) if (r.repo) set.add(r.repo);
    for (const f of this.faults()) if (f.repo) set.add(f.repo);
    for (const f of extraFaults) if (f.repo) set.add(f.repo);
    return [...set].filter(Boolean).sort();
  }

  private fetchActionsForRepo(repo: string) {
    const q = new URLSearchParams({
      repo,
      provider: CI_PROVIDER_GITHUB_ACTIONS,
    }).toString();
    return this.api
      .getIfChanged<CIRunsResponse>("GET /api/ci/runs", undefined, q)
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
      const selGhaRepo = this.selectedActionsRepo();
      let ghaRepos: string[] = [];
      if (repo && (prov === "all" || prov === "github")) {
        ghaRepos = [repo];
      } else if (!repo && prov === "github") {
        ghaRepos = this.knownActionsRepos([], []);
      } else if (prov === "all" && selGhaRepo) {
        ghaRepos = [selGhaRepo];
      }

      let runsErr: unknown = null;
      const [runsRes, faultsRes, initialGha] = await Promise.all([
        this.api
          .getIfChanged<CIRunsResponse>("GET /api/ci/runs")
          .catch((err) => {
            runsErr = err;
            return { body: null as CIRunsResponse | null, changed: false };
          }),
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
        Promise.all(ghaRepos.map((r) => this.fetchActionsForRepo(r))),
      ]);
      if (this.activeCount === 0) return;

      let ghaResults = initialGha;
      if (!repo && prov === "github" && ghaRepos.length === 0) {
        const discovered = this.knownActionsRepos(runsRes.body?.runs ?? [], [
          ...(faultsRes.body?.faults ?? []),
          ...(runsRes.body?.faults ?? []),
        ]);
        if (discovered.length > 0) {
          ghaResults = await Promise.all(
            discovered.map((r) => this.fetchActionsForRepo(r)),
          );
          if (this.activeCount === 0) return;
        }
      }

      const ghaBodies = ghaResults
        .map((res) => res.body)
        .filter((b): b is CIRunsResponse => b !== null);

      if (runsErr && ghaBodies.length === 0) {
        throw runsErr;
      }

      if (runsRes.body || ghaBodies.length > 0) {
        const body = runsRes.body;
        if (body || ghaBodies.some((b) => b.enabled !== undefined)) {
          const grainEnabled = body ? body.enabled !== false : this.enabled();
          this.enabled.set(
            grainEnabled || ghaBodies.some((b) => b.enabled !== false),
          );
        }
        const byId = new Map<string, CIRun>();
        const baseRuns = body
          ? (body.runs ?? [])
          : this.runs().filter((r) => providerOfRun(r) === "grain");
        for (const r of baseRuns) {
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

  private knownRunRepo(id: string): string | undefined {
    const det = this.detail();
    if (det?.id === id && det.repo) return det.repo;
    const listed = this.runs().find((r) => r.id === id);
    if (listed?.repo) return listed.repo;
    for (const f of this.faults()) {
      if (f.repo && f.runs?.some((r) => r.runId === id)) return f.repo;
    }
    const ghaRepo = actionsRunRepo(id);
    return ghaRepo || undefined;
  }

  private fetchArtifactsResponse(
    id: string,
    cursor?: string,
  ): Promise<CIRunArtifactsResponse> {
    const query = cursor
      ? new URLSearchParams({ cursor }).toString()
      : undefined;
    return this.api.get<CIRunArtifactsResponse>(
      "GET /api/ci/runs/{id}/artifacts",
      { id },
      query,
    );
  }

  private clearSelectedArtifacts(): void {
    this.artifacts.set([]);
    this.artifactsEnabled.set(true);
    this.artifactsAvailable.set(false);
    this.artifactsLoading.set(false);
    this.artifactsError.set(null);
    this.artifactsTotal.set(0);
    this.artifactsTruncated.set(false);
    this.artifactsNextCursor.set("");
  }

  private applyRunArtifacts(
    id: string,
    jobs: CIRun["jobs"],
    res: CIRunArtifactsResponse | null,
    err: unknown,
    append = false,
  ): void {
    const base = append ? this.artifacts() : [];
    const incoming = Array.isArray(res?.artifacts) ? res.artifacts : [];
    const merged = mergeRunArtifacts(id, [...base, ...incoming], jobs);
    if (res) {
      this.artifactsEnabled.set(res.enabled !== false);
      this.artifactsAvailable.set(!!res.available);
      this.artifactsError.set(null);
      this.artifacts.set(merged);
      this.artifactsTotal.set(Math.max(res.total ?? 0, merged.length));
      this.artifactsTruncated.set(!!res.truncated);
      this.artifactsNextCursor.set(res.nextCursor ?? "");
    } else if (err) {
      this.artifactsEnabled.set(true);
      this.artifactsAvailable.set(merged.length > 0);
      this.artifactsError.set(errorText(err));
      this.artifacts.set(merged);
      this.artifactsTotal.set(merged.length);
      this.artifactsTruncated.set(false);
      this.artifactsNextCursor.set("");
    } else {
      this.artifactsEnabled.set(true);
      this.artifactsAvailable.set(merged.length > 0);
      this.artifactsError.set(null);
      this.artifacts.set(merged);
      this.artifactsTotal.set(merged.length);
      this.artifactsTruncated.set(false);
      this.artifactsNextCursor.set("");
    }
    if (this.faultRunArtifacts()[id]) {
      const snap = this.activeArtifactsState();
      this.faultRunArtifacts.update((prev) => ({
        ...prev,
        [id]: { ...snap, loading: false },
      }));
    }
  }

  async selectRun(id: string | null): Promise<void> {
    if (this.selectedId() === id && this.detail()?.id === id) return;
    this.selectedId.set(id);
    this.jobLogs.set({});
    this.clearSelectedArtifacts();
    if (!id) {
      this.detailReqSeq++;
      this.detail.set(null);
      this.detailLoading.set(false);
      return;
    }
    await this.loadRunDetail(id, true);
  }

  async loadRunDetail(id: string, showSpinner = true): Promise<void> {
    const knownRepo = this.knownRunRepo(id);
    if (!this.access.can("GET /api/ci/runs/{id}", knownRepo)) return;
    const canReadArts = this.access.can(
      "GET /api/ci/runs/{id}/artifacts",
      knownRepo,
    );
    const seq = ++this.detailReqSeq;
    if (showSpinner) {
      this.detailLoading.set(true);
      if (canReadArts) this.artifactsLoading.set(true);
    }
    try {
      const runPromise = this.api
        .get<CIRun>("GET /api/ci/runs/{id}", { id })
        .then(
          (run) => ({ run, err: null as unknown }),
          (err) => ({ run: null as CIRun | null, err }),
        );
      const artPromise = canReadArts
        ? this.fetchArtifactsResponse(id).then(
            (res) => ({ res, err: null as unknown }),
            (err) => ({ res: null as CIRunArtifactsResponse | null, err }),
          )
        : Promise.resolve({
            res: null as CIRunArtifactsResponse | null,
            err: null as unknown,
          });
      const [runOut, artOut] = await Promise.all([runPromise, artPromise]);
      if (
        this.activeCount === 0 ||
        this.selectedId() !== id ||
        this.detailReqSeq !== seq
      ) {
        return;
      }
      if (runOut.run) {
        this.detail.set(runOut.run);
        const allowArts = this.access.can(
          "GET /api/ci/runs/{id}/artifacts",
          runOut.run.repo,
        );
        if (allowArts) {
          this.applyRunArtifacts(id, runOut.run.jobs, artOut.res, artOut.err);
        } else {
          this.applyRunArtifacts(id, runOut.run.jobs, null, null);
        }
      } else {
        this.detail.set(null);
        if (runOut.err) {
          this.actionError.set(errorText(runOut.err));
        }
        if (canReadArts) {
          this.applyRunArtifacts(id, undefined, artOut.res, artOut.err);
        }
      }
    } finally {
      if (
        this.activeCount > 0 &&
        this.selectedId() === id &&
        this.detailReqSeq === seq
      ) {
        if (showSpinner) this.detailLoading.set(false);
        this.artifactsLoading.set(false);
      }
    }
  }

  async reloadRunArtifacts(id: string, repo?: string): Promise<void> {
    const effectiveRepo = repo || this.knownRunRepo(id);
    if (!this.access.can("GET /api/ci/runs/{id}/artifacts", effectiveRepo)) {
      return;
    }
    const seq = ++this.detailReqSeq;
    this.artifactsLoading.set(true);
    this.artifactsError.set(null);
    try {
      const res = await this.fetchArtifactsResponse(id);
      if (
        this.activeCount === 0 ||
        this.selectedId() !== id ||
        this.detailReqSeq !== seq
      ) {
        return;
      }
      const det = this.detail();
      this.applyRunArtifacts(
        id,
        det?.id === id ? det.jobs : undefined,
        res,
        null,
      );
    } catch (err) {
      if (
        this.activeCount === 0 ||
        this.selectedId() !== id ||
        this.detailReqSeq !== seq
      ) {
        return;
      }
      const det = this.detail();
      this.applyRunArtifacts(
        id,
        det?.id === id ? det.jobs : undefined,
        null,
        err,
      );
    } finally {
      if (
        this.activeCount > 0 &&
        this.selectedId() === id &&
        this.detailReqSeq === seq
      ) {
        this.artifactsLoading.set(false);
      }
    }
  }

  async loadMoreRunArtifacts(id: string, repo?: string): Promise<void> {
    const cursor = this.artifactsNextCursor();
    const effectiveRepo = repo || this.knownRunRepo(id);
    if (
      !cursor ||
      this.artifactsLoading() ||
      !this.access.can("GET /api/ci/runs/{id}/artifacts", effectiveRepo)
    ) {
      return;
    }
    const seq = ++this.detailReqSeq;
    this.artifactsLoading.set(true);
    try {
      const res = await this.fetchArtifactsResponse(id, cursor);
      if (
        this.activeCount === 0 ||
        this.selectedId() !== id ||
        this.detailReqSeq !== seq
      ) {
        return;
      }
      const det = this.detail();
      this.applyRunArtifacts(
        id,
        det?.id === id ? det.jobs : undefined,
        res,
        null,
        true,
      );
    } catch (err) {
      if (
        this.activeCount === 0 ||
        this.selectedId() !== id ||
        this.detailReqSeq !== seq
      ) {
        return;
      }
      this.artifactsError.set(errorText(err));
    } finally {
      if (
        this.activeCount > 0 &&
        this.selectedId() === id &&
        this.detailReqSeq === seq
      ) {
        this.artifactsLoading.set(false);
      }
    }
  }

  async loadFaultRunArtifacts(
    runId: string,
    repo?: string,
    force = false,
    cursor?: string,
  ): Promise<void> {
    if (!runId) return;
    const effectiveRepo = repo || this.knownRunRepo(runId);
    if (!this.access.can("GET /api/ci/runs/{id}/artifacts", effectiveRepo)) {
      this.faultRunArtifacts.update((prev) => ({
        ...prev,
        [runId]: {
          loading: false,
          error: this.access.deniedReason(
            "GET /api/ci/runs/{id}/artifacts",
            effectiveRepo,
          ),
          enabled: true,
          available: false,
          artifacts: [],
          total: 0,
          truncated: false,
          nextCursor: "",
        },
      }));
      return;
    }
    const existing = this.faultRunArtifacts()[runId];
    if (
      !force &&
      !cursor &&
      existing &&
      (existing.loading || !existing.error)
    ) {
      return;
    }
    const seq = (this.faultArtReqSeq.get(runId) ?? 0) + 1;
    this.faultArtReqSeq.set(runId, seq);
    this.faultRunArtifacts.update((prev) => ({
      ...prev,
      [runId]: {
        loading: true,
        error: null,
        enabled: existing?.enabled ?? true,
        available: existing?.available ?? false,
        artifacts: cursor ? (existing?.artifacts ?? []) : [],
        total: existing?.total ?? 0,
        truncated: existing?.truncated ?? false,
        nextCursor: existing?.nextCursor ?? "",
      },
    }));
    try {
      const res = await this.fetchArtifactsResponse(runId, cursor);
      if (this.activeCount === 0 || this.faultArtReqSeq.get(runId) !== seq) {
        return;
      }
      const det = this.detail();
      const knownRun =
        det?.id === runId ? det : this.runs().find((r) => r.id === runId);
      const base = cursor ? (existing?.artifacts ?? []) : [];
      const incoming = Array.isArray(res?.artifacts) ? res.artifacts : [];
      const merged = mergeRunArtifacts(
        runId,
        [...base, ...incoming],
        knownRun?.jobs,
      );
      this.faultRunArtifacts.update((prev) => ({
        ...prev,
        [runId]: {
          loading: false,
          error: null,
          enabled: res.enabled !== false,
          available: !!res.available,
          artifacts: merged,
          total: Math.max(res.total ?? 0, merged.length),
          truncated: !!res.truncated,
          nextCursor: res.nextCursor ?? "",
        },
      }));
      if (this.selectedId() === runId && !cursor) {
        this.applyRunArtifacts(runId, knownRun?.jobs, res, null);
      }
    } catch (err) {
      if (this.activeCount === 0 || this.faultArtReqSeq.get(runId) !== seq) {
        return;
      }
      this.faultRunArtifacts.update((prev) => ({
        ...prev,
        [runId]: {
          loading: false,
          error: errorText(err),
          enabled: existing?.enabled ?? true,
          available: existing?.available ?? false,
          artifacts: cursor ? (existing?.artifacts ?? []) : [],
          total: existing?.total ?? 0,
          truncated: existing?.truncated ?? false,
          nextCursor: existing?.nextCursor ?? "",
        },
      }));
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
