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
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { GrainConfig, Task } from "../api/models";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { ProcessesPageComponent } from "./processes-page.component";
import {
  type ScheduleDraftSnapshot,
  type Composition,
  type DeclarationAcceptanceView,
  type RepoDefaultsView,
  type RepoWorkflowsResponse,
  type Schedule,
  type ScheduleRun,
  type Suite,
  type SuiteRun,
  type Template,
  type TemplateField,
  validateScheduleDraft,
} from "./processes.models";

class FakeProcessesApi {
  configBody: GrainConfig = {
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
    targetRepos: ["acme/widgets"],
    approvedByDefault: true,
  };

  tasks: Task[] = [
    {
      id: "301",
      title: "Audit deps",
      state: "running",
      repo: "acme/widgets",
      scheduled: true,
    },
    {
      id: "401",
      title: "Lint pass",
      state: "queued",
      repo: "acme/widgets",
      suiteRun: true,
    },
    {
      id: "402",
      title: "Security pass",
      state: "running",
      repo: "acme/widgets",
      suiteRun: true,
    },
  ];

  schedules: Schedule[] = [
    {
      id: "sched-1",
      title: "Audit deps",
      description: "Check outdated dependencies.",
      repo: "acme/widgets",
      base: "",
      autoMerge: true,
      capabilities: [],
      recurrence: {
        kind: "github_workflow_run",
        githubWorkflowRun: {
          workflow: "Nightly E2E",
          conclusions: ["failure"],
          branches: ["release"],
        },
      },
      timeZone: "UTC",
      overlap: "skip",
      source: "deployment",
      type: "task",
      enabled: true,
      nextRunAt: "2026-11-13T09:00:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      revision: "rev-s1",
    },
    {
      id: "sched-gitref",
      title: "Sync upstream tag",
      description: "Rebase onto latest upstream tag.",
      repo: "acme/widgets",
      base: "main",
      autoMerge: false,
      capabilities: [],
      recurrence: {
        kind: "git_ref",
        gitRef: {
          repo: "upstream/core",
          ref: "refs/tags/latest",
        },
      },
      overlap: "skip",
      source: "deployment",
      type: "task",
      enabled: true,
      nextRunAt: "2026-11-13T10:00:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      revision: "rev-s2",
    },
    {
      id: "sched-sys",
      title: "Memory consolidation",
      description: "System memory job.",
      repo: "",
      autoMerge: false,
      templateId: "system:memory",
      system: true,
      capabilities: [],
      recurrence: { kind: "daily", timeOfDay: "03:00", timeZone: "UTC" },
      timeZone: "UTC",
      overlap: "skip",
      source: "system",
      type: "system",
      enabled: true,
      nextRunAt: "2026-11-13T03:00:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      revision: "rev-sys",
    },
  ];

  templates: Template[] = [
    {
      id: "repo:template:acme/widgets:release-notes",
      name: "release-notes",
      title: "Draft release notes for {{version}}",
      description: "Summarize commits since last tag for {{version}}.",
      fields: [
        {
          name: "version",
          label: "Version",
          default: "v1.2.0",
          required: true,
        },
      ],
      autoMerge: false,
      capabilities: [],
      declaredIn: {
        repo: "acme/widgets",
        path: ".grain/templates/release-notes.yml",
      },
    },
    {
      id: "tmpl-deploy-1",
      name: "Go upgrade",
      title: "chore: bump {{pkg}}",
      description: "Bump {{pkg}} version in go.mod.",
      fields: [
        {
          name: "pkg",
          label: "Go package",
          default: "golang.org/x/net",
          options: ["golang.org/x/net", "golang.org/x/sys"],
          required: false,
        },
      ],
      autoMerge: true,
      capabilities: [],
      revision: "rev-t1",
    },
  ];

  suites: Suite[] = [
    {
      id: "suite-1",
      name: "Hardening sweep",
      items: [{ templateId: "tmpl-deploy-1", templateName: "Go upgrade" }],
      mode: "until_clean",
      maxPasses: 3,
      requireApproval: true,
      autoMerge: false,
      autoApproveProposals: false,
      revision: "rev-st1",
    },
  ];

  suiteRuns: SuiteRun[] = [
    {
      id: 7,
      suiteId: "suite-1",
      suiteName: "Hardening sweep",
      repo: "acme/widgets",
      base: "main",
      mode: "until_clean",
      maxPasses: 3,
      requireApproval: true,
      autoMerge: false,
      status: "active",
      pass: 1,
      createdAt: "2026-11-12T00:00:00Z",
      tasks: [
        {
          taskId: "401",
          templateId: "tmpl-deploy-1",
          templateName: "Go upgrade",
          pass: 1,
          state: "queued",
          approved: true,
          openedPullRequest: false,
          proposed: false,
        },
        {
          taskId: "402",
          templateId: "tmpl-deploy-1",
          templateName: "Go upgrade",
          pass: 1,
          state: "running",
          approved: true,
          openedPullRequest: false,
          proposed: false,
        },
      ],
    },
  ];

  acceptances: DeclarationAcceptanceView[] = [
    {
      id: "repo:template:acme/widgets:release-notes",
      kind: "template",
      repo: "acme/widgets",
      requested: ["push:refs/tags/v*"],
      requestedAt: "2026-11-12T00:00:00Z",
      awaiting: true,
      unaccepted: ["push:refs/tags/v*"],
      needsScopes: ["repos:write"],
    },
  ];

  repoDecl: RepoDefaultsView = {
    repo: "acme/widgets",
    declarations: true,
    declarationsStatus: {
      commit: "abcdef1234567890",
      checkedAt: "2026-11-12T00:05:00Z",
      templates: [".grain/templates/release-notes.yml"],
      triggers: [".grain/triggers/docs.yml"],
      mergeRules: ".grain/merge-rules.yml",
    },
  };

  repoWfs: RepoWorkflowsResponse = {
    repo: "acme/widgets",
    dir: ".grain/workflows",
    workflows: [
      {
        path: ".grain/workflows/ci.yml",
        name: "CI",
        text: "name: CI\non: [push]\n",
      },
    ],
  };

  compositionSample: Composition = {
    kind: "task",
    repo: "acme/widgets",
    base: "main",
    tasks: [
      {
        title: "Audit deps",
        fields: [
          { name: "repo", values: ["acme/widgets"], source: "schedule" },
          { name: "autoMerge", values: ["on"], source: "schedule" },
        ],
      },
    ],
  };

  scheduleRunResult: ScheduleRun = {
    taskId: "601",
    schedule: this.schedules[0],
  };

  calls: { method: string; route: string; params?: unknown; body?: unknown }[] =
    [];

  config = () => Promise.resolve(this.configBody);
  tasks_ = () => Promise.resolve(this.tasks);
  clearConditionalCache = () => undefined;

  getIfChanged = (route: string) => {
    switch (route) {
      case "GET /api/tasks":
        return Promise.resolve({
          body: structuredClone(this.tasks),
          changed: true,
        });
      case "GET /api/schedules":
        return Promise.resolve({
          body: structuredClone(this.schedules),
          changed: true,
        });
      case "GET /api/templates":
        return Promise.resolve({
          body: structuredClone(this.templates),
          changed: true,
        });
      case "GET /api/suites":
        return Promise.resolve({
          body: structuredClone(this.suites),
          changed: true,
        });
      case "GET /api/suite-runs":
        return Promise.resolve({
          body: structuredClone(this.suiteRuns),
          changed: true,
        });
      case "GET /api/declarations":
        return Promise.resolve({
          body: structuredClone(this.acceptances),
          changed: true,
        });
      default:
        return Promise.resolve({ body: null, changed: false });
    }
  };

  get = (route: string, params?: Record<string, unknown>) => {
    this.calls.push({ method: "GET", route, params });
    if (route === "GET /api/deployment/reachable-repos") {
      return Promise.resolve(["acme/widgets"]);
    }
    if (
      route === "GET /api/schedules/{id}/composition" ||
      route === "GET /api/templates/{id}/composition" ||
      route === "GET /api/suites/{id}/composition"
    ) {
      return Promise.resolve(structuredClone(this.compositionSample));
    }
    if (route === "GET /api/suite-runs/{id}") {
      const id = Number(params?.["id"]);
      const found =
        this.suiteRuns.find((r) => r.id === id) ?? this.suiteRuns[0];
      return Promise.resolve(structuredClone(found));
    }
    if (route === "GET /api/repos/{owner}/{name}/declarations") {
      return Promise.resolve(structuredClone(this.repoDecl));
    }
    if (route === "GET /api/repos/{owner}/{name}/workflows") {
      return Promise.resolve(structuredClone(this.repoWfs));
    }
    return Promise.resolve({});
  };

