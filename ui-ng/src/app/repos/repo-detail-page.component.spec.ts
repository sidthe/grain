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
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
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
  refuseGet: string | null = null;
  declarationsBody: Record<string, unknown> = {
    repo: "acme/platform",
    declarations: false,
  };
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
      declaration?: { repo: string; path: string };
    }[];
  } = {
    repo: "acme/platform",
    default: "",
    defaultRuns: true,
    items: [
      { item: "release", kind: "release", override: "", runs: true },
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
  releaseEnabledValue?: boolean;

  configBody: GrainConfig & Record<string, unknown> = {
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
    if (this.refuseGet === key) {
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error("declarations fetch refused"))),
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
        ...(this.releaseEnabledValue !== undefined
          ? { enabled: this.releaseEnabledValue }
          : {}),
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
    if (key === "GET /api/repos/{owner}/{name}/declarations") {
      return Promise.resolve(structuredClone(this.declarationsBody));
    }
    if (key === "GET /api/repos/{owner}/{name}/work-ownership") {
      return Promise.resolve(structuredClone(this.workOwnershipBody));
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
        setTimeout(() =>
          reject(new Error('ciMode: must be "grain", "github", or "none"')),
        ),
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
    if (key === "PUT /api/repos/{owner}/{name}/work-ownership") {
      const req = (body ?? {}) as {
        default?: string;
        item?: string;
        state?: string;
      };
      if (req.default !== undefined) {
        this.workOwnershipBody.default = req.default;
        this.workOwnershipBody.defaultRuns = req.default !== "off";
      }
      if (req.item !== undefined) {
        const target = this.workOwnershipBody.items.find(
          (i) => i.item === req.item,
        );
        if (target) {
          target.override = req.state ?? "";
        } else {
          this.workOwnershipBody.items.push({
            item: req.item,
            kind: "unknown",
            override: req.state ?? "",
            runs: false,
          });
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
      return Promise.resolve(structuredClone(this.workOwnershipBody));
    }
    if (key === "PUT /api/repos/{owner}/{name}/release") {
      const req = (body ?? {}) as { enabled?: boolean };
      if (req.enabled !== undefined) {
        this.releaseEnabledValue = Boolean(req.enabled);
        const rel = this.workOwnershipBody.items.find(
          (i) => i.item === "release",
        );
        if (rel) {
          rel.override = req.enabled ? "on" : "off";
          rel.runs = Boolean(req.enabled);
        }
        return Promise.resolve({ enabled: this.releaseEnabledValue });
      }
      return Promise.resolve({ ok: true });
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

  it("loads and toggles repo declarations on the Advanced tab and supports the /declarations alias", async () => {
    const api = new FakeRepoApi();
    const { el, harness } = await mountRepo("/repos/acme/platform", api);

    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-tab-advanced"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" &&
          c.key === "GET /api/repos/{owner}/{name}/declarations" &&
          c.params?.["owner"] === "acme" &&
          c.params?.["name"] === "platform",
      ),
    ).toBe(true);

    const sw = () =>
      el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-declarations"]',
      )!;
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().getAttribute("aria-label")).toBe(
      "Read acme/platform's own declarations",
    );

    sw().click();
    await new Promise((r) => setTimeout(r, 15));
    harness.detectChanges();

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
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(
      el.querySelector('[data-testid="declarations-not-read-yet"]')
        ?.textContent,
    ).toContain("Not read yet");

    TestBed.resetTestingModule();
    const { el: el2 } = await mountRepo(
      "/repos/acme/platform/declarations",
      api,
    );
    expect(
      el2.querySelector('[data-testid="card-repo-declarations"]'),
    ).not.toBeNull();
  });

  it("renders declarations status, triggers, push refs, error fallback, and deduplicated port warnings", async () => {
    const api = new FakeRepoApi();
    api.declarationsBody = {
      repo: "acme/platform",
      declarations: true,
      declarationsStatus: {
        commit: "0f1e2d3c4b5a69788796",
        error: "parsing .grain/triggers/broken.yml: bad yaml",
        templates: [".grain/templates/nightly.yml"],
        suites: [".grain/suites/smoke.yml"],
        schedules: [".grain/schedules/nightly.yml"],
        triggers: [".grain/triggers/design-docs.yml"],
        mergeRules: ".grain/merge-rules.yml",
        pushes: [
          {
            path: ".grain/templates/release.yml",
            refs: [{ ref: "refs/tags/v*", force: true, delete: true }],
          },
        ],
        warnings: [
          "both .grain/merge-rules.yml and .grain/sensitive.yml exist; sensitive.yml is ignored",
          "port-types in .grain/settings.yml: main->nonexistent names nonexistent, which is not a paired branch",
        ],
      },
      pairedBranches: ["main", "release/1.0"],
      portBranches: ["main"],
      declaredPortBranches: ["release/1.0"],
      portDirections: [
        {
          from: "main",
          to: "release/1.0",
          paired: true,
          operatorTypes: ["fix"],
          declaredTypes: ["docs"],
          types: ["fix", "docs"],
        },
        {
          from: "main",
          to: "nonexistent",
          paired: false,
          declaredTypes: ["fix"],
        },
      ],
      portWarnings: [
        "port-types in .grain/settings.yml: main->nonexistent names nonexistent, which is not a paired branch",
        "operator port-types: main->ghost names ghost, which is not a paired branch",
      ],
    };

    const { el } = await mountRepo("/repos/acme/platform/advanced", api);
    const cardText = el.querySelector(
      '[data-testid="card-repo-declarations"]',
    )!.textContent!;
    expect(cardText).toContain(
      "Last read failed: parsing .grain/triggers/broken.yml: bad yaml — still running what 0f1e2d3c4b5a declared.",
    );
    expect(cardText).toContain(
      "Still running from 0f1e2d3c4b5a: 1 template(s), 1 suite(s), 1 schedule(s), 1 trigger(s), merge rules in .grain/merge-rules.yml",
    );
    expect(cardText).toContain(
      "Path triggers: .grain/triggers/design-docs.yml",
    );
    expect(cardText).toContain(
      "Tasks from .grain/templates/release.yml may also push: refs/tags/v* (force, delete)",
    );

    const portsCard = el.querySelector('[data-testid="card-repo-ports"]')!;
    expect(portsCard.textContent).toContain(
      "Grain ports each merge between main, release/1.0",
    );
    expect(portsCard.textContent).toContain("nothing (not a paired branch)");
    const portWarns = [
      ...portsCard.querySelectorAll('[data-testid="repo-port-warning"]'),
    ].map((n) => n.textContent?.trim());
    expect(portWarns).toEqual([
      "Warning: operator port-types: main->ghost names ghost, which is not a paired branch",
    ]);
  });

  it("handles declarations GET error with retry and keeps switch state when PUT fails", async () => {
    const api = new FakeRepoApi();
    api.refuseGet = "GET /api/repos/{owner}/{name}/declarations";
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/advanced",
      api,
    );
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    expect(
      el.querySelector('[data-testid="declarations-error-banner"]')
        ?.textContent,
    ).toContain("declarations fetch refused");

    api.refuseGet = null;
    api.refusePut = "PUT /api/repos/{owner}/{name}/declarations";
    el.querySelector<HTMLButtonElement>(
      '[data-testid="retry-declarations-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    const sw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-declarations"]',
    )!;
    expect(sw.getAttribute("aria-checked")).toBe("false");

    sw.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(
      el.querySelector('[data-testid="repo-error-banner"]')?.textContent,
    ).toContain("ciMode");
  });

  it("enforces repo-scoped access.can(route, repo) gating across Repo Detail tabs and refuses out-of-scope mutations", async () => {
    const api = new FakeRepoApi();
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "repo-admin",
        roles: ["repo-admin"],
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
          "connections:read",
          "connections:write",
        ],
        repoLimits: {
          "repos:write": ["acme/other"],
          "capabilities:admin": ["acme/other"],
          "releases:write": ["acme/other"],
          "ci:write": ["acme/other"],
          "tasks:write": ["acme/other"],
          "connections:write": ["acme/other"],
        },
      },
    };

    const { el, harness } = await mountRepo("/repos/acme/platform", api);
    expect(
      el.querySelector<HTMLButtonElement>(
        '[data-testid="save-repo-config-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      el.querySelector<HTMLButtonElement>(
        '[data-testid="refresh-lifecycle-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      el.querySelector<HTMLButtonElement>(
        '[data-testid="save-issue-import-btn"]',
      )!.disabled,
    ).toBe(true);
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="import-issues-btn"]')!
        .disabled,
    ).toBe(true);

    // Agents tab: both repos:write and capabilities:admin are limited to acme/other
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-tab-agents"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 15));
    harness.detectChanges();
    expect(
      el.querySelector<HTMLInputElement>(
        '[data-testid="input-repo-setup-cmd"]',
      )!.disabled,
    ).toBe(true);
    expect(
      el.querySelector<HTMLTextAreaElement>(
        '[data-testid="input-repo-prompt-ext"]',
      )!.disabled,
    ).toBe(true);
    expect(
      el.querySelector<HTMLInputElement>('[data-testid="input-repo-caps"]')!
        .disabled,
    ).toBe(true);
    const saveAgentsBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-agents-btn"]',
    )!;
    expect(saveAgentsBtn.disabled).toBe(true);
    saveAgentsBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // Advanced tab: declarations write disabled with reason for acme/platform
    el.querySelector<HTMLButtonElement>(
      '[data-testid="repo-tab-advanced"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 15));
    harness.detectChanges();
    const declSwitch = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-repo-declarations"]',
    )!;
    expect(declSwitch.disabled).toBe(true);
    expect(
      el.querySelector('[data-testid="declarations-write-denied"]')
        ?.textContent,
    ).toContain("repos:write");
    declSwitch.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("gates individual agent settings mutations to matching repo-scoped routes", async () => {
    const api = new FakeRepoApi();
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "repo-writer",
        roles: ["repo-writer"],
        full: false,
        scopes: [
          "repos:read",
          "repos:write",
          "capabilities:read",
          "capabilities:admin",
        ],
        repoLimits: {
          "repos:write": ["acme/platform"],
          "capabilities:admin": ["acme/other"],
        },
      },
    };

    const { el, harness } = await mountRepo("/repos/acme/platform/agents", api);
    expect(
      el.querySelector<HTMLInputElement>(
        '[data-testid="input-repo-setup-cmd"]',
      )!.disabled,
    ).toBe(false);
    expect(
      el.querySelector<HTMLInputElement>('[data-testid="input-repo-caps"]')!
        .disabled,
    ).toBe(true);

    const saveBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-agents-btn"]',
    )!;
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 15));
    harness.detectChanges();

    const putKeys = api.calls
      .filter((c) => c.method === "PUT")
      .map((c) => c.key);
    expect(putKeys).toEqual([
      "PUT /api/repos/{owner}/{name}/setup-command",
      "PUT /api/repos/{owner}/{name}/prompt-extension",
    ]);
  });

  it("denies reading declarations when repos:read is limited to another repository and locks toggle under configRepoOnly", async () => {
    const api = new FakeRepoApi();
    api.configBody = {
      version: "v3.6.0",
      access: {
        role: "other-reader",
        roles: ["other-reader"],
        full: false,
        scopes: ["repos:read", "repos:write"],
        repoLimits: {
          "repos:read": ["acme/other"],
          "repos:write": ["acme/other"],
        },
      },
    };

    const { el } = await mountRepo("/repos/acme/platform/advanced", api);
    expect(
      el.querySelector('[data-testid="declarations-read-denied"]')?.textContent,
    ).toContain("repos:read");
    expect(
      api.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/declarations",
      ),
    ).toBe(false);

    TestBed.resetTestingModule();
    const roApi = new FakeRepoApi();
    roApi.configBody = {
      version: "v3.6.0",
      configRepoOnly: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const { el: roEl } = await mountRepo(
      "/repos/acme/platform/advanced",
      roApi,
    );
    expect(
      roEl.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-declarations"]',
      )!.disabled,
    ).toBe(true);
  });

  it("renders Work Ownership silence, overrides, declarations, paused, unknown, and empty states", async () => {
    const api = new FakeRepoApi();
    const { el } = await mountRepo("/repos/acme/platform/releases", api);

    const card = el.querySelector('[data-testid="card-repo-work-ownership"]')!;
    const cardText = card.textContent!;
    expect(cardText).toContain("Standing work on this deployment: on");
    expect(cardText).toContain("the base-branch check");
    expect(cardText).toContain(
      "tasks people file by hand against this repository",
    );
    expect(cardText).toContain("Runs this repository's work");
    expect(cardText).toContain("Off, set here");
    expect(cardText).toContain("Nightly sweep");
    expect(cardText).toContain("repo:schedule:acme:platform:nightly");
    expect(cardText).toContain("declared in .grain/schedules/nightly.yml");
    expect(cardText).toContain("Not run");
    expect(cardText).toContain("Runs");
    expect(
      [...card.querySelectorAll(".status-pill")].filter((p) =>
        p.textContent?.includes("Nobody has said"),
      ),
    ).toHaveLength(2);

    const sw = card.querySelector<HTMLButtonElement>(
      '[data-testid="switch-work-ownership-default"]',
    )!;
    expect(sw.getAttribute("aria-label")).toBe(
      "Standing work on this deployment",
    );
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(
      card
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Nightly sweep: off"]',
        )!
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      card
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Nightly sweep: on"]',
        )!
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      card
        .querySelector<HTMLButtonElement>(
          'button[aria-label="release: say nothing"]',
        )!
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Paused schedule, title === item (no duplicate id code), and unknown stale override.
    TestBed.resetTestingModule();
    const metaApi = new FakeRepoApi();
    metaApi.workOwnershipBody = {
      repo: "acme/platform",
      default: "",
      defaultRuns: true,
      items: [
        {
          item: "local-chore",
          kind: "schedule",
          title: "Housekeeping",
          override: "",
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
    const { el: metaEl } = await mountRepo(
      "/repos/acme/platform/releases",
      metaApi,
    );
    const pausedRow = metaEl.querySelector(
      '[data-testid="work-ownership-item-local-chore"]',
    )!;
    expect(pausedRow.textContent).toContain("Paused on its own row");
    expect(pausedRow.textContent).toContain("Runs");
    const sameTitleRow = metaEl.querySelector(
      '[data-testid="work-ownership-item-chore"]',
    )!;
    expect(sameTitleRow.querySelector("code")).toBeNull();
    const unknownRow = metaEl.querySelector(
      '[data-testid="work-ownership-item-withdrawn"]',
    )!;
    expect(unknownRow.textContent).toContain("nothing here has this id");
    expect(
      unknownRow.querySelector('button[aria-label="withdrawn: say nothing"]'),
    ).not.toBeNull();

    // Empty work items message.
    TestBed.resetTestingModule();
    const emptyApi = new FakeRepoApi();
    emptyApi.workOwnershipBody = {
      repo: "acme/platform",
      default: "",
      defaultRuns: true,
      items: [],
    };
    const { el: emptyEl } = await mountRepo(
      "/repos/acme/platform/releases",
      emptyApi,
    );
    expect(
      emptyEl.querySelector('[data-testid="work-ownership-empty"]')
        ?.textContent,
    ).toContain("No work items");
  });

  it("writes repository default via switch and three-state buttons and clears item exceptions with empty state", async () => {
    const api = new FakeRepoApi();
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );

    const sw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-work-ownership-default"]',
    )!;
    sw.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/work-ownership" &&
          (c.body as { default?: string })?.default === "off",
      ),
    ).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(
      el.querySelector('[data-testid="work-ownership-switch-label"]')
        ?.textContent,
    ).toContain("Standing work on this deployment: off");
    expect(
      el.querySelector('[data-testid="work-ownership-default-row"]')
        ?.textContent,
    ).toContain("Does not run this repository's work");

    const releaseRow = el.querySelector(
      '[data-testid="work-ownership-item-release"]',
    )!;
    expect(releaseRow.textContent).toContain("Nobody has said");
    expect(releaseRow.textContent).toContain("Not run");

    // Return default to unset ("say nothing").
    el.querySelector<HTMLButtonElement>(
      'button[aria-label="the repository default: say nothing"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/work-ownership" &&
          (c.body as { default?: string })?.default === "",
      ),
    ).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");

    // Clear Nightly sweep exception using "" (not "on").
    el.querySelector<HTMLButtonElement>(
      'button[aria-label="Nightly sweep: say nothing"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.key === "PUT /api/repos/{owner}/{name}/work-ownership" &&
          (c.body as { item?: string; state?: string })?.item ===
            "repo:schedule:acme:platform:nightly" &&
          (c.body as { item?: string; state?: string })?.state === "",
      ),
    ).toBe(true);
    expect(
      el.querySelector('[data-testid="work-ownership-items"]')?.textContent,
    ).not.toContain("Off, set here");
  });

  it("keeps the release work-ownership row and release workflow switch synchronized", async () => {
    const api = new FakeRepoApi();
    api.releaseEnabledValue = true;
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );

    const releaseSwitch = () =>
      el.querySelector<HTMLButtonElement>(
        '[data-testid="switch-repo-release-enabled"]',
      )!;
    expect(releaseSwitch().getAttribute("aria-checked")).toBe("true");

    // Turn release off from Work Ownership -> updates Release workflow switch.
    el.querySelector<HTMLButtonElement>(
      'button[aria-label="release: off"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(releaseSwitch().getAttribute("aria-checked")).toBe("false");

    // Turn release back on from Release settings -> reloads Work Ownership row.
    releaseSwitch().click();
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="save-repo-release-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(
      el
        .querySelector<HTMLButtonElement>('button[aria-label="release: on"]')!
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("handles work-ownership GET errors with retry, preserves state on PUT failure, and validates bad input gracefully", async () => {
    const api = new FakeRepoApi();
    api.refuseGet = "GET /api/repos/{owner}/{name}/work-ownership";
    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    expect(
      el.querySelector('[data-testid="work-ownership-error-banner"]')
        ?.textContent,
    ).toContain("declarations fetch refused");
    expect(
      el.querySelector('[data-testid="switch-work-ownership-default"]'),
    ).toBeNull();

    api.refuseGet = null;
    api.refusePut = "PUT /api/repos/{owner}/{name}/work-ownership";
    el.querySelector<HTMLButtonElement>(
      '[data-testid="retry-work-ownership-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    const sw = el.querySelector<HTMLButtonElement>(
      '[data-testid="switch-work-ownership-default"]',
    )!;
    expect(sw.getAttribute("aria-checked")).toBe("true");

    sw.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(
      el.querySelector('[data-testid="repo-error-banner"]')?.textContent,
    ).toContain("ciMode");

    // Client-side validation rejects invalid work item ids and states without sending PUT.
    const comp = harness.routeDebugElement?.componentInstance as unknown as {
      setWorkOwnershipDefault: (state: string) => Promise<void>;
      setWorkItemOwnership: (item: string, state: string) => Promise<void>;
    };
    const putCountBefore = api.calls.filter(
      (c) =>
        c.method === "PUT" &&
        c.key === "PUT /api/repos/{owner}/{name}/work-ownership",
    ).length;

    await comp.setWorkItemOwnership("bad,item", "off");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-error-banner"]')?.textContent,
    ).toContain("holds ',' or '='");

    await comp.setWorkItemOwnership("   ", "off");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-error-banner"]')?.textContent,
    ).toContain("cannot be empty");

    await comp.setWorkOwnershipDefault("invalid-state");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-error-banner"]')?.textContent,
    ).toContain("not an ownership setting");

    const putCountAfter = api.calls.filter(
      (c) =>
        c.method === "PUT" &&
        c.key === "PUT /api/repos/{owner}/{name}/work-ownership",
    ).length;
    expect(putCountAfter).toBe(putCountBefore);
  });

  it("gates work-ownership reads and writes with repo-scoped access.can(route, repo) and configRepoOnly", async () => {
    // 1. Denied read on acme/platform when repos:read is limited to acme/other.
    const noReadApi = new FakeRepoApi();
    noReadApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "other-reader",
        roles: ["other-reader"],
        full: false,
        scopes: ["repos:read", "repos:write"],
        repoLimits: {
          "repos:read": ["acme/other"],
          "repos:write": ["acme/other"],
        },
      },
    };
    const { el: deniedEl } = await mountRepo(
      "/repos/acme/platform/releases",
      noReadApi,
    );
    expect(
      deniedEl.querySelector('[data-testid="work-ownership-read-denied"]')
        ?.textContent,
    ).toContain("repos:read");
    expect(
      noReadApi.calls.some(
        (c) => c.key === "GET /api/repos/{owner}/{name}/work-ownership",
      ),
    ).toBe(false);

    // 2. Read allowed, write denied on acme/platform -> controls disabled with aria-describedby.
    TestBed.resetTestingModule();
    const readOnlyApi = new FakeRepoApi();
    readOnlyApi.configBody = {
      version: "v3.6.0",
      access: {
        role: "repo-reader",
        roles: ["repo-reader"],
        full: false,
        scopes: ["repos:read", "repos:write"],
        repoLimits: {
          "repos:read": ["acme/platform"],
          "repos:write": ["acme/other"],
        },
      },
    };
    const { el: roRoleEl } = await mountRepo(
      "/repos/acme/platform/releases",
      readOnlyApi,
    );
    const sw = roRoleEl.querySelector<HTMLButtonElement>(
      '[data-testid="switch-work-ownership-default"]',
    )!;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute("aria-describedby")).toBe(
      "repo-work-ownership-denied-reason",
    );
    expect(
      roRoleEl.querySelector('[data-testid="work-ownership-write-denied"]')
        ?.textContent,
    ).toContain("repos:write");
    const defOffBtn = roRoleEl.querySelector<HTMLButtonElement>(
      'button[aria-label="the repository default: off"]',
    )!;
    expect(defOffBtn.disabled).toBe(true);
    expect(defOffBtn.getAttribute("aria-describedby")).toBe(
      "repo-work-ownership-denied-reason",
    );
    sw.click();
    defOffBtn.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(readOnlyApi.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // 3. configRepoOnly locks controls and links aria-describedby to repo-config-readonly-banner.
    TestBed.resetTestingModule();
    const cfgRoApi = new FakeRepoApi();
    cfgRoApi.configBody = {
      version: "v3.6.0",
      configRepoOnly: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const { el: cfgEl } = await mountRepo(
      "/repos/acme/platform/releases",
      cfgRoApi,
    );
    const cfgSw = cfgEl.querySelector<HTMLButtonElement>(
      '[data-testid="switch-work-ownership-default"]',
    )!;
    expect(cfgSw.disabled).toBe(true);
    expect(cfgSw.getAttribute("aria-describedby")).toBe(
      "repo-config-readonly-banner",
    );
    expect(
      cfgEl.querySelector<HTMLButtonElement>(
        'button[aria-label="Nightly sweep: on"]',
      )!.disabled,
    ).toBe(true);
  });

  it("renders standing items with explicit On override beneath off default, guards concurrent saves, clears stale error on retry, and isolates repo switches", async () => {
    const api = new FakeRepoApi();
    api.workOwnershipBody = {
      repo: "acme/platform",
      default: "off",
      defaultRuns: false,
      items: [
        {
          item: "release",
          kind: "release",
          title: "Release",
          override: "",
          runs: false,
        },
        {
          item: "ports",
          kind: "standing",
          title: "Automatic ports to paired branches",
          override: "on",
          runs: true,
        },
      ],
    };

    const { el, harness } = await mountRepo(
      "/repos/acme/platform/releases",
      api,
    );

    const portsRow = el.querySelector(
      '[data-testid="work-ownership-item-ports"]',
    )!;
    expect(portsRow.textContent).toContain(
      "Automatic ports to paired branches",
    );
    expect(portsRow.textContent).toContain("ports");
    expect(portsRow.textContent).toContain("On, set here");
    expect(portsRow.textContent).toContain("Runs");
    expect(
      portsRow
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Automatic ports to paired branches: on"]',
        )!
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Failed PUT sets error banner; subsequent successful PUT clears that error banner.
    api.refusePut = "PUT /api/repos/{owner}/{name}/work-ownership";
    const defOnBtn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="the repository default: on"]',
    )!;
    defOnBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="repo-error-banner"]')?.textContent,
    ).toContain("ciMode");

    api.refusePut = null;
    defOnBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();
    expect(el.querySelector('[data-testid="repo-error-banner"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="work-ownership-default-row"]')
        ?.textContent,
    ).toContain("On, set here");

    // Switching repositories ignores a delayed GET from the prior repository.
    let resolveSlowGet!: (v: unknown) => void;
    const origGet = api.get;
    api.get = (key: string, params?: RouteParams) => {
      if (
        key === "GET /api/repos/{owner}/{name}/work-ownership" &&
        params?.["name"] === "platform"
      ) {
        api.calls.push({ method: "GET", key, params });
        return new Promise((r) => {
          resolveSlowGet = r;
        });
      }
      return origGet(key, params);
    };

    const comp = harness.routeDebugElement?.componentInstance as unknown as {
      loadWorkOwnership: (force?: boolean) => Promise<void>;
    };
    const staleLoad = comp.loadWorkOwnership(true);

    api.workOwnershipBody = {
      repo: "acme/other",
      default: "",
      defaultRuns: true,
      items: [{ item: "release", kind: "release", override: "", runs: true }],
    };
    await harness.navigateByUrl("/repos/acme/other/releases");
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    resolveSlowGet({
      repo: "acme/platform",
      default: "off",
      defaultRuns: false,
      items: [],
    });
    await staleLoad;
    harness.detectChanges();

    expect(
      el.querySelector('[data-testid="repo-detail-heading"]')?.textContent,
    ).toContain("acme/other");
    expect(
      el.querySelector('[data-testid="work-ownership-switch-label"]')
        ?.textContent,
    ).toContain("Standing work on this deployment: on");
    expect(
      el.querySelector('[data-testid="work-ownership-item-release"]'),
    ).not.toBeNull();
  });
});
