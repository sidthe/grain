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

import { APP_BASE_HREF } from "@angular/common";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { vi } from "vitest";
import { GrainApi, type RouteParams } from "../api/grain-api.service";
import type { GrainConfig } from "../api/models";
import { RepoDetailPageComponent } from "./repo-detail-page.component";

interface RepoCall {
  method: string;
  key: string;
  params?: RouteParams;
  body?: unknown;
}

class FakeRepoApi {
  calls: RepoCall[] = [];
  ciMode = "grain";
  refusePut: string | null = null;
  refusePutMessage = 'ciMode: must be "grain", "github", or "none"';
  declarationsBody: Record<string, unknown> = {
    declarations: false,
    declarationsStatus: null,
  };

  configBody: GrainConfig = {
    version: "v3.6.0",
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
  };

  config = () => Promise.resolve(structuredClone(this.configBody));

  get = (key: string, params?: RouteParams) => {
    this.calls.push({ method: "GET", key, params });
    if (key === "GET /api/deployment/repos/{owner}/{name}/config") {
      return Promise.resolve({
        baseBranch: "main",
        cloneUrl: "https://github.com/acme/platform.git",
        gitCredential: "github-main",
      });
    }
    if (key === "GET /api/repos/{owner}/{name}/settings") {
      return Promise.resolve({
        ciMode: this.ciMode,
        mergeOnGreen: true,
        requireBranchUpToDate: false,
      });
    }
    if (key === "GET /api/repos/{owner}/{name}/declarations") {
      return Promise.resolve(structuredClone(this.declarationsBody));
    }
    if (key === "GET /api/deployment/git-connections") {
      return Promise.resolve([
        { credential: "github-main" },
        { credential: "github-enterprise" },
      ]);
    }
    if (key === "GET /api/repos/{owner}/{name}/branches") {
      return Promise.resolve([{ name: "main", sha: "1234567890abcdef" }]);
    }
    if (key === "GET /api/repos/{owner}/{name}/release") {
      return Promise.resolve({
        pendingReleases: [
          { version: "v1.3.0", summary: "Trunk release candidate" },
        ],
      });
    }
    if (key === "GET /api/repos/{owner}/{name}/releases") {
      return Promise.resolve([{ name: "v1.2", status: "open" }]);
    }
    if (key === "GET /api/repos/{owner}/{name}/releases/{release}/candidates") {
      return Promise.resolve([
        { id: "rc-1", version: "v1.2.0-rc1", status: "qualifying" },
      ]);
    }
    return Promise.resolve({});
  };

  put = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "PUT", key, params, body });
    if (this.refusePut === key) {
      // Rejected on a later tick, as a real refusal is: a promise that
      // is already rejected when the component awaits it is reported
      // by zone.js as unhandled before the await attaches.
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(this.refusePutMessage))),
      );
    }
    if (key === "PUT /api/repos/{owner}/{name}/declarations") {
      const next = Boolean((body as { declarations?: boolean })?.declarations);
      this.declarationsBody = {
        ...this.declarationsBody,
        declarations: next,
      };
      return Promise.resolve(structuredClone(this.declarationsBody));
    }
    return Promise.resolve({ ok: true });
  };

  post = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "POST", key, params, body });
    return Promise.resolve({ ok: true });
  };

  delete = (key: string, params?: RouteParams) => {
    this.calls.push({ method: "DELETE", key, params });
    return Promise.resolve({ ok: true });
  };
}

async function flushUi(harness: RouterTestingHarness) {
  await harness.fixture.whenStable();
  await Promise.resolve();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

async function waitForEl<T extends Element>(
  harness: RouterTestingHarness,
  selector: string,
): Promise<T> {
  let found: T | null = null;
  await vi.waitFor(() => {
    harness.detectChanges();
    found = (harness.fixture.nativeElement as HTMLElement).querySelector<T>(
      selector,
    );
    expect(found).not.toBeNull();
  });
  return found!;
}

async function mountRepo(url: string, api = new FakeRepoApi()) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          {
            path: "repos/:owner/:name",
            component: RepoDetailPageComponent,
          },
          {
            path: "repos/:owner/:name/:tab",
            component: RepoDetailPageComponent,
          },
          {
            path: "repos/:host/:owner/:name/:tab",
            component: RepoDetailPageComponent,
          },
          { path: "settings/repositories", children: [] },
          { path: "tasks", children: [] },
        ],
        withComponentInputBinding(),
      ),
      { provide: APP_BASE_HREF, useValue: "/next/" },
      { provide: GrainApi, useValue: api },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  harness.fixture.autoDetectChanges(true);
  await harness.fixture.whenStable();
  await new Promise((r) => setTimeout(r, 20));
  await harness.fixture.whenStable();
  return {
    harness,
    el: harness.fixture.nativeElement as HTMLElement,
    api,
  };
}