  post = (route: string, params?: unknown, body?: Record<string, unknown>) => {
    this.calls.push({ method: "POST", route, params, body });
    if (
      route === "POST /api/schedules/composition" ||
      route === "POST /api/suites/composition"
    ) {
      return Promise.resolve(structuredClone(this.compositionSample));
    }
    if (route === "POST /api/schedules") {
      const created: Schedule = {
        ...this.schedules[0],
        id: "sched-new",
        title: String(body?.["title"] || "New sched"),
      };
      this.schedules.push(created);
      return Promise.resolve(created);
    }
    if (route === "POST /api/schedules/{id}/run") {
      return Promise.resolve(structuredClone(this.scheduleRunResult));
    }
    if (route === "POST /api/templates") {
      const created: Template = {
        id: "tmpl-new",
        name: String(body?.["name"] ?? ""),
        title: String(body?.["title"] ?? ""),
        description: String(body?.["description"] ?? ""),
        autoMerge: false,
        capabilities: [],
      };
      this.templates.push(created);
      return Promise.resolve(created);
    }
    if (route === "POST /api/tasks/from-template") {
      return Promise.resolve({
        id: "701",
        title: "Draft release notes for v1.2.0",
        state: "queued",
      });
    }
    if (route === "POST /api/suites") {
      const created: Suite = {
        id: "suite-2",
        name: String(body?.["name"] ?? ""),
        items: [{ templateId: "tmpl-deploy-1", templateName: "Go upgrade" }],
        mode: String(body?.["mode"] ?? "count"),
        count: Number(body?.["count"] ?? 1),
        requireApproval: Boolean(body?.["requireApproval"]),
        autoMerge: body?.["autoMerge"] !== false,
        autoApproveProposals: false,
      };
      this.suites.push(created);
      return Promise.resolve(created);
    }
    if (route === "POST /api/suite-runs") {
      const created: SuiteRun = {
        ...this.suiteRuns[0],
        id: 8,
        repo: String(body?.["repo"] ?? "acme/widgets"),
        base: String(body?.["base"] ?? "main"),
      };
      this.suiteRuns.unshift(created);
      return Promise.resolve(created);
    }
    if (route === "POST /api/declarations/accept") {
      this.acceptances[0].awaiting = false;
      this.acceptances[0].acceptedBy = "alice@example.com";
      return Promise.resolve(structuredClone(this.acceptances[0]));
    }
    return Promise.resolve({});
  };

  patch = (
    route: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
  ) => {
    this.calls.push({ method: "PATCH", route, params, body });
    if (route === "PATCH /api/schedules/{id}") {
      const id = String(params?.["id"] ?? "");
      const found =
        this.schedules.find((s) => s.id === id) ?? this.schedules[0];
      if (typeof body?.["enabled"] === "boolean") {
        found.enabled = body["enabled"];
      }
      return Promise.resolve(structuredClone(found));
    }
    if (route === "PATCH /api/templates/{id}") {
      return Promise.resolve(structuredClone(this.templates[1]));
    }
    if (route === "PATCH /api/suites/{id}") {
      return Promise.resolve(structuredClone(this.suites[0]));
    }
    return Promise.resolve({});
  };

  put = (route: string, params?: unknown, body?: Record<string, unknown>) => {
    this.calls.push({ method: "PUT", route, params, body });
    if (route === "PUT /api/repos/{owner}/{name}/declarations") {
      this.repoDecl.declarations = !!body?.["declarations"];
      return Promise.resolve(structuredClone(this.repoDecl));
    }
    if (route === "PUT /api/repos/{owner}/{name}/workflows") {
      this.repoWfs.workflows =
        (body?.["workflows"] as RepoWorkflowsResponse["workflows"]) ?? [];
      return Promise.resolve(structuredClone(this.repoWfs));
    }
    return Promise.resolve({});
  };

  delete = (route: string, params?: Record<string, unknown>) => {
    this.calls.push({ method: "DELETE", route, params });
    if (route === "DELETE /api/schedules/{id}") {
      this.schedules = this.schedules.filter((s) => s.id !== params?.["id"]);
    }
    return Promise.resolve({});
  };
}

async function flush(harness: RouterTestingHarness): Promise<void> {
  harness.detectChanges();
  await harness.fixture.whenStable();
  await new Promise((r) => setTimeout(r, 10));
  harness.detectChanges();
  await new Promise((r) => setTimeout(r, 10));
  harness.detectChanges();
  await harness.fixture.whenStable();
}

