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

import { TestBed } from "@angular/core/testing";
import {
  Router,
  provideRouter,
  withComponentInputBinding,
} from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { Subject } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents, type GrainEvent } from "../api/grain-events.service";
import type { GrainConfig } from "../api/models";
import { CIPageComponent } from "./ci-page.component";
import {
  type CIFault,
  type CIRun,
  type CIRunArtifact,
  type CIRunArtifactsResponse,
  type CIRunLogResponse,
  type CIWorkflowOption,
  artifactDownloadable,
  faultFixWhere,
  faultRunCommit,
  faultSourceLabel,
  faultsForRun,
  isActionsRunId,
  mergeRunArtifacts,
  parseProviderQueryParam,
  providerQueryParam,
  pullRequestExternalUrl,
  repoFromActionsRunId,
  runBucket,
  runProviderQueryParams,
  safeExternalUrl,
} from "./ci.models";

class FakeCIApi {
  configBody: GrainConfig = {
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
    targetRepos: ["acme/widgets", "acme/infra"],
  };

  runs: CIRun[] = [
    {
      id: "run-errored-1",
      provider: "grain",
      repo: "acme/widgets",
      ref: "refs/heads/grain/task-101",
      commit: "aaa111122223333",
      event: "push",
      requestedBy: "101",
      conclusion: "errored",
      error: "sandbox boot failed: granule image pull timeout",
      startedAt: "2026-11-12T00:00:00Z",
      finishedAt: "2026-11-12T00:01:15Z",
      jobs: [
        {
          jobId: "test",
          name: "Unit tests",
          workflow: "CI",
          conclusion: "errored",
          error: "sandbox boot failed",
          steps: [],
        },
      ],
    },
    {
      id: "run-failed-2",
      provider: "grain",
      repo: "acme/widgets",
      ref: "refs/heads/grain/task-102",
      commit: "bbb222233334444",
      event: "pull_request",
      requestedBy: "102",
      conclusion: "failure",
      startedAt: "2026-11-12T00:02:00Z",
      finishedAt: "2026-11-12T00:04:00Z",
      jobs: [
        {
          jobId: "unit",
          name: "Go unit suite",
          workflow: "CI",
          conclusion: "failure",
          failureSummary: { failedTests: ["TestCheckoutRace"] },
          steps: [
            {
              name: "Run go test",
              conclusion: "failure",
              exitCode: 1,
              output:
                "=== RUN TestCheckoutRace\n--- FAIL: TestCheckoutRace (0.14s)\npanic: race detected",
            },
          ],
        },
      ],
    },
    {
      id: "run-running-3",
      provider: "grain",
      repo: "acme/infra",
      ref: "refs/heads/main",
      commit: "ccc333344445555",
      event: "workflow_dispatch",
      status: "running",
      startedAt: "2026-11-12T00:05:00Z",
      jobs: [
        {
          jobId: "lint",
          name: "Lint",
          workflow: "Checks",
          startedAt: "2026-11-12T00:05:02Z",
          steps: [
            {
              name: "golangci-lint",
              startedAt: "2026-11-12T00:05:03Z",
              output: "linting pkg/...",
            },
          ],
        },
      ],
    },
    {
      id: "gha:acme:widgets:9001",
      provider: "github-actions",
      repo: "acme/widgets",
      ref: "refs/heads/main",
      commit: "ddd444455556666",
      conclusion: "failure",
      actions: {
        runId: 9001,
        workflowName: "GitHub E2E",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/acme/widgets/actions/runs/9001",
      },
      jobs: [
        {
          jobId: "e2e",
          name: "Playwright E2E",
          conclusion: "failure",
          steps: [{ name: "npx playwright test", conclusion: "failure" }],
        },
      ],
    },
  ];

  faults: CIFault[] = [
    {
      source: "grain",
      digest: "fault-granule-pull",
      repo: "acme/widgets",
      jobId: "test",
      jobName: "Unit tests",
      step: "Setup sandbox",
      kind: "errored",
      summary: "Granule image registry 503 across branches",
      runCount: 4,
      refCount: 3,
      ownerTaskId: "88",
      runs: [
        {
          runId: "run-errored-1",
          ref: "grain/task-101",
          taskId: "101",
          sha: "aaa111122223333",
        },
      ],
      refs: ["grain/task-101", "grain/task-99", "main"],
    },
  ];

  artifactsByRun: Record<string, CIRunArtifact[]> = {
    "run-failed-2": [
      {
        run: "run-failed-2",
        job: "unit",
        name: "coverage-report",
        stored: true,
        bytes: 24576,
      },
      {
        run: "run-failed-2",
        job: "unit",
        name: "expired-trace",
        stored: false,
        bytes: 1024,
      },
    ],
  };

  workflows: CIWorkflowOption[] = [
    { path: ".grain/workflows/ci.yml", name: "CI" },
    { path: ".grain/workflows/nightly.yml", name: "Nightly" },
  ];

  ghaLog: CIRunLogResponse = {
    run: "gha:acme:widgets:9001",
    job: "Playwright E2E",
    jobId: 77,
    bytes: 128,
    log: "Step 1: Launching browser\nError: Timed out waiting for selector #app",
  };