describe("RepoDetailPageComponent (/next/repos/:owner/:name)", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("saves repository config, pins Git connection, imports issues, and renders zero native <select> elements", async () => {
    const { el, api } = await mountRepo("/repos/acme/platform");

    expect(
      el.querySelector('[data-testid="repo-detail-heading"]')?.textContent,
    ).toContain("acme/platform");
    expect(el.querySelectorAll("select").length).toBe(0);

    el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-config-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      api.calls.some(
        (c) =>
          c.key === "PUT /api/deployment/repos/{owner}/{name}/config" &&
          c.params?.["owner"] === "acme" &&
          c.params?.["name"] === "platform",
      ),
    ).toBe(true);

    // Import issues
    el.querySelector<HTMLButtonElement>(
      '[data-testid="import-issues-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      api.calls.some(
        (c) => c.key === "POST /api/repos/{owner}/{name}/import-issues",
      ),
    ).toBe(true);
  });

  it("creates branches and manages releases, RC promotion, candidate qualification, and pending release approvals", async () => {
    const { el, api, harness } = await mountRepo(
      "/repos/acme/platform/branches",
    );

    const brInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-new-branch-name"]',
    )!;
    brInput.value = "release/v1.3";
    brInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();

    el.querySelector<HTMLButtonElement>(
      '[data-testid="create-branch-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      api.calls.some(
        (c) =>
          c.key === "POST /api/repos/{owner}/{name}/branches" &&
          (c.body as { name?: string })?.name === "release/v1.3",
      ),
    ).toBe(true);

    // Switch to Releases tab
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-tab-releases"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 15));
    harness.detectChanges();

    // Approve pending trunk release v1.3.0
    el.querySelector<HTMLButtonElement>(
      '[data-testid="approve-pending-release-v1.3.0"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      api.calls.some(
        (c) =>
          c.key ===
            "POST /api/repos/{owner}/{name}/pending-releases/{version}/approve" &&
          c.params?.["version"] === "v1.3.0",
      ),
    ).toBe(true);

    // Cut & promote RC + approve qualification
    el.querySelector<HTMLButtonElement>('[data-testid="cut-rc-v1.2"]')!.click();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="promote-rc-v1.2"]',
    )!.click();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="approve-qualification-rc-1"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(
      api.calls.some(
        (c) =>
          c.key ===
          "POST /api/repos/{owner}/{name}/releases/{release}/candidates",
      ),
    ).toBe(true);
    expect(
      api.calls.some(
        (c) =>
          c.key ===
          "POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote",
      ),
    ).toBe(true);
    expect(
      api.calls.some(
        (c) =>
          c.key ===
          "POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve",
      ),
    ).toBe(true);
  });
  // 2026-11-13 repository walkthrough: the CI mode pill offered "both"
  // and "off", which PUT .../ci-mode refuses, and had no "none", so a
  // repository on no CI read as Grain CI.
  it("offers exactly the CI modes the server accepts and shows a repo on none as No CI", async () => {
    const api = new FakeRepoApi();
    api.ciMode = "none";
    const { el, harness } = await mountRepo("/repos/acme/platform/ci", api);
    const pill = el.querySelector<HTMLButtonElement>(
      '[data-testid="select-repo-ci-mode"]',
    )!;
    expect(pill.textContent).toContain("No CI");
    pill.click();
    harness.detectChanges();
    const opts = [
      ...el.querySelectorAll<HTMLElement>(
        '[data-testid^="select-repo-ci-mode-opt-"]',
      ),
    ].map((o) => o.dataset["testid"]!.replace("select-repo-ci-mode-opt-", ""));
    expect(opts).toEqual(["grain", "github", "none"]);
  });

  it("puts the CI mode pill back when the server refuses the new mode", async () => {
    const api = new FakeRepoApi();
    api.refusePut = "PUT /api/repos/{owner}/{name}/ci-mode";
    const { el, harness } = await mountRepo("/repos/acme/platform/ci", api);
    const pill = el.querySelector<HTMLButtonElement>(
      '[data-testid="select-repo-ci-mode"]',
    )!;
    expect(pill.textContent).toContain("Grain CI");
    pill.click();
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="select-repo-ci-mode-opt-github"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    harness.detectChanges();
    expect(
      api.calls.some(
        (c) =>
          c.key === "PUT /api/repos/{owner}/{name}/ci-mode" &&
          (c.body as { ciMode?: string })?.ciMode === "github",
      ),
    ).toBe(true);
    expect(pill.textContent).toContain("Grain CI");
  });
  // 2026-11-13 repository walkthrough: one click on the switch let
  // base-branch repair PRs merge with no human; the classic page asks.
  it("asks before letting base-branch repairs bypass the human gate, and not when turning it off", async () => {
    const { el, api, harness } = await mountRepo(
      "/repos/acme/platform/merge-queue",
    );
    const key =
      "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates";
    const sw = () =>
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="Base-branch repairs bypass human review gates"]',
      )!;
    sw().click();
    harness.detectChanges();
    const dialog = el.querySelector('[data-testid="confirm-dialog"]');
    expect(dialog?.textContent).toContain(
      "Let base-branch repair PRs in acme/platform merge without a human",
    );
    expect(api.calls.some((c) => c.key === key)).toBe(false);
    el.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-cancel"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    harness.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(api.calls.some((c) => c.key === key)).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");

    sw().click();
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-accept"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 10));
    harness.detectChanges();
    expect(api.calls.filter((c) => c.key === key).map((c) => c.body)).toEqual([
      { baseRepairBypassesHumanGates: true },
    ]);
    expect(sw().getAttribute("aria-checked")).toBe("true");

    sw().click();
    await new Promise((r) => setTimeout(r, 10));
    harness.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(api.calls.filter((c) => c.key === key).map((c) => c.body)).toEqual([
      { baseRepairBypassesHumanGates: true },
      { baseRepairBypassesHumanGates: false },
    ]);
  });

  it("loads, toggles, and refreshes repo declarations via GET and PUT /api/repos/{owner}/{name}/declarations", async () => {
    const api = new FakeRepoApi();
    const { el, harness } = await mountRepo("/repos/acme/platform", api);

    // Loaded automatically with repo core data
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" &&
          c.key === "GET /api/repos/{owner}/{name}/declarations" &&
          c.params?.["owner"] === "acme" &&
          c.params?.["name"] === "platform",
      ),
    ).toBe(true);

    // Switch to Declarations tab
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-tab-declarations"]',
    )!.click();
    await waitForEl(harness, '[data-testid="card-repo-declarations"]');

    const statePill = () =>
      el.querySelector('[data-testid="repo-declarations-state"]');
    const sw = () =>
      el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-declarations"]',
      )!;

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(statePill()?.textContent?.trim()).toBe("Disabled");
    });
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(
      el.querySelector('[data-testid="repo-declarations-off"]')?.textContent,
    ).toContain("Declarations sync is off for acme/platform");

    // Toggle declarations on -> PUT { declarations: true } -> shows pending message
    sw().click();
    await flushUi(harness);
    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/declarations" &&
          c.params?.["owner"] === "acme" &&
          c.params?.["name"] === "platform" &&
          (c.body as { declarations?: boolean })?.declarations === true,
      ),
    ).toBe(true);
    expect(statePill()?.textContent?.trim()).toBe("Enabled");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(
      el.querySelector('[data-testid="repo-declarations-pending"]')
        ?.textContent,
    ).toContain("Not read yet — grain picks this up on its next cycle.");

    // Refresh picks up synced status, discovered files, pushes, warnings, and ports
    api.declarationsBody = {
      declarations: true,
      declarationsStatus: {
        commit: "abcdef1234567890",
        checkedAt: "2026-11-13T21:00:00Z",
        syncedAt: "2026-11-13T21:00:00Z",
        templates: [".grain/templates/release.yml"],
        suites: [".grain/suites/sweep.yml"],
        schedules: [".grain/schedules/nightly.yml"],
        triggers: [".grain/triggers/docs.yml"],
        mergeRules: ".grain/merge-rules.yml",
        pushes: [
          {
            repo: "acme/platform",
            path: ".grain/templates/release.yml",
            refs: [{ ref: "refs/tags/v*", force: true, delete: false }],
          },
        ],
        warnings: ["duplicate warning"],
      },
      pairedBranches: ["main", "release/v1"],
      portBranches: ["main"],
      declaredPortBranches: ["release/v1"],
      portDirections: [
        {
          from: "main",
          to: "release/v1",
          paired: true,
          operatorTypes: ["fix"],
          declaredTypes: ["feat"],
          types: ["fix", "feat"],
        },
      ],
      portWarnings: ["duplicate warning", "operator-only port warning"],
    };

    el.querySelector<HTMLButtonElement>(
      '[data-testid="refresh-repo-declarations-btn"]',
    )!.click();
    await flushUi(harness);

    expect(
      el.querySelector('[data-testid="repo-declarations-summary"]')
        ?.textContent,
    ).toContain(
      "Read at abcdef123456: 1 template(s), 1 suite(s), 1 schedule(s), 1 trigger(s), merge rules in .grain/merge-rules.yml",
    );
    const filesText = el.querySelector(
      '[data-testid="repo-declarations-files"]',
    )?.textContent;
    expect(filesText).toContain(".grain/templates/release.yml");
    expect(filesText).toContain(".grain/suites/sweep.yml");
    expect(filesText).toContain(".grain/schedules/nightly.yml");
    expect(filesText).toContain(".grain/triggers/docs.yml");
    expect(filesText).toContain(".grain/merge-rules.yml");
    expect(
      el.querySelector('[data-testid="repo-declarations-push"]')?.textContent,
    ).toContain(
      "Tasks from .grain/templates/release.yml may also push: refs/tags/v* (force)",
    );
    expect(
      el.querySelectorAll('[data-testid="repo-declarations-warning"]').length,
    ).toBe(1);
    expect(
      el.querySelector('[data-testid="card-repo-ports"]')?.textContent,
    ).toContain("Grain ports each merge between main, release/v1");
    // Deduplicates warnings already shown in declarationsStatus.warnings
    const portWarnings = el.querySelectorAll(
      '[data-testid="repo-port-warning"]',
    );
    expect(portWarnings.length).toBe(1);
    expect(portWarnings[0].textContent).toContain("operator-only port warning");
  });

  it("renders failed sync status with last-good summary and keeps switch unchanged when PUT /declarations is refused", async () => {
    const api = new FakeRepoApi();
    api.declarationsBody = {
      declarations: true,
      declarationsStatus: {
        commit: "fedcba6543219876",
        checkedAt: "2026-11-13T21:05:00Z",
        error:
          ".grain/templates/bad.yml: unknown key\n.grain/suites/s.yml: bad mode",
        templates: [".grain/templates/good.yml"],
      },
    };
    api.refusePut = "PUT /api/repos/{owner}/{name}/declarations";
    api.refusePutMessage = "forbidden: repository declarations locked";

    const { el, harness } = await mountRepo(
      "/repos/acme/platform/advanced",
      api,
    );

    expect(
      el.querySelector('[data-testid="repo-declarations-sync-error"]')
        ?.textContent,
    ).toContain("Last read failed:");
    expect(
      el.querySelector('[data-testid="repo-declarations-still-running"]')
        ?.textContent,
    ).toContain(
      "Still running from fedcba654321: 1 template(s), 0 suite(s), 0 schedule(s), 0 trigger(s)",
    );

    const sw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-declarations"]',
    )!;
    sw.click();
    await new Promise((r) => setTimeout(r, 10));
    await flushUi(harness);

    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(
      el.querySelector('[data-testid="repo-declarations-error"]')?.textContent,
    ).toContain("forbidden: repository declarations locked");
  });

  it("enforces repo-scoped access.can(route, repo) on Repo Detail mutations and declarations to prevent scope escalation", async () => {
    const api = new FakeRepoApi();
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/repo-maintainer",
        roles: ["grain/repo-maintainer"],
        full: false,
        scopes: [
          "repos:read",
          "repos:write",
          "capabilities:read",
          "capabilities:admin",
          "releases:read",
          "releases:write",
          "ci:write",
          "tasks:write",
          "connections:write",
        ],
        repoLimits: {
          "repos:write": ["acme/allowed"],
          "capabilities:admin": ["acme/allowed"],
          "releases:write": ["acme/allowed"],
          "ci:write": ["acme/allowed"],
          "tasks:write": ["acme/allowed"],
          "connections:write": ["acme/allowed"],
        },
      },
    };

    // Disallowed repo: acme/platform
    const { el, harness } = await mountRepo("/repos/acme/platform/agents", api);
    const cmp = harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      saveAgentTabSettings: () => Promise<void>;
      toggleDeclarations: () => Promise<void>;
      saveRepoConfig: () => Promise<void>;
      saveCiMode: (mode: string) => Promise<void>;
      toggleMergeOnGreen: () => Promise<void>;
      createBranch: () => Promise<void>;
      createRelease: () => Promise<void>;
    };

    const setupInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-repo-setup-cmd"]',
    )!;
    const promptInput = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="input-repo-prompt-ext"]',
    )!;
    const capsInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-repo-caps"]',
    )!;
    const saveAgentsBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-agents-btn"]',
    )!;

    expect(setupInput.disabled).toBe(true);
    expect(promptInput.disabled).toBe(true);
    expect(capsInput.disabled).toBe(true);
    expect(saveAgentsBtn.disabled).toBe(true);

    // Direct method invocations must also fail closed and emit zero writes
    await cmp.saveAgentTabSettings();
    await cmp.toggleDeclarations();
    await cmp.saveRepoConfig();
    await cmp.saveCiMode("none");
    await cmp.toggleMergeOnGreen();
    await cmp.createBranch();
    await cmp.createRelease();

    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // Switch to Declarations tab on disallowed repo: switch is disabled
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-tab-declarations"]',
    )!.click();
    const declSwitch = await waitForEl<HTMLButtonElement>(
      harness,
      '[data-testid="switch-repo-declarations"]',
    );
    expect(declSwitch.disabled).toBe(true);
    declSwitch.click();
    await flushUi(harness);
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // Now test split scopes on acme/platform: capabilities:admin allowed on acme/platform,
    // repos:write still limited to acme/allowed -> only capabilities PUT may fire.
    TestBed.resetTestingModule();
    const splitApi = new FakeRepoApi();
    splitApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/split-maintainer",
        roles: ["grain/split-maintainer"],
        full: false,
        scopes: [
          "repos:read",
          "repos:write",
          "capabilities:read",
          "capabilities:admin",
        ],
        repoLimits: {
          "repos:write": ["acme/allowed"],
          "capabilities:admin": ["acme/platform"],
        },
      },
    };
    const splitMount = await mountRepo("/repos/acme/platform/agents", splitApi);
    const splitEl = splitMount.el;
    expect(
      splitEl.querySelector<HTMLInputElement>(
        '[data-testid="input-repo-setup-cmd"]',
      )!.disabled,
    ).toBe(true);
    expect(
      splitEl.querySelector<HTMLTextAreaElement>(
        '[data-testid="input-repo-prompt-ext"]',
      )!.disabled,
    ).toBe(true);
    const splitCaps = splitEl.querySelector<HTMLInputElement>(
      '[data-testid="input-repo-caps"]',
    )!;
    expect(splitCaps.disabled).toBe(false);
    const splitSaveBtn = splitEl.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-agents-btn"]',
    )!;
    expect(splitSaveBtn.disabled).toBe(false);

    splitCaps.value = "ci:read, tasks:read";
    splitCaps.dispatchEvent(new Event("input", { bubbles: true }));
    splitMount.harness.detectChanges();
    splitSaveBtn.click();
    await flushUi(splitMount.harness);

    const writeKeys = splitApi.calls
      .filter((c) => c.method !== "GET")
      .map((c) => c.key);
    expect(writeKeys).toEqual(["PUT /api/repos/{owner}/{name}/capabilities"]);

    // Now verify acme/allowed allows declarations & agent saves
    TestBed.resetTestingModule();
    const allowedApi = new FakeRepoApi();
    allowedApi.configBody = structuredClone(api.configBody);
    const allowedMount = await mountRepo(
      "/repos/acme/allowed/declarations",
      allowedApi,
    );
    const allowedSwitch = allowedMount.el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-declarations"]',
    )!;
    expect(allowedSwitch.disabled).toBe(false);
    allowedSwitch.click();
    await flushUi(allowedMount.harness);
    expect(
      allowedApi.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/declarations" &&
          c.params?.["owner"] === "acme" &&
          c.params?.["name"] === "allowed",
      ),
    ).toBe(true);
  });

  it("withholds GET /declarations and shows denied banner when repos:read excludes the repo", async () => {
    const api = new FakeRepoApi();
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/scoped-reader",
        roles: ["grain/scoped-reader"],
        full: false,
        scopes: ["repos:read"],
        repoLimits: {
          "repos:read": ["acme/allowed"],
        },
      },
    };
    const { el } = await mountRepo("/repos/acme/platform/declarations", api);
    expect(
      api.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/declarations",
      ),
    ).toBe(false);
    expect(
      el.querySelector('[data-testid="repo-declarations-denied"]')?.textContent,
    ).toContain("repos:read on this repository");
  });

  it("blocks config mutations under configRepoOnly while allowing operational actions, and guards all mutations", async () => {
    const api = new FakeRepoApi();
    api.configBody = {
      version: "v3.6.0",
      configRepoOnly: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/declarations",
      api,
    );
    expect(
      el.querySelector('[data-testid="repo-readonly-banner"]'),
    ).not.toBeNull();
    const declSwitch = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-declarations"]',
    )!;
    expect(declSwitch.disabled).toBe(true);

    const cmp = harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      toggleDeclarations: () => Promise<void>;
      saveAgentTabSettings: () => Promise<void>;
      pinGitConnection: (c: string) => Promise<void>;
      toggleWatchDefaultBranch: () => Promise<void>;
      saveWorkflows: () => Promise<void>;
      deleteSelectedWorkflow: () => Promise<void>;
      saveReleaseSettings: () => Promise<void>;
      toggleRequireUpToDate: () => Promise<void>;
      toggleBypassHumanGates: () => void;
      importIssues: () => Promise<void>;
    };
    await cmp.toggleDeclarations();
    await cmp.saveAgentTabSettings();
    await cmp.pinGitConnection("other");
    await cmp.toggleWatchDefaultBranch();
    await cmp.saveWorkflows();
    await cmp.deleteSelectedWorkflow();
    await cmp.saveReleaseSettings();
    await cmp.toggleRequireUpToDate();
    cmp.toggleBypassHumanGates();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // Operational actions remain enabled and permitted under configRepoOnly
    await cmp.importIssues();
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.key === "POST /api/repos/{owner}/{name}/import-issues",
      ),
    ).toBe(true);
  });

  it("scopes host-prefixed repositories and resets state when navigating between repositories", async () => {
    const api = new FakeRepoApi();
    api.declarationsBody = {
      declarations: true,
      declarationsStatus: {
        commit: "1122334455667788",
        templates: [".grain/templates/t.yml"],
      },
    };
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/host-scoped",
        roles: ["grain/host-scoped"],
        full: false,
        scopes: ["repos:read", "repos:write"],
        repoLimits: {
          "repos:write": ["ghes.example.com/acme/allowed"],
        },
      },
    };

    const { el, harness } = await mountRepo(
      "/repos/ghes.example.com/acme/allowed/declarations",
      api,
    );
    expect(
      el.querySelector('[data-testid="repo-detail-heading"]')?.textContent,
    ).toContain("ghes.example.com/acme/allowed");
    expect(
      api.calls.some(
        (c) =>
          c.key === "GET /api/repos/{owner}/{name}/declarations" &&
          c.params?.["owner"] === "ghes.example.com/acme" &&
          c.params?.["name"] === "allowed",
      ),
    ).toBe(true);
    expect(
      el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-declarations"]',
      )!.disabled,
    ).toBe(false);

    // Navigate in-place to a disallowed repo on the same host
    api.declarationsBody = {
      declarations: false,
      declarationsStatus: null,
    };
    await harness.navigateByUrl(
      "/repos/ghes.example.com/acme/forbidden/declarations",
    );
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(
        el.querySelector('[data-testid="repo-detail-heading"]')?.textContent,
      ).toContain("ghes.example.com/acme/forbidden");
      expect(
        el
          .querySelector('[data-testid="repo-declarations-state"]')
          ?.textContent?.trim(),
      ).toBe("Disabled");
    });
    expect(
      el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-declarations"]',
      )!.disabled,
    ).toBe(true);
  });
});