describe("ProcessesPageComponent (D-9)", () => {
  let api: FakeProcessesApi;

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      configurable: true,
      writable: true,
    });
    api = new FakeProcessesApi();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: "processes", component: ProcessesPageComponent },
            { path: "processes/:tab", component: ProcessesPageComponent },
            { path: "task/:id", component: ProcessesPageComponent },
          ],
          withComponentInputBinding(),
        ),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("manages Schedules: outside-[inert] dialog, github_workflow_run conclusions/branches, empty base, git_ref.repo, system-schedule guard, and workflowRun Run now notice", async () => {
    const harness = await RouterTestingHarness.create(
      "/processes/schedules?new=1",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;

    expect(root.querySelectorAll("select").length).toBe(0);

    // ?new=1 opens New Schedule dialog outside [inert]
    const dialog = root.querySelector('[data-testid="schedule-dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();
    expect(root.querySelector(".view-panel")?.hasAttribute("inert")).toBe(true);

    const titleIn = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-title-input"]',
    )!;
    titleIn.value = "Nightly security scan";
    titleIn.dispatchEvent(new Event("input"));
    await flush(harness);

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-preview-composition-btn"]',
      )!
      .click();
    await flush(harness);
    expect(
      api.calls.some((c) => c.route === "POST /api/schedules/composition"),
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(true);

    // 1. Edit github_workflow_run schedule (sched-1): preserves base: "", conclusions: ["failure"], branches: ["release"], locks Suite target
    const sched1Row = root.querySelector<HTMLElement>(
      '[data-testid="sched-row-sched-1"]',
    )!;
    expect(sched1Row.textContent).toContain(
      "On GitHub workflow: Nightly E2E (failure · on release)",
    );
    sched1Row.click();
    await flush(harness);

    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);

    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-base-input"]')!
        .value,
    ).toBe("");
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="sched-target-suite"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="sched-trigger-conclusion-input"]',
      )!.value,
    ).toBe("failure");
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="sched-trigger-branch-input"]',
      )!.value,
    ).toBe("release");

    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);

    const ghaPatch = api.calls.find(
      (c) =>
        c.route === "PATCH /api/schedules/{id}" &&
        (c.params as Record<string, unknown>)?.["id"] === "sched-1",
    )!;
    const ghaBody = ghaPatch.body as Record<string, unknown>;
    expect(ghaBody["base"]).toBe("");
    expect(ghaBody["capabilities"]).toBeUndefined();
    expect(ghaBody["recurrence"]).toEqual({
      kind: "github_workflow_run",
      githubWorkflowRun: {
        workflow: "Nightly E2E",
        conclusions: ["failure"],
        branches: ["release"],
      },
    });

    // 2. Edit git_ref schedule (sched-gitref): preserves gitRef.repo = "upstream/core"
    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-gitref"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    const gitRefPatch = api.calls.find(
      (c) =>
        c.route === "PATCH /api/schedules/{id}" &&
        (c.params as Record<string, unknown>)?.["id"] === "sched-gitref",
    )!;
    expect(
      (gitRefPatch.body as { recurrence: { gitRef: { repo: string } } })
        .recurrence.gitRef.repo,
    ).toBe("upstream/core");

    // 3. Edit system schedule (sched-sys): hides content inputs & sends only cadence/overlap/revision
    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-sys"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-system-banner"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-testid="sched-title-input"]')).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    const sysPatch = api.calls.find(
      (c) =>
        c.route === "PATCH /api/schedules/{id}" &&
        (c.params as Record<string, unknown>)?.["id"] === "sched-sys",
    )!;
    expect(Object.keys(sysPatch.body as object).sort()).toEqual([
      "overlap",
      "recurrence",
      "revision",
      "timeZone",
    ]);

    // 4. Run now with workflowRun: true and no taskId/suiteRunId shows honest trigger notice
    const snackbar = TestBed.inject(SnackbarService);
    api.scheduleRunResult = {
      workflowRun: true,
      schedule: api.schedules[0],
    };
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-run-now-btn"]')!
      .click();
    await flush(harness);
    expect(snackbar.current()?.message).toBe(
      "No concluded GitHub workflow run matched this trigger yet.",
    );
  });

  it("preserves TemplateField metadata (label, default, options, required) across PATCH and launches via POST /api/tasks/from-template", async () => {
    const harness = await RouterTestingHarness.create(
      "/processes/templates?launch=1",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;

    const launchDialog = root.querySelector(
      '[data-testid="launch-template-dialog"]',
    )!;
    expect(launchDialog).not.toBeNull();
    expect(launchDialog.closest("[inert]")).toBeNull();

    const versionInput = root.querySelector<HTMLInputElement>(
      '[data-testid="launch-field-version"]',
    )!;
    expect(versionInput.value).toBe("v1.2.0");

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="launch-template-submit"]',
      )!
      .click();
    await flush(harness);
    expect(
      api.calls.some((c) => c.route === "POST /api/tasks/from-template"),
    ).toBe(true);

    // Navigate back to templates tab and edit deployment template tmpl-deploy-1
    await harness.navigateByUrl("/processes/templates");
    await flush(harness);
    const tplRoot = harness.routeNativeElement!;

    tplRoot
      .querySelector<HTMLElement>('[data-testid="tmpl-row-tmpl-deploy-1"]')!
      .click();
    await flush(harness);
    tplRoot
      .querySelector<HTMLButtonElement>('[data-testid="tmpl-edit-btn"]')!
      .click();
    await flush(harness);

    const tmplDlg = tplRoot.querySelector('[data-testid="template-dialog"]')!;
    expect(tmplDlg.closest("[inert]")).toBeNull();

    // Append a second parameter while keeping existing "pkg" metadata intact
    const paramsInput = tplRoot.querySelector<HTMLInputElement>(
      '[data-testid="tmpl-params-input"]',
    )!;
    expect(paramsInput.value).toBe("pkg");
    paramsInput.value = "pkg, target_go";
    paramsInput.dispatchEvent(new Event("input"));
    await flush(harness);

    tplRoot
      .querySelector<HTMLButtonElement>('[data-testid="tmpl-save-btn"]')!
      .click();
    await flush(harness);

    const tmplPatch = api.calls.find(
      (c) => c.route === "PATCH /api/templates/{id}",
    )!;
    const savedFields = (tmplPatch.body as { fields: TemplateField[] }).fields;
    expect(savedFields).toEqual([
      {
        name: "pkg",
        label: "Go package",
        default: "golang.org/x/net",
        options: ["golang.org/x/net", "golang.org/x/sys"],
        required: false,
      },
      {
        name: "target_go",
        required: true,
      },
    ]);
  });

  it("lists a suite run that has filed no tasks (tasks: null) beside the others, naming no pass", async () => {
    // A run that ended before its first pass was filed comes back from the
    // server with `tasks: null` and `pass: 0`; reading .length off it threw
    // and the rest of the runs list never rendered.
    api.suiteRuns = [
      ...api.suiteRuns,
      {
        ...api.suiteRuns[0],
        id: 9,
        status: "failed",
        pass: 0,
        base: "",
        error: "pass 1 could not be filed: template gone",
        tasks: null,
      },
    ];
    const harness = await RouterTestingHarness.create("/processes/suites");
    await flush(harness);
    const root = harness.routeNativeElement!;
    root
      .querySelector<HTMLButtonElement>('[data-testid="suites-subview-runs"]')!
      .click();
    await flush(harness);

    const empty = root.querySelector('[data-testid="suite-run-row-9"]')!;
    expect(empty).toBeTruthy();
    expect(root.querySelector('[data-testid="suite-run-row-7"]')).toBeTruthy();
    expect(empty.textContent).toContain("0 tasks");
    expect(empty.textContent).not.toMatch(/Pass 0/);
    expect(
      root.querySelector('[data-testid="suite-run-row-7"]')!.textContent,
    ).toContain("Pass 1");
  });

  it("preserves Suite requireApproval/autoMerge on PATCH, launches Suite Runs via ?run=1, and closes all non-closed pass tasks (including running)", async () => {
    const harness = await RouterTestingHarness.create("/processes/suites");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Edit existing suite-1 (requireApproval: true, autoMerge: false) and verify PATCH preserves both!
    root
      .querySelector<HTMLButtonElement>('[data-testid="suite-edit-btn"]')!
      .click();
    await flush(harness);
    const suiteDialog = root.querySelector('[data-testid="suite-dialog"]')!;
    expect(suiteDialog.closest("[inert]")).toBeNull();
    expect(
      root
        .querySelector('[data-testid="suite-require-approval-switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      root
        .querySelector('[data-testid="suite-auto-merge-switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");

    root
      .querySelector<HTMLButtonElement>('[data-testid="suite-save-btn"]')!
      .click();
    await flush(harness);
    const suitePatch = api.calls.find(
      (c) => c.route === "PATCH /api/suites/{id}",
    )!;
    expect(suitePatch.body).toMatchObject({
      requireApproval: true,
      autoMerge: false,
      revision: "rev-st1",
    });

    // Launch Suite Run via Run suite dialog
    root
      .querySelector<HTMLButtonElement>('[data-testid="proc-run-suite-btn"]')!
      .click();
    await flush(harness);
    expect(
      root
        .querySelector('[data-testid="run-suite-dialog"]')
        ?.closest("[inert]"),
    ).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="run-suite-submit"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/suite-runs")).toBe(
      true,
    );

    // Cancel active suite run tasks (401 queued + 402 running) -> BOTH must call POST /api/tasks/{id}/close, NEVER /stop!
    root
      .querySelector<HTMLButtonElement>('[data-testid="suite-run-cancel-btn"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await flush(harness);

    const closeCalls = api.calls.filter(
      (c) => c.route === "POST /api/tasks/{id}/close",
    );
    expect(
      closeCalls.map((c) => (c.params as { id: string }).id).sort(),
    ).toEqual(["401", "402"]);
    expect(api.calls.some((c) => c.route === "POST /api/tasks/{id}/stop")).toBe(
      false,
    );
  });

  it("enforces global scope on Accept declaration and supports saving & deleting Repo workflow overrides", async () => {
    // 1. Repo-limited repos:write cannot accept declaration requiring global repos:write
    api.configBody = {
      access: {
        role: "grain/repo-dev",
        roles: ["grain/repo-dev"],
        full: false,
        scopes: ["capabilities:read", "repos:write", "settings:write"],
        repoLimits: {
          "repos:write": ["acme/widgets"],
        },
      },
      targetRepos: ["acme/widgets"],
      approvedByDefault: true,
    };

    const harness = await RouterTestingHarness.create(
      "/processes/declarations",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;

    const acceptBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="decl-accept-btn-repo:template:acme/widgets:release-notes"]',
    )!;
    expect(acceptBtn.disabled).toBe(true);
    const repoWarn = root.querySelector(
      '[data-testid="decl-accept-warning-repo:template:acme/widgets:release-notes"]',
    );
    expect(repoWarn).not.toBeNull();
    expect(repoWarn!.textContent).toContain("repos:write");
    expect(repoWarn!.textContent).toContain("specific repositories");

    // 2. Grant global repos:write and reload -> Accept declaration succeeds, plus edit & delete workflow override
    api.configBody = {
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
      targetRepos: ["acme/widgets"],
      approvedByDefault: true,
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [{ path: "processes/:tab", component: ProcessesPageComponent }],
          withComponentInputBinding(),
        ),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const harness2 = await RouterTestingHarness.create(
      "/processes/declarations",
    );
    await flush(harness2);
    const root2 = harness2.routeNativeElement!;

    root2
      .querySelector<HTMLButtonElement>(
        '[data-testid="decl-accept-btn-repo:template:acme/widgets:release-notes"]',
      )!
      .click();
    await flush(harness2);
    expect(
      api.calls.some((c) => c.route === "POST /api/declarations/accept"),
    ).toBe(true);

    // Inspect existing workflow override and delete it via Delete override button
    root2
      .querySelector<HTMLButtonElement>(
        '[data-testid="decl-inspect-wf-.grain/workflows/ci.yml"]',
      )!
      .click();
    await flush(harness2);
    const wfDlg = root2.querySelector('[data-testid="repo-workflow-dialog"]')!;
    expect(wfDlg.closest("[inert]")).toBeNull();

    root2
      .querySelector<HTMLButtonElement>('[data-testid="wf-delete-btn"]')!
      .click();
    await flush(harness2);
    const putCall = api.calls.find(
      (c) => c.route === "PUT /api/repos/{owner}/{name}/workflows",
    )!;
    expect(putCall.body).toEqual({ workflows: [] });
  });

  it("never floods Declarations with GitHub-wide reachable-repos when targetRepos is configured", async () => {
    api.configBody = {
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
      targetRepos: ["acme/widgets"],
      reposWithWorkflows: ["acme/external-ci"],
      approvedByDefault: true,
    };
    const baseGet = api.get;
    api.get = (route: string, params?: Record<string, unknown>) => {
      if (route === "GET /api/deployment/reachable-repos") {
        api.calls.push({ method: "GET", route, params });
        return Promise.resolve({
          available: true,
          repos: Array.from({ length: 200 }, (_, i) => ({
            repo: `github-org/unrelated-${i}`,
            push: true,
          })),
        });
      }
      return baseGet(route, params);
    };

    const harness = await RouterTestingHarness.create(
      "/processes/declarations",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Never calls reachable-repos on Processes; only lists instance-configured repos.
    expect(
      api.calls.some((c) => c.route === "GET /api/deployment/reachable-repos"),
    ).toBe(false);
    expect(
      root.querySelector('[data-testid="decl-repo-row-acme/widgets"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="decl-repo-row-acme/external-ci"]'),
    ).not.toBeNull();
    expect(
      root.querySelector(
        '[data-testid="decl-repo-row-github-org/unrelated-0"]',
      ),
    ).toBeNull();
    expect(
      root.querySelectorAll('[data-testid^="decl-repo-row-"]').length,
    ).toBe(2);
  });

  it("resets all schedule editor form state and pending validations on close and reopen (Cancel, Escape, Scrim, New/Edit switch)", async () => {
    const harness = await RouterTestingHarness.create("/processes/schedules");
    await flush(harness);
    const root = harness.routeNativeElement!;

    const setInput = (testid: string, value: string): void => {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-testid="${testid}"]`,
      )!;
      el.value = value;
      el.dispatchEvent(new Event("input"));
    };

    // 1. Open New schedule, trigger required field validation, mutate every field, then close via Cancel
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);

    // Clicking Save with empty Title triggers required validation and blocks POST
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-title-error"]')?.textContent,
    ).toContain("Task title is required");
    expect(
      root
        .querySelector('[data-testid="sched-title-input"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );

    // Mutate fields + switch to github_workflow_run + switch overlap + trigger workflow error + preview composition
    setInput("sched-desc-input", "Stale description");
    setInput("sched-repo-input", "acme/stale-repo");
    setInput("sched-base-input", "stale-branch");
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-github_workflow_run"]',
      )!
      .click();
    await flush(harness);
    setInput("sched-trigger-conclusion-input", "cancelled");
    setInput("sched-trigger-branch-input", "release/old");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-overlap-allow"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-preview-composition-btn"]',
      )!
      .click();
    await flush(harness);
    expect(root.querySelector("g-composition-view")).not.toBeNull();

    // Trigger pending validation on workflow input before cancelling
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-trigger-workflow-error"]')
        ?.textContent,
    ).toContain("Workflow name or file is required");

    // Close via Cancel
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-cancel-btn"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();

    // Reopen New schedule -> all controls and pending validations must be reset!
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-dialog-title"]')?.textContent ||
        root.querySelector("#sched-dialog-title")?.textContent,
    ).toContain("New schedule or trigger");
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-title-input"]')!
        .value,
    ).toBe("");
    expect(
      root.querySelector<HTMLTextAreaElement>(
        '[data-testid="sched-desc-input"]',
      )!.value,
    ).toBe("");
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-repo-input"]')!
        .value,
    ).toBe("acme/widgets");
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-base-input"]')!
        .value,
    ).toBe("main");
    expect(
      root
        .querySelector('[data-testid="sched-kind-daily"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      root
        .querySelector('[data-testid="sched-overlap-skip"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(root.querySelector('[data-testid="sched-title-error"]')).toBeNull();
    expect(
      root
        .querySelector('[data-testid="sched-title-input"]')
        ?.hasAttribute("aria-invalid"),
    ).toBe(false);
    expect(
      root
        .querySelector('[data-testid="schedule-dialog"]')!
        .querySelector("g-composition-view"),
    ).toBeNull();

    // Switching to github_workflow_run also shows clean defaults without stale errors or stale values
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-github_workflow_run"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="sched-trigger-workflow-input"]',
      )!.value,
    ).toBe("");
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="sched-trigger-conclusion-input"]',
      )!.value,
    ).toBe("failure");
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="sched-trigger-branch-input"]',
      )!.value,
    ).toBe("");
    expect(
      root.querySelector('[data-testid="sched-trigger-workflow-error"]'),
    ).toBeNull();

    // 2. Close via Scrim click after selecting Template target & switching to git_ref, then open Edit on sched-1
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-target-template"]',
      )!
      .click();
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-kind-git_ref"]')!
      .click();
    await flush(harness);
    setInput("sched-git-ref-repo-input", "stale/upstream");
    setInput("sched-git-ref-input", "bad-ref");
    root
      .querySelector<HTMLInputElement>('[data-testid="sched-git-ref-input"]')!
      .dispatchEvent(new Event("blur"));
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-git-ref-error"]'),
    ).not.toBeNull();

    // Click scrim to close
    root.querySelector<HTMLElement>(".scrim")!.click();
    await flush(harness);
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();

    // Edit sched-1 -> submits PATCH with sched-1's clean state, zero leaked templateId/git_ref
    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-1"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-git-ref-error"]'),
    ).toBeNull();
    expect(
      root
        .querySelector('[data-testid="sched-target-prompt"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-title-input"]')!
        .value,
    ).toBe("Audit deps");

    // Mutate sched-1 title to invalid empty, blur -> close via Escape -> reopen New schedule
    setInput("sched-title-input", "");
    root
      .querySelector<HTMLInputElement>('[data-testid="sched-title-input"]')!
      .dispatchEvent(new Event("blur"));
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-title-error"]'),
    ).not.toBeNull();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush(harness);
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();

    // Reopen New schedule after Escape from Edit -> must target POST /api/schedules (not PATCH), with clean defaults
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="sched-title-error"]')).toBeNull();
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-title-input"]')!
        .value,
    ).toBe("");

    setInput("sched-title-input", "Clean new schedule");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);

    const posts = api.calls.filter((c) => c.route === "POST /api/schedules");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      title: "Clean new schedule",
      repo: "acme/widgets",
      base: "main",
      recurrence: { kind: "daily", timeOfDay: "09:00", timeZone: "UTC" },
    });
    expect(api.calls.some((c) => c.route === "PATCH /api/schedules/{id}")).toBe(
      false,
    );
  });

  it("validates required and formatted schedule fields across target kinds and cadence kinds before submission", async () => {
    // Seed an unbound template-backed schedule and a custom-timezone schedule to verify edit validation & timezone clear
    api.schedules.push(
      {
        id: "sched-tmpl",
        title: "chore: bump pkg",
        description: "Bump pkg version in go.mod.",
        repo: "acme/widgets",
        base: "main",
        templateId: "tmpl-deploy-1",
        templateName: "Go upgrade",
        autoMerge: true,
        capabilities: [],
        recurrence: { kind: "everyNMinutes", everyNMinutes: 15 },
        overlap: "skip",
        source: "deployment",
        type: "template",
        enabled: true,
        nextRunAt: "2026-11-13T09:00:00Z",
        createdAt: "2026-11-01T00:00:00Z",
        revision: "rev-tmpl",
      },
      {
        id: "sched-tz",
        title: "NY check",
        description: "Check NY morning",
        repo: "acme/widgets",
        base: "main",
        autoMerge: false,
        capabilities: [],
        recurrence: {
          kind: "daily",
          timeOfDay: "09:00",
          timeZone: "America/New_York",
        },
        timeZone: "America/New_York",
        overlap: "skip",
        source: "deployment",
        type: "task",
        enabled: true,
        nextRunAt: "2026-11-13T14:00:00Z",
        createdAt: "2026-11-01T00:00:00Z",
        revision: "rev-tz",
      },
    );

    const harness = await RouterTestingHarness.create("/processes/schedules");
    await flush(harness);
    const root = harness.routeNativeElement!;

    const setInput = (testid: string, value: string): void => {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-testid="${testid}"]`,
      )!;
      el.value = value;
      el.dispatchEvent(new Event("input"));
    };

    // 1. Open New schedule: test blank pill-select clearing repo, everyNMinutes < 10 & empty, everyNHours, daily time/tz, monthly day, github_workflow_run, git_ref, suite base
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);

    setInput("sched-title-input", "Validation check");

    // Pick blank placeholder option in sched-repo-select -> clears repo & shows required error
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-repo-select"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-repo-select-opt-"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-repo-error"]')?.textContent,
    ).toContain("Repository (owner/name) is required");

    // Restore valid repo, break daily timeOfDay & timeZone -> blocks submit
    setInput("sched-repo-input", "acme/widgets");
    setInput("sched-time-input", "25:99");
    setInput("sched-tz-input", "Mars/Olympus");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-time-error"]')?.textContent,
    ).toContain("HH:MM");
    expect(
      root.querySelector('[data-testid="sched-tz-error"]')?.textContent,
    ).toContain("IANA");
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );

    // Every N minutes: clearing input does NOT silently submit 15; entering 5 fails min 10
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-everyNMinutes"]',
      )!
      .click();
    await flush(harness);
    setInput("sched-every-min-input", "");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-every-min-error"]')?.textContent,
    ).toContain("required");
    setInput("sched-every-min-input", "5");
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-every-min-error"]')?.textContent,
    ).toContain("at least 10");
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );

    // Every N hours: clearing or 0 blocks submit
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-everyNHours"]',
      )!
      .click();
    await flush(harness);
    setInput("sched-every-hr-input", "0");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-every-hr-error"]')?.textContent,
    ).toContain("at least 1");

    // Monthly: dayOfMonth 29 blocks submit
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-kind-monthly"]')!
      .click();
    await flush(harness);
    setInput("sched-time-input", "09:00");
    setInput("sched-tz-input", "UTC");
    setInput("sched-day-of-month-input", "29");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-day-of-month-error"]')
        ?.textContent,
    ).toContain("at most 28");

    // Suite target requires Base branch
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-kind-daily"]')!
      .click();
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-target-suite"]')!
      .click();
    await flush(harness);
    setInput("sched-base-input", "");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-base-error"]')?.textContent,
    ).toContain("Base branch is required");
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );

    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-cancel-btn"]')!
      .click();
    await flush(harness);

    // 2. Editing unbound template schedule (sched-tmpl) and clearing repo must block PATCH (no fallback to editing.repo)
    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-tmpl"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    setInput("sched-repo-input", "");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-repo-error"]')?.textContent,
    ).toContain("Repository (owner/name) is required");
    expect(api.calls.some((c) => c.route === "PATCH /api/schedules/{id}")).toBe(
      false,
    );
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-cancel-btn"]')!
      .click();
    await flush(harness);

    // 3. Clearing timeZone on sched-tz sends timeZone: "" on PATCH; failed PATCH renders error inside dialog and clears on reopen
    const basePatch = api.patch;
    let failNext = true;
    api.patch = async (route, params, body) => {
      if (route === "PATCH /api/schedules/{id}" && failNext) {
        failNext = false;
        throw { error: "stale revision" };
      }
      return basePatch(route, params, body);
    };

    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-tz"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    setInput("sched-tz-input", "");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-dialog-error"]')?.textContent,
    ).toContain("stale revision");

    // Cancel clears dialog error; reopening and saving succeeds with timeZone: ""
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-cancel-btn"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="sched-dialog-error"]')).toBeNull();
    setInput("sched-tz-input", "");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    const tzPatch = api.calls.find(
      (c) =>
        c.route === "PATCH /api/schedules/{id}" &&
        (c.params as Record<string, unknown>)?.["id"] === "sched-tz",
    )!;
    expect((tzPatch.body as Record<string, unknown>)["timeZone"]).toBe("");
  });

  it("appends provider=github-actions to schedule workflow run links when runId has gha: prefix", async () => {
    api.schedules[0] = {
      ...api.schedules[0],
      lastWorkflowRun: {
        runId: "gha:acme:widgets:88",
        conclusion: "failure",
        at: "2026-11-12T09:00:00Z",
      },
    };
    const harness = await RouterTestingHarness.create("/processes");
    await flush(harness);
    const root = harness.routeNativeElement!;

    const ghaLink = [...root.querySelectorAll<HTMLAnchorElement>("a")].find(
      (a) => a.textContent?.includes("gha:acme:widgets:88"),
    );
    expect(ghaLink).toBeDefined();
    expect(decodeURIComponent(ghaLink!.getAttribute("href")!)).toBe(
      "/ci/runs/gha:acme:widgets:88?provider=github-actions",
    );
  });

  it("validateScheduleDraft enforces boundary rules for all target and cadence kinds", () => {
    const baseDraft: ScheduleDraftSnapshot = {
      system: false,
      targetKind: "prompt",
      templateId: "",
      boundTemplateRepo: "",
      suiteId: "",
      title: "Nightly check",
      repo: "acme/widgets",
      base: "main",
      kind: "daily",
      everyNMinutes: "15",
      everyNHours: "6",
      timeOfDay: "09:00",
      timeZone: "UTC",
      dayOfMonth: "1",
      triggerWorkflow: "",
      gitRefRepo: "",
      gitRef: "refs/heads/main",
    };

    expect(validateScheduleDraft(baseDraft)).toEqual({});
    expect(
      validateScheduleDraft({ ...baseDraft, title: "   " }).title,
    ).toBeDefined();
    expect(
      validateScheduleDraft({ ...baseDraft, repo: "not-a-repo" }).repo,
    ).toBeDefined();
    expect(
      validateScheduleDraft({
        ...baseDraft,
        repo: "git.example.com/team/lib",
      }),
    ).toEqual({});
    expect(
      validateScheduleDraft({ ...baseDraft, base: "bad..branch" }).base,
    ).toBeDefined();
    expect(
      validateScheduleDraft({
        ...baseDraft,
        targetKind: "template",
        templateId: "t1",
        boundTemplateRepo: "acme/bound",
        repo: "",
      }),
    ).toEqual({});
    expect(
      validateScheduleDraft({
        ...baseDraft,
        targetKind: "template",
        templateId: "",
        repo: "acme/widgets",
      }).templateId,
    ).toBeDefined();
    expect(
      validateScheduleDraft({
        ...baseDraft,
        kind: "everyNMinutes",
        everyNMinutes: "9",
      }).everyNMinutes,
    ).toBeDefined();
    expect(
      validateScheduleDraft({
        ...baseDraft,
        kind: "everyNMinutes",
        everyNMinutes: "10",
      }),
    ).toEqual({});
    expect(
      validateScheduleDraft({
        ...baseDraft,
        kind: "everyNHours",
        everyNHours: "8785",
      }).everyNHours,
    ).toBeDefined();
    expect(
      validateScheduleDraft({
        ...baseDraft,
        kind: "git_ref",
        repo: "",
        gitRefRepo: "",
        gitRef: "main",
      }),
    ).toMatchObject({
      repo: expect.any(String),
      gitRefRepo: expect.any(String),
      gitRef: expect.any(String),
    });
    expect(
      validateScheduleDraft({
        ...baseDraft,
        system: true,
        title: "",
        repo: "",
        kind: "everyNMinutes",
        everyNMinutes: "5",
      }),
    ).toEqual({
      everyNMinutes: "Interval in minutes must be at least 10.",
    });
  });
});

