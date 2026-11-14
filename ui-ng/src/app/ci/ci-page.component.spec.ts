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

import fs from "node:fs";
import path from "node:path";
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
import { AccessService } from "../services/access.service";
import { CIPageComponent } from "./ci-page.component";
import {
  type CIFault,
  type CIRun,
  type CIRunArtifact,
  type CIRunLogResponse,
  type CIWorkflowOption,
  actionsRunRepo,
  canDownloadArtifact,
  ciRunQueryParams,
  faultsForRun,
  formatArtifactTime,
  mergeRunArtifacts,
  parseProviderQueryParam,
  providerQueryParam,
  pullRequestLink,
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
  logCalls: { id: string; query?: string }[] = [];
  artifactCalls: { id: string; query?: string }[] = [];
  artifactsResponseByRun: Record<
    string,
    {
      enabled?: boolean;
      available?: boolean;
      artifacts?: CIRunArtifact[];
      total?: number;
      truncated?: boolean;
      nextCursor?: string;
    }
  > = {};

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

  get = (route: string, params?: Record<string, unknown>, query?: string) => {
    if (route === "GET /api/ci/runs/{id}") {
      const id = String(params?.["id"] ?? "");
      const found = this.runs.find((r) => r.id === id);
      return Promise.resolve(structuredClone(found ?? this.runs[0]));
    }
    if (route === "GET /api/ci/runs/{id}/artifacts") {
      const id = String(params?.["id"] ?? "");
      this.artifactCalls.push({ id, query });
      const override = this.artifactsResponseByRun[id];
      if (override) {
        return Promise.resolve(structuredClone(override));
      }
      const list = this.artifactsByRun[id] ?? [];
      return Promise.resolve({
        enabled: true,
        available: true,
        artifacts: structuredClone(list),
        total: list.length,
      });
    }
    if (route === "GET /api/ci/runs/{id}/log") {
      this.logCalls.push({ id: String(params?.["id"] ?? ""), query });
      return Promise.resolve(structuredClone(this.ghaLog));
    }
    if (route === "GET /api/ci/workflows") {
      return Promise.resolve({
        workflows: structuredClone(this.workflows),
        total: this.workflows.length,
      });
    }
    return Promise.resolve({});
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

  delete = (
    route: string,
    params?: Record<string, unknown>,
    body?: unknown,
  ) => {
    this.deleteCalls.push({ route, params, body });
    if (route === "DELETE /api/ci/runs/{id}") {
      const id = String(params?.["id"] ?? "");
      const found = this.runs.find((r) => r.id === id);
      if (found) {
        found.status = "completed";
        found.conclusion = "cancelled";
        const reason = (body as { reason?: string } | undefined)?.reason;
        if (reason) found.cancelReason = reason;
      }
      return Promise.resolve({});
    }
    if (route === "DELETE /api/ci/cache") {
      return Promise.resolve({ enabled: true, available: true, removed: 7 });
    }
    return Promise.resolve({});
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

    // 1. Cancel active run via cancel dialog with optional reason — verify dialog is NOT inside [inert]
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
    cancelReasonInput.value = "  Superseded by newer push  ";
    cancelReasonInput.dispatchEvent(new Event("input"));
    await flush(harness);

    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-submit"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
    expect(root.querySelector(".view-panel")?.hasAttribute("inert")).toBe(
      false,
    );
    expect(api.deleteCalls).toContainEqual({
      route: "DELETE /api/ci/runs/{id}",
      params: { id: "run-running-3" },
      body: { reason: "Superseded by newer push" },
    });
    expect(
      root.querySelector('[data-testid="ci-cancel-reason"]')?.textContent,
    ).toContain("Superseded by newer push");

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

  it("supports dismissing cancel dialog, resetting draft reason, optional empty reason, and error reporting", async () => {
    const harness = await RouterTestingHarness.create("/ci/runs/run-running-3");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Dismiss with Cancel button sends nothing and resets draft on reopen
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-run-btn"]')!
      .click();
    await flush(harness);
    const reasonEl = () =>
      root.querySelector<HTMLTextAreaElement>(
        '[data-testid="ci-cancel-reason-input"]',
      )!;
    reasonEl().value = "aborted note";
    reasonEl().dispatchEvent(new Event("input"));
    await flush(harness);

    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-dismiss"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
    expect(api.deleteCalls).toEqual([]);

    // Reopen -> draft reason is cleared; Escape dismisses without DELETE
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-run-btn"]')!
      .click();
    await flush(harness);
    expect(reasonEl().value).toBe("");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
    expect(api.deleteCalls).toEqual([]);

    // Error during DELETE disables buttons in-flight, closes modal on failure, and surfaces ci-action-error
    const origDelete = api.delete;
    let rejectDelete!: (err: Error) => void;
    api.delete = () =>
      new Promise<unknown>((_, reject) => {
        rejectDelete = reject;
      });
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-run-btn"]')!
      .click();
    await flush(harness);
    reasonEl().value = "too late";
    reasonEl().dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-submit"]')!
      .click();
    harness.detectChanges();
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="ci-cancel-submit"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="ci-cancel-submit"]')!
        .textContent,
    ).toContain("Cancelling");
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="ci-cancel-dismiss"]',
      )!.disabled,
    ).toBe(true);

    rejectDelete(new Error('no CI run "run-running-3" is still going'));
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
    expect(root.querySelector(".view-panel")?.hasAttribute("inert")).toBe(
      false,
    );
    expect(
      root.querySelector('[data-testid="ci-action-error"]')?.textContent,
    ).toContain("no CI run");
    api.delete = origDelete;

    // Submit with blank/whitespace reason -> DELETE sent with undefined body
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-run-btn"]')!
      .click();
    await flush(harness);
    reasonEl().value = "   ";
    reasonEl().dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-cancel-submit"]')!
      .click();
    await flush(harness);
    expect(api.deleteCalls).toContainEqual({
      route: "DELETE /api/ci/runs/{id}",
      params: { id: "run-running-3" },
      body: undefined,
    });
  });

  it("serializes and restores provider=github-actions query params when filtering and navigating to GitHub Actions runs", async () => {
    expect(actionsRunRepo("gha:acme:widgets:9001")).toBe("acme/widgets");
    expect(actionsRunRepo("gha:acme/widgets:9001")).toBe("acme/widgets");
    expect(actionsRunRepo("run-failed-2")).toBe("");
    expect(providerQueryParam("github")).toBe("github-actions");
    expect(providerQueryParam("grain")).toBe("grain");
    expect(providerQueryParam("all")).toBeNull();
    expect(parseProviderQueryParam("github-actions")).toBe("github");
    expect(parseProviderQueryParam("grain")).toBe("grain");
    expect(parseProviderQueryParam(null)).toBe("all");
    expect(ciRunQueryParams("gha:acme:widgets:9001")).toEqual({
      provider: "github-actions",
    });
    expect(ciRunQueryParams("run-failed-2")).toBeNull();
    expect(ciRunQueryParams("run-failed-2", "github-actions")).toEqual({
      provider: "github-actions",
    });
    expect(
      ciRunQueryParams(
        { id: "run-failed-2", provider: "grain" },
        "github-actions",
      ),
    ).toBeNull();
    expect(ciRunQueryParams({ id: "run-failed-2" }, "github-actions")).toEqual({
      provider: "github-actions",
    });

    // 1. Deep-linking to /ci?provider=github-actions initializes the GitHub Actions filter & fetches GHA runs immediately.
    const harness = await RouterTestingHarness.create(
      "/ci?provider=github-actions&repo=acme%2Fwidgets",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;
    const router = TestBed.inject(Router);

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
    expect(root.querySelectorAll(".ci-run-row").length).toBe(1);

    // 2. Switching provider updates the URL query param (clears provider=github-actions on All providers, re-adds on GitHub Actions).
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-all"]')!
      .click();
    await flush(harness);
    expect(router.parseUrl(router.url).queryParams["provider"]).toBeUndefined();
    expect(router.parseUrl(router.url).queryParams["repo"]).toBe(
      "acme/widgets",
    );

    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-provider-github"]')!
      .click();
    await flush(harness);
    expect(router.parseUrl(router.url).queryParams["provider"]).toBe(
      "github-actions",
    );
  });

  it("preserves and appends provider=github-actions when opening GitHub Actions runs and returning to /ci", async () => {
    api.configBody = {
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const harness = await RouterTestingHarness.create("/ci/runs/run-errored-1");
    await flush(harness);
    const router = TestBed.inject(Router);

    // Select repo acme/widgets under All providers so both Grain and GitHub Actions runs appear.
    let root = harness.routeNativeElement!;
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-repo-pill"]')!
      .click();
    await flush(harness);
    const opts = [
      ...root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="ci-repo-menu"] [role="option"]',
      ),
    ];
    opts.find((b) => b.textContent?.includes("acme/widgets"))!.click();
    await flush(harness);

    // Clicking a GitHub Actions run navigates to /ci/runs/<id>?provider=github-actions.
    root
      .querySelector<HTMLElement>(
        '[data-testid="ci-run-row-gha:acme:widgets:9001"]',
      )!
      .click();
    await flush(harness);
    const parsedRunUrl = router.parseUrl(router.url);
    expect(
      parsedRunUrl.root.children["primary"]?.segments.map((s) => s.path),
    ).toEqual(["ci", "runs", "gha:acme:widgets:9001"]);
    expect(parsedRunUrl.queryParams["provider"]).toBe("github-actions");
    expect(parsedRunUrl.queryParams["repo"]).toBe("acme/widgets");

    // Returning to /ci preserves ?provider=github-actions & repo filter.
    root = harness.routeNativeElement!;
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-mobile-back"]')!
      .click();
    await flush(harness);
    const parsedBackUrl = router.parseUrl(router.url);
    expect(
      parsedBackUrl.root.children["primary"]?.segments.map((s) => s.path),
    ).toEqual(["ci"]);
    expect(parsedBackUrl.queryParams["provider"]).toBe("github-actions");
    expect(parsedBackUrl.queryParams["repo"]).toBe("acme/widgets");
  });

  it("extracts repo from gha: selected run id to query GET /api/ci/runs with provider=github-actions even without targetRepos", async () => {
    api.configBody = {
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
      targetRepos: [],
    };
    const harness = await RouterTestingHarness.create(
      "/ci/runs/gha:acme:widgets:9001?provider=github-actions",
    );
    await flush(harness);

    expect(
      api.runListQueries.some(
        (q) =>
          q.includes("provider=github-actions") &&
          q.includes("repo=acme%2Fwidgets"),
      ),
    ).toBe(true);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-detail-title"]',
      )?.textContent,
    ).toContain("GitHub E2E");
  });

  it("fetches GHA runs from selected gha: run repo even under All providers with empty targetRepos", async () => {
    api.configBody = {
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
      targetRepos: [],
    };
    const harness = await RouterTestingHarness.create(
      "/ci/runs/gha:acme:widgets:9001",
    );
    await flush(harness);

    expect(
      api.runListQueries.some(
        (q) =>
          q.includes("provider=github-actions") &&
          q.includes("repo=acme%2Fwidgets"),
      ),
    ).toBe(true);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-run-row-gha:acme:widgets:9001"]',
      ),
    ).not.toBeNull();
  });

  it("displays exact shared-fault runIds, opens specific fault runs past active filters, and inspects artifacts inline via GET /api/ci/runs/{id}/artifacts", async () => {
    expect(pullRequestLink("acme/widgets#26")).toBe(
      "https://github.com/acme/widgets/pull/26",
    );
    expect(pullRequestLink("grain/config#6")).toBeNull();
    expect(pullRequestLink("javascript:alert(1)")).toBeNull();
    expect(formatArtifactTime("2026-11-12T03:04:00Z")).toBe(
      "2026-11-12 03:04 UTC",
    );

    const siblingRun: CIRun = {
      id: "run-errored-sibling",
      provider: "grain",
      repo: "acme/widgets",
      ref: "refs/heads/grain/task-99",
      commit: "999888777666",
      event: "push",
      requestedBy: "99",
      conclusion: "errored",
      error: "sandbox boot failed: granule image pull timeout",
      startedAt: "2026-11-11T23:50:00Z",
      finishedAt: "2026-11-11T23:51:00Z",
      jobs: [
        {
          jobId: "test",
          name: "Unit tests",
          workflow: "CI",
          conclusion: "errored",
          steps: [],
        },
      ],
    };
    // Add siblingRun to detail lookup (not in initial runs list!) to prove pinned navigation works even for older fault runs.
    const origGet = api.get.bind(api);
    api.get = (
      route: string,
      params?: Record<string, unknown>,
      query?: string,
    ) => {
      if (
        route === "GET /api/ci/runs/{id}" &&
        params?.["id"] === "run-errored-sibling"
      ) {
        return Promise.resolve(structuredClone(siblingRun));
      }
      return origGet(route, params, query);
    };

    api.faults = [
      {
        source: "grain",
        digest: "fault-granule-pull",
        repo: "acme/widgets",
        jobId: "test",
        jobName: "Unit tests",
        step: "Setup sandbox",
        kind: "errored",
        paths: ["scripts/granule/guest-inputs.sh"],
        runCount: 2,
        refCount: 2,
        ownerTaskId: "88",
        ownerRef: "grain/task-88",
        fixes: [
          {
            pullRequest: "acme/widgets#26",
            files: ["scripts/granule/guest-inputs.sh"],
          },
        ],
        runs: [
          {
            runId: "run-errored-1",
            ref: "refs/heads/grain/task-101",
            taskId: "101",
            commit: "aaa111122223333",
          },
          {
            runId: "run-errored-sibling",
            ref: "refs/heads/grain/task-99",
            taskId: "99",
            commit: "999888777666",
          },
        ],
      },
    ];
    api.artifactsByRun["run-errored-sibling"] = [
      {
        run: "run-errored-sibling",
        job: "test",
        name: "granule-boot-log",
        stored: true,
        bytes: 4096,
        collectedAt: "2026-11-11T23:51:05Z",
      },
      {
        run: "run-errored-sibling",
        job: "test",
        name: "core-dumps",
        stored: false,
        note: "280.0MB is over the 32.0MB a single artifact may be",
      },
    ];

    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // 1. Shared fault card displays source, common files, fix PR link, and exact runIds.
    const card = root.querySelector('[data-testid="ci-fault-card"]')!;
    expect(card.textContent).toContain("Grain CI");
    expect(card.textContent).toContain("Unit tests › Setup sandbox");
    expect(card.textContent).toContain("scripts/granule/guest-inputs.sh");
    expect(card.textContent).toContain("Fix PR acme/widgets#26");
    const faultRunIds = [
      ...card.querySelectorAll('[data-testid="ci-fault-run-id"]'),
    ].map((el) => el.textContent?.trim());
    expect(faultRunIds).toEqual(["run-errored-1", "run-errored-sibling"]);

    // 2. Inspect artifacts inline on the fault card via GET /api/ci/runs/{id}/artifacts.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-artifacts-btn-run-errored-sibling"]',
      )!
      .click();
    await flush(harness);
    expect(api.artifactCalls.some((c) => c.id === "run-errored-sibling")).toBe(
      true,
    );
    const inlineArtPanel = root.querySelector(
      '[data-testid="ci-fault-artifacts-run-errored-sibling"]',
    )!;
    expect(inlineArtPanel.textContent).toContain("granule-boot-log");
    expect(inlineArtPanel.textContent).toContain("job test");
    expect(inlineArtPanel.textContent).toContain("4.0 KiB");
    expect(inlineArtPanel.textContent).toContain("2026-11-11 23:51 UTC");
    expect(inlineArtPanel.textContent).toContain("280.0MB is over the 32.0MB");
    const dlLinks = inlineArtPanel.querySelectorAll<HTMLAnchorElement>(
      '[data-testid="ci-fault-artifact-download"]',
    );
    expect(dlLinks.length).toBe(1);
    expect(dlLinks[0].getAttribute("href")).toBe(
      "/api/ci/runs/run-errored-sibling/artifacts/test/granule-boot-log",
    );
    expect(
      inlineArtPanel.querySelector(
        '[data-testid="ci-fault-artifact-not-stored"]',
      ),
    ).not.toBeNull();

    // 3. Even while filtered to "Failed", clicking a specific fault runId opens and pins that runId in the inspector.
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-filter-failed"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-open-run-run-errored-sibling"]',
      )!
      .click();
    await flush(harness);
    expect(
      root
        .querySelector('[data-testid="ci-detail-run-id"]')
        ?.textContent?.trim(),
    ).toBe("run-errored-sibling");
    expect(
      root
        .querySelector('[data-testid="ci-detail-permalink"]')
        ?.getAttribute("href"),
    ).toBe("/ci/runs/run-errored-sibling");

    // 4. The errored callout inside the inspector also lists every affected runId and supports inline artifact inspection.
    const calloutIds = [
      ...root.querySelectorAll('[data-testid="ci-callout-fault-run-id"]'),
    ].map((el) => el.textContent?.trim());
    expect(calloutIds).toEqual(["run-errored-1", "run-errored-sibling"]);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-callout-artifacts-btn-run-errored-1"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-callout-artifacts-run-errored-1"]')
        ?.textContent,
    ).toContain("No stored artifacts for this run.");
  });

  it("caps shared fault run lists past 5 entries behind Show all and expands on click", async () => {
    api.faults = [
      {
        source: "grain",
        digest: "fault-many-runs",
        repo: "acme/widgets",
        jobId: "test",
        jobName: "Unit tests",
        kind: "errored",
        runs: Array.from({ length: 7 }, (_, i) => ({
          runId: `run-cluster-${i + 1}`,
          ref: `grain/task-${200 + i}`,
        })),
        refs: Array.from({ length: 7 }, (_, i) => `grain/task-${200 + i}`),
      },
    ];
    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    expect(
      root.querySelectorAll('[data-testid="ci-fault-run-id"]').length,
    ).toBe(5);
    const toggleBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-fault-toggle-all-runs"]',
    )!;
    expect(toggleBtn.textContent).toContain("Show all 7 runs");
    toggleBtn.click();
    await flush(harness);
    expect(
      root.querySelectorAll('[data-testid="ci-fault-run-id"]').length,
    ).toBe(7);
  });

  it("merges GET /api/ci/runs/{id}/artifacts with unstored job.artifacts notes, renders inline job artifacts, paginates, and retries errors", async () => {
    expect(
      mergeRunArtifacts(
        "r1",
        [{ run: "r1", job: "unit", name: "cov", stored: true, bytes: 100 }],
        [
          {
            jobId: "unit",
            name: "Unit",
            artifacts: [
              { job: "unit", name: "cov", stored: false, note: "stale" },
              {
                job: "unit",
                name: "oversize-dump",
                stored: false,
                note: "over limit",
              },
            ],
          },
        ],
      ).map((a) => `${a.name}:${a.stored}`),
    ).toEqual(["cov:true", "oversize-dump:false"]);
    expect(
      canDownloadArtifact("gha:acme:widgets:9001", {
        run: "gha:acme:widgets:9001",
        job: "",
        name: "dist",
        stored: true,
      }),
    ).toBe(false);
    expect(
      canDownloadArtifact(
        "run-1",
        { run: "run-1", job: "unit", name: "cov", stored: true },
        "grain",
        true,
      ),
    ).toBe(true);

    const failedRun = api.runs.find((r) => r.id === "run-failed-2")!;
    failedRun.jobs![0].artifacts = [
      {
        run: "run-failed-2",
        job: "unit",
        name: "core-dumps",
        stored: false,
        note: "280.0MB is over the 32.0MB a single artifact may be",
      },
    ];
    api.artifactsResponseByRun["run-failed-2"] = {
      enabled: true,
      available: true,
      artifacts: [
        {
          run: "run-failed-2",
          job: "unit",
          name: "coverage-report",
          stored: true,
          bytes: 24576,
        },
      ],
      total: 2,
      truncated: true,
      nextCursor: "page-2",
    };

    const origGet = api.get.bind(api);
    let failArt = false;
    api.get = (
      route: string,
      params?: Record<string, unknown>,
      query?: string,
    ) => {
      if (
        route === "GET /api/ci/runs/{id}/artifacts" &&
        params?.["id"] === "run-failed-2"
      ) {
        api.artifactCalls.push({ id: "run-failed-2", query });
        if (failArt) {
          return Promise.reject(new Error("artifact directory unreadable"));
        }
        if (query?.includes("cursor=page-2")) {
          return Promise.resolve({
            enabled: true,
            available: true,
            artifacts: [
              {
                run: "run-failed-2",
                job: "unit",
                name: "extra-trace",
                stored: true,
                bytes: 512,
              },
            ],
            total: 2,
            truncated: false,
          });
        }
      }
      return origGet(route, params, query);
    };

    const harness = await RouterTestingHarness.create("/ci/runs/run-failed-2");
    await flush(harness);
    const root = harness.routeNativeElement!;

    const jobArts = root.querySelector('[data-testid="ci-job-artifacts"]')!;
    expect(jobArts.textContent).toContain("coverage-report");
    expect(jobArts.textContent).toContain("core-dumps");
    expect(
      jobArts
        .querySelector('[data-testid="ci-job-artifact-download"]')
        ?.getAttribute("href"),
    ).toBe("/api/ci/runs/run-failed-2/artifacts/unit/coverage-report");

    const artSection = root.querySelector(
      '[data-testid="ci-artifacts-section"]',
    )!;
    expect(artSection.textContent).toContain("coverage-report");
    expect(artSection.textContent).toContain("core-dumps");

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-artifact-load-more"]',
      )!
      .click();
    await flush(harness);
    expect(artSection.textContent).toContain("extra-trace");

    // Verify error + Retry on reload via switching away and back
    failArt = true;
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-errored-1"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-failed-2"]')!
      .click();
    await flush(harness);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-artifact-error"]',
      )?.textContent,
    ).toContain("artifact directory unreadable");
    failArt = false;
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>(
        '[data-testid="ci-artifact-retry"]',
      )!
      .click();
    await flush(harness);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-artifact-error"]',
      ),
    ).toBeNull();
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-artifacts-section"]',
      )?.textContent,
    ).toContain("coverage-report");
  });

  it("renders GitHub Actions artifacts without empty job labels or broken download links", async () => {
    api.artifactsResponseByRun["gha:acme:widgets:9001"] = {
      enabled: true,
      available: true,
      artifacts: [
        {
          run: "gha:acme:widgets:9001",
          job: "",
          name: "playwright-report",
          stored: false,
          bytes: 8192,
          note: "a GitHub Actions artifact is listed only: grain does not download it",
        },
      ],
      total: 1,
    };
    const harness = await RouterTestingHarness.create(
      "/ci/runs/gha:acme:widgets:9001?provider=github-actions",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;
    const artSection = root.querySelector(
      '[data-testid="ci-artifacts-section"]',
    )!;
    expect(artSection.textContent).toContain("playwright-report");
    expect(artSection.textContent).not.toContain("· job");
    expect(
      artSection.querySelector('[data-testid="ci-artifact-download"]'),
    ).toBeNull();
    expect(
      artSection
        .querySelector('[data-testid="ci-artifact-external"]')
        ?.getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/actions/runs/9001");
  });

  it("distinguishes deployment unavailable artifacts from CI-disabled state", async () => {
    api.artifactsResponseByRun["run-errored-1"] = {
      enabled: true,
      available: false,
      artifacts: [],
      total: 0,
    };
    api.artifactsResponseByRun["run-running-3"] = {
      enabled: false,
      available: false,
      artifacts: [],
      total: 0,
    };
    const harness = await RouterTestingHarness.create("/ci/runs/run-errored-1");
    await flush(harness);
    const root = harness.routeNativeElement!;
    expect(
      root.querySelector('[data-testid="ci-artifact-unavailable"]')
        ?.textContent,
    ).toContain("does not keep CI artifacts");

    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-running-3"]')!
      .click();
    await flush(harness);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="ci-artifact-unavailable"]',
      )?.textContent,
    ).toContain("CI is not enabled");
  });

  it("ignores stale out-of-order artifact responses when rapidly switching runs", async () => {
    const origGet = api.get.bind(api);
    let resolveSlowArts!: (v: unknown) => void;
    api.get = (
      route: string,
      params?: Record<string, unknown>,
      query?: string,
    ) => {
      if (
        route === "GET /api/ci/runs/{id}/artifacts" &&
        params?.["id"] === "run-errored-1"
      ) {
        return new Promise((r) => {
          resolveSlowArts = r;
        });
      }
      return origGet(route, params, query);
    };
    api.artifactsResponseByRun["run-running-3"] = {
      enabled: true,
      available: true,
      artifacts: [
        {
          run: "run-running-3",
          job: "lint",
          name: "lint-json",
          stored: true,
          bytes: 256,
        },
      ],
      total: 1,
    };
    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-running-3"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-artifacts-section"]')?.textContent,
    ).toContain("lint-json");

    resolveSlowArts({
      enabled: true,
      available: true,
      artifacts: [
        {
          run: "run-errored-1",
          job: "test",
          name: "stale-from-errored-1",
          stored: true,
          bytes: 99,
        },
      ],
      total: 1,
    });
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-artifacts-section"]')?.textContent,
    ).not.toContain("stale-from-errored-1");
    expect(
      root.querySelector('[data-testid="ci-artifacts-section"]')?.textContent,
    ).toContain("lint-json");
  });

  it("supports shared-fault runId selection and mobile detail back navigation at 390px phone width", async () => {
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      configurable: true,
      writable: true,
    });
    api.artifactsByRun["run-errored-1"] = [
      {
        run: "run-errored-1",
        job: "test",
        name: "boot-trace",
        stored: true,
        bytes: 2048,
      },
    ];
    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    expect(
      root.querySelector(".ci-split")?.classList.contains("has-mobile-detail"),
    ).toBe(false);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-open-run-run-errored-1"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector(".ci-split")?.classList.contains("has-mobile-detail"),
    ).toBe(true);
    expect(
      root
        .querySelector('[data-testid="ci-detail-run-id"]')
        ?.textContent?.trim(),
    ).toBe("run-errored-1");
    expect(
      root.querySelector('[data-testid="ci-artifacts-section"]')?.textContent,
    ).toContain("boot-trace");
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-mobile-back"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector(".ci-split")?.classList.contains("has-mobile-detail"),
    ).toBe(false);
  });

  it("enforces repo-scoped ci:read RBAC on shared-fault artifact inspection without 403 requests", async () => {
    api.configBody = {
      access: {
        role: "grain/repo-ci",
        roles: ["grain/repo-ci"],
        full: false,
        scopes: ["ci:read"],
        repoLimits: {
          "ci:read": ["acme/infra"],
        },
      },
      targetRepos: ["acme/widgets", "acme/infra"],
    };
    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    const beforeCalls = api.artifactCalls.length;
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="ci-fault-artifacts-btn-run-errored-1"]',
      )!
      .click();
    await flush(harness);
    expect(api.artifactCalls.length).toBe(beforeCalls);
    expect(
      root.querySelector('[data-testid="ci-fault-artifacts-run-errored-1"]')
        ?.textContent,
    ).toContain("does not hold ci:read on this repository");
  });

  it("completely hides mutable CI action buttons before config loads and for grain/viewer, and scopes contributor buttons to ci:write", async () => {
    let resolveConfig!: (cfg: GrainConfig) => void;
    api.config = () =>
      new Promise<GrainConfig>((resolve) => {
        resolveConfig = resolve;
      });

    const harness = await RouterTestingHarness.create("/ci/runs/run-running-3");
    harness.detectChanges();
    const root = harness.routeNativeElement!;

    const mutableSelectors = [
      '[data-testid="ci-open-run-dialog"]',
      '[data-testid="ci-caches-menu-btn"]',
      '[data-testid="ci-cancel-run-btn"]',
      '[data-testid="ci-rerun-btn"]',
      '[data-testid="ci-rerun-failed-btn"]',
      '[data-testid="ci-open-quarantine-btn"]',
    ];
    for (const sel of mutableSelectors) {
      expect(root.querySelector(sel), `${sel} before config loads`).toBeNull();
    }

    // Resolve as grain/viewer (read-only): every mutable button stays completely absent.
    resolveConfig({
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["ci:read", "tasks:read", "caches:read"],
      },
      targetRepos: ["acme/widgets", "acme/infra"],
    });
    await flush(harness);

    for (const sel of mutableSelectors) {
      expect(
        root.querySelector(sel),
        `${sel} on active run for viewer`,
      ).toBeNull();
    }
    expect(
      root.querySelector('[data-testid="ci-detail-title"]')?.textContent,
    ).toContain("Checks");

    // Inspect a failed/errored Grain run as viewer: Re-run all, Re-run failed, and Quarantine remain hidden.
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-failed-2"]')!
      .click();
    await flush(harness);
    for (const sel of mutableSelectors) {
      expect(
        root.querySelector(sel),
        `${sel} on failed run for viewer`,
      ).toBeNull();
    }

    // Upgrade to grain/contributor (has ci:write, lacks caches:write and tests:write).
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "grain/contributor",
        roles: ["grain/contributor"],
        full: false,
        scopes: ["ci:read", "ci:write", "tasks:read", "tasks:write"],
      },
      targetRepos: ["acme/widgets", "acme/infra"],
    });
    await flush(harness);

    expect(
      root.querySelector('[data-testid="ci-open-run-dialog"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-testid="ci-rerun-btn"]')).not.toBeNull();
    expect(
      root.querySelector('[data-testid="ci-rerun-failed-btn"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-testid="ci-caches-menu-btn"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="ci-open-quarantine-btn"]'),
    ).toBeNull();

    // Mid-session downgrade back to viewer immediately hides all mutable buttons and disables/blocks submission.
    access.setConfig({
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["ci:read"],
      },
      targetRepos: ["acme/widgets", "acme/infra"],
    });
    await flush(harness);
    for (const sel of mutableSelectors) {
      expect(
        root.querySelector(sel),
        `${sel} after downgrade to viewer`,
      ).toBeNull();
    }
  });

  it("hides repo-scoped mutable CI buttons on unauthorized repositories and guards programmatic mutations", async () => {
    api.runs.unshift({
      id: "run-running-widgets",
      provider: "grain",
      repo: "acme/widgets",
      ref: "refs/heads/main",
      status: "running",
      startedAt: "2026-11-12T00:08:00Z",
      jobs: [],
    });
    api.configBody = {
      access: {
        role: "grain/repo-ci",
        roles: ["grain/repo-ci"],
        full: false,
        scopes: ["ci:read", "ci:write", "tests:write", "caches:write"],
        repoLimits: {
          "ci:write": ["acme/infra"],
          "caches:write": ["acme/infra"],
        },
      },
      targetRepos: ["acme/widgets", "acme/infra"],
    };

    const harness = await RouterTestingHarness.create("/ci/runs/run-running-3");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Authorized repo acme/infra shows Cancel run, Re-run all, and Quarantine test.
    expect(
      root.querySelector('[data-testid="ci-cancel-run-btn"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-testid="ci-rerun-btn"]')).not.toBeNull();
    expect(
      root.querySelector('[data-testid="ci-open-quarantine-btn"]'),
    ).not.toBeNull();

    // Switching to active run on unauthorized repo acme/widgets hides Cancel run and Re-run buttons.
    root
      .querySelector<HTMLElement>(
        '[data-testid="ci-run-row-run-running-widgets"]',
      )!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-cancel-run-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="ci-rerun-btn"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="ci-open-quarantine-btn"]'),
    ).not.toBeNull();

    // Failed run on unauthorized repo acme/widgets hides both Re-run all and Re-run failed.
    root
      .querySelector<HTMLElement>('[data-testid="ci-run-row-run-failed-2"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-rerun-btn"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="ci-rerun-failed-btn"]'),
    ).toBeNull();

    // Header Run workflow & Flush cache respect repoFilter when repoLimits apply.
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-repo-pill"]')!
      .click();
    await flush(harness);
    const repoOptions = [
      ...root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="ci-repo-menu"] [role="option"]',
      ),
    ];
    repoOptions.find((b) => b.textContent?.includes("acme/widgets"))!.click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-open-run-dialog"]')).toBeNull();
    expect(root.querySelector('[data-testid="ci-caches-menu-btn"]')).toBeNull();

    // Switching repo filter to authorized acme/infra shows repo-scoped Actions cache flush only (not global caches).
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-repo-pill"]')!
      .click();
    await flush(harness);
    const infraOpt = [
      ...root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="ci-repo-menu"] [role="option"]',
      ),
    ].find((b) => b.textContent?.includes("acme/infra"))!;
    infraOpt.click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="ci-open-run-dialog"]'),
    ).not.toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="ci-caches-menu-btn"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="ci-flush-job-cache"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="ci-flush-package-cache"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="ci-flush-actions-cache"]'),
    ).not.toBeNull();

    // Direct invocation of mutation handlers for an unauthorized repo sends zero API calls.
    const cmp = harness.routeDebugElement!.componentInstance as unknown as {
      rerunSelected(run: CIRun, failedOnly: boolean): Promise<void>;
      confirmCancelRun(run: CIRun): void;
      openQuarantineDialog(run: CIRun): void;
    };
    const widgetsRun = api.runs.find((r) => r.id === "run-failed-2")!;
    const beforePosts = api.postCalls.length;
    await cmp.rerunSelected(widgetsRun, true);
    cmp.confirmCancelRun(api.runs[0]);
    expect(api.postCalls.length).toBe(beforePosts);
    expect(root.querySelector('[data-testid="ci-cancel-dialog"]')).toBeNull();
  });

  it("aligns filter pop-menus within 390px viewports and ships component-scoped filter wrap/containment rules", async () => {
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      configurable: true,
      writable: true,
    });
    const harness = await RouterTestingHarness.create("/ci");
    await flush(harness);
    const root = harness.routeNativeElement!;

    const repoBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-repo-pill"]',
    )!;
    const branchBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-branch-pill"]',
    )!;
    const cachesBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="ci-caches-menu-btn"]',
    )!;

    repoBtn.getBoundingClientRect = () =>
      ({
        left: 16,
        right: 110,
        width: 94,
        top: 180,
        bottom: 214,
        height: 34,
      }) as DOMRect;
    branchBtn.getBoundingClientRect = () =>
      ({
        left: 230,
        right: 340,
        width: 110,
        top: 180,
        bottom: 214,
        height: 34,
      }) as DOMRect;
    cachesBtn.getBoundingClientRect = () =>
      ({
        left: 16,
        right: 136,
        width: 120,
        top: 60,
        bottom: 100,
        height: 40,
      }) as DOMRect;

    repoBtn.click();
    await flush(harness);
    expect(
      root
        .querySelector('[data-testid="ci-repo-menu"]')!
        .classList.contains("align-right"),
    ).toBe(false);

    branchBtn.click();
    await flush(harness);
    expect(
      root
        .querySelector('[data-testid="ci-branch-menu"]')!
        .classList.contains("align-right"),
    ).toBe(true);

    cachesBtn.click();
    await flush(harness);
    expect(
      root
        .querySelector('[data-testid="ci-caches-menu"]')!
        .classList.contains("align-right"),
    ).toBe(false);

    const listCss = fs.readFileSync(
      path.join(__dirname, "ci-list.css"),
      "utf8",
    );
    expect(listCss).toContain("g-ci-page .filter-strip");
    expect(listCss).toContain("flex-wrap: wrap");
    expect(listCss).toContain(".ci-toolbar .segmented");
    expect(listCss).toContain("min-width: min(200px, calc(100vw - 32px))");
    expect(listCss).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(listCss).toContain("border-right: 0");
  });
});