  runListQueries: string[] = [];
  postCalls: {
    route: string;
    params?: unknown;
    body?: unknown;
    query?: string;
  }[] = [];
  deleteCalls: { route: string; params?: unknown; body?: unknown }[] = [];
  deleteError: Error | null = null;
  logCalls: { id: string; query?: string }[] = [];
  artifactCalls: { id: string; query?: string }[] = [];
  artifactResponsesByRun: Record<string, CIRunArtifactsResponse> = {};
  artifactResponder:
    ((id: string, query?: string) => Promise<CIRunArtifactsResponse>) | null =
    null;
  artifactErrorByRun: Record<string, Error | string> = {};

  config = () => Promise.resolve(this.configBody);
  clearConditionalCache = () => undefined;

  getIfChanged = (
    route: string,
    _params?: Record<string, unknown>,
    query?: string,
  ) => {
    if (route === "GET /api/ci/runs") {
      this.runListQueries.push(query ?? "");
      const qp = new URLSearchParams(query ?? "");
      const prov = qp.get("provider");
      const repo = qp.get("repo");
      // Mirror pkg/ui/ci_actions.go wantsActions: human sessions only receive
      // GitHub Actions runs when both repo and provider=github-actions are sent.
      if (prov === "github-actions" && repo) {
        const gha = this.runs.filter(
          (r) => r.provider === "github-actions" && r.repo === repo,
        );
        return Promise.resolve({
          body: {
            enabled: true,
            runs: structuredClone(gha),
            matched: gha.length,
            stored: gha.length,
            repoProvider: "github-actions",
          },
          changed: true,
        });
      }
      const grainOnly = this.runs.filter(
        (r) => r.provider !== "github-actions",
      );
      return Promise.resolve({
        body: {
          enabled: true,
          runs: structuredClone(grainOnly),
          matched: grainOnly.length,
          stored: grainOnly.length,
          faults: structuredClone(this.faults),
        },
        changed: true,
      });
    }
    if (route === "GET /api/ci/faults") {
      return Promise.resolve({
        body: {
          enabled: true,
          faults: structuredClone(this.faults),
          total: this.faults.length,
        },
        changed: true,
      });
    }
    return Promise.resolve({ body: null, changed: false });
  };

