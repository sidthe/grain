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
import type {
  CapabilityMethod,
  CapabilityOption,
  GrantCheck,
  GrainConfig,
} from "../api/models";
import { RepoDetailPageComponent } from "./repo-detail-page.component";

interface RepoCall {
  method: string;
  key: string;
  params?: RouteParams;
  query?: Record<string, unknown>;
  body?: unknown;
}

class FakeRepoApi {
  calls: RepoCall[] = [];
  ciMode = "grain";
  refuseGet: string | null = null;
  refuseGetMessage = "failed to load";
  refusePut: string | null = null;
  refusePutMessage = 'ciMode: must be "grain", "github", or "none"';
  declarationsBody: Record<string, unknown> = {
    declarations: false,
    declarationsStatus: null,
  };
  branchesBody: { name: string; sha?: string; head?: string }[] = [
    { name: "main", sha: "1234567890abcdef" },
  ];
  unfixableBody: {
    unfixableChecks: string[] | null;
    grainCICheckName?: string;
  } = {
    unfixableChecks: [],
    grainCICheckName: "grain CI",
  };
  ciCapsBody: {
    ciCapabilities: string[] | null;
    availableCICapabilities: string[];
  } = {
    ciCapabilities: [],
    availableCICapabilities: ["github-read"],
  };
  capabilityMethodsBody: CapabilityMethod[] = [
    {
      ref: "release#registry-push",
      capability: "release",
      method: "registry-push",
      description: "Push release images",
    },
    {
      ref: "repo#read",
      capability: "repo",
      method: "read",
      description: "Read repository",
    },
  ];
  grantCheckHandler: ((grants: unknown[]) => GrantCheck[]) | null = null;
  releaseEnabled = true;
  workOwnershipBody: {
    repo: string;
    default: string;
    defaultRuns: boolean;
    items: {
      item: string;
      kind: string;
      title?: string;
      override: string;
      runs: boolean;
      paused?: boolean;
      declaration?: { repo?: string; path: string };
    }[];
  } = {
    repo: "acme/platform",
    default: "",
    defaultRuns: true,
    items: [
      {
        item: "release",
        kind: "release",
        title: "Release",
        override: "",
        runs: true,
      },
      {
        item: "repo:schedule:acme:platform:nightly",
        kind: "schedule",
        title: "Nightly sweep",
        override: "off",
        runs: false,
        declaration: {
          repo: "acme/platform",
          path: ".grain/schedules/nightly.yml",
        },
      },
    ],
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

  get = (
    key: string,
    params?: RouteParams,
    query?: Record<string, unknown>,
  ) => {
    this.calls.push({ method: "GET", key, params, query });
    if (this.refuseGet === key) {
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(this.refuseGetMessage))),
      );
    }
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
    if (key === "GET /api/repos/{owner}/{name}/work-ownership") {
      return Promise.resolve(structuredClone(this.workOwnershipBody));
    }
    if (key === "GET /api/deployment/git-connections") {
      return Promise.resolve([
        { credential: "github-main" },
        { credential: "github-enterprise" },
      ]);
    }
    if (key === "GET /api/repos/{owner}/{name}/branches") {
      return Promise.resolve(structuredClone(this.branchesBody));
    }
    if (key === "GET /api/repos/{owner}/{name}/unfixable-checks") {
      return Promise.resolve(structuredClone(this.unfixableBody));
    }
    if (key === "GET /api/repos/{owner}/{name}/ci-capabilities") {
      return Promise.resolve(structuredClone(this.ciCapsBody));
    }
    if (key === "GET /api/capability-methods") {
      return Promise.resolve({
        items: structuredClone(this.capabilityMethodsBody),
      });
    }
    if (key === "GET /api/repos/{owner}/{name}/release") {
      return Promise.resolve({
        enabled: this.releaseEnabled,
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
    if (key === "PUT /api/repos/{owner}/{name}/unfixable-checks") {
      const list = (body as { unfixableChecks?: string[] })?.unfixableChecks;
      const clean = Array.isArray(list)
        ? list.map((s) => s.trim()).filter(Boolean)
        : [];
      this.unfixableBody = {
        ...this.unfixableBody,
        unfixableChecks: clean.length > 0 ? clean : null,
      };
      return Promise.resolve(structuredClone(this.unfixableBody));
    }
    if (key === "PUT /api/repos/{owner}/{name}/ci-capabilities") {
      const list = (body as { ciCapabilities?: string[] })?.ciCapabilities;
      const clean = Array.isArray(list)
        ? list.map((s) => s.trim()).filter(Boolean)
        : [];
      this.ciCapsBody = {
        ...this.ciCapsBody,
        ciCapabilities: clean.length > 0 ? clean : null,
      };
      return Promise.resolve(structuredClone(this.ciCapsBody));
    }
    if (key === "PUT /api/repos/{owner}/{name}/capabilities") {
      const list = (body as { defaultCapabilities?: string[] })
        ?.defaultCapabilities;
      const clean = Array.isArray(list)
        ? list.map((s) => s.trim()).filter(Boolean)
        : [];
      return Promise.resolve({ defaultCapabilities: clean });
    }
    if (key === "PUT /api/repos/{owner}/{name}/work-ownership") {
      const req = (body ?? {}) as {
        default?: string;
        item?: string;
        state?: string;
      };
      if (req.default !== undefined) {
        this.workOwnershipBody.default = req.default;
        this.workOwnershipBody.defaultRuns = req.default !== "off";
      } else if (req.item !== undefined && req.state !== undefined) {
        const target = this.workOwnershipBody.items.find(
          (i) => i.item === req.item,
        );
        if (target) {
          target.override = req.state;
        }
      }
      for (const item of this.workOwnershipBody.items) {
        item.runs =
          item.override === "on"
            ? true
            : item.override === "off"
              ? false
              : this.workOwnershipBody.defaultRuns;
      }
      const rel = this.workOwnershipBody.items.find(
        (i) => i.item === "release",
      );
      if (rel) this.releaseEnabled = rel.runs;
      return Promise.resolve(structuredClone(this.workOwnershipBody));
    }
    if (key === "PUT /api/repos/{owner}/{name}/release") {
      const req = (body ?? {}) as { enabled?: boolean };
      if (req.enabled !== undefined) {
        this.releaseEnabled = Boolean(req.enabled);
        const rel = this.workOwnershipBody.items.find(
          (i) => i.item === "release",
        );
        if (rel) {
          rel.override = this.releaseEnabled ? "on" : "off";
          rel.runs = this.releaseEnabled;
        }
      }
      return Promise.resolve({
        enabled: this.releaseEnabled,
        pendingReleases: [
          { version: "v1.3.0", summary: "Trunk release candidate" },
        ],
      });
    }
    return Promise.resolve({ ok: true });
  };

  post = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "POST", key, params, body });
    if (key === "POST /api/capability-grants/check") {
      const req = (body ?? {}) as { grants?: unknown[] };
      const grants = req.grants ?? [];
      if (this.grantCheckHandler) {
        return Promise.resolve({ checks: this.grantCheckHandler(grants) });
      }
      const checks: GrantCheck[] = grants.map((raw) => {
        const item = raw as {
          grant?: string;
          capability?: string;
          with?: Record<string, unknown>;
        };
        if (item.grant) {
          return { grant: item.grant, recorded: item.grant };
        }
        const ref = item.capability ?? "";
        const canonical = ref.startsWith("https://")
          ? ref
          : `https://grain.dev/capabilities/${ref}`;
        const withJson = item.with ? JSON.stringify(item.with) : "{}";
        return {
          grant: `${ref}=${withJson}`,
          recorded: `${canonical}=${withJson}`,
        };
      });
      return Promise.resolve({ checks });
    }
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

  it("renders work ownership silence, explicit exceptions, resolved states, and metadata", async () => {
    const api = new FakeRepoApi();
    const nightly = "repo:schedule:acme:platform:nightly";
    api.workOwnershipBody = {
      repo: "acme/platform",
      default: "",
      defaultRuns: true,
      items: [
        {
          item: "release",
          kind: "release",
          override: "",
          runs: true,
        },
        {
          item: nightly,
          kind: "schedule",
          title: "Nightly sweep",
          override: "off",
          runs: false,
          declaration: {
            repo: "acme/platform",
            path: ".grain/schedules/nightly.yml",
          },
        },
        {
          item: "local-chore",
          kind: "schedule",
          title: "Housekeeping",
          override: "on",
          runs: true,
          paused: true,
        },
        {
          item: "chore",
          kind: "schedule",
          title: "chore",
          override: "",
          runs: true,
        },
        {
          item: "withdrawn",
          kind: "unknown",
          override: "off",
          runs: false,
        },
      ],
    };

    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );
    await waitForEl(harness, '[data-testid="wo-items-list"]');

    const card = el.querySelector('[data-testid="card-repo-work-ownership"]')!;
    expect(card.textContent).toContain("Standing work on this deployment: on");
    expect(card.textContent).toContain("the base-branch check");
    expect(card.textContent).toContain(
      "tasks people file by hand against this repository",
    );
    expect(
      el.querySelector('[data-testid="wo-default-said"]')?.textContent,
    ).toContain("Nobody has said");
    expect(
      el.querySelector('[data-testid="wo-default-resolved"]')?.textContent,
    ).toContain("Runs this repository's work");

    // Three-state button aria-pressed reflects server state and active button stays clickable
    const nightlyOff = el.querySelector<HTMLButtonElement>(
      `button[aria-label="Nightly sweep: off"]`,
    )!;
    expect(nightlyOff.getAttribute("aria-pressed")).toBe("true");
    expect(nightlyOff.disabled).toBe(false);
    expect(
      el
        .querySelector(`button[aria-label="Nightly sweep: on"]`)!
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      el
        .querySelector(`button[aria-label="Nightly sweep: say nothing"]`)!
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      el
        .querySelector(`button[aria-label="release: say nothing"]`)!
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Metadata parity: id shown only when differing from title, declaration path, paused, unknown
    const nightlyRow = el.querySelector(
      `[data-testid="wo-item-row-${nightly}"]`,
    )!;
    expect(nightlyRow.textContent).toContain("Nightly sweep");
    expect(nightlyRow.textContent).toContain(nightly);
    expect(nightlyRow.textContent).toContain(
      "declared in .grain/schedules/nightly.yml",
    );
    expect(nightlyRow.textContent).toContain("Off, set here");
    expect(nightlyRow.textContent).toContain("Not run");

    const pausedRow = el.querySelector(
      '[data-testid="wo-item-row-local-chore"]',
    )!;
    expect(pausedRow.textContent).toContain("Paused on its own row");
    expect(pausedRow.textContent).toContain("On, set here");
    expect(pausedRow.textContent).toContain("Runs");

    const sameTitleRow = el.querySelector('[data-testid="wo-item-row-chore"]')!;
    expect(sameTitleRow.querySelectorAll("code").length).toBe(0);

    const unknownRow = el.querySelector(
      '[data-testid="wo-item-row-withdrawn"]',
    )!;
    expect(unknownRow.textContent).toContain("nothing here has this id");
    expect(
      el.querySelector(`button[aria-label="withdrawn: say nothing"]`),
    ).not.toBeNull();
  });

  it("writes repository default, clears item overrides, and syncs two-way with release workflow switch", async () => {
    const api = new FakeRepoApi();
    const nightly = "repo:schedule:acme:platform:nightly";
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );
    await waitForEl(harness, '[data-testid="wo-default-row"]');

    // Toggle standing-work switch off -> PUT { default: "off" } -> release switch syncs off
    const sw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-work-ownership"]',
    )!;
    const relSw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-release-enabled"]',
    )!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(relSw.getAttribute("aria-checked")).toBe("true");

    sw.click();
    await flushUi(harness);
    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/work-ownership" &&
          (c.body as { default?: string })?.default === "off",
      ),
    ).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(relSw.getAttribute("aria-checked")).toBe("false");
    expect(
      el.querySelector('[data-testid="wo-default-resolved"]')?.textContent,
    ).toContain("Does not run this repository's work");
    // Release item still says "Nobody has said" while resolving to "Not run"
    const relRow = el.querySelector('[data-testid="wo-item-row-release"]')!;
    expect(relRow.textContent).toContain("Nobody has said");
    expect(relRow.textContent).toContain("Not run");

    // Set repository default back to say nothing ("")
    el.querySelector<HTMLButtonElement>(
      'button[aria-label="the repository default: say nothing"]',
    )!.click();
    await flushUi(harness);
    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/work-ownership" &&
          (c.body as { default?: string })?.default === "",
      ),
    ).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(relSw.getAttribute("aria-checked")).toBe("true");

    // Clear Nightly sweep exception without turning it "on" -> sends { item: nightly, state: "" }
    el.querySelector<HTMLButtonElement>(
      'button[aria-label="Nightly sweep: say nothing"]',
    )!.click();
    await flushUi(harness);
    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/work-ownership" &&
          (c.body as { item?: string; state?: string })?.item === nightly &&
          (c.body as { item?: string; state?: string })?.state === "",
      ),
    ).toBe(true);
    expect(
      el.querySelector(`[data-testid="wo-item-said-${nightly}"]`)?.textContent,
    ).toContain("Nobody has said");

    // Saving Release settings off refreshes Work Ownership release item
    relSw.click();
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-release-btn"]',
    )!.click();
    await flushUi(harness);
    expect(relRow.textContent).toContain("Off, set here");
    expect(relRow.textContent).toContain("Not run");
  });

  it("renders empty work items copy when no items exist", async () => {
    const api = new FakeRepoApi();
    api.workOwnershipBody = {
      repo: "acme/platform",
      default: "",
      defaultRuns: true,
      items: [],
    };
    const { harness } = await mountRepo("/repos/acme/platform/releases", api);
    const empty = await waitForEl(harness, '[data-testid="wo-empty-items"]');
    expect(empty.textContent).toContain(
      "No work items: this repository declares no schedules here",
    );
  });

  it("reports failed GET without drawing empty list and preserves state on refused PUT or invalid input", async () => {
    const api = new FakeRepoApi();
    api.refuseGet = "GET /api/repos/{owner}/{name}/work-ownership";
    api.refuseGetMessage = "work ownership store unavailable";

    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );
    const errEl = await waitForEl(
      harness,
      '[data-testid="repo-work-ownership-error"]',
    );
    expect(errEl.textContent).toContain("work ownership store unavailable");
    expect(
      el.querySelector('[data-testid="switch-repo-work-ownership"]'),
    ).toBeNull();
    expect(el.textContent).not.toContain("Nobody has said");

    // Retry succeeds when error clears
    api.refuseGet = null;
    api.refusePut = "PUT /api/repos/{owner}/{name}/work-ownership";
    api.refusePutMessage = "forbidden: repository settings locked";
    errEl.querySelector<HTMLButtonElement>("button")!.click();
    await waitForEl(harness, '[data-testid="switch-repo-work-ownership"]');

    const sw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-work-ownership"]',
    )!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    sw.click();
    await new Promise((r) => setTimeout(r, 15));
    await flushUi(harness);

    // Refused PUT preserves existing switch state and shows inline error
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(
      el.querySelector('[data-testid="repo-work-ownership-error"]')
        ?.textContent,
    ).toContain("forbidden: repository settings locked");

    // Client-side validation rejects malformed item IDs and invalid states without calling PUT
    const callsBefore = api.calls.length;
    const cmp = harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      saveWorkDefault: (state: string) => Promise<void>;
      saveWorkItem: (item: string, state: string) => Promise<void>;
    };

    await cmp.saveWorkDefault("invalid");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-work-ownership-error"]')
        ?.textContent,
    ).toContain("Invalid ownership state");

    await cmp.saveWorkItem("bad,item", "off");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-work-ownership-error"]')
        ?.textContent,
    ).toContain('cannot contain "," or "="');

    await cmp.saveWorkItem(" ", "off");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-work-ownership-error"]')
        ?.textContent,
    ).toContain("cannot be empty");

    expect(api.calls.length).toBe(callsBefore);
  });

  it("enforces repos:read, repos:write, configRepoOnly, and host-prefixed repo scoping on work ownership", async () => {
    // 1. repos:read denied -> no GET, shows denied banner
    const readDeniedApi = new FakeRepoApi();
    readDeniedApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/scoped-reader",
        roles: ["grain/scoped-reader"],
        full: false,
        scopes: ["repos:read"],
        repoLimits: { "repos:read": ["acme/allowed"] },
      },
    };
    const m1 = await mountRepo("/repos/acme/platform/releases", readDeniedApi);
    expect(
      readDeniedApi.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/work-ownership",
      ),
    ).toBe(false);
    expect(
      m1.el.querySelector('[data-testid="repo-work-ownership-denied"]')
        ?.textContent,
    ).toContain("repos:read on this repository");

    // 2. repos:read allowed, repos:write denied -> read-only banner + aria-describedby + no PUT
    TestBed.resetTestingModule();
    const writeDeniedApi = new FakeRepoApi();
    writeDeniedApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["repos:read", "releases:read"],
      },
    };
    const m2 = await mountRepo("/repos/acme/platform/releases", writeDeniedApi);
    await waitForEl(m2.harness, '[data-testid="switch-repo-work-ownership"]');
    const roBanner = m2.el.querySelector(
      '[data-testid="repo-work-ownership-readonly"]',
    );
    expect(roBanner?.textContent).toContain("repos:write");
    const roSw = m2.el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-work-ownership"]',
    )!;
    expect(roSw.disabled).toBe(true);
    expect(roSw.getAttribute("aria-describedby")).toBe(
      "repo-work-ownership-readonly",
    );
    const roDefBtn = m2.el.querySelector<HTMLButtonElement>(
      '[data-testid="wo-default-btn-off"]',
    )!;
    expect(roDefBtn.disabled).toBe(true);
    expect(roDefBtn.getAttribute("aria-describedby")).toBe(
      "repo-work-ownership-readonly",
    );
    const cmp2 = m2.harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      saveWorkDefault: (s: string) => Promise<void>;
      saveWorkItem: (i: string, s: string) => Promise<void>;
    };
    await cmp2.saveWorkDefault("off");
    await cmp2.saveWorkItem("release", "off");
    expect(writeDeniedApi.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // 3. configRepoOnly -> disabled + aria-describedby=repo-readonly-banner + no PUT
    TestBed.resetTestingModule();
    const lockedApi = new FakeRepoApi();
    lockedApi.configBody = {
      version: "v3.6.0",
      configRepoOnly: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const m3 = await mountRepo("/repos/acme/platform/releases", lockedApi);
    await waitForEl(m3.harness, '[data-testid="switch-repo-work-ownership"]');
    const lockedSw = m3.el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-work-ownership"]',
    )!;
    expect(lockedSw.disabled).toBe(true);
    expect(lockedSw.getAttribute("aria-describedby")).toBe(
      "repo-readonly-banner",
    );
    const cmp3 = m3.harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      saveWorkDefault: (s: string) => Promise<void>;
      saveWorkItem: (i: string, s: string) => Promise<void>;
    };
    await cmp3.saveWorkDefault("off");
    await cmp3.saveWorkItem("release", "off");
    expect(lockedApi.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // 4. Host-prefixed repo scoping and in-place navigation reset
    TestBed.resetTestingModule();
    const hostApi = new FakeRepoApi();
    hostApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/host-scoped",
        roles: ["grain/host-scoped"],
        full: false,
        scopes: ["repos:read", "repos:write"],
        repoLimits: { "repos:write": ["ghes.example.com/acme/allowed"] },
      },
    };
    const m4 = await mountRepo(
      "/repos/ghes.example.com/acme/allowed/releases",
      hostApi,
    );
    await waitForEl(m4.harness, '[data-testid="switch-repo-work-ownership"]');
    expect(
      hostApi.calls.some(
        (c) =>
          c.key === "GET /api/repos/{owner}/{name}/work-ownership" &&
          c.params?.["owner"] === "ghes.example.com/acme" &&
          c.params?.["name"] === "allowed",
      ),
    ).toBe(true);
    expect(
      m4.el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-work-ownership"]',
      )!.disabled,
    ).toBe(false);

    hostApi.workOwnershipBody = {
      repo: "ghes.example.com/acme/forbidden",
      default: "off",
      defaultRuns: false,
      items: [],
    };
    await m4.harness.navigateByUrl(
      "/repos/ghes.example.com/acme/forbidden/releases",
    );
    await vi.waitFor(() => {
      m4.harness.detectChanges();
      expect(
        m4.el.querySelector('[data-testid="wo-default-resolved"]')?.textContent,
      ).toContain("Does not run this repository's work");
    });
    expect(
      m4.el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-work-ownership"]',
      )!.disabled,
    ).toBe(true);
  });

  it("shows 'No Grain-managed branches yet' when branches are empty, surfaces GET failures and denied scope honestly, and renders the table after branch creation", async () => {
    // 1. Empty branches list -> honest empty state, no table
    const api = new FakeRepoApi();
    api.branchesBody = [];
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/branches",
      api,
    );

    const emptyBox = await waitForEl(
      harness,
      '[data-testid="repo-branches-empty"]',
    );
    expect(emptyBox.textContent?.trim()).toBe("No Grain-managed branches yet");
    expect(
      el.querySelector('table[aria-label="Repository branches"]'),
    ).toBeNull();

    // Creating a branch transitions out of the empty state into the table
    api.branchesBody = [{ name: "release/v2.0", sha: "abcdef1234567890" }];
    const brInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-new-branch-name"]',
    )!;
    brInput.value = "release/v2.0";
    brInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="create-branch-btn"]',
    )!.click();
    await flushUi(harness);

    expect(el.querySelector('[data-testid="repo-branches-empty"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="branch-row-release/v2.0"]')?.textContent,
    ).toContain("abcdef1234");

    // 2. Failed GET -> shows error + Retry, never falsely says "No Grain-managed branches yet"
    TestBed.resetTestingModule();
    const failApi = new FakeRepoApi();
    failApi.branchesBody = [];
    failApi.refuseGet = "GET /api/repos/{owner}/{name}/branches";
    failApi.refuseGetMessage = "branches store offline";
    const m2 = await mountRepo("/repos/acme/platform/branches", failApi);
    const errEl = await waitForEl(
      m2.harness,
      '[data-testid="repo-branches-error"]',
    );
    expect(errEl.textContent).toContain("branches store offline");
    expect(
      m2.el.querySelector('[data-testid="repo-branches-empty"]'),
    ).toBeNull();

    failApi.refuseGet = null;
    errEl.querySelector<HTMLButtonElement>("button")!.click();
    const recoveredEmpty = await waitForEl(
      m2.harness,
      '[data-testid="repo-branches-empty"]',
    );
    expect(recoveredEmpty.textContent?.trim()).toBe(
      "No Grain-managed branches yet",
    );

    // 3. Denied repos:read -> shows denied banner, skips GET
    TestBed.resetTestingModule();
    const deniedApi = new FakeRepoApi();
    deniedApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/scoped-reader",
        roles: ["grain/scoped-reader"],
        full: false,
        scopes: ["repos:read"],
        repoLimits: { "repos:read": ["acme/allowed"] },
      },
    };
    const m3 = await mountRepo("/repos/acme/platform/branches", deniedApi);
    expect(
      deniedApi.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/branches",
      ),
    ).toBe(false);
    expect(
      m3.el.querySelector('[data-testid="repo-branches-denied"]')?.textContent,
    ).toContain("repos:read on this repository");
    expect(
      m3.el.querySelector('[data-testid="repo-branches-empty"]'),
    ).toBeNull();
  });

  it("adds, validates, and withdraws repo unfixable checks via GET/PUT /unfixable-checks", async () => {
    const api = new FakeRepoApi();
    api.unfixableBody = {
      unfixableChecks: null,
      grainCICheckName: "grain CI",
    };

    const { el, harness } = await mountRepo(
      "/repos/acme/platform/merge-queue",
      api,
    );
    const card = await waitForEl(
      harness,
      '[data-testid="card-repo-unfixable-checks"]',
    );
    expect(card.classList).toContain("unfixable-card");
    expect(card.textContent).toContain("Checks no commit here can clear");
    expect(card.textContent).toContain("This does not exempt them.");
    expect(
      el.querySelector('[data-testid="repo-unfixable-empty"]')?.textContent,
    ).toContain(
      "grain treats every check acme/platform reports as one a commit could turn green.",
    );

    const input = el.querySelector<HTMLInputElement>(
      '[data-testid="input-unfixable-check"]',
    )!;
    const addBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="add-unfixable-check-btn"]',
    )!;
    expect(addBtn.disabled).toBe(true);

    // Reject grain CI (case-insensitively) without firing PUT
    input.value = "grain ci";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    expect(addBtn.disabled).toBe(false);
    addBtn.click();
    await flushUi(harness);

    expect(
      el.querySelector('[data-testid="repo-unfixable-error"]')?.textContent,
    ).toContain("judges one exact commit on the branch");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      api.calls.some(
        (c) => c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks",
      ),
    ).toBe(false);

    // Reject comma-containing check names without firing PUT
    input.value = "cla/google,license/cla";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    expect(el.querySelector('[data-testid="repo-unfixable-error"]')).toBeNull();
    addBtn.click();
    await flushUi(harness);
    expect(
      el.querySelector('[data-testid="repo-unfixable-error"]')?.textContent,
    ).toContain('cannot contain ","');
    expect(
      api.calls.some(
        (c) => c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks",
      ),
    ).toBe(false);

    // Add valid check "cla/google" -> PUT { unfixableChecks: ["cla/google"] }, clears draft
    input.value = "  cla/google  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    addBtn.click();
    await flushUi(harness);

    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks" &&
          JSON.stringify(c.body) ===
            JSON.stringify({ unfixableChecks: ["cla/google"] }),
      ),
    ).toBe(true);
    expect(input.value).toBe("");
    expect(
      el.querySelector('[data-testid="unfixable-chip-cla/google"]')
        ?.textContent,
    ).toContain("cla/google");
    expect(el.querySelector('[data-testid="repo-unfixable-empty"]')).toBeNull();

    // Reject case-insensitive duplicate "CLA/Google" without firing PUT
    const putCountBeforeDup = api.calls.filter(
      (c) => c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks",
    ).length;
    input.value = "CLA/Google";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    addBtn.click();
    await flushUi(harness);

    expect(
      el.querySelector('[data-testid="repo-unfixable-error"]')?.textContent,
    ).toContain("acme/platform already declares CLA/Google unfixable");
    expect(
      api.calls.filter(
        (c) => c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks",
      ).length,
    ).toBe(putCountBeforeDup);

    // Also reject invalid direct saveUnfixableChecks(["grain CI"]) and comma payloads
    const cmp = harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      saveUnfixableChecks: (c: string[]) => Promise<boolean>;
    };
    const putCountBeforeDirect = api.calls.filter(
      (c) => c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks",
    ).length;
    expect(await cmp.saveUnfixableChecks(["grain CI"])).toBe(false);
    expect(await cmp.saveUnfixableChecks(["a,b"])).toBe(false);
    expect(
      api.calls.filter(
        (c) => c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks",
      ).length,
    ).toBe(putCountBeforeDirect);

    // Withdraw "cla/google" -> PUT { unfixableChecks: [] }, server null normalizes back to empty state
    el.querySelector<HTMLButtonElement>(
      '[data-testid="remove-unfixable-cla/google"]',
    )!.click();
    await flushUi(harness);

    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/unfixable-checks" &&
          JSON.stringify(c.body) === JSON.stringify({ unfixableChecks: [] }),
      ),
    ).toBe(true);
    expect(
      el.querySelector('[data-testid="unfixable-chip-cla/google"]'),
    ).toBeNull();
    expect(
      el.querySelector('[data-testid="repo-unfixable-empty"]')?.textContent,
    ).toContain("grain treats every check acme/platform reports");
  });

  it("handles failed unfixable-checks GET/PUT without corrupting state and enforces RBAC, configRepoOnly, and repo switches", async () => {
    // 1. Failed GET -> shows load error + Retry, never renders empty-list copy
    const api = new FakeRepoApi();
    api.refuseGet = "GET /api/repos/{owner}/{name}/unfixable-checks";
    api.refuseGetMessage = "unfixable checks store unavailable";
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/merge-queue",
      api,
    );

    const loadErr = await waitForEl(
      harness,
      '[data-testid="repo-unfixable-load-error"]',
    );
    expect(loadErr.textContent).toContain("unfixable checks store unavailable");
    expect(el.querySelector('[data-testid="repo-unfixable-empty"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="input-unfixable-check"]'),
    ).toBeNull();

    // Retry succeeds and failed PUT preserves existing chips & typed draft
    api.refuseGet = null;
    api.unfixableBody = {
      unfixableChecks: ["cla/google"],
      grainCICheckName: "grain CI",
    };
    api.refusePut = "PUT /api/repos/{owner}/{name}/unfixable-checks";
    api.refusePutMessage = "unfixableChecks write rejected";
    loadErr.querySelector<HTMLButtonElement>("button")!.click();
    await waitForEl(harness, '[data-testid="unfixable-chip-cla/google"]');

    const input = el.querySelector<HTMLInputElement>(
      '[data-testid="input-unfixable-check"]',
    )!;
    input.value = "license/cla";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="add-unfixable-check-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 15));
    await flushUi(harness);

    expect(
      el.querySelector('[data-testid="repo-unfixable-error"]')?.textContent,
    ).toContain("unfixableChecks write rejected");
    expect(input.value).toBe("license/cla");
    expect(
      el.querySelector('[data-testid="unfixable-chip-cla/google"]'),
    ).not.toBeNull();
    expect(
      el.querySelector('[data-testid="unfixable-chip-license/cla"]'),
    ).toBeNull();

    // 2. repos:read denied -> no GET, shows denied banner
    TestBed.resetTestingModule();
    const readDeniedApi = new FakeRepoApi();
    readDeniedApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/scoped-reader",
        roles: ["grain/scoped-reader"],
        full: false,
        scopes: ["repos:read"],
        repoLimits: { "repos:read": ["acme/allowed"] },
      },
    };
    const m2 = await mountRepo(
      "/repos/acme/platform/merge-queue",
      readDeniedApi,
    );
    expect(
      readDeniedApi.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/unfixable-checks",
      ),
    ).toBe(false);
    expect(
      m2.el.querySelector('[data-testid="repo-unfixable-denied"]')?.textContent,
    ).toContain("repos:read on this repository");

    // 3. repos:read without repos:write -> readonly banner, disabled input/Add, no chip remove buttons, zero writes
    TestBed.resetTestingModule();
    const writeDeniedApi = new FakeRepoApi();
    writeDeniedApi.unfixableBody = {
      unfixableChecks: ["cla/google"],
      grainCICheckName: "grain CI",
    };
    writeDeniedApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["repos:read"],
      },
    };
    const m3 = await mountRepo(
      "/repos/acme/platform/merge-queue",
      writeDeniedApi,
    );
    await waitForEl(m3.harness, '[data-testid="repo-unfixable-readonly"]');
    const roInput = m3.el.querySelector<HTMLInputElement>(
      '[data-testid="input-unfixable-check"]',
    )!;
    const roAdd = m3.el.querySelector<HTMLButtonElement>(
      '[data-testid="add-unfixable-check-btn"]',
    )!;
    expect(roInput.disabled).toBe(true);
    expect(roAdd.disabled).toBe(true);
    expect(roAdd.getAttribute("aria-describedby")).toBe(
      "repo-unfixable-readonly",
    );
    expect(
      m3.el.querySelector('[data-testid="remove-unfixable-cla/google"]'),
    ).toBeNull();
    const cmp3 = m3.harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      addUnfixableCheck: () => Promise<void>;
      removeUnfixableCheck: (c: string) => Promise<void>;
      saveUnfixableChecks: (c: string[]) => Promise<boolean>;
    };
    await cmp3.addUnfixableCheck();
    await cmp3.removeUnfixableCheck("cla/google");
    await cmp3.saveUnfixableChecks(["license/cla"]);
    expect(writeDeniedApi.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // 4. configRepoOnly -> disabled + aria-describedby=repo-readonly-banner + zero writes
    TestBed.resetTestingModule();
    const lockedApi = new FakeRepoApi();
    lockedApi.unfixableBody = {
      unfixableChecks: ["cla/google"],
      grainCICheckName: "grain CI",
    };
    lockedApi.configBody = {
      version: "v3.6.0",
      configRepoOnly: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const m4 = await mountRepo("/repos/acme/platform/merge-queue", lockedApi);
    await waitForEl(m4.harness, '[data-testid="unfixable-chip-cla/google"]');
    const lockedAdd = m4.el.querySelector<HTMLButtonElement>(
      '[data-testid="add-unfixable-check-btn"]',
    )!;
    expect(lockedAdd.disabled).toBe(true);
    expect(lockedAdd.getAttribute("aria-describedby")).toBe(
      "repo-readonly-banner",
    );
    expect(
      m4.el.querySelector('[data-testid="remove-unfixable-cla/google"]'),
    ).toBeNull();
    const cmp4 = m4.harness.fixture.debugElement.query(
      By.directive(RepoDetailPageComponent),
    ).componentInstance as unknown as {
      saveUnfixableChecks: (c: string[]) => Promise<boolean>;
    };
    await cmp4.saveUnfixableChecks([]);
    expect(lockedApi.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // 5. Host-prefixed repo scoping and in-place navigation reset
    TestBed.resetTestingModule();
    const hostApi = new FakeRepoApi();
    hostApi.unfixableBody = {
      unfixableChecks: ["cla/allowed"],
      grainCICheckName: "grain CI",
    };
    hostApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/host-scoped",
        roles: ["grain/host-scoped"],
        full: false,
        scopes: ["repos:read", "repos:write"],
        repoLimits: { "repos:write": ["ghes.example.com/acme/allowed"] },
      },
    };
    const m5 = await mountRepo(
      "/repos/ghes.example.com/acme/allowed/merge-queue",
      hostApi,
    );
    await waitForEl(m5.harness, '[data-testid="unfixable-chip-cla/allowed"]');
    expect(
      hostApi.calls.some(
        (c) =>
          c.key === "GET /api/repos/{owner}/{name}/unfixable-checks" &&
          c.params?.["owner"] === "ghes.example.com/acme" &&
          c.params?.["name"] === "allowed",
      ),
    ).toBe(true);
    expect(
      m5.el.querySelector<HTMLInputElement>(
        '[data-testid="input-unfixable-check"]',
      )!.disabled,
    ).toBe(false);

    hostApi.unfixableBody = {
      unfixableChecks: [],
      grainCICheckName: "grain CI",
    };
    await m5.harness.navigateByUrl(
      "/repos/ghes.example.com/acme/forbidden/merge-queue",
    );
    await vi.waitFor(() => {
      m5.harness.detectChanges();
      expect(
        m5.el.querySelector('[data-testid="repo-unfixable-empty"]')
          ?.textContent,
      ).toContain("ghes.example.com/acme/forbidden");
    });
    expect(
      m5.el.querySelector('[data-testid="unfixable-chip-cla/allowed"]'),
    ).toBeNull();
    expect(
      m5.el.querySelector<HTMLInputElement>(
        '[data-testid="input-unfixable-check"]',
      )!.disabled,
    ).toBe(true);
  });

  it("manages CI capability grants, server methods, custom grants, errors, RBAC, and repo switches", async () => {
    // 1. Happy path: config enrichment, retired/unready filtering, pill toggles, method & custom grants
    const api = new FakeRepoApi();
    const ciCatalog: CapabilityOption[] = [
      {
        id: "github-read",
        name: "GitHub read",
        description: "Read repository metadata and PR state",
        ready: true,
      },
      {
        id: "unready-cap",
        name: "Unready CI cap",
        description: "Needs org token",
        ready: false,
        needs: ["org-token"],
      },
    ];
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
      ciCapabilities: ciCatalog,
    };
    api.ciCapsBody = {
      ciCapabilities: [
        "retired-cap",
        "https://grain.dev/capabilities/release#registry-push={}",
      ],
      availableCICapabilities: ["github-read", "unready-cap", "custom-runner"],
    };

    const { harness, el } = await mountRepo("/repos/acme/platform/ci", api);
    await waitForEl(harness, '[data-testid="card-repo-ci-capabilities"]');
    await waitForEl(harness, '[data-testid="repo-ci-grants-cap-github-read"]');

    // Offered ready pill + synthesized label + held retired pill render; unheld unready cap stays hidden
    expect(
      el.querySelector('[data-testid="repo-ci-grants-cap-github-read"]')
        ?.textContent,
    ).toContain("GitHub read");
    expect(
      el.querySelector('[data-testid="repo-ci-grants-cap-custom-runner"]'),
    ).not.toBeNull();
    expect(
      el.querySelector('[data-testid="repo-ci-grants-cap-unready-cap"]'),
    ).toBeNull();
    const retiredPill = el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-cap-retired-cap"]',
    )!;
    expect(retiredPill).not.toBeNull();
    expect(retiredPill.getAttribute("aria-pressed")).toBe("true");
    expect(
      el.querySelector('[data-testid="repo-ci-caps-warnings"]')?.textContent,
    ).toContain("retired-cap");

    // Toggle offered pill on -> emits PUT with cleaned capabilities
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-cap-github-read"]',
    )!.click();
    await flushUi(harness);
    const put1 = api.calls.find(
      (c) =>
        c.method === "PUT" &&
        c.key === "PUT /api/repos/{owner}/{name}/ci-capabilities",
    );
    expect(put1?.body).toEqual({
      ciCapabilities: [
        "retired-cap",
        "https://grain.dev/capabilities/release#registry-push={}",
        "github-read",
      ],
    });

    // Untick retired pill -> removes retired cap & clears retired warning
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-cap-retired-cap"]',
    )!.click();
    await flushUi(harness);
    expect(
      el.querySelector('[data-testid="repo-ci-caps-warnings"]'),
    ).toBeNull();

    // Open "+ Add CI grant" builder -> must NOT show API scope mode, queries capability-methods with kind=ci
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-add-open"]',
    )!.click();
    await flushUi(harness);
    expect(
      el.querySelector('[data-testid="repo-ci-grants-mode-api"]'),
    ).toBeNull();
    const methodGet = api.calls.find(
      (c) => c.method === "GET" && c.key === "GET /api/capability-methods",
    );
    expect(methodGet?.query).toBe("kind=ci&repo=acme%2Fplatform");

    // Attach default method (release#registry-push with JSON args) -> omits subject on /check
    const argsInput = el.querySelector<HTMLInputElement>(
      '[data-testid="repo-ci-grants-method-args"]',
    )!;
    argsInput.value = '{"repository":"ghcr.io/acme/widgets"}';
    argsInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-attach"]',
    )!.click();
    await flushUi(harness);
    const checkCall = api.calls.find(
      (c) => c.key === "POST /api/capability-grants/check",
    );
    expect((checkCall?.body as { subject?: unknown })?.subject).toBeUndefined();
    expect(api.ciCapsBody.ciCapabilities).toContain(
      'https://grain.dev/capabilities/release#registry-push={"repository":"ghcr.io/acme/widgets"}',
    );

    // Custom grant rejects api:* client-side without calling check or PUT
    const countBeforeApiReject = api.calls.length;
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-mode-raw"]',
    )!.click();
    harness.detectChanges();
    const rawInput = el.querySelector<HTMLInputElement>(
      '[data-testid="repo-ci-grants-raw-input"]',
    )!;
    rawInput.value = "api:tasks-read";
    rawInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-attach"]',
    )!.click();
    await flushUi(harness);
    expect(
      el.querySelector('[data-testid="repo-ci-grants-error"]')?.textContent,
    ).toContain("API scope");
    expect(api.calls.length).toBe(countBeforeApiReject);

    // Remove held chip grant -> triggers PUT without removed entry
    el.querySelector<HTMLButtonElement>(
      '[data-testid="remove-grant-0"]',
    )!.click();
    await flushUi(harness);
    expect(api.ciCapsBody.ciCapabilities).not.toContain(
      "https://grain.dev/capabilities/release#registry-push={}",
    );

    // 2. Empty state when zero capabilities offered/held; refused PUT reverts and surfaces error
    api.refusePut = "PUT /api/repos/{owner}/{name}/ci-capabilities";
    api.refusePutMessage = "unknown capability";
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-cap-github-read"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    await flushUi(harness);
    expect(
      el.querySelector('[data-testid="repo-ci-caps-error"]')?.textContent,
    ).toContain("unknown capability");
    expect(
      el
        .querySelector('[data-testid="repo-ci-grants-cap-github-read"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    // 3. Failed GET renders Retry without falsely showing empty state; Retry recovers
    TestBed.resetTestingModule();
    const failGetApi = new FakeRepoApi();
    failGetApi.refuseGet = "GET /api/repos/{owner}/{name}/ci-capabilities";
    failGetApi.refuseGetMessage = "ci capabilities service unavailable";
    failGetApi.ciCapsBody = {
      ciCapabilities: null,
      availableCICapabilities: [],
    };
    const m2 = await mountRepo("/repos/acme/platform/ci", failGetApi);
    await waitForEl(m2.harness, '[data-testid="repo-ci-caps-load-error"]');
    expect(
      m2.el.querySelector('[data-testid="repo-ci-caps-empty"]'),
    ).toBeNull();
    failGetApi.refuseGet = null;
    m2.el
      .querySelector<HTMLButtonElement>('[data-testid="repo-ci-caps-retry"]')!
      .click();
    await flushUi(m2.harness);
    await waitForEl(m2.harness, '[data-testid="repo-ci-caps-empty"]');
    expect(
      m2.el.querySelector('[data-testid="repo-ci-caps-empty"]')?.textContent,
    ).toContain("None offered -- grant access under Grants");

    // 4. RBAC: capabilities:read denied skips GET; capabilities:admin denied disables writes
    TestBed.resetTestingModule();
    const readDeniedApi = new FakeRepoApi();
    readDeniedApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["repos:read"],
      },
    };
    const m3 = await mountRepo("/repos/acme/platform/ci", readDeniedApi);
    await waitForEl(m3.harness, '[data-testid="repo-ci-caps-denied"]');
    expect(
      readDeniedApi.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/ci-capabilities",
      ),
    ).toBe(false);

    TestBed.resetTestingModule();
    const roApi = new FakeRepoApi();
    roApi.ciCapsBody = {
      ciCapabilities: ["github-read"],
      availableCICapabilities: ["github-read"],
    };
    roApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/reader",
        roles: ["grain/reader"],
        full: false,
        scopes: ["repos:read", "capabilities:read"],
      },
    };
    const m4 = await mountRepo("/repos/acme/platform/ci", roApi);
    await waitForEl(m4.harness, '[data-testid="repo-ci-caps-readonly"]');
    const roPill = m4.el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-ci-grants-cap-github-read"]',
    )!;
    expect(roPill.disabled).toBe(true);
    expect(roPill.getAttribute("aria-describedby")).toBe(
      "repo-ci-caps-readonly",
    );
    expect(
      m4.el.querySelector('[data-testid="repo-ci-grants-add-open"]'),
    ).toBeNull();

    // 5. configRepoOnly locks CI capabilities editor & host-prefixed navigation resets state
    TestBed.resetTestingModule();
    const hostApi = new FakeRepoApi();
    hostApi.ciCapsBody = {
      ciCapabilities: ["github-read"],
      availableCICapabilities: ["github-read"],
    };
    hostApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "grain/host-scoped",
        roles: ["grain/host-scoped"],
        full: false,
        scopes: ["repos:read", "capabilities:read", "capabilities:admin"],
        repoLimits: {
          "capabilities:admin": ["ghes.example.com/acme/allowed"],
        },
      },
    };
    const m5 = await mountRepo(
      "/repos/ghes.example.com/acme/allowed/ci",
      hostApi,
    );
    await waitForEl(
      m5.harness,
      '[data-testid="repo-ci-grants-cap-github-read"]',
    );
    expect(
      m5.el.querySelector<HTMLButtonElement>(
        '[data-testid="repo-ci-grants-cap-github-read"]',
      )!.disabled,
    ).toBe(false);

    hostApi.ciCapsBody = {
      ciCapabilities: [],
      availableCICapabilities: [],
    };
    await m5.harness.navigateByUrl("/repos/ghes.example.com/acme/forbidden/ci");
    await waitForEl(m5.harness, '[data-testid="repo-ci-caps-empty"]');
    expect(
      m5.el.querySelector('[data-testid="repo-ci-grants-cap-github-read"]'),
    ).toBeNull();
    expect(
      m5.el.querySelector('[data-testid="repo-ci-caps-readonly"]'),
    ).not.toBeNull();
  });

  it("validates agent settings explicitly and reports sequential save errors without silent failures", async () => {
    const api = new FakeRepoApi();
    const { harness, el } = await mountRepo("/repos/acme/platform/agents", api);
    await waitForEl(harness, '[data-testid="card-repo-agents"]');

    const setupInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-repo-setup-cmd"]',
    )!;
    const promptInput = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="input-repo-prompt-ext"]',
    )!;
    const capsInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-repo-caps"]',
    )!;
    const saveBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-agents-btn"]',
    )!;

    // 1. Multi-field client validation: zero PUTs, ordered alert, aria-invalid, focus first invalid
    setupInput.value = "npm ci\u0007";
    setupInput.dispatchEvent(new Event("input", { bubbles: true }));
    promptInput.value = "Always run unit tests";
    promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    capsInput.value = "ci:read, , package-publish";
    capsInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();

    saveBtn.click();
    await flushUi(harness);

    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const banner = el.querySelector('[data-testid="repo-agents-error"]')!;
    expect(banner).not.toBeNull();
    const items = Array.from(
      banner.querySelectorAll(".repo-error-list li"),
    ).map((li) => li.textContent ?? "");
    expect(items.length).toBe(2);
    expect(items[0]).toContain("Sandbox setup command");
    expect(items[1]).toContain("Default capabilities");
    expect(setupInput.getAttribute("aria-invalid")).toBe("true");
    expect(promptInput.getAttribute("aria-invalid")).toBeNull();
    expect(capsInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      el.querySelector('[data-testid="error-repo-setup-cmd"]'),
    ).not.toBeNull();
    expect(el.querySelector('[data-testid="error-repo-caps"]')).not.toBeNull();
    expect(document.activeElement).toBe(setupInput);

    // Fixing setup removes setup error while preserving caps error
    setupInput.value = "npm ci";
    setupInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    expect(setupInput.getAttribute("aria-invalid")).toBeNull();
    expect(el.querySelector('[data-testid="error-repo-setup-cmd"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="repo-agents-error"]')?.textContent,
    ).toContain("Default capabilities");

    // Verify additional invalid cap cases: unclosed JSON args, whitespace token, CI-only grain-ci
    for (const bad of [
      "release#registry-push={",
      "release#registry-push=badjson",
      "bad token",
      "grain-ci",
      "repo#read",
      "release#registry-push",
    ]) {
      capsInput.value = bad;
      capsInput.dispatchEvent(new Event("input", { bubbles: true }));
      harness.detectChanges();
      saveBtn.click();
      await flushUi(harness);
      expect(capsInput.getAttribute("aria-invalid")).toBe("true");
      expect(
        el.querySelector('[data-testid="error-repo-caps"]'),
      ).not.toBeNull();
    }
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // 2. Step 1 failure halts sequence before prompt/capabilities PUTs
    capsInput.value = 'ci:read, gcp#gcp-key={"permission_set":"viewer"}';
    capsInput.dispatchEvent(new Event("input", { bubbles: true }));
    harness.detectChanges();
    api.refusePut = "PUT /api/repos/{owner}/{name}/setup-command";
    api.refusePutMessage = "setup command disallowed";
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await flushUi(harness);
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.key),
    ).toEqual(["PUT /api/repos/{owner}/{name}/setup-command"]);
    expect(setupInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      el.querySelector('[data-testid="repo-agents-error"]')?.textContent,
    ).toContain("setup command disallowed");
    expect(document.activeElement).toBe(setupInput);

    // 3. Step 3 failure after steps 1 & 2 succeed reports partial saves and exact failed step
    api.calls = [];
    api.refusePut = "PUT /api/repos/{owner}/{name}/capabilities";
    api.refusePutMessage = "capability not permitted";
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    await flushUi(harness);
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.key),
    ).toEqual([
      "PUT /api/repos/{owner}/{name}/setup-command",
      "PUT /api/repos/{owner}/{name}/prompt-extension",
      "PUT /api/repos/{owner}/{name}/capabilities",
    ]);
    const partialBanner = el.querySelector(
      '[data-testid="repo-agents-error"]',
    )!;
    const partialItems = Array.from(
      partialBanner.querySelectorAll(".repo-error-list li"),
    ).map((li) => li.textContent ?? "");
    expect(partialItems.length).toBe(2);
    expect(partialItems[0]).toContain("Sandbox setup command");
    expect(partialItems[0]).toContain("Standing prompt extension");
    expect(partialItems[1]).toContain("Default capabilities");
    expect(partialItems[1]).toContain("capability not permitted");
    expect(capsInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(capsInput);

    // 4. Full valid save succeeds cleanly and clears errors
    api.calls = [];
    api.refusePut = null;
    saveBtn.click();
    await flushUi(harness);
    expect(el.querySelector('[data-testid="repo-agents-error"]')).toBeNull();
    expect(capsInput.getAttribute("aria-invalid")).toBeNull();
    const capPut = api.calls.find(
      (c) => c.key === "PUT /api/repos/{owner}/{name}/capabilities",
    );
    expect(capPut?.body).toEqual({
      defaultCapabilities: [
        "ci:read",
        'gcp#gcp-key={"permission_set":"viewer"}',
      ],
    });
  });
});