describe("ProcessesPageComponent RBAC (G-06)", () => {
  let api: FakeProcessesApi;

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      configurable: true,
      writable: true,
    });
    api = new FakeProcessesApi();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: "processes", component: ProcessesPageComponent },
            { path: "processes/:tab", component: ProcessesPageComponent },
            { path: "task/:id", component: ProcessesPageComponent },
          ],
          withComponentInputBinding(),
        ),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function mount(
    url: string,
    accessConfig: GrainConfig["access"],
    targetRepos?: string[],
  ) {
    api.configBody = {
      ...api.configBody,
      access: accessConfig,
      ...(targetRepos !== undefined ? { targetRepos } : {}),
    };
    const harness = await RouterTestingHarness.create(url);
    const access = TestBed.inject(AccessService);
    access.setConfig(api.configBody);
    await flush(harness);
    const root = harness.routeNativeElement!;
    const setInput = async (testId: string, val: string) => {
      const el = root.querySelector<HTMLInputElement>(
        `[data-testid="${testId}"]`,
      )!;
      el.value = val;
      el.dispatchEvent(new Event("input"));
      await flush(harness);
    };
    const btn = (testId: string) =>
      root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    return { harness, root, access, setInput, btn };
  }

  it("disables or hides all mutation buttons and blocks deep links for grain/viewer across every tab", async () => {
    const viewerAccess: GrainConfig["access"] = {
      role: "grain/viewer",
      roles: ["grain/viewer"],
      full: false,
      scopes: [
        "schedules:read",
        "templates:read",
        "suites:read",
        "repos:read",
        "tasks:read",
      ],
    };

    const { harness, root, btn } = await mount(
      "/processes/schedules?new=1",
      viewerAccess,
    );

    // Schedules: ?new=1 blocked, New schedule hidden, all row actions disabled
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();
    expect(btn("proc-new-schedule-btn")).toBeNull();
    expect(btn("sched-run-now-btn")!.disabled).toBe(true);
    expect(btn("sched-toggle-enabled-btn")!.disabled).toBe(true);
    expect(btn("sched-edit-btn")!.disabled).toBe(true);
    expect(btn("sched-delete-btn")!.disabled).toBe(true);
    btn("sched-run-now-btn")!.click();
    await flush(harness);

    // Templates: ?launch=1 blocked, header actions hidden, Launch/Edit/Delete disabled
    await harness.navigateByUrl("/processes/templates?launch=1");
    await flush(harness);
    expect(
      root.querySelector('[data-testid="launch-template-dialog"]'),
    ).toBeNull();
    expect(btn("proc-launch-template-btn")).toBeNull();
    expect(btn("proc-new-template-btn")).toBeNull();
    btn("tmpl-row-tmpl-deploy-1")!.click();
    await flush(harness);
    expect(btn("tmpl-launch-btn")!.disabled).toBe(true);
    expect(btn("tmpl-edit-btn")!.disabled).toBe(true);
    expect(btn("tmpl-delete-btn")!.disabled).toBe(true);

    // Suites: ?run=1 blocked, header actions hidden, Run/Edit/Delete/Cancel disabled
    await harness.navigateByUrl("/processes/suites?run=1");
    await flush(harness);
    expect(root.querySelector('[data-testid="run-suite-dialog"]')).toBeNull();
    expect(btn("proc-run-suite-btn")).toBeNull();
    expect(btn("proc-new-suite-btn")).toBeNull();
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(true);
    expect(btn("suite-edit-btn")!.disabled).toBe(true);
    expect(btn("suite-delete-btn")!.disabled).toBe(true);

    btn("suites-subview-runs")!.click();
    await flush(harness);
    btn("suite-run-row-7")!.click();
    await flush(harness);
    expect(btn("suite-run-cancel-btn")!.disabled).toBe(true);

    // Declarations: toggle switch & accept disabled, add-workflow hidden, inspect remains clickable
    btn("proc-tab-declarations")!.click();
    await flush(harness);
    expect(btn("decl-toggle-switch")!.disabled).toBe(true);
    const acceptBtns = root.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="decl-accept-btn-"]',
    );
    expect(acceptBtns.length).toBeGreaterThan(0);
    for (const ab of Array.from(acceptBtns)) {
      expect(ab.disabled).toBe(true);
    }
    expect(btn("decl-add-workflow-btn")).toBeNull();
    const inspectBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid^="decl-inspect-wf-"]',
    );
    expect(inspectBtn).not.toBeNull();
    expect(inspectBtn!.disabled).toBe(false);

    const writeCalls = api.calls.filter(
      (c) =>
        c.method === "POST" ||
        c.method === "PATCH" ||
        c.method === "DELETE" ||
        c.method === "PUT",
    );
    expect(writeCalls).toEqual([]);
  });

  it("enforces repoLimits vs canGlobalScope('suites:write') for cross-repo, unbound, and single-repo suites", async () => {
    api.templates = [
      {
        id: "tmpl-a",
        name: "A1",
        title: "A1",
        description: "",
        repo: "acme/widgets",
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-a2",
        name: "A2",
        title: "A2",
        description: "",
        repo: "acme/widgets",
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-decl-a",
        name: "Decl A",
        title: "Decl A",
        description: "",
        declaredIn: {
          repo: "acme/widgets",
          path: ".grain/templates/a.yml",
        },
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-b",
        name: "B1",
        title: "B1",
        description: "",
        repo: "acme/other",
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-any",
        name: "Any repo",
        title: "Any",
        description: "",
        autoMerge: false,
        capabilities: [],
      },
    ];
    api.suites = [
      {
        id: "suite-multi",
        name: "Multi-repo sweep",
        mode: "count",
        count: 1,
        items: [{ templateId: "tmpl-a" }, { templateId: "tmpl-b" }],
      },
      {
        id: "suite-any",
        name: "Unbound sweep",
        mode: "count",
        count: 1,
        items: [{ templateId: "tmpl-any" }],
      },
      {
        id: "suite-other",
        name: "Other repo sweep",
        mode: "count",
        count: 1,
        items: [{ templateId: "tmpl-b" }],
      },
      {
        id: "suite-allowed",
        name: "Allowed single-repo sweep",
        mode: "count",
        count: 1,
        items: [{ templateId: "tmpl-a" }, { templateId: "tmpl-a2" }],
      },
      {
        id: "suite-decl-allowed",
        name: "Allowed declared single-repo sweep",
        mode: "count",
        count: 1,
        declaredIn: {
          repo: "acme/widgets",
          path: ".grain/suites/a.yml",
        },
        items: [{ templateId: "tmpl-decl-a" }],
      },
    ];

    const { harness, root, access, setInput, btn } = await mount(
      "/processes/suites",
      {
        role: "repo-suite-runner",
        roles: ["repo-suite-runner"],
        full: false,
        scopes: ["suites:read", "suites:write", "templates:read", "repos:read"],
        repoLimits: { "suites:write": ["acme/widgets"] },
      },
      ["acme/other", "acme/widgets"],
    );

    // Global suite creation/editing/deletion stays disabled
    expect(btn("proc-new-suite-btn")).toBeNull();
    // Cross-repo (suite-multi), unbound (suite-any), and other-repo (suite-other) cannot run
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(true);
    expect(btn("suite-edit-btn")!.disabled).toBe(true);
    expect(btn("suite-delete-btn")!.disabled).toBe(true);

    btn("suite-row-suite-any")!.click();
    await flush(harness);
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(true);

    btn("suite-row-suite-other")!.click();
    await flush(harness);
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(true);

    // Single-repo suites bound to allowed repo ARE runnable, while edit/delete stay global-gated
    btn("suite-row-suite-decl-allowed")!.click();
    await flush(harness);
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(false);

    btn("suite-row-suite-allowed")!.click();
    await flush(harness);
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(false);
    expect(btn("suite-edit-btn")!.disabled).toBe(true);
    expect(btn("suite-delete-btn")!.disabled).toBe(true);

    // Header Run suite button selects first runnable suite even when cross-repo suite is selected
    btn("suite-row-suite-multi")!.click();
    await flush(harness);
    expect(btn("proc-run-suite-btn")).not.toBeNull();
    btn("proc-run-suite-btn")!.click();
    await flush(harness);

    expect(
      root.querySelector('[data-testid="run-suite-dialog"]'),
    ).not.toBeNull();
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="run-suite-repo-input"]',
      )!.value,
    ).toBe("acme/widgets");
    expect(btn("run-suite-submit")!.disabled).toBe(false);

    // Unrunnable suites are disabled inside the Run suite picker
    btn("run-suite-picker")!.click();
    await flush(harness);
    const pickerOptions = Array.from(
      root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="run-suite-dialog"] [role="option"]',
      ),
    );
    expect(
      pickerOptions.find((o) => o.textContent?.includes("Multi-repo sweep"))!
        .disabled,
    ).toBe(true);
    expect(
      pickerOptions.find((o) => o.textContent?.includes("Unbound sweep"))!
        .disabled,
    ).toBe(true);
    expect(
      pickerOptions.find((o) => o.textContent?.includes("Other repo sweep"))!
        .disabled,
    ).toBe(true);
    expect(
      pickerOptions.find((o) =>
        o.textContent?.includes("Allowed single-repo sweep"),
      )!.disabled,
    ).toBe(false);
    btn("run-suite-picker")!.click();
    await flush(harness);

    // Changing target repo outside repoLimits blocks submission
    await setInput("run-suite-repo-input", "acme/other");
    expect(btn("run-suite-submit")!.disabled).toBe(true);
    await setInput("run-suite-repo-input", "acme/widgets");
    expect(btn("run-suite-submit")!.disabled).toBe(false);
    root.querySelector<HTMLElement>(".scrim")!.click();
    await flush(harness);

    // Granting global suites:write unlocks New suite, cross-repo Run suite, and Edit/Delete
    access.setConfig({
      access: {
        role: "global-suite-admin",
        roles: ["global-suite-admin"],
        full: false,
        scopes: ["suites:read", "suites:write", "templates:read", "repos:read"],
      },
    });
    await flush(harness);
    expect(btn("proc-new-suite-btn")).not.toBeNull();
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(false);
    expect(btn("suite-edit-btn")!.disabled).toBe(false);
    expect(btn("suite-delete-btn")!.disabled).toBe(false);

    btn("suite-row-suite-any")!.click();
    await flush(harness);
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(false);
  });

  it("hides proc-run-suite-btn and ignores ?run=1 when repo-scoped user has no single-repo runnable suite", async () => {
    api.templates = [
      {
        id: "tmpl-a",
        name: "A",
        title: "A",
        description: "",
        repo: "acme/widgets",
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-b",
        name: "B",
        title: "B",
        description: "",
        repo: "acme/other",
        autoMerge: false,
        capabilities: [],
      },
    ];
    api.suites = [
      {
        id: "suite-multi",
        name: "Multi",
        mode: "count",
        count: 1,
        items: [{ templateId: "tmpl-a" }, { templateId: "tmpl-b" }],
      },
    ];

    const { root, btn } = await mount("/processes/suites?run=1", {
      role: "repo-suite-runner",
      roles: ["repo-suite-runner"],
      full: false,
      scopes: ["suites:read", "suites:write", "templates:read"],
      repoLimits: { "suites:write": ["acme/widgets"] },
    });

    expect(btn("proc-run-suite-btn")).toBeNull();
    expect(root.querySelector('[data-testid="run-suite-dialog"]')).toBeNull();
    expect(btn("suite-open-run-dialog-btn")!.disabled).toBe(true);
  });

  it("enforces global scope vs repoLimits across schedules:write, templates:write, and tasks:write", async () => {
    api.templates = [
      ...api.templates,
      {
        id: "tmpl-sys",
        name: "System",
        title: "System workflow",
        description: "",
        system: true,
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-other",
        name: "Other",
        title: "Other repo template",
        description: "",
        repo: "acme/other",
        autoMerge: false,
        capabilities: [],
      },
    ];
    api.suiteRuns = [
      { ...api.suiteRuns[0], id: 7, repo: "acme/widgets" },
      { ...api.suiteRuns[0], id: 8, repo: "acme/other" },
      { ...api.suiteRuns[0], id: 9, repo: "" },
    ];

    const repoLimitedAccess: GrainConfig["access"] = {
      role: "repo-dev",
      roles: ["repo-dev"],
      full: false,
      scopes: [
        "schedules:read",
        "schedules:write",
        "templates:read",
        "templates:write",
        "suites:read",
        "tasks:read",
        "tasks:write",
        "repos:read",
      ],
      repoLimits: {
        "schedules:write": ["acme/widgets"],
        "templates:write": ["acme/widgets"],
        "tasks:write": ["acme/widgets"],
      },
    };

    const { harness, root, access, setInput, btn } = await mount(
      "/processes/schedules",
      repoLimitedAccess,
      ["acme/other", "acme/widgets"],
    );

    // Schedules: {id} routes require global schedules:write; POST allows repo-scoped creation
    expect(btn("sched-run-now-btn")!.disabled).toBe(true);
    expect(btn("sched-toggle-enabled-btn")!.disabled).toBe(true);
    expect(btn("sched-edit-btn")!.disabled).toBe(true);
    expect(btn("sched-delete-btn")!.disabled).toBe(true);
    expect(btn("proc-new-schedule-btn")).not.toBeNull();

    btn("proc-new-schedule-btn")!.click();
    await flush(harness);
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-repo-input"]')!
        .value,
    ).toBe("acme/widgets");
    expect(btn("sched-save-btn")!.disabled).toBe(false);
    await setInput("sched-repo-input", "acme/other");
    expect(btn("sched-save-btn")!.disabled).toBe(true);
    await setInput("sched-repo-input", "");
    expect(btn("sched-save-btn")!.disabled).toBe(true);
    root.querySelector<HTMLElement>(".scrim")!.click();
    await flush(harness);

    // Templates: {id} routes & repoless system launch require global scope
    btn("proc-tab-templates")!.click();
    await flush(harness);

    btn("tmpl-row-tmpl-sys")!.click();
    await flush(harness);
    expect(btn("tmpl-launch-btn")!.disabled).toBe(true);

    btn("tmpl-row-tmpl-other")!.click();
    await flush(harness);
    expect(btn("tmpl-launch-btn")!.disabled).toBe(true);
    expect(btn("tmpl-edit-btn")!.disabled).toBe(true);
    expect(btn("tmpl-delete-btn")!.disabled).toBe(true);

    btn("tmpl-row-repo:template:acme/widgets:release-notes")!.click();
    await flush(harness);
    expect(btn("tmpl-launch-btn")!.disabled).toBe(false);

    btn("tmpl-row-tmpl-deploy-1")!.click();
    await flush(harness);
    expect(btn("tmpl-launch-btn")!.disabled).toBe(false);
    expect(btn("tmpl-edit-btn")!.disabled).toBe(true);
    expect(btn("tmpl-delete-btn")!.disabled).toBe(true);

    btn("tmpl-launch-btn")!.click();
    await flush(harness);
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="launch-repo-input"]')!
        .value,
    ).toBe("acme/widgets");
    expect(btn("launch-template-submit")!.disabled).toBe(false);
    await setInput("launch-repo-input", "acme/other");
    expect(btn("launch-template-submit")!.disabled).toBe(true);
    root.querySelector<HTMLElement>(".scrim")!.click();
    await flush(harness);

    // Creating a template pre-selects permitted repo and blocks empty/other repo
    btn("proc-new-template-btn")!.click();
    await flush(harness);
    await setInput("tmpl-name-input", "Repo tmpl");
    await setInput("tmpl-title-input", "Title");
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="tmpl-repo-input"]')!
        .value,
    ).toBe("acme/widgets");
    expect(btn("tmpl-save-btn")!.disabled).toBe(false);
    await setInput("tmpl-repo-input", "");
    expect(btn("tmpl-save-btn")!.disabled).toBe(true);
    await setInput("tmpl-repo-input", "acme/other");
    expect(btn("tmpl-save-btn")!.disabled).toBe(true);
    root.querySelector<HTMLElement>(".scrim")!.click();
    await flush(harness);

    // Suite runs cancel: checks sr.repo or global tasks:write when repo is empty
    btn("proc-tab-suites")!.click();
    await flush(harness);
    btn("suites-subview-runs")!.click();
    await flush(harness);

    btn("suite-run-row-7")!.click();
    await flush(harness);
    expect(btn("suite-run-cancel-btn")!.disabled).toBe(false);

    btn("suite-run-row-8")!.click();
    await flush(harness);
    expect(btn("suite-run-cancel-btn")!.disabled).toBe(true);

    btn("suite-run-row-9")!.click();
    await flush(harness);
    expect(btn("suite-run-cancel-btn")!.disabled).toBe(true);

    // Global permissions unlock repo-less cancel, schedule {id} actions, template edit/delete & system launch
    access.setConfig({
      access: {
        ...repoLimitedAccess,
        role: "global-writer",
        roles: ["global-writer"],
        repoLimits: undefined,
      },
    });
    await flush(harness);
    expect(btn("suite-run-cancel-btn")!.disabled).toBe(false);

    btn("proc-tab-templates")!.click();
    await flush(harness);
    expect(btn("tmpl-edit-btn")!.disabled).toBe(false);
    expect(btn("tmpl-delete-btn")!.disabled).toBe(false);
    btn("tmpl-row-tmpl-sys")!.click();
    await flush(harness);
    expect(btn("tmpl-launch-btn")!.disabled).toBe(false);

    btn("proc-tab-schedules")!.click();
    await flush(harness);
    expect(btn("sched-run-now-btn")!.disabled).toBe(false);
    expect(btn("sched-toggle-enabled-btn")!.disabled).toBe(false);
    expect(btn("sched-edit-btn")!.disabled).toBe(false);
    expect(btn("sched-delete-btn")!.disabled).toBe(false);
  });

  it("shows inline insufficient global-scopes warnings, gates submission per declaration, and clears warnings when global scopes are granted", async () => {
    api.acceptances = [
      {
        id: "repo:suite:acme:widgets:deploy-sweep",
        kind: "suite",
        repo: "acme/widgets",
        requested: [
          'https://grain.dev/capabilities/gcp#gcp-key={"permission_set":"artifact-publisher"}',
          "https://grain.dev/capabilities/api#secrets:write",
        ],
        requestedAt: "2026-11-12T00:00:00Z",
        accepted: ["https://grain.dev/capabilities/api#secrets:write"],
        acceptedBy: "alice@example.com",
        acceptedCommit: "abcdef1234567890",
        acceptedAt: "2026-11-11T00:00:00Z",
        awaiting: true,
        unaccepted: [
          'https://grain.dev/capabilities/gcp#gcp-key={"permission_set":"artifact-publisher"}',
        ],
        needsScopes: ["capabilities:admin", "secrets:write"],
      },
      {
        id: "repo:template:acme:widgets:release-notes",
        kind: "template",
        repo: "acme/widgets",
        requested: ["push:refs/tags/v*"],
        requestedAt: "2026-11-12T01:00:00Z",
        awaiting: true,
        unaccepted: ["push:refs/tags/v*"],
        needsScopes: ["repos:write"],
      },
      {
        id: "ci:acme/widgets:publish-images",
        kind: "ci-job",
        repo: "acme/widgets",
        requested: [
          'https://grain.dev/capabilities/gcp#gcp-key={"permission_set":"artifact-publisher"}',
        ],
        requestedAt: "2026-11-10T00:00:00Z",
        accepted: [
          'https://grain.dev/capabilities/gcp#gcp-key={"permission_set":"artifact-publisher"}',
        ],
        acceptedBy: "alice@example.com",
        acceptedCommit: "0123456789ab",
        acceptedAt: "2026-11-10T01:00:00Z",
        awaiting: false,
        needsScopes: ["capabilities:admin"],
      },
    ];

    // User holds global repos:write + repo-limited secrets:write, and lacks capabilities:admin
    const { harness, root, access, btn } = await mount(
      "/processes/declarations",
      {
        role: "release-manager",
        roles: ["release-manager"],
        full: false,
        scopes: [
          "capabilities:read",
          "repos:read",
          "repos:write",
          "secrets:write",
        ],
        repoLimits: {
          "secrets:write": ["acme/widgets"],
        },
      },
      ["acme/widgets"],
    );

    // 1. Widened suite declaration lacks capabilities:admin and holds secrets:write only per-repo
    const suiteBtn = btn(
      "decl-accept-btn-repo:suite:acme:widgets:deploy-sweep",
    )!;
    const suiteWarn = root.querySelector<HTMLElement>(
      '[data-testid="decl-accept-warning-repo:suite:acme:widgets:deploy-sweep"]',
    )!;
    expect(suiteBtn.disabled).toBe(true);
    expect(suiteWarn).not.toBeNull();
    expect(suiteWarn.getAttribute("role")).toBe("status");
    expect(suiteBtn.getAttribute("aria-describedby")).toBe(suiteWarn.id);
    expect(suiteWarn.textContent).toContain("Insufficient scopes");
    expect(suiteWarn.textContent).toContain("release-manager");
    expect(suiteWarn.textContent).toContain("capabilities:admin");
    expect(suiteWarn.textContent).toContain("secrets:write");
    expect(suiteWarn.textContent).toContain("global scope(s)");
    // Widened item marker also appears
    const suiteItem = root.querySelector(
      '[data-testid="decl-acceptance-item-repo:suite:acme:widgets:deploy-sweep"]',
    )!;
    expect(suiteItem.textContent).toContain("New since accepted:");

    // Clicking disabled button never submits POST /api/declarations/accept
    suiteBtn.click();
    await flush(harness);
    expect(
      api.calls.some((c) => c.route === "POST /api/declarations/accept"),
    ).toBe(false);

    // 2. Template declaration needs only global repos:write (which IS held globally) -> NO warning, submission works
    const tmplBtn = btn(
      "decl-accept-btn-repo:template:acme:widgets:release-notes",
    )!;
    expect(tmplBtn.disabled).toBe(false);
    expect(
      root.querySelector(
        '[data-testid="decl-accept-warning-repo:template:acme:widgets:release-notes"]',
      ),
    ).toBeNull();
    expect(tmplBtn.hasAttribute("aria-describedby")).toBe(false);

    // 3. Already accepted CI declaration shows no warning even though user lacks capabilities:admin
    expect(
      root.querySelector(
        '[data-testid="decl-accept-warning-ci:acme/widgets:publish-images"]',
      ),
    ).toBeNull();
    expect(btn("decl-accept-btn-ci:acme/widgets:publish-images")).toBeNull();
    expect(
      root.querySelector(
        '[data-testid="decl-status-ci:acme/widgets:publish-images"]',
      )?.textContent,
    ).toContain("Accepted");

    // 4. Granting global scopes removes the warning and enables submission
    access.setConfig({
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    });
    await flush(harness);
    expect(
      btn("decl-accept-btn-repo:suite:acme:widgets:deploy-sweep")!.disabled,
    ).toBe(false);
    expect(
      root.querySelector(
        '[data-testid="decl-accept-warning-repo:suite:acme:widgets:deploy-sweep"]',
      ),
    ).toBeNull();
  });

  it("gates declaration acceptance while config is loading and while a submit request is in flight, and renders cleanly on 390px mobile", async () => {
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      configurable: true,
      writable: true,
    });

    api.acceptances = [
      {
        id: "ci:acme/widgets:very-long-deployment-preview-declaration-name",
        kind: "ci-job",
        repo: "acme/widgets",
        requested: [
          'https://grain.dev/capabilities/gcp#gcp-key={"permission_set":"artifact-publisher-with-long-name"}',
          'https://grain.dev/capabilities/host-script#run={"script":"deploy-preview"}',
        ],
        requestedAt: "2026-11-12T00:00:00Z",
        awaiting: true,
        unaccepted: [
          'https://grain.dev/capabilities/gcp#gcp-key={"permission_set":"artifact-publisher-with-long-name"}',
        ],
        needsScopes: ["capabilities:admin"],
      },
    ];

    let resolveConfig!: (cfg: GrainConfig) => void;
    api.config = () =>
      new Promise<GrainConfig>((res) => {
        resolveConfig = res;
      });

    const harness = await RouterTestingHarness.create(
      "/processes/declarations",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;

    // On 390px phone, select repo to enter mobile detail view
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="decl-repo-row-acme/widgets"]',
      )!
      .click();
    await flush(harness);
    expect(
      root
        .querySelector(".proc-split")
        ?.classList.contains("has-mobile-detail"),
    ).toBe(true);

    const declId =
      "ci:acme/widgets:very-long-deployment-preview-declaration-name";
    const acceptBtn = root.querySelector<HTMLButtonElement>(
      `[data-testid="decl-accept-btn-${declId}"]`,
    )!;
    // Before config finishes loading: button is gated without flashing an erroneous missing-scopes warning
    expect(acceptBtn.disabled).toBe(true);
    expect(
      root.querySelector(`[data-testid="decl-accept-warning-${declId}"]`),
    ).toBeNull();

    // Resolve config as grain/viewer -> inline warning appears inside mobile detail card
    resolveConfig({
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["capabilities:read", "repos:read"],
      },
      targetRepos: ["acme/widgets"],
      approvedByDefault: true,
    });
    await flush(harness);

    expect(acceptBtn.disabled).toBe(true);
    const warnEl = root.querySelector<HTMLElement>(
      `[data-testid="decl-accept-warning-${declId}"]`,
    )!;
    expect(warnEl).not.toBeNull();
    expect(warnEl.classList.contains("proc-decl-warning")).toBe(true);
    expect(warnEl.textContent).toContain("grain/viewer");
    expect(warnEl.textContent).toContain("capabilities:admin");
    expect(warnEl.closest(".proc-decl-item")).not.toBeNull();

    // Grant full access and verify single-flight protection during POST
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    });
    await flush(harness);
    expect(acceptBtn.disabled).toBe(false);
    expect(
      root.querySelector(`[data-testid="decl-accept-warning-${declId}"]`),
    ).toBeNull();

    let resolvePost!: (v: DeclarationAcceptanceView) => void;
    const origPost = api.post;
    api.post = (
      route: string,
      params?: unknown,
      body?: Record<string, unknown>,
    ) => {
      if (route === "POST /api/declarations/accept") {
        api.calls.push({ method: "POST", route, params, body });
        return new Promise<DeclarationAcceptanceView>((res) => {
          resolvePost = res;
        });
      }
      return origPost(route, params, body);
    };

    acceptBtn.click();
    harness.detectChanges();
    expect(acceptBtn.disabled).toBe(true);
    expect(acceptBtn.textContent?.trim()).toBe("Accepting…");
    // Second click while in flight does not send duplicate POST
    acceptBtn.click();
    expect(
      api.calls.filter((c) => c.route === "POST /api/declarations/accept"),
    ).toHaveLength(1);

    api.acceptances[0].awaiting = false;
    api.acceptances[0].acceptedBy = "alice@example.com";
    resolvePost(structuredClone(api.acceptances[0]));
    await flush(harness);
    expect(
      root.querySelector(`[data-testid="decl-status-${declId}"]`)?.textContent,
    ).toContain("Accepted");
  });
});
