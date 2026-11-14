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
import { SnackbarService } from "../services/snackbar.service";
import { ProcessesPageComponent } from "./processes-page.component";
import type {
  Composition,
  DeclarationAcceptanceView,
  RepoDefaultsView,
  RepoWorkflowsResponse,
  Schedule,
  ScheduleRun,
  Suite,
  SuiteRun,
  Template,
  TemplateField,
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

  reachableRepos = ["acme/widgets"];

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
      return Promise.resolve([...this.reachableRepos]);
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

  it("triggers required and format field validations before schedule submission across targets and cadences", async () => {
    const setInput = async (
      root: HTMLElement,
      harness: RouterTestingHarness,
      testid: string,
      value: string,
      blur = false,
    ) => {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-testid="${testid}"]`,
      )!;
      el.value = value;
      el.dispatchEvent(new Event("input"));
      if (blur) el.dispatchEvent(new Event("blur"));
      await flush(harness);
      return el;
    };

    const harness = await RouterTestingHarness.create("/processes/schedules");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // 1. Open New schedule -> immediate submit triggers required Title validation and blocks POST
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);

    const saveBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="sched-save-btn"]',
    )!;
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    await flush(harness);

    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );
    const titleInput = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-title-input"]',
    )!;
    expect(titleInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      root.querySelector('[data-testid="sched-title-error"]')?.textContent,
    ).toContain("Task title is required");
    expect(document.activeElement).toBe(titleInput);

    // Typing valid title clears Title error immediately
    await setInput(root, harness, "sched-title-input", "Nightly check");
    expect(titleInput.getAttribute("aria-invalid")).toBeNull();
    expect(root.querySelector('[data-testid="sched-title-error"]')).toBeNull();

    // 2. Repository required & owner/name format validation
    await setInput(root, harness, "sched-repo-input", "", true);
    expect(
      root.querySelector('[data-testid="sched-repo-error"]')?.textContent,
    ).toContain("Repository (owner/name) is required");
    await setInput(root, harness, "sched-repo-input", "not-a-repo", true);
    expect(
      root.querySelector('[data-testid="sched-repo-error"]')?.textContent,
    ).toContain("owner/name");
    await setInput(root, harness, "sched-repo-input", "acme/widgets", true);
    expect(root.querySelector('[data-testid="sched-repo-error"]')).toBeNull();

    // 3. Suite target requires Base branch and valid branch syntax
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-target-suite"]')!
      .click();
    await flush(harness);
    await setInput(root, harness, "sched-base-input", "");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );
    expect(
      root.querySelector('[data-testid="sched-base-error"]')?.textContent,
    ).toContain("Base branch is required");
    await setInput(root, harness, "sched-base-input", "bad..branch", true);
    expect(
      root.querySelector('[data-testid="sched-base-error"]')?.textContent,
    ).toContain("valid git branch name");
    await setInput(root, harness, "sched-base-input", "main", true);
    expect(root.querySelector('[data-testid="sched-base-error"]')).toBeNull();

    // Switch back to Inline prompt for cadence checks
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-target-prompt"]')!
      .click();
    await flush(harness);
    await setInput(root, harness, "sched-title-input", "Cadence test");

    // 4. Daily timeOfDay & timeZone validation
    await setInput(root, harness, "sched-time-input", "25:99", true);
    expect(
      root.querySelector('[data-testid="sched-time-error"]')?.textContent,
    ).toContain("HH:MM");
    await setInput(root, harness, "sched-tz-input", "Mars/Olympus", true);
    expect(
      root.querySelector('[data-testid="sched-tz-error"]')?.textContent,
    ).toContain("IANA time zone");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );
    await setInput(root, harness, "sched-time-input", "09:30", true);
    await setInput(root, harness, "sched-tz-input", "UTC", true);

    // 5. everyNMinutes: no silent coercion on empty/0, enforces minimum 10
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-everyNMinutes"]',
      )!
      .click();
    await flush(harness);
    const minEl = await setInput(root, harness, "sched-every-min-input", "5");
    expect(minEl.value).toBe("5");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-every-min-error"]')?.textContent,
    ).toContain("between 10");
    await setInput(root, harness, "sched-every-min-input", "", true);
    expect(minEl.value).toBe("");
    expect(
      root.querySelector('[data-testid="sched-every-min-error"]')?.textContent,
    ).toContain("required");
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );

    // 6. everyNHours validation
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-everyNHours"]',
      )!
      .click();
    await flush(harness);
    await setInput(root, harness, "sched-every-hr-input", "0", true);
    expect(
      root.querySelector('[data-testid="sched-every-hr-error"]')?.textContent,
    ).toContain("between 1");

    // 7. monthly dayOfMonth validation
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-kind-monthly"]')!
      .click();
    await flush(harness);
    await setInput(root, harness, "sched-day-of-month-input", "32", true);
    expect(
      root.querySelector('[data-testid="sched-day-of-month-error"]')
        ?.textContent,
    ).toContain("between 1 and 31");

    // 8. github_workflow_run requires Workflow name or file
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-github_workflow_run"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-trigger-workflow-error"]'),
    ).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );
    expect(
      root.querySelector('[data-testid="sched-trigger-workflow-error"]')
        ?.textContent,
    ).toContain("Workflow name or file is required");

    // 9. git_ref validates watched ref format (must start with refs/) and watched repo
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-kind-git_ref"]')!
      .click();
    await flush(harness);
    await setInput(root, harness, "sched-git-ref-input", "main", true);
    expect(
      root.querySelector('[data-testid="sched-git-ref-error"]')?.textContent,
    ).toContain("refs/");
    await setInput(root, harness, "sched-git-ref-repo-input", "badrepo", true);
    expect(
      root.querySelector('[data-testid="sched-git-ref-repo-error"]')
        ?.textContent,
    ).toContain("owner/name");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(
      false,
    );

    // Fix git_ref fields -> submits POST /api/schedules cleanly
    await setInput(root, harness, "sched-git-ref-repo-input", "");
    await setInput(root, harness, "sched-git-ref-input", "refs/heads/main");
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "POST /api/schedules")).toBe(true);
  });

  it("resets all schedule editor form controls and pending validations on close and re-open", async () => {
    api.schedules.push({
      id: "sched-tmpl",
      title: "Go upgrade",
      description: "",
      repo: "acme/widgets",
      base: "main",
      autoMerge: true,
      templateId: "tmpl-deploy-1",
      templateName: "Go upgrade",
      capabilities: [],
      recurrence: { kind: "daily", timeOfDay: "09:00", timeZone: "UTC" },
      timeZone: "UTC",
      overlap: "skip",
      source: "deployment",
      type: "template",
      enabled: true,
      nextRunAt: "2026-11-13T09:00:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      revision: "rev-tmpl",
    });
    const basePost = api.post;
    let failNextSave = true;
    api.post = (
      route: string,
      params?: Record<string, unknown>,
      body?: Record<string, unknown>,
    ) => {
      if (route === "POST /api/schedules" && failNextSave) {
        failNextSave = false;
        api.calls.push({ method: "POST", route, params, body });
        return new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                Object.assign(new Error("simulated schedule error"), {
                  status: 400,
                  error: { error: "simulated schedule error" },
                }),
              ),
            0,
          ),
        );
      }
      return basePost(route, params, body);
    };

    const harness = await RouterTestingHarness.create("/processes/schedules");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // 1. Open Edit on sched-tmpl, clear repo -> blocked before PATCH (must not fall back to editing.repo)
    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-tmpl"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    const repoInput = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-repo-input"]',
    )!;
    repoInput.value = "";
    repoInput.dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(api.calls.some((c) => c.route === "PATCH /api/schedules/{id}")).toBe(
      false,
    );
    expect(
      root.querySelector('[data-testid="sched-repo-error"]')?.textContent,
    ).toContain("Repository (owner/name) is required");

    // 2. Close via Cancel -> Reopen New schedule: must reset target, repo, errors, and submit POST (not PATCH)
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-cancel-btn"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="schedule-dialog"] h2')?.textContent,
    ).toContain("New schedule or trigger");
    expect(root.querySelector('[data-testid="sched-repo-error"]')).toBeNull();
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-repo-input"]')!
        .value,
    ).toBe("acme/widgets");
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-title-input"]')!
        .value,
    ).toBe("");

    // Mutate form, switch to github_workflow_run, fail API save to populate sched-dialog-error, then close via scrim
    const tIn = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-title-input"]',
    )!;
    tIn.value = "Stale draft";
    tIn.dispatchEvent(new Event("input"));
    const dIn = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="sched-desc-input"]',
    )!;
    dIn.value = "Stale prompt";
    dIn.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="sched-kind-github_workflow_run"]',
      )!
      .click();
    await flush(harness);
    const wfIn = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-trigger-workflow-input"]',
    )!;
    wfIn.value = "StaleWF";
    wfIn.dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-dialog-error"]')?.textContent,
    ).toContain("simulated schedule error");

    // Close via scrim
    root.querySelector<HTMLElement>(".scrim")!.click();
    await flush(harness);
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();
    expect(root.querySelector('[data-testid="proc-action-error"]')).toBeNull();

    // 3. Reopen New schedule -> all controls and errors completely reset
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="sched-dialog-error"]')).toBeNull();
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
      root
        .querySelector('[data-testid="sched-kind-daily"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
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

    // Switch back to daily, fill valid title, and verify clean POST /api/schedules
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-kind-daily"]')!
      .click();
    await flush(harness);
    const cleanTitle = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-title-input"]',
    )!;
    cleanTitle.value = "Fresh schedule";
    cleanTitle.dispatchEvent(new Event("input"));
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-save-btn"]')!
      .click();
    await flush(harness);

    const posts = api.calls.filter((c) => c.route === "POST /api/schedules");
    expect(posts.length).toBe(2);
    expect(posts[1].body).toMatchObject({
      title: "Fresh schedule",
      description: "",
      repo: "acme/widgets",
      base: "main",
      recurrence: { kind: "daily", timeOfDay: "09:00", timeZone: "UTC" },
    });

    // 4. Edit sched-1, mutate title + clear workflow to trigger error, close via Escape, then reopen sched-gitref
    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-1"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    const editTitle = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-title-input"]',
    )!;
    editTitle.value = "";
    editTitle.dispatchEvent(new Event("input"));
    editTitle.dispatchEvent(new Event("blur"));
    await flush(harness);
    expect(
      root.querySelector('[data-testid="sched-title-error"]'),
    ).not.toBeNull();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush(harness);
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();

    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-gitref"]')!
      .click();
    await flush(harness);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
      .click();
    await flush(harness);
    expect(root.querySelector('[data-testid="sched-title-error"]')).toBeNull();
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="sched-title-input"]')!
        .value,
    ).toBe("Sync upstream tag");
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="sched-git-ref-input"]',
      )!.value,
    ).toBe("refs/tags/latest");
  });

  it("appends provider=github-actions to lastWorkflowRun links when runId is a GitHub Actions run", async () => {
    api.schedules[0] = {
      ...api.schedules[0],
      lastWorkflowRun: {
        runId: "gha:acme:widgets:9001",
        conclusion: "failure",
      },
    };
    const harness = await RouterTestingHarness.create("/processes");
    await flush(harness);
    const root = harness.routeNativeElement!;

    root
      .querySelector<HTMLElement>('[data-testid="sched-row-sched-1"]')!
      .click();
    await flush(harness);

    const runLink = Array.from(root.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "gha:acme:widgets:9001",
    );
    expect(runLink?.getAttribute("href")).toBe(
      "/ci/runs/gha:acme:widgets:9001?provider=github-actions",
    );
  });

  it("disables mutating buttons and blocks deep-link dialogs for grain/viewer across all tabs", async () => {
    api.configBody = {
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: [
          "schedules:read",
          "templates:read",
          "suites:read",
          "tasks:read",
          "repos:read",
          "capabilities:read",
        ],
        repoLimits: {},
      },
      targetRepos: ["acme/widgets"],
      approvedByDefault: false,
    };
    api.templates.push({
      id: "tmpl-widgets",
      name: "Widgets lint",
      title: "Lint widgets",
      description: "Run lint in acme/widgets",
      repo: "acme/widgets",
      autoMerge: false,
      capabilities: [],
      revision: "rev-w1",
    });

    // 1. Schedules tab + ?new=1 deep link blocked
    const harness = await RouterTestingHarness.create(
      "/processes/schedules?new=1",
    );
    await flush(harness);
    const root = harness.routeNativeElement!;
    expect(root.querySelector('[data-testid="schedule-dialog"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="proc-new-schedule-btn"]'),
    ).toBeNull();
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="sched-run-now-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="sched-toggle-enabled-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="sched-delete-btn"]')!
        .disabled,
    ).toBe(true);

    // 2. Templates tab + ?launch=1 deep link blocked
    await harness.navigateByUrl("/processes/templates?launch=1");
    await flush(harness);
    expect(root.querySelector('[data-testid="launch-dialog"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="proc-launch-template-btn"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="proc-new-template-btn"]'),
    ).toBeNull();
    root
      .querySelector<HTMLElement>('[data-testid="tmpl-row-tmpl-deploy-1"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="tmpl-launch-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="tmpl-edit-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="tmpl-delete-btn"]')!
        .disabled,
    ).toBe(true);

    // 3. Suites + Suite runs tab + ?run=1 deep link blocked
    await harness.navigateByUrl("/processes/suites?run=1");
    await flush(harness);
    expect(root.querySelector('[data-testid="run-suite-dialog"]')).toBeNull();
    expect(root.querySelector('[data-testid="proc-run-suite-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="proc-new-suite-btn"]')).toBeNull();
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-open-run-dialog-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="suite-edit-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="suite-delete-btn"]')!
        .disabled,
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>('[data-testid="suites-subview-runs"]')!
      .click();
    await flush(harness);
    root.querySelector<HTMLElement>('[data-testid="suite-run-row-7"]')!.click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-run-cancel-btn"]',
      )!.disabled,
    ).toBe(true);

    // 4. Declarations tab
    await harness.navigateByUrl("/processes/declarations");
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="decl-toggle-switch"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="decl-add-workflow-btn"]'),
    ).toBeNull();
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="decl-accept-btn-repo:template:acme/widgets:release-notes"]',
      )!.disabled,
    ).toBe(true);
  });

  it("enforces canGlobalScope vs repo-scoped permissions for suite execution, suite edits, and suite-run cancellation", async () => {
    api.configBody = {
      access: {
        role: "widgets-suite-runner",
        roles: ["widgets-suite-runner"],
        full: false,
        scopes: [
          "suites:read",
          "suites:write",
          "templates:read",
          "tasks:read",
          "tasks:write",
        ],
        repoLimits: {
          "suites:write": ["acme/widgets"],
          "tasks:write": ["acme/widgets"],
        },
      },
      targetRepos: ["acme/gadgets", "acme/widgets"],
      approvedByDefault: true,
    };
    api.reachableRepos = ["acme/gadgets", "acme/widgets"];
    api.templates.push(
      {
        id: "tmpl-widgets",
        name: "Widgets pass",
        title: "Widgets pass",
        description: "Runs in acme/widgets",
        repo: "acme/widgets",
        autoMerge: false,
        capabilities: [],
        revision: "rev-w",
      },
      {
        id: "tmpl-gadgets",
        name: "Gadgets pass",
        title: "Gadgets pass",
        description: "Runs in acme/gadgets",
        repo: "acme/gadgets",
        autoMerge: false,
        capabilities: [],
        revision: "rev-g",
      },
    );
    api.suites.push(
      {
        id: "suite-widgets",
        name: "Widgets single-repo",
        items: [{ templateId: "tmpl-widgets", templateName: "Widgets pass" }],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
        revision: "rev-sw",
      },
      {
        id: "suite-gadgets",
        name: "Gadgets single-repo",
        items: [{ templateId: "tmpl-gadgets", templateName: "Gadgets pass" }],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
        revision: "rev-sg",
      },
      {
        id: "suite-multi",
        name: "Cross-repo sweep",
        items: [
          { templateId: "tmpl-widgets", templateName: "Widgets pass" },
          { templateId: "tmpl-gadgets", templateName: "Gadgets pass" },
        ],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
        revision: "rev-sm",
      },
    );
    api.tasks.push({
      id: "403",
      title: "Gadgets task",
      state: "running",
      repo: "acme/gadgets",
      suiteRun: true,
    });
    api.suiteRuns.push({
      id: 18,
      suiteId: "suite-multi",
      suiteName: "Cross-repo sweep",
      repo: "",
      base: "main",
      mode: "count",
      count: 1,
      requireApproval: false,
      autoMerge: false,
      status: "active",
      pass: 1,
      createdAt: "2026-11-12T01:00:00Z",
      tasks: [
        {
          taskId: "401",
          templateId: "tmpl-widgets",
          pass: 1,
          state: "running",
          approved: true,
          openedPullRequest: false,
          proposed: false,
        },
        {
          taskId: "403",
          templateId: "tmpl-gadgets",
          pass: 1,
          state: "running",
          approved: true,
          openedPullRequest: false,
          proposed: false,
        },
      ],
    });

    const harness = await RouterTestingHarness.create("/processes/suites");
    await flush(harness);
    const root = harness.routeNativeElement!;

    // Global suite creation is hidden without global suites:write, while header Run suite appears because suite-widgets is runnable
    expect(root.querySelector('[data-testid="proc-new-suite-btn"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="proc-run-suite-btn"]'),
    ).not.toBeNull();

    // Unbound ("any") suite-1: Run suite, Edit, and Delete all disabled
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-open-run-dialog-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="suite-edit-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="suite-delete-btn"]')!
        .disabled,
    ).toBe(true);

    // Multi-repo ("several") suite-multi: Run suite disabled
    root
      .querySelector<HTMLElement>('[data-testid="suite-row-suite-multi"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-open-run-dialog-btn"]',
      )!.disabled,
    ).toBe(true);

    // Unauthorized single-repo suite-gadgets: Run suite disabled
    root
      .querySelector<HTMLElement>('[data-testid="suite-row-suite-gadgets"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-open-run-dialog-btn"]',
      )!.disabled,
    ).toBe(true);

    // Authorized single-repo suite-widgets: Run suite enabled, Edit/Delete still disabled
    root
      .querySelector<HTMLElement>('[data-testid="suite-row-suite-widgets"]')!
      .click();
    await flush(harness);
    const runBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="suite-open-run-dialog-btn"]',
    )!;
    expect(runBtn.disabled).toBe(false);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="suite-edit-btn"]')!
        .disabled,
    ).toBe(true);

    // Opening Run suite prefills suite-widgets + acme/widgets, excludes unauthorized suites in picker, and validates target repo
    runBtn.click();
    await flush(harness);
    const repoInput = root.querySelector<HTMLInputElement>(
      '[data-testid="run-suite-repo-input"]',
    )!;
    expect(repoInput.value).toBe("acme/widgets");
    const submitRunBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="run-suite-submit"]',
    )!;
    expect(submitRunBtn.disabled).toBe(false);

    root
      .querySelector<HTMLButtonElement>('[data-testid="run-suite-picker"]')!
      .click();
    await flush(harness);
    const pickerOpts = [
      ...root.querySelectorAll('[role="listbox"] [role="option"]'),
    ].map((el) => el.textContent?.trim());
    expect(pickerOpts).toEqual(["Widgets single-repo"]);

    repoInput.value = "acme/gadgets";
    repoInput.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(submitRunBtn.disabled).toBe(true);

    repoInput.value = "acme/widgets";
    repoInput.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(submitRunBtn.disabled).toBe(false);
    submitRunBtn.click();
    await flush(harness);
    expect(
      api.calls.filter((c) => c.route === "POST /api/suite-runs").length,
    ).toBe(1);

    // Cancel suite run: authorized on #7 (acme/widgets), disabled on #8 (cross-repo acme/widgets + acme/gadgets)
    root
      .querySelector<HTMLButtonElement>('[data-testid="suites-subview-runs"]')!
      .click();
    await flush(harness);
    root.querySelector<HTMLElement>('[data-testid="suite-run-row-7"]')!.click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-run-cancel-btn"]',
      )!.disabled,
    ).toBe(false);

    root
      .querySelector<HTMLElement>('[data-testid="suite-run-row-18"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="suite-run-cancel-btn"]',
      )!.disabled,
    ).toBe(true);
  });

  it("blocks ?run=1 deep link when repo-scoped suites:write only has cross-repo or unauthorized suites", async () => {
    api.configBody = {
      access: {
        role: "widgets-suite-runner",
        roles: ["widgets-suite-runner"],
        full: false,
        scopes: ["suites:read", "suites:write", "templates:read"],
        repoLimits: { "suites:write": ["acme/widgets"] },
      },
      targetRepos: ["acme/widgets", "acme/gadgets"],
      approvedByDefault: true,
    };
    api.templates.push({
      id: "tmpl-gadgets",
      name: "Gadgets pass",
      title: "Gadgets pass",
      description: "Runs in acme/gadgets",
      repo: "acme/gadgets",
      autoMerge: false,
      capabilities: [],
      revision: "rev-g",
    });
    api.suites.push({
      id: "suite-gadgets",
      name: "Gadgets single-repo",
      items: [{ templateId: "tmpl-gadgets", templateName: "Gadgets pass" }],
      mode: "count",
      count: 1,
      requireApproval: false,
      autoMerge: false,
      autoApproveProposals: false,
      revision: "rev-sg",
    });

    const harness = await RouterTestingHarness.create(
      "/processes/suites?run=1",
    );
    await flush(harness);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="run-suite-dialog"]',
      ),
    ).toBeNull();
  });

  it("enforces canGlobalScope vs repo-scoped permissions across schedules, templates, composition reads, and declarations", async () => {
    api.configBody = {
      access: {
        role: "widgets-ops",
        roles: ["widgets-ops"],
        full: false,
        scopes: [
          "schedules:read",
          "schedules:write",
          "templates:read",
          "templates:write",
          "tasks:read",
          "tasks:write",
          "tasks:from-template",
          "repos:read",
          "repos:write",
          "capabilities:read",
        ],
        repoLimits: {
          "schedules:read": ["acme/widgets"],
          "schedules:write": ["acme/widgets"],
          "templates:read": ["acme/widgets"],
          "templates:write": ["acme/widgets"],
          "tasks:write": ["acme/widgets"],
          "tasks:from-template": ["acme/widgets"],
          "repos:write": ["acme/widgets"],
        },
      },
      targetRepos: ["acme/widgets", "acme/gadgets"],
      approvedByDefault: true,
    };
    api.reachableRepos = ["acme/widgets", "acme/gadgets"];
    api.templates.push(
      {
        id: "tmpl-sys",
        name: "System health check",
        title: "System check",
        description: "Controller-wide system template",
        system: true,
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "tmpl-widgets",
        name: "Widgets task",
        title: "Widgets task",
        description: "Scoped to acme/widgets",
        repo: "acme/widgets",
        autoMerge: false,
        capabilities: [],
        revision: "rev-tw",
      },
      {
        id: "tmpl-gadgets",
        name: "Gadgets task",
        title: "Gadgets task",
        description: "Scoped to acme/gadgets",
        repo: "acme/gadgets",
        autoMerge: false,
        capabilities: [],
        revision: "rev-tg",
      },
    );

    // 1. Schedules: {id} mutations disabled and GET composition skipped when schedules:read is repo-scoped
    const harness = await RouterTestingHarness.create("/processes/schedules");
    await flush(harness);
    const root = harness.routeNativeElement!;
    expect(
      api.calls.some((c) => c.route === "GET /api/schedules/{id}/composition"),
    ).toBe(false);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="sched-run-now-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="sched-toggle-enabled-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="sched-edit-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="sched-delete-btn"]')!
        .disabled,
    ).toBe(true);

    // New schedule disables Save for unauthorized default/other repo and empty repo, enables Save for acme/widgets
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-schedule-btn"]',
      )!
      .click();
    await flush(harness);
    const schedSave = root.querySelector<HTMLButtonElement>(
      '[data-testid="sched-save-btn"]',
    )!;
    const schedRepo = root.querySelector<HTMLInputElement>(
      '[data-testid="sched-repo-input"]',
    )!;
    // knownRepos() sorts alphabetically -> "acme/gadgets" is first and unauthorized
    expect(schedRepo.value).toBe("acme/gadgets");
    expect(schedSave.disabled).toBe(true);
    schedRepo.value = "";
    schedRepo.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(schedSave.disabled).toBe(true);
    schedRepo.value = "acme/widgets";
    schedRepo.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(schedSave.disabled).toBe(false);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sched-cancel-btn"]')!
      .click();
    await flush(harness);

    // 2. Templates: system, unbound, and other-repo templates disabled; GET composition skipped
    api.calls = [];
    await harness.navigateByUrl("/processes/templates");
    await flush(harness);
    expect(
      api.calls.some((c) => c.route === "GET /api/templates/{id}/composition"),
    ).toBe(false);

    for (const tid of ["tmpl-deploy-1", "tmpl-sys", "tmpl-gadgets"]) {
      root
        .querySelector<HTMLElement>(`[data-testid="tmpl-row-${tid}"]`)!
        .click();
      await flush(harness);
      expect(
        root.querySelector<HTMLButtonElement>(
          '[data-testid="tmpl-launch-btn"]',
        )!.disabled,
      ).toBe(true);
    }

    root
      .querySelector<HTMLElement>('[data-testid="tmpl-row-tmpl-widgets"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="tmpl-launch-btn"]')!
        .disabled,
    ).toBe(false);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="tmpl-edit-btn"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="tmpl-delete-btn"]')!
        .disabled,
    ).toBe(true);

    // New template requires allowed repo (not blank, not acme/gadgets)
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="proc-new-template-btn"]',
      )!
      .click();
    await flush(harness);
    const tName = root.querySelector<HTMLInputElement>(
      '[data-testid="tmpl-name-input"]',
    )!;
    const tTitle = root.querySelector<HTMLInputElement>(
      '[data-testid="tmpl-title-input"]',
    )!;
    const tRepo = root.querySelector<HTMLInputElement>(
      '[data-testid="tmpl-repo-input"]',
    )!;
    const tSave = root.querySelector<HTMLButtonElement>(
      '[data-testid="tmpl-save-btn"]',
    )!;
    tName.value = "Scoped tmpl";
    tName.dispatchEvent(new Event("input"));
    tTitle.value = "Scoped tmpl";
    tTitle.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(tSave.disabled).toBe(true);
    tRepo.value = "acme/gadgets";
    tRepo.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(tSave.disabled).toBe(true);
    tRepo.value = "acme/widgets";
    tRepo.dispatchEvent(new Event("input"));
    await flush(harness);
    expect(tSave.disabled).toBe(false);

    // 3. Declarations: acme/widgets allowed, acme/gadgets disabled
    await harness.navigateByUrl("/processes/declarations");
    await flush(harness);
    root
      .querySelector<HTMLElement>('[data-testid="decl-repo-row-acme/widgets"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="decl-toggle-switch"]',
      )!.disabled,
    ).toBe(false);
    root
      .querySelector<HTMLElement>('[data-testid="decl-repo-row-acme/gadgets"]')!
      .click();
    await flush(harness);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="decl-toggle-switch"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="decl-add-workflow-btn"]'),
    ).toBeNull();
  });

  it("awaits GET /api/config before evaluating ?run=1 deep-link permissions", async () => {
    let resolveConfig!: (cfg: GrainConfig) => void;
    api.config = () =>
      new Promise<GrainConfig>((resolve) => {
        resolveConfig = resolve;
      });
    const harness = await RouterTestingHarness.create(
      "/processes/suites?run=1",
    );
    harness.detectChanges();
    await new Promise((r) => setTimeout(r, 15));
    harness.detectChanges();
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="run-suite-dialog"]',
      ),
    ).toBeNull();

    resolveConfig({
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["suites:read"],
        repoLimits: {},
      },
      targetRepos: ["acme/widgets"],
      approvedByDefault: false,
    });
    await flush(harness);
    expect(
      harness.routeNativeElement!.querySelector(
        '[data-testid="run-suite-dialog"]',
      ),
    ).toBeNull();
  });
});