  get = async (
    route: string,
    params?: Record<string, unknown>,
    query?: string,
  ) => {
    if (route === "GET /api/ci/runs/{id}") {
      const id = String(params?.["id"] ?? "");
      const found = this.runs.find((r) => r.id === id);
      return structuredClone(found ?? this.runs[0]);
    }
    if (route === "GET /api/ci/runs/{id}/artifacts") {
      const id = String(params?.["id"] ?? "");
      this.artifactCalls.push({ id, query });
      if (this.artifactErrorByRun[id]) {
        const err = this.artifactErrorByRun[id];
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (this.artifactResponder) {
        return await this.artifactResponder(id, query);
      }
      if (this.artifactResponsesByRun[id]) {
        return structuredClone(this.artifactResponsesByRun[id]);
      }
      const list = this.artifactsByRun[id] ?? [];
      return {
        enabled: true,
        available: true,
        artifacts: structuredClone(list),
        total: list.length,
      };
    }
    if (route === "GET /api/ci/runs/{id}/log") {
      this.logCalls.push({ id: String(params?.["id"] ?? ""), query });
      return structuredClone(this.ghaLog);
    }
    if (route === "GET /api/ci/workflows") {
      return {
        workflows: structuredClone(this.workflows),
        total: this.workflows.length,
      };
    }
    return {};
  };

  post = (
    route: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    query?: string,
  ) => {
    this.postCalls.push({ route, params, body, query });
    if (route === "POST /api/ci/runs") {
      const created: CIRun = {
        id: "run-triggered-99",
        provider: "grain",
        repo: String(body?.["repo"] || "acme/widgets"),
        ref: String(body?.["ref"] || "main"),
        status: "running",
        startedAt: "2026-11-12T00:10:00Z",
        jobs: [],
      };
      this.runs.unshift(created);
      return Promise.resolve(created);
    }
    if (route === "POST /api/tests/quarantine") {
      return Promise.resolve({
        testName: String(body?.["testName"] ?? ""),
        reason: String(body?.["reason"] ?? ""),
        ttl: String(body?.["ttl"] ?? "30d"),
        followUpTaskId: "501",
        createdAt: "2026-11-12T00:10:00Z",
        quarantineYaml: `tests:\n  - testName: ${body?.["testName"]}\n    ttl: 30d\n`,
      });
    }
    if (route === "POST /api/actions-cache/flush") {
      return Promise.resolve({ entries: 4, bytes: 1048576 });
    }
    if (route === "POST /api/package-cache/flush") {
      return Promise.resolve({ entries: 12, bytes: 2097152 });
    }
    return Promise.resolve({});
  };

  delete = async (
    route: string,
    params?: Record<string, unknown>,
    body?: unknown,
  ) => {
    this.deleteCalls.push({ route, params, body });
    if (this.deleteError) {
      throw this.deleteError;
    }
    if (route === "DELETE /api/ci/runs/{id}") {
      const id = String(params?.["id"] ?? "");
      const found = this.runs.find((r) => r.id === id);
      if (found) {
        found.status = "completed";
        found.conclusion = "cancelled";
        const r =
          body && typeof body === "object" && "reason" in body
            ? (body as { reason?: unknown }).reason
            : undefined;
        if (typeof r === "string" && r.trim()) {
          found.cancelReason = r.trim();
        }
      }
      return {};
    }
    if (route === "DELETE /api/ci/cache") {
      return { enabled: true, available: true, removed: 7 };
    }
    return {};
  };
}

async function flush(harness: RouterTestingHarness): Promise<void> {
  harness.detectChanges();
  await harness.fixture.whenStable();
  await new Promise((r) => setTimeout(r, 10));
  harness.detectChanges();
  await harness.fixture.whenStable();
}

describe("CIPageComponent (D-26)", () => {
  let api: FakeCIApi;
  let events$: Subject<GrainEvent>;

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      configurable: true,
      writable: true,
    });
    api = new FakeCIApi();
    events$ = new Subject<GrainEvent>();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: "ci", component: CIPageComponent },
            { path: "ci/runs/:id", component: CIPageComponent },
            { path: "task/:id", component: CIPageComponent },
          ],
          withComponentInputBinding(),
        ),
        { provide: GrainApi, useValue: api },
        {
          provide: GrainEvents,
          useValue: { events: () => events$.asObservable() },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("separates shared infrastructure faults (Errored) from isolated code failures (Failed) using FaultRun.runId without cross-source leakage", async () => {
    // Verify pure model guard: grain fault on "main" never taints a GitHub Actions run on "main",
    // nor an unrelated Grain run on "main" whose runId is not in fault.runs.
    const ghaRun = api.runs.find((r) => r.id === "gha:acme:widgets:9001")!;
    expect(faultsForRun(ghaRun, api.faults)).toEqual([]);
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(
      safeExternalUrl("https://github.com/acme/widgets/actions/runs/9001"),
    ).toBe("https://github.com/acme/widgets/actions/runs/9001");

    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    expect(root.querySelectorAll("select").length).toBe(0);

    const banner = root.querySelector('[data-testid="ci-faults-banner"]')!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("1 active fault cluster");
    expect(banner.textContent).toContain("Granule image registry 503");
    expect(banner.textContent).toContain("Assigned fix #88");

    // Select isolated failure run first, then click "Inspect affected runs" on fault card to verify f.runs[0].runId navigation.
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-failed-2"]')!
      .click();
    await flush(harness);

    expect(
      root.querySelector('[data-testid="ci-failed-callout"]')?.textContent,
    ).toContain("Branch code / test failure");
    const logWell = root.querySelector('[data-testid="ci-log-viewer"]')!;
    expect(logWell.textContent).toContain("FAIL: TestCheckoutRace");

    // Only stored === true artifacts render download links.
    const dls = root.querySelectorAll<HTMLAnchorElement>(
      '[data-testid="ci-artifact-download"]',
    );
    expect(dls.length).toBe(1);
    expect(dls[0].getAttribute("href")).toBe(
      "/api/ci/runs/run-failed-2/artifacts/unit/coverage-report",
    );

    // Click Inspect affected runs -> opens run-errored-1 via f.runs[0].runId.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-inspect-runs"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-errored-callout"]')?.textContent,
    ).toContain("Shared deployment / infrastructure fault");
    expect(
      root
        .querySelector('[data-testid="ci-detail-task-link"]')
        ?.getAttribute("href"),
    ).toBe("/task/101");
  });

  it("queries provider=github-actions when switching provider or selecting a repo, renders safe external links, and loads GitHub logs", async () => {
    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Filter to GitHub Actions provider -> queries GET /api/ci/runs?repo=...&provider=github-actions
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-github"]')!
      .click();
    await flush(harness);
    expect(
      api.runListQueries.some(
        (q) =>
          q.includes("provider=github-actions") &&
          q.includes("repo=acme%2Fwidgets"),
      ),
    ).toBe(true);
    expect(root.querySelectorAll(".ci-run-row").length).toBe(1);

    root
      .querySelector<HTMLElement>(
        '[data-testid="ci-run-row-gha:acme:widgets:9001"]',
      )!
      .click();
    await flush(harness);

    const extLink = root.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-external-link"]',
    )!;
    expect(extLink.getAttribute("rel")).toBe("noopener noreferrer");

    // Fetch external GitHub Actions job log
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-fetch-gha-log"]')!
      .click();
    await flush(harness);
    expect(api.logCalls.length).toBeGreaterThan(0);
    expect(
      root.querySelector('[data-testid="ci-log-viewer"]')?.textContent,
    ).toContain("Timed out waiting for selector #app");

    // Switch to All providers and pick Repo: acme/widgets via WAI-ARIA listbox -> merges Grain + GitHub runs!
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-all"]')!
      .click();
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-repo-pill"]')!
      .click();
    await flush(harness);

    const repoOptions = [
      ...root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="ci-repo-menu"] [role="option"]',
      ),
    ];
    expect(repoOptions.length).toBeGreaterThanOrEqual(3);
    repoOptions.find((b) => b.textContent?.includes("acme/widgets"))!.click();
    await flush(harness);
    // 2 Grain runs on acme/widgets + 1 GitHub Actions run on acme/widgets = 3 merged runs
    expect(root.querySelectorAll(".ci-run-row").length).toBe(3);

    // Escape closes open pop-menu
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-repo-pill"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-repo-menu"]')).not.toBeNull();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-repo-menu"]')).toBeNull();
  });

  it("keeps modals outside [inert], enforces repo-scoped RBAC inside dialogs, cancels runs, flushes caches, and quarantines flaky tests", async () => {
    api.configBody = {
      access: {
        role: "grain/repo-ci",
        roles: ["grain/repo-ci"],
        full: false,
        scopes: ["ci:read", "ci:write", "tests:write", "caches:write"],
        repoLimits: {
          "ci:write": ["acme/infra"],
        },
      },
      targetRepos: ["acme/widgets", "acme/infra"],
    };

    const harness = await RouterTestingHarness.create("/ci/runs/run-running-3");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // 1. Cancel active run via cancel dialog with optional reason — verify ci-cancel-dialog is NOT inside [inert]
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-run-btn"]')!
      .click();
    await flush(harness);
    const cancelDlg = root.querySelector('[data-testid="ci-cancel-dialog"]')!;
    expect(cancelDlg).not.toBeNull();
    expect(cancelDlg.closest("[inert]")).toBeNull();
    expect(root.querySelector(".view-panel")?.hasAttribute("inert")).toBe(true);

    const cancelReasonInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="ci-cancel-reason-input"]',
    )!;
    cancelReasonInput.value = "  wrong branch  ";
    cancelReasonInput.dispatchEvent(new Event("input"));
    await flush(harness);

    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-confirm"]')!
      .click();
    await flush(harness);
    expect(api.deleteCalls).toContainEqual({
      route: "DELETE /api/ci/runs/{id}",
      params: { id: "run-running-3" },
      body: { reason: "wrong branch" },
    });
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="ci-cancel-reason"]')?.textContent,
    ).toContain("wrong branch");

    // 2. Trigger manual workflow dialog — verify outside [inert], RBAC repo limit, and Escape dismissal
    const openRunBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-open-run-dialog"]',
    )!;
    openRunBtn.focus();
    openRunBtn.click();
    await flush(harness);
    const runDialog = root.querySelector('[data-testid="ci-run-dialog"]')!;
    expect(runDialog).not.toBeNull();
    expect(runDialog.closest("[inert]")).toBeNull();

    const repoInput = root.querySelector<HTMLInputElement>(
      '[data-testid="ci-run-repo-input"]',
    )!;
    const submitBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-run-submit"]',
    )!;
    // Unauthorized repo acme/widgets disables ci-run-submit
    repoInput.value = "acme/widgets";
    repoInput.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(submitBtn.disabled).toBe(true);

    // Authorized repo acme/infra enables ci-run-submit
    repoInput.value = "acme/infra";
    repoInput.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(submitBtn.disabled).toBe(false);

    const wfOpt = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-wf-opt-.grain/workflows/ci.yml"]',
    )!;
    expect(wfOpt).not.toBeNull();
    wfOpt.click();
    submitBtn.click();
    await flush(harness);
    expect(
      api.postCalls.some(
        (c) =>
          c.route === "POST /api/ci/runs" &&
          (c.body as Record<string, unknown>)?.["workflow"] ===
            ".grain/workflows/ci.yml",
      ),
    ).toBe(true);

    // 3. Flush Actions cache via confirm dialog
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-caches-menu-btn"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-flush-actions-cache"]',
      )!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await flush(harness);
    expect(
      api.postCalls.some((c) => c.route === "POST /api/actions-cache/flush"),
    ).toBe(true);

    // 4. Quarantine flaky test on failed run — verify outside [inert]
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-failed-2"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-open-quarantine-btn"]',
      )!
      .click();
    await flush(harness);
    const qDialog = root.querySelector('[data-testid="ci-quarantine-dialog"]')!;
    expect(qDialog).not.toBeNull();
    expect(qDialog.closest("[inert]")).toBeNull();

    const testInput = root.querySelector<HTMLInputElement>(
      '[data-testid="ci-quarantine-test-input"]',
    )!;
    expect(testInput.value).toBe("TestCheckoutRace");
    const reasonInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="ci-quarantine-reason-input"]',
    )!;
    reasonInput.value = "Flaky timer under load";
    reasonInput.dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-quarantine-submit"]')!
      .click();
    await flush(harness);
    expect(
      api.postCalls.some((c) => c.route === "POST /api/tests/quarantine"),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="ci-quarantine-result"]')?.textContent,
    ).toContain("#501");

    // Capture-phase Escape dismisses quarantine dialog
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-quarantine-dialog"]'),
    ).toBeNull();
  });

  it("cancels CI runs with no reason omitted, aborts on Cancel/Escape, and preserves typed reason on error", async () => {
    const harness = await RouterTestingHarness.create("/ci/runs/run-running-3");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Dismissing with Cancel sends nothing and clears the draft.
    const cancelBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-cancel-run-btn"]',
    )!;
    cancelBtn.click();
    await flush(harness);
    const reasonInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="ci-cancel-reason-input"]',
    )!;
    reasonInput.value = "accidental draft";
    reasonInput.dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-dismiss"]')!
      .click();
    await flush(harness);
    expect(api.deleteCalls).toHaveLength(0);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();

    // Dismissing with Escape also sends nothing.
    cancelBtn.click();
    await flush(harness);
    expect(
      root.querySelector<HTMLTextAreaElement>(
        '[data-testid="ci-cancel-reason-input"]',
      )!.value,
    ).toBe("");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush(harness);
    expect(api.deleteCalls).toHaveLength(0);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();

    // Error keeps the dialog open with the user's typed reason and shows an alert.
    cancelBtn.click();
    await flush(harness);
    const retryInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="ci-cancel-reason-input"]',
    )!;
    retryInput.value = "  superseded by newer push  ";
    retryInput.dispatchEvent(new Event("input"));
    await flush(harness);
    api.deleteError = new Error("transient gateway error");
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-confirm"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-cancel-error"]')?.textContent,
    ).toContain("transient gateway error");
    expect(
      root.querySelector('[data-testid="ci-cancel-dialog"]'),
    ).not.toBeNull();
    expect(
      root.querySelector<HTMLTextAreaElement>(
        '[data-testid="ci-cancel-reason-input"]',
      )!.value,
    ).toBe("  superseded by newer push  ");

    // Dismiss error dialog and verify submitting with blank reason omits payload body.
    api.deleteError = null;
    api.deleteCalls = [];
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-dismiss"]')!
      .click();
    await flush(harness);
    cancelBtn.click();
    await flush(harness);
    const blankInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="ci-cancel-reason-input"]',
    )!;
    blankInput.value = "   ";
    blankInput.dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-confirm"]')!
      .click();
    await flush(harness);
    expect(api.deleteCalls).toEqual([
      {
        route: "DELETE /api/ci/runs/{id}",
        params: { id: "run-running-3" },
        body: undefined,
      },
    ]);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
    expect(root.querySelector('[data-testid="ci-cancel-reason"]')).toBeNull();
  });

  it("serializes and restores provider=github-actions query params on deep links, filter changes, run navigation, and Back/Forward", async () => {
    expect(isActionsRunId("gha:acme:widgets:9001")).toBe(true);
    expect(isActionsRunId("run-1")).toBe(false);
    expect(repoFromActionsRunId("gha:acme:widgets:9001")).toBe("acme/widgets");
    expect(repoFromActionsRunId("gha:bad")).toBe("");
    expect(providerQueryParam("github")).toBe("github-actions");
    expect(providerQueryParam("grain")).toBe("grain");
    expect(providerQueryParam("all")).toBeNull();
    expect(parseProviderQueryParam("github-actions")).toBe("github");
    expect(parseProviderQueryParam("grain")).toBe("grain");
    expect(parseProviderQueryParam("anything-else")).toBe("all");
    expect(runProviderQueryParams("gha:acme:widgets:9001")).toEqual({
      provider: "github-actions",
    });
    expect(runProviderQueryParams("run-1")).toBeNull();

    // 1. Deep-link directly to /ci?provider=github-actions
    const harness = await RouterTestingHarness.create(
      "/ci?provider=github-actions",
    );
    await flush(harness);
    const router = TestBed.inject(Router);
    const root = harness.routeNativeElement!;

    expect(router.url).toBe("/ci?provider=github-actions");
    expect(
      root
        .querySelector('[data-testid="ci-provider-github"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      api.runListQueries.some(
        (q) =>
          q.includes("provider=github-actions") &&
          q.includes("repo=acme%2Fwidgets"),
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="ci-run-row-gha:acme:widgets:9001"]'),
    ).not.toBeNull();

    // 2. Selecting a repo with provider=github-actions preserves both in URL and shows Clear filters when empty
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-repo-pill"]')!
      .click();
    await flush(harness);
    const infraOption = [
      ...root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="ci-repo-menu"] [role="option"]',
      ),
    ].find((b) => b.textContent?.includes("acme/infra"))!;
    infraOption.click();
    await flush(harness);
    expect(router.url).toBe("/ci?provider=github-actions&repo=acme%2Finfra");
    expect(
      root.querySelector('[data-testid="ci-empty"] button')?.textContent,
    ).toContain("Clear filters");

    // Clicking Clear filters removes query params and restores all runs
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-empty"] button')!
      .click();
    await flush(harness);
    expect(router.url).toBe("/ci");

    // 3. Clicking GitHub Actions filter from /ci appends ?provider=github-actions
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-github"]')!
      .click();
    await flush(harness);
    expect(router.url).toBe("/ci?provider=github-actions");

    // Switching back to /ci via Router (Back/Forward simulation) updates filter
    await router.navigateByUrl("/ci");
    await flush(harness);
    expect(
      root
        .querySelector('[data-testid="ci-provider-all"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("preserves and appends provider=github-actions when opening or exiting GitHub Actions runs on /ci/runs/:id", async () => {
    const harness = await RouterTestingHarness.create(
      "/ci/runs/run-failed-2?repo=acme%2Fwidgets",
    );
    await flush(harness);
    const router = TestBed.inject(Router);
    const root = harness.routeNativeElement!;

    // Navigating to a GitHub Actions run from /ci/runs/:id appends provider=github-actions.
    root
      .querySelector<HTMLElement>(
        '[data-testid="ci-run-row-gha:acme:widgets:9001"]',
      )!
      .click();
    await flush(harness);
    expect(router.url).toBe(
      "/ci/runs/gha:acme:widgets:9001?repo=acme%2Fwidgets&provider=github-actions",
    );

    // Exiting mobile detail preserves provider=github-actions and repo in /ci URL.
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      configurable: true,
      writable: true,
    });
    const backBtn = root.querySelector<HTMLButtonElement>(".ci-mobile-back")!;
    backBtn.click();
    await flush(harness);
    expect(router.url).toBe("/ci?repo=acme%2Fwidgets&provider=github-actions");
  });

  it("discovers repository from deep-linked gha: run ID even when config targetRepos is empty", async () => {
    api.configBody = {
      ...api.configBody,
      targetRepos: [],
    };
    const harness = await RouterTestingHarness.create(
      "/ci/runs/gha:acme:widgets:9001",
    );
    await flush(harness);
    expect(harness.routeNativeElement).not.toBeNull();
    expect(
      api.runListQueries.some(
        (q) =>
          q.includes("provider=github-actions") &&
          q.includes("repo=acme%2Fwidgets"),
      ),
    ).toBe(true);
  });

  it("evaluates shared-fault and artifact helper contracts cleanly", () => {
    expect(faultSourceLabel("github")).toBe("GitHub CI");
    expect(faultSourceLabel("grain")).toBe("Grain CI");
    expect(faultSourceLabel(undefined)).toBe("Grain CI");

    expect(faultRunCommit({ commit: "11223344", sha: "deadbeef" })).toBe(
      "11223344",
    );
    expect(faultRunCommit({ sha: "deadbeef" })).toBe("deadbeef");
    expect(faultRunCommit({})).toBe("");

    expect(faultFixWhere({ files: [] })).toBe(
      "touches a file this failure names",
    );
    expect(faultFixWhere({ files: ["pkg/ci/boot.go"] })).toBe(
      "touches pkg/ci/boot.go",
    );
    expect(faultFixWhere({ files: ["a.go", "b.go"] })).toBe(
      "touches 2 of the files this failure names",
    );

    expect(pullRequestExternalUrl("acme/widgets#42")).toBe(
      "https://github.com/acme/widgets/pull/42",
    );
    expect(pullRequestExternalUrl("#42")).toBeNull();
    expect(pullRequestExternalUrl("javascript:alert(1)#42")).toBeNull();

    expect(
      artifactDownloadable("run-1", {
        run: "run-1",
        job: "unit",
        name: "coverage.xml",
        stored: true,
      }),
    ).toBe(true);
    expect(
      artifactDownloadable("gha:acme:widgets:9001", {
        run: "gha:acme:widgets:9001",
        job: "e2e",
        name: "playwright-report",
        stored: true,
      }),
    ).toBe(false);
    expect(
      artifactDownloadable("run-1", {
        run: "run-1",
        job: "",
        name: "missing-job",
        stored: true,
      }),
    ).toBe(false);

    const merged = mergeRunArtifacts(
      [
        {
          run: "run-1",
          job: "unit",
          name: "coverage-report",
          stored: true,
          bytes: 2048,
        },
      ],
      [
        {
          jobId: "unit",
          name: "Unit",
          artifacts: [
            {
              run: "run-1",
              job: "unit",
              name: "coverage-report",
              stored: false,
              note: "kept until next run",
            },
            {
              run: "run-1",
              job: "",
              name: "expired-trace",
              stored: false,
              note: "evicted after 7d",
            },
          ],
        },
      ],
      "run-1",
    );
    expect(merged.length).toBe(2);
    expect(merged[0]).toMatchObject({
      job: "unit",
      name: "coverage-report",
      stored: true,
      note: "kept until next run",
    });
    expect(merged[1]).toMatchObject({
      job: "unit",
      name: "expired-trace",
      stored: false,
      note: "evicted after 7d",
    });

    const faultBackedFailure: CIRun = {
      id: "run-shared-fail",
      provider: "grain",
      repo: "acme/widgets",
      conclusion: "failure",
      finishedAt: "2026-11-12T00:05:00Z",
    };
    expect(
      runBucket(faultBackedFailure, [
        {
          source: "grain",
          digest: "d1",
          repo: "acme/widgets",
          jobName: "Unit",
          runs: [{ runId: "run-shared-fail" }],
        },
      ]),
    ).toBe("errored");
  });

  it("displays shared-fault runIds, metadata, PR links, and navigates between affected runs", async () => {
    api.runs.push({
      id: "run-errored-2",
      provider: "grain",
      repo: "acme/widgets",
      ref: "refs/heads/grain/task-109",
      commit: "eee555566667777",
      event: "push",
      requestedBy: "109",
      conclusion: "errored",
      error: "sandbox boot failed: granule image pull timeout",
      startedAt: "2026-11-12T00:06:00Z",
      finishedAt: "2026-11-12T00:07:15Z",
      jobs: [
        {
          jobId: "test",
          name: "Unit tests",
          workflow: "CI",
          conclusion: "errored",
          steps: [],
        },
      ],
    });
    api.faults = [
      {
        ...api.faults[0],
        paths: ["deploy/helm/values.yaml", "pkg/sandbox/boot.go"],
        ownerRef: "grain/fix-88",
        fixes: [
          {
            pullRequest: "acme/widgets#42",
            task: "88",
            title: "Retry granule registry pulls",
            files: ["pkg/sandbox/boot.go"],
          },
        ],
        runs: [
          {
            runId: "run-errored-1",
            ref: "grain/task-101",
            taskId: "101",
            commit: "aaa111122223333",
          },
          {
            runId: "run-errored-2",
            ref: "grain/task-109",
            taskId: "109",
            commit: "eee555566667777",
          },
        ],
      },
    ];

    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const router = TestBed.inject(Router);
    const root = harness.routeNativeElement!;

    expect(
      root.querySelector('[data-testid="ci-fault-source-grain"]')?.textContent,
    ).toContain("Grain CI");
    expect(
      root.querySelector('[data-testid="ci-fault-paths"]')?.textContent,
    ).toContain("pkg/sandbox/boot.go");
    expect(
      root.querySelector('[data-testid="ci-fault-owner"]')?.textContent,
    ).toContain("grain/fix-88");

    const prLink = root.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-fault-card"] a[target="_blank"]',
    )!;
    expect(prLink.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/42",
    );
    expect(prLink.getAttribute("rel")).toBe("noopener noreferrer");

    const run1Link = root.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-fault-run-link-run-errored-1"]',
    )!;
    const run2Link = root.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-fault-run-link-run-errored-2"]',
    )!;
    expect(run1Link.textContent?.trim()).toBe("run-errored-1");
    expect(run2Link.textContent?.trim()).toBe("run-errored-2");
    expect(
      root
        .querySelector('[data-testid="ci-fault-run-task-run-errored-2"]')
        ?.getAttribute("href"),
    ).toBe("/task/109");

    run2Link.click();
    await flush(harness);
    expect(router.url).toBe("/ci/runs/run-errored-2");
    const detailRoot = harness.routeNativeElement!;
    expect(
      detailRoot.querySelector('[data-testid="ci-detail-run-id"]')?.textContent,
    ).toContain("run-errored-2");

    const calloutRuns = detailRoot.querySelector(
      '[data-testid="ci-errored-callout-runs"]',
    )!;
    expect(calloutRuns.textContent).toContain("run-errored-1");
    detailRoot
      .querySelector<HTMLAnchorElement>(
        '[data-testid="ci-callout-run-link-run-errored-1"]',
      )!
      .click();
    await flush(harness);
    expect(router.url).toBe("/ci/runs/run-errored-1");
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-detail-run-id"]',
      )?.textContent,
    ).toContain("run-errored-1");
  });

  it("toggles inline fault artifact inspection with stored downloads, unstored notes, pagination, errors, and GitHub fault runId resolution", async () => {
    api.faults = [
      {
        ...api.faults[0],
        runs: [
          { runId: "run-errored-1", ref: "grain/task-101", taskId: "101" },
          { runId: "run-errored-err", ref: "grain/task-108", taskId: "108" },
        ],
      },
      {
        source: "github",
        digest: "gha-fault-1",
        repo: "acme/widgets",
        jobName: "Playwright E2E",
        step: "npx playwright test",
        kind: "errored",
        runs: [
          {
            runId: "9001",
            ref: "main",
            commit: "ddd444455556666",
          },
        ],
      },
    ];
    api.artifactResponder = async (id, query) => {
      if (query?.includes("cursor=c-2")) {
        return {
          enabled: true,
          available: true,
          total: 2,
          artifacts: [
            {
              run: id,
              job: "test",
              name: "old-core.dmp",
              stored: false,
              bytes: 512,
              note: "expired under retention policy",
            },
          ],
        };
      }
      return {
        enabled: true,
        available: true,
        total: 2,
        truncated: true,
        nextCursor: "c-2",
        artifacts: [
          {
            run: id,
            job: "test",
            name: "boot-log.txt",
            stored: true,
            bytes: 4096,
          },
        ],
      };
    };
    api.artifactErrorByRun["run-errored-err"] = "artifact index unavailable";

    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const router = TestBed.inject(Router);
    const root = harness.routeNativeElement!;

    const artBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-fault-run-artifacts-btn-run-errored-1"]',
    )!;
    expect(artBtn.getAttribute("aria-expanded")).toBe("false");
    artBtn.click();
    await flush(harness);

    expect(artBtn.getAttribute("aria-expanded")).toBe("true");
    expect(
      api.artifactCalls.some((c) => c.id === "run-errored-1" && !c.query),
    ).toBe(true);
    const panel = root.querySelector(
      '[data-testid="ci-fault-run-artifacts-run-errored-1"]',
    )!;
    const dl = panel.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-fault-artifact-download-run-errored-1-boot-log.txt"]',
    )!;
    expect(dl.getAttribute("href")).toBe(
      "/api/ci/runs/run-errored-1/artifacts/test/boot-log.txt",
    );

    const loadMoreBtn = panel.querySelector<HTMLButtonElement>("button")!;
    loadMoreBtn.click();
    await flush(harness);
    expect(
      api.artifactCalls.some(
        (c) => c.id === "run-errored-1" && c.query?.includes("cursor=c-2"),
      ),
    ).toBe(true);
    expect(panel.textContent).toContain("old-core.dmp");
    expect(panel.textContent).toContain("expired under retention policy");

    // Collapsing toggles aria-expanded back to false.
    artBtn.click();
    await flush(harness);
    expect(artBtn.getAttribute("aria-expanded")).toBe("false");
    expect(
      root.querySelector(
        '[data-testid="ci-fault-run-artifacts-run-errored-1"]',
      ),
    ).toBeNull();

    // Error state inside fault artifact inspection renders alert cleanly.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-run-artifacts-btn-run-errored-err"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector(
        '[data-testid="ci-fault-run-artifacts-run-errored-err"]',
      )?.textContent,
    ).toContain("artifact index unavailable");

    // Switch to GitHub provider so GitHub Actions runs are loaded, then verify runId 9001 resolves to gha:.
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-github"]')!
      .click();
    await flush(harness);

    const ghLink = root.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-fault-run-link-9001"]',
    )!;
    expect(ghLink.textContent?.trim()).toBe("9001");
    ghLink.click();
    await flush(harness);
    expect(router.url).toBe(
      "/ci/runs/gha:acme:widgets:9001?provider=github-actions",
    );
  });

  it("renders merged job-level artifacts inline above steps and handles disabled, unavailable, and GitHub Actions artifact contracts", async () => {
    const failedRun = api.runs.find((r) => r.id === "run-failed-2")!;
    failedRun.jobs[0].artifacts = [
      {
        run: "run-failed-2",
        job: "unit",
        name: "coverage-report",
        stored: false,
        note: "mirrored from runner",
      },
      {
        run: "run-failed-2",
        job: "",
        name: "evicted-heap.prof",
        stored: false,
        bytes: 8192,
        note: "evicted after 7d",
      },
    ];

    const harness = await RouterTestingHarness.create("/ci/runs/run-failed-2");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Job-level artifacts render inline inside expanded unit job without duplicating stored artifacts.
    const jobArts = root.querySelector('[data-testid="ci-job-artifacts"]')!;
    expect(jobArts).not.toBeNull();
    expect(jobArts.textContent).toContain("coverage-report");
    expect(jobArts.textContent).toContain("mirrored from runner");
    expect(jobArts.textContent).toContain("evicted-heap.prof");
    expect(jobArts.textContent).toContain("evicted after 7d");
    const jobDl = jobArts.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-job-artifact-download"]',
    )!;
    expect(jobDl.getAttribute("href")).toBe(
      "/api/ci/runs/run-failed-2/artifacts/unit/coverage-report",
    );
    // Detail artifacts section retains 1 download link and deduplicated list.
    expect(
      root.querySelectorAll('[data-testid="ci-artifact-row"]').length,
    ).toBe(3);

    // GitHub Actions run renders external link and omits empty "job " label.
    api.artifactResponsesByRun["gha:acme:widgets:9001"] = {
      enabled: true,
      available: true,
      total: 1,
      artifacts: [
        {
          run: "gha:acme:widgets:9001",
          job: "",
          name: "playwright-report",
          stored: false,
          bytes: 65536,
          note: "hosted on GitHub Actions",
        },
      ],
    };
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-github"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLElement>(
        '[data-testid="ci-run-row-gha:acme:widgets:9001"]',
      )!
      .click();
    await flush(harness);
    const ghaSec = root.querySelector('[data-testid="ci-artifacts-section"]')!;
    expect(ghaSec.textContent).toContain("playwright-report");
    expect(ghaSec.textContent).not.toContain("job ");
    const ghaExt = ghaSec.querySelector<HTMLAnchorElement>(
      '[data-testid="ci-artifact-external"]',
    )!;
    expect(ghaExt.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/actions/runs/9001",
    );

    // Switch back to All providers to verify Grain CI disabled / unavailable artifact states.
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-all"]')!
      .click();
    await flush(harness);

    api.artifactResponsesByRun["run-errored-1"] = {
      enabled: false,
      available: false,
      artifacts: [],
      total: 0,
    };
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-errored-1"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-artifacts-disabled"]'),
    ).not.toBeNull();

    api.artifactResponsesByRun["run-running-3"] = {
      enabled: true,
      available: false,
      artifacts: [],
      total: 0,
    };
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-running-3"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-artifacts-unavailable"]'),
    ).not.toBeNull();
  });

  it("gates fault and detail artifact fetches behind repo-scoped ci:read RBAC", async () => {
    api.configBody = {
      ...api.configBody,
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["ci:read"],
        repoLimits: { "ci:read": ["acme/infra"] },
      },
    };

    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Inline fault artifact toggle for acme/widgets must not hit GET /artifacts.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-run-artifacts-btn-run-errored-1"]',
      )!
      .click();
    await flush(harness);
    expect(api.artifactCalls.length).toBe(0);
    expect(
      root.querySelector('[data-testid="ci-fault-art-denied-run-errored-1"]'),
    ).not.toBeNull();

    // Selecting seeded run-errored-1 (acme/widgets) renders ci-artifacts-denied without calling API.
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-errored-1"]')!
      .click();
    await flush(harness);
    expect(api.artifactCalls.length).toBe(0);
    expect(
      root.querySelector('[data-testid="ci-artifacts-denied"]'),
    ).not.toBeNull();
  });
});
