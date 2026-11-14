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

import { HttpHeaders, HttpResponse } from "@angular/common/http";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { GrainConfig } from "../api/models";
import { AccessService } from "../services/access.service";
import { ContextPageComponent } from "./context-page.component";
import {
  type FsListResponse,
  type Memory,
  type MemoryDocument,
  buildMemoryScopes,
  highlightSyntaxHtml,
  isMemoryRepoDirPrefix,
  parseGrepOutput,
  parseGrepResponse,
  repoFromMemoryFsPath,
} from "./context.models";

interface RecordedCall {
  method: string;
  route: string;
  params?: unknown;
  query?: string;
  body?: unknown;
}

class FakeContextApi {
  calls: RecordedCall[] = [];

  configBody: GrainConfig = {
    version: "v3.5.0-test",
    targetRepos: ["acme/api"],
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
  };

  memories: Memory[] = [
    {
      repo: "",
      text: "# Global Rules\n\nAlways run **go test** before proposing.",
      updatedAt: "2026-11-11T10:00:00Z",
      updatedBy: "Alice Example",
      updatedByKind: "human",
    },
    {
      repo: "acme/api",
      text: "Use strict OpenAPI validation in `pkg/api`.",
      updatedAt: "2026-11-11T18:00:00Z",
      updatedBy: "Alice",
      updatedByKind: "human",
    },
  ];

  documents: MemoryDocument[] = [
    {
      repo: "",
      name: "db-migrations",
      summary: "Zero-downtime PostgreSQL migration rules and lock timeouts.",
      length: 148,
      updatedAt: "2026-11-11T20:00:00Z",
      updatedBy: "Alice Example",
      updatedByKind: "human",
    },
    {
      repo: "acme/api",
      name: "auth-tokens",
      summary: "OIDC token minting and audience verification rules.",
      length: 92,
      updatedAt: "2026-11-11T21:00:00Z",
      updatedBy: "Alice",
      updatedByKind: "human",
    },
  ];

  docBodies: Record<string, string> = {
    ":db-migrations":
      "## Migrations\n\nAlways set `lock_timeout = '2s'` before `ALTER TABLE`.",
    "acme/api:auth-tokens": "Verify `aud` and `iss` on every bearer token.",
  };

  fsDirs: Record<string, FsListResponse> = {
    "": {
      scheme: "memory",
      path: "",
      entries: [
        { name: "repos", type: "dir" },
        { name: "memory.md", type: "file", size: 58 },
        { name: "policy.json", type: "file", size: 42 },
      ],
    },
    repos: {
      scheme: "memory",
      path: "repos",
      entries: [{ name: "acme", type: "dir" }],
    },
    "repos/acme": {
      scheme: "memory",
      path: "repos/acme",
      entries: [
        { name: "api.md", type: "file", size: 44 },
        { name: "web.md", type: "file", size: 32 },
      ],
    },
  };

  fsFiles: Record<string, string> = {
    "memory.md": "# Global Rules\n\nAlways run **go test**.",
    "policy.json": '{\n  "strict": true,\n  "maxRetries": 3\n}',
    "repos/acme/api.md": "Use strict OpenAPI validation.",
    "repos/acme/web.md": "Keep CSS under 8 kB.",
  };

  config = () => Promise.resolve(this.configBody);
  getIfChanged = () => Promise.resolve({ body: [], changed: false });

  get = (route: string, params?: Record<string, string>, query?: string) => {
    this.calls.push({ method: "GET", route, params, query });
    if (route === "GET /api/deployment/reachable-repos") {
      return Promise.resolve({
        configured: true,
        repos: [
          { repo: "acme/api", push: true },
          { repo: "acme/web", push: false },
        ],
      });
    }
    if (route === "GET /api/memory") {
      const repoFilter = query ? new URLSearchParams(query).get("repo") : null;
      const list =
        repoFilter !== null
          ? this.memories.filter((m) => (m.repo || "") === repoFilter)
          : this.memories;
      return Promise.resolve(structuredClone(list));
    }
    if (route === "GET /api/memory/documents") {
      const repoFilter = query ? new URLSearchParams(query).get("repo") : null;
      const list =
        repoFilter !== null
          ? this.documents.filter((d) => (d.repo || "") === repoFilter)
          : this.documents;
      return Promise.resolve(structuredClone(list));
    }
    if (route === "GET /api/memory/documents/{name}") {
      const name = params?.["name"] ?? "";
      const repo = query ? new URLSearchParams(query).get("repo") || "" : "";
      const doc = this.documents.find(
        (d) => (d.repo || "") === repo && d.name === name,
      );
      return Promise.resolve({
        ...(doc ?? { repo, name, summary: "", length: 0 }),
        text: this.docBodies[`${repo}:${name}`] ?? "",
      });
    }
    if (route === "GET /api/fs/memory/{path...}") {
      const p = params?.["path"] ?? "";
      return Promise.resolve(
        structuredClone(
          this.fsDirs[p] ?? { scheme: "memory", path: p, entries: [] },
        ),
      );
    }
    return Promise.resolve({});
  };

  grepHandler?: (
    path: string,
    query?: string,
  ) => { body: string; headers?: Record<string, string> };

  getText = (
    route: string,
    params?: Record<string, string>,
    query?: string,
  ) => {
    this.calls.push({ method: "GET_TEXT", route, params, query });
    const p = params?.["path"] ?? "";
    if (query?.includes("grep=")) {
      if (this.grepHandler) {
        return Promise.resolve(this.grepHandler(p, query).body);
      }
      return Promise.resolve(
        'policy.json:2:  "strict": true,\n[truncated at match limit (50 matches); pass --max 100]\n',
      );
    }
    return Promise.resolve(this.fsFiles[p] ?? "");
  };

  getTextResponse = (
    route: string,
    params?: Record<string, string>,
    query?: string,
  ): Promise<HttpResponse<string>> => {
    this.calls.push({ method: "GET_TEXT", route, params, query });
    const p = params?.["path"] ?? "";
    if (query?.includes("grep=")) {
      const reply = this.grepHandler
        ? this.grepHandler(p, query)
        : {
            body: 'policy.json:2:  "strict": true,\n[truncated at match limit (50 matches); pass --max 100]\n',
            headers: { "X-Grain-Truncated": "true" },
          };
      return Promise.resolve(
        new HttpResponse({
          body: reply.body,
          headers: new HttpHeaders(reply.headers ?? {}),
        }),
      );
    }
    return Promise.resolve(
      new HttpResponse({
        body: this.fsFiles[p] ?? "",
        headers: new HttpHeaders(),
      }),
    );
  };

  put = (route: string, params?: unknown, body?: unknown) => {
    this.calls.push({ method: "PUT", route, params, body });
    if (route === "PUT /api/memory") {
      const { repo, text } = body as { repo: string; text: string };
      const idx = this.memories.findIndex((m) => (m.repo || "") === repo);
      if (!text) {
        if (idx >= 0) this.memories.splice(idx, 1);
      } else {
        const entry: Memory = {
          repo,
          text,
          updatedAt: "2026-11-12T00:05:00Z",
          updatedBy: "Alice Example",
          updatedByKind: "human",
        };
        if (idx >= 0) this.memories[idx] = entry;
        else this.memories.push(entry);
      }
      return Promise.resolve({ repo, text });
    }
    if (route === "PUT /api/memory/documents") {
      const { repo, name, summary, text } = body as {
        repo: string;
        name: string;
        summary: string;
        text: string;
      };
      const idx = this.documents.findIndex(
        (d) => (d.repo || "") === (repo || "") && d.name === name,
      );
      if (!text) {
        if (idx >= 0) this.documents.splice(idx, 1);
        delete this.docBodies[`${repo || ""}:${name}`];
        return Promise.resolve({});
      }
      const entry: MemoryDocument = {
        repo: repo || "",
        name,
        summary,
        length: new TextEncoder().encode(text).length,
        updatedAt: "2026-11-12T00:05:00Z",
        updatedBy: "Alice Example",
        updatedByKind: "human",
      };
      if (idx >= 0) this.documents[idx] = entry;
      else this.documents.push(entry);
      this.docBodies[`${repo || ""}:${name}`] = text;
      return Promise.resolve(entry);
    }
    return Promise.resolve({});
  };
}

async function settle(f: ComponentFixture<unknown>): Promise<void> {
  await f.whenStable();
  await new Promise((r) => setTimeout(r, 10));
  f.detectChanges();
  await f.whenStable();
}

describe("ContextPageComponent", () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  async function setup(api = new FakeContextApi()) {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [ContextPageComponent],
      providers: [
        provideRouter([]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig(api.configBody);
    const fixture = TestBed.createComponent(ContextPageComponent);
    fixture.autoDetectChanges();
    await settle(fixture);
    return { fixture, api, root: fixture.nativeElement as HTMLElement };
  }

  it("renders Context-scoped .ctx-split workspace, parses ReachableReposResult objects, previews Markdown, switches repo scopes, and saves via PUT /api/memory", async () => {
    const { fixture, root, api } = await setup();

    expect(root.querySelectorAll("select").length).toBe(0);
    // Uses Context-scoped classes (.ctx-split / .ctx-list-pane / .ctx-detail-pane), never .inbox-split.
    expect(root.querySelector(".ctx-split")).not.toBeNull();
    expect(root.querySelector(".inbox-split")).toBeNull();

    // When targetRepos is configured, unconfigured GitHub reachable-repos ("acme/web") do not flood scopes.
    expect(
      root.querySelector('[data-testid="scope-row-acme/api"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-testid="scope-row-acme/web"]')).toBeNull();
    expect(
      api.calls.some((c) => c.route === "GET /api/deployment/reachable-repos"),
    ).toBe(false);
    expect(
      root.querySelector('[data-testid="memory-scope-title"]')?.textContent,
    ).toContain("This deployment");
    expect(
      root.querySelector('[data-testid="memory-preview"]')?.innerHTML,
    ).toContain("<strong>go test</strong>");

    // Edit deployment instructions -> dirty pill appears -> save.
    const textarea = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-textarea"]',
    )!;
    textarea.value = "# Global Rules\n\nRun lint and vitest before commit.";
    textarea.dispatchEvent(new Event("input"));
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="memory-dirty-pill"]'),
    ).not.toBeNull();

    root
      .querySelector<HTMLButtonElement>('[data-testid="memory-save-btn"]')!
      .click();
    await settle(fixture);

    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.route === "PUT /api/memory" &&
          (c.body as { repo: string; text: string }).repo === "" &&
          (c.body as { repo: string; text: string }).text.includes("vitest"),
      ),
    ).toBe(true);
    expect(root.querySelector('[data-testid="memory-dirty-pill"]')).toBeNull();

    // Switch scope to acme/api via left pane row.
    root
      .querySelector<HTMLElement>('[data-testid="scope-row-acme/api"] button')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="memory-scope-title"]')?.textContent,
    ).toContain("acme/api");
    expect(
      root.querySelector<HTMLTextAreaElement>('[data-testid="memory-textarea"]')
        ?.value,
    ).toContain("OpenAPI");
  });

  it("validates slug format (<=64) and UTF-8 byte lengths, saves, and renders confirm dialog outside [attr.inert]", async () => {
    const { fixture, root, api } = await setup();

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-documents"]',
      )!
      .click();
    await settle(fixture);

    // Select existing pack "db-migrations" -> fetches detail body.
    root
      .querySelector<HTMLElement>(
        '[data-testid="doc-row-db-migrations"] button',
      )!
      .click();
    await settle(fixture);
    expect(
      root.querySelector<HTMLTextAreaElement>('[data-testid="doc-text-input"]')
        ?.value,
    ).toContain("lock_timeout");

    // Start creating a new pack -> test slug regex and UTF-8 byte length validation.
    root
      .querySelector<HTMLButtonElement>('[data-testid="doc-new-btn"]')!
      .click();
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="doc-name-hint"]')?.textContent,
    ).toContain("Lowercase letters, digits, and single hyphens");

    const nameInput = root.querySelector<HTMLInputElement>(
      '[data-testid="doc-name-input"]',
    )!;
    nameInput.value = "Bad_Slug--Name";
    nameInput.dispatchEvent(new Event("input"));

    const bodyInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="doc-text-input"]',
    )!;
    bodyInput.value = "## SLOs\n\nKeep p99 latency under 250ms.";
    bodyInput.dispatchEvent(new Event("input"));

    const sumInput = root.querySelector<HTMLInputElement>(
      '[data-testid="doc-summary-input"]',
    )!;
    // 101 UTF-16 code units of "é" = 202 UTF-8 bytes (> 200 byte limit).
    sumInput.value = "é".repeat(101);
    sumInput.dispatchEvent(new Event("input"));
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="doc-name-error"]')?.textContent,
    ).toContain("lowercase letters, digits, and single hyphens");
    expect(
      root.querySelector('[data-testid="doc-summary-error"]')?.textContent,
    ).toContain("Summary exceeds 200 bytes (202/200)");
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="doc-save-btn"]')!
        .disabled,
    ).toBe(true);

    // Fix slug and summary within limits -> Save enabled -> PUT /api/memory/documents.
    nameInput.value = "observability-slo";
    nameInput.dispatchEvent(new Event("input"));
    sumInput.value = "Latency SLOs and error-budget alert rules.";
    sumInput.dispatchEvent(new Event("input"));
    await settle(fixture);

    expect(root.querySelector('[data-testid="doc-name-error"]')).toBeNull();
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="doc-save-btn"]',
    )!;
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    await settle(fixture);

    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.route === "PUT /api/memory/documents" &&
          (c.body as { name: string; summary: string }).name ===
            "observability-slo",
      ),
    ).toBe(true);

    // Delete document opens ConfirmDialogComponent OUTSIDE the [inert] section.
    root
      .querySelector<HTMLButtonElement>('[data-testid="doc-delete-btn"]')!
      .click();
    await settle(fixture);
    const dialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);

    expect(
      api.calls.some(
        (c) =>
          c.method === "PUT" &&
          c.route === "PUT /api/memory/documents" &&
          (c.body as { name: string; text: string }).name ===
            "observability-slo" &&
          (c.body as { name: string; text: string }).text === "",
      ),
    ).toBe(true);
  });

  it("browses /api/fs/memory/{path...}, strips [truncated grep footers, and enforces repo-limited RBAC", async () => {
    const api = new FakeContextApi();
    api.configBody = {
      version: "v3.5.0-test",
      targetRepos: ["acme/api", "acme/web"],
      access: {
        role: "repo-dev",
        roles: ["repo-dev"],
        full: false,
        scopes: ["memory:read", "memory:write", "repos:read"],
        repoLimits: {
          "memory:read": ["acme/api"],
          "memory:write": ["acme/api"],
          "repos:read": ["acme/api"],
        },
      },
    };

    const { fixture, root } = await setup(api);

    // Auto-selects first permitted repo ("acme/api") and disables Deployment scope.
    expect(
      root.querySelector('[data-testid="memory-scope-title"]')?.textContent,
    ).toContain("acme/api");
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="context-scope-deployment"]',
      )!.disabled,
    ).toBe(true);
    expect(
      api.calls.some(
        (c) => c.route === "GET /api/memory" && c.query === "repo=acme%2Fapi",
      ),
    ).toBe(true);

    // Switch to Namespace tab via ArrowRight on tablist -> verifies WAI-ARIA tabpanel wiring.
    const instTab = root.querySelector<HTMLButtonElement>(
      '[data-testid="context-tab-instructions"]',
    )!;
    expect(instTab.getAttribute("aria-controls")).toBe(
      "context-panel-instructions",
    );
    expect(root.querySelector('[role="tabpanel"]')?.id).toBe(
      "context-panel-instructions",
    );

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-namespace"]',
      )!
      .click();
    await settle(fixture);

    // Navigate into repos -> acme -> open permitted api.md vs denied web.md.
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-entry-repos"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-entry-acme"]')!
      .click();
    await settle(fixture);

    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-entry-web.md"]')!
      .click();
    await settle(fixture);
    // Denied by repoFromMemoryFsPath("repos/acme/web.md") === "acme/web".
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET_TEXT" &&
          (c.params as { path?: string })?.path === "repos/acme/web.md",
      ),
    ).toBe(false);

    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-entry-api.md"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fs-file-title"]')?.textContent,
    ).toContain("memory://repos/acme/api.md");
  });

  it("wires WAI-ARIA role=none on listbox items and single-pass syntax highlighting without nested token corruption", async () => {
    const { fixture, root } = await setup();

    const trigger = root.querySelector<HTMLButtonElement>(
      '[data-testid="context-repo-trigger"]',
    )!;
    trigger.click();
    await settle(fixture);

    const menu = root.querySelector('[data-testid="context-repo-menu"]')!;
    const liRoles = Array.from(menu.querySelectorAll("li")).map((li) =>
      li.getAttribute("role"),
    );
    expect(liRoles.every((r) => r === "none")).toBe(true);

    // Escape closes listbox.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle(fixture);
    expect(root.querySelector('[data-testid="context-repo-menu"]')).toBeNull();

    // Unit-check model helpers for C1, M7, m10, and m14.
    const scopes = buildMemoryScopes(
      [],
      [],
      [{ repo: "acme/api", push: true }, null, 42, "acme/web"],
    );
    expect(scopes.map((s) => s.repo)).toEqual(["", "acme/api", "acme/web"]);
    expect(repoFromMemoryFsPath("repos/acme/api/notes.md")).toBe("acme/api");
    expect(repoFromMemoryFsPath("repos/acme/api.md")).toBe("acme/api");
    expect(
      repoFromMemoryFsPath(
        "repos/git.forge.example/experimental/grain/MEMORY.md",
      ),
    ).toBe("git.forge.example/experimental/grain");
    expect(
      repoFromMemoryFsPath("repos/git.forge.example/experimental"),
    ).toBeUndefined();
    expect(repoFromMemoryFsPath("repos/acme/../global.md")).toBeUndefined();
    expect(repoFromMemoryFsPath("memory.md")).toBeUndefined();
    expect(isMemoryRepoDirPrefix("", ["acme/api"])).toBe(true);
    expect(isMemoryRepoDirPrefix("repos", ["acme/api"])).toBe(true);
    expect(isMemoryRepoDirPrefix("repos/acme", ["acme/api"])).toBe(true);
    expect(isMemoryRepoDirPrefix("repos/secret", ["acme/api"])).toBe(false);
    expect(isMemoryRepoDirPrefix("global", ["acme/api"])).toBe(false);
    expect(isMemoryRepoDirPrefix("global/sub", ["acme/api"])).toBe(false);
    expect(
      isMemoryRepoDirPrefix("repos/git.forge.example/experimental", [
        "git.forge.example/experimental/grain",
      ]),
    ).toBe(true);

    const hits = parseGrepOutput(
      "a.md:4:hello\n[truncated at match limit (50 matches)]\n[truncated: walked 100 entries]\n",
      "repos/acme/api",
    );
    expect(hits).toEqual([
      { file: "repos/acme/api/a.md", line: 4, text: "hello" },
    ]);

    const html = highlightSyntaxHtml(
      'const msg = "return 42 & <tag>";',
      "sample.ts",
    );
    expect(html).toContain(
      '<span class="ctx-tok-str">&quot;return 42 &amp; &lt;tag&gt;&quot;</span>',
    );
    expect(html).not.toContain('ctx-tok-str"><span');
  });

  it("falls back to reachable-repos only when no repositories are configured on the deployment", async () => {
    const api = new FakeContextApi();
    api.configBody = {
      version: "v3.5.0-test",
      targetRepos: [],
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    };
    const { root } = await setup(api);
    expect(
      api.calls.some((c) => c.route === "GET /api/deployment/reachable-repos"),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="scope-row-acme/web"]'),
    ).not.toBeNull();
  });

  it("blocks deployment-wide memory:// dirs, root grep, and config:// bypasses when memory:read has repoLimits", async () => {
    const api = new FakeContextApi();
    api.fsDirs[""] = {
      scheme: "memory",
      path: "",
      entries: [
        { name: "global", type: "dir" },
        { name: "repos", type: "dir" },
        { name: "global.md", type: "file", size: 24 },
      ],
    };
    api.configBody = {
      version: "v3.5.0-test",
      targetRepos: ["acme/api", "acme/web"],
      access: {
        role: "repo-dev",
        roles: ["repo-dev"],
        full: false,
        // Even with unrestricted settings:read in scopes, repo-limited
        // memory:read must hide config:// so state-repo memory cannot leak.
        scopes: ["memory:read", "memory:write", "settings:read"],
        repoLimits: {
          "memory:read": ["acme/api"],
          "memory:write": ["acme/api"],
        },
      },
    };

    const { fixture, root } = await setup(api);

    // Switch to Namespace tab.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-namespace"]',
      )!
      .click();
    await settle(fixture);

    // config:// tab must be hidden when memory:read is repo-limited.
    expect(root.querySelector('[data-testid="fs-scheme-config"]')).toBeNull();
    expect(
      api.calls.some((c) => c.route === "GET /api/fs/config/{path...}"),
    ).toBe(false);

    // Clicking deployment-wide directory "global" or file "global.md" must be blocked.
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-entry-global"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-entry-global.md"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.route === "GET /api/fs/memory/{path...}" &&
          ((c.params as { path?: string })?.path === "global" ||
            (c.params as { path?: string })?.path === "global.md"),
      ),
    ).toBe(false);

    // Grepping from memory:// root must only query permitted repo subtrees, never "" or global.
    const grepInput = root.querySelector<HTMLInputElement>(
      '[data-testid="fs-grep-input"]',
    )!;
    grepInput.value = "strict";
    grepInput.dispatchEvent(new Event("input"));
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-grep-btn"]')!
      .click();
    await settle(fixture);

    const grepCalls = api.calls.filter(
      (c) => c.method === "GET_TEXT" && c.query?.includes("grep="),
    );
    expect(grepCalls.length).toBe(1);
    expect((grepCalls[0].params as { path?: string })?.path).toBe(
      "repos/acme/api",
    );
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET_TEXT" &&
          c.query?.includes("grep=") &&
          ((c.params as { path?: string })?.path === "" ||
            (c.params as { path?: string })?.path === "global"),
      ),
    ).toBe(false);
  });

  it("enforces deployment-wide memory write repoLimits across standing instructions, + New pack, documents, and scope switches", async () => {
    const api = new FakeContextApi();
    api.configBody = {
      version: "v3.5.0-test",
      targetRepos: ["acme/api", "acme/web"],
      access: {
        role: "docs-reader-api-writer",
        roles: ["docs-reader-api-writer"],
        full: false,
        scopes: ["memory:read", "memory:write", "settings:read"],
        repoLimits: {
          "memory:write": ["acme/api"],
          "settings:read": ["acme/api"],
        },
      },
    };

    const { fixture, root } = await setup(api);

    // Select deployment scope (allowed because memory:read is unlimited).
    const depBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="context-scope-deployment"]',
    )!;
    expect(depBtn.disabled).toBe(false);
    depBtn.click();
    await settle(fixture);

    expect(
      root.querySelector<HTMLTextAreaElement>(
        '[data-testid="memory-textarea"]',
      )!.readOnly,
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="memory-write-denied"]')?.textContent,
    ).toContain("cannot modify deployment-wide memory");
    expect(root.querySelector('[data-testid="memory-save-btn"]')).toBeNull();

    // Switch to Documents tab on deployment scope: + New pack disabled & deployment doc is read-only.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-documents"]',
      )!
      .click();
    await settle(fixture);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="doc-new-btn"]')!
        .disabled,
    ).toBe(true);

    root
      .querySelector<HTMLElement>(
        '[data-testid="doc-row-db-migrations"] button',
      )!
      .click();
    await settle(fixture);
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="doc-summary-input"]')!
        .readOnly,
    ).toBe(true);
    expect(
      root.querySelector<HTMLTextAreaElement>('[data-testid="doc-text-input"]')!
        .readOnly,
    ).toBe(true);
    expect(root.querySelector('[data-testid="doc-save-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="doc-delete-btn"]')).toBeNull();

    // Switch to acme/api, open writable doc, then switch back to deployment scope -> must stay non-writable.
    root
      .querySelector<HTMLButtonElement>('[data-testid="context-repo-trigger"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-repo-opt-acme/api"]',
      )!
      .click();
    await settle(fixture);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="doc-new-btn"]')!
        .disabled,
    ).toBe(false);
    root
      .querySelector<HTMLElement>('[data-testid="doc-row-auth-tokens"] button')!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="doc-save-btn"]')).not.toBeNull();

    // Switch back to deployment scope -> stale selectedDocRepo must be cleared.
    depBtn.click();
    await settle(fixture);
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="doc-new-btn"]')!
        .disabled,
    ).toBe(true);

    // Namespace config:// must also be hidden because settings:read has repoLimits.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-namespace"]',
      )!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="fs-scheme-config"]')).toBeNull();
  });

  it("fails closed before config loads and blocks whitespace/traversal repo bypasses", async () => {
    const api = new FakeContextApi();
    let resolveCfg!: (v: GrainConfig) => void;
    api.config = () =>
      new Promise<GrainConfig>((resolve) => {
        resolveCfg = resolve;
      });

    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [ContextPageComponent],
      providers: [
        provideRouter([]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const access = TestBed.inject(AccessService);
    const fixture = TestBed.createComponent(ContextPageComponent);
    fixture.detectChanges();

    // Before /api/config completes, deployment writes and config:// stay denied.
    const root = fixture.nativeElement as HTMLElement;
    expect(access.configLoaded()).toBe(false);
    expect(root.querySelector('[data-testid="memory-save-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="fs-scheme-config"]')).toBeNull();

    resolveCfg({
      version: "v3.5.0-test",
      targetRepos: ["acme/api"],
      access: {
        role: "repo-dev",
        roles: ["repo-dev"],
        full: false,
        scopes: ["memory:read", "memory:write", "settings:read"],
        repoLimits: {
          "memory:read": ["acme/api"],
          "memory:write": ["acme/api"],
        },
      },
    });
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="memory-scope-title"]')?.textContent,
    ).toContain("acme/api");
    expect(
      api.calls.some((c) => c.route === "GET /api/memory" && !c.query),
    ).toBe(false);
    expect(root.querySelector('[data-testid="fs-scheme-config"]')).toBeNull();
  });

  it("renders a component-scoped [truncated] grep footer notice from backend response flags and body lines", async () => {
    const api = new FakeContextApi();
    const { fixture, root } = await setup(api);

    // 1. Unit checks on parseGrepResponse for header-only, match-limit, walk-limit, and clean results.
    expect(parseGrepResponse("a.md:4:hello\n", "repos/acme/api")).toEqual({
      hits: [{ file: "repos/acme/api/a.md", line: 4, text: "hello" }],
      truncated: false,
      walkTruncated: false,
      notices: [],
    });
    expect(
      parseGrepResponse("a.md:4:hello\n", "repos/acme/api", {
        truncatedHeader: true,
      }),
    ).toEqual({
      hits: [{ file: "repos/acme/api/a.md", line: 4, text: "hello" }],
      truncated: true,
      walkTruncated: false,
      notices: [
        "[truncated: search results exceeded the match limit; narrow the path or refine the pattern]",
      ],
    });
    expect(
      parseGrepResponse(
        "[truncated: walked 2000 entries and stopped at repos/acme/z.md; it and everything after it were not searched, so finding no match here does not mean there is none: narrow the path or pass --glob]\n",
        "",
        { truncatedHeader: true, walkTruncatedHeader: true },
      ),
    ).toEqual({
      hits: [],
      truncated: true,
      walkTruncated: true,
      notices: [
        "[truncated: walked 2000 entries and stopped at repos/acme/z.md; it and everything after it were not searched, so finding no match here does not mean there is none: narrow the path or pass --glob]",
      ],
    });

    // Switch to Namespace tab.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-namespace"]',
      )!
      .click();
    await settle(fixture);

    const runSearch = async (query: string) => {
      const grepInput = root.querySelector<HTMLInputElement>(
        '[data-testid="fs-grep-input"]',
      )!;
      grepInput.value = query;
      grepInput.dispatchEvent(new Event("input"));
      await settle(fixture);
      root
        .querySelector<HTMLButtonElement>('[data-testid="fs-grep-btn"]')!
        .click();
      await settle(fixture);
    };

    // 2. Non-truncated grep must NOT display the footer notice.
    api.grepHandler = () => ({
      body: "memory.md:3:Always run go test.\n",
      headers: { "X-Grain-Matches": "1" },
    });
    await runSearch("go test");
    expect(root.querySelector('[data-testid="fs-grep-truncated"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="fs-grep-count"]')?.textContent?.trim(),
    ).toBe("1 match");

    // 3. Match-limit truncated grep renders footer notice with backend flag & line, without adding footer as a hit.
    api.grepHandler = () => ({
      body: 'policy.json:2:  "strict": true,\n[truncated at match limit (100 matches); pass --max 200 (grain grep) to raise the limit]\n',
      headers: {
        "X-Grain-Truncated": "true",
        "X-Grain-Matches": "100",
      },
    });
    await runSearch("strict");
    const matchNotice = root.querySelector(
      '[data-testid="fs-grep-truncated"]',
    )!;
    expect(matchNotice).not.toBeNull();
    expect(matchNotice.getAttribute("role")).toBe("status");
    expect(matchNotice.textContent).toContain("Search results truncated");
    expect(matchNotice.textContent).toContain(
      "[truncated at match limit (100 matches); pass --max 200 (grain grep) to raise the limit]",
    );
    expect(
      root.querySelectorAll('[data-testid="fs-grep-results"] li').length,
    ).toBe(1);
    expect(
      root.querySelector('[data-testid="fs-grep-count"]')?.textContent,
    ).toContain("1 match (truncated)");

    // 4. Clearing search removes the footer notice as well as the results.
    const clearBtn = Array.from(root.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Clear search"),
    )!;
    clearBtn.click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="fs-grep-results"]')).toBeNull();
    expect(root.querySelector('[data-testid="fs-grep-truncated"]')).toBeNull();

    // 5. Walk-limit truncated search with 0 matches still displays the walk-truncation footer notice.
    api.grepHandler = () => ({
      body: "[truncated: walked 2000 entries and stopped at repos/acme/z.md; it and everything after it were not searched, so finding no match here does not mean there is none: narrow the path or pass --glob]\n",
      headers: {
        "X-Grain-Truncated": "true",
        "X-Grain-Walk-Truncated": "true",
        "X-Grain-Matches": "0",
      },
    });
    await runSearch("missing-term");
    const walkNotice = root.querySelector('[data-testid="fs-grep-truncated"]')!;
    expect(walkNotice).not.toBeNull();
    expect(walkNotice.textContent).toContain("Search walk truncated");
    expect(walkNotice.textContent).toContain("walked 2000 entries");
    expect(
      root.querySelector('[data-testid="fs-grep-count"]')?.textContent,
    ).toContain("0 matches (truncated)");

    // 6. Header-only truncation flag (no [truncated...] footer line in body) still renders a clear notice.
    api.grepHandler = () => ({
      body: "memory.md:1:# Global Rules\n",
      headers: { "X-Grain-Truncated": "true" },
    });
    await runSearch("Rules");
    const hdrNotice = root.querySelector('[data-testid="fs-grep-truncated"]')!;
    expect(hdrNotice).not.toBeNull();
    expect(hdrNotice.textContent).toContain(
      "[truncated: search results exceeded the match limit",
    );

    // 7. Navigating into a directory clears the truncated grep notice.
    await runSearch("Rules");
    expect(
      root.querySelector('[data-testid="fs-grep-truncated"]'),
    ).not.toBeNull();
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fs-breadcrumbs"] button',
      )!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="fs-grep-truncated"]')).toBeNull();
  });

  it("merges [truncated] grep notices across multiple repoLimits subtrees and falls back to getText", async () => {
    const api = new FakeContextApi();
    api.configBody = {
      version: "v3.5.0-test",
      targetRepos: ["acme/api", "acme/web"],
      access: {
        role: "multi-repo-reader",
        roles: ["multi-repo-reader"],
        full: false,
        scopes: ["memory:read"],
        repoLimits: {
          "memory:read": ["acme/api", "acme/web"],
        },
      },
    };
    api.grepHandler = (p) => {
      if (p === "repos/acme/api") {
        return {
          body: "MEMORY.md:1:api rule\n[truncated at match limit (100 matches); pass --max 200]\n",
          headers: { "X-Grain-Truncated": "true" },
        };
      }
      return {
        body: "MEMORY.md:1:web rule\n",
        headers: { "X-Grain-Matches": "1" },
      };
    };

    const { fixture, root } = await setup(api);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="context-tab-namespace"]',
      )!
      .click();
    await settle(fixture);

    const grepInput = root.querySelector<HTMLInputElement>(
      '[data-testid="fs-grep-input"]',
    )!;
    grepInput.value = "rule";
    grepInput.dispatchEvent(new Event("input"));
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-grep-btn"]')!
      .click();
    await settle(fixture);

    const notice = root.querySelector('[data-testid="fs-grep-truncated"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("repos/acme/api");
    expect(notice.textContent).toContain("[truncated at match limit");
    expect(notice.textContent).not.toContain("repos/acme/web");
    expect(
      root.querySelectorAll('[data-testid="fs-grep-results"] li').length,
    ).toBe(2);

    // Also verify graceful fallback when an API test double only implements getText (no getTextResponse).
    (api as { getTextResponse?: unknown }).getTextResponse = undefined;
    grepInput.value = "fallback";
    grepInput.dispatchEvent(new Event("input"));
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fs-grep-btn"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fs-grep-truncated"]')?.textContent,
    ).toContain("repos/acme/api: [truncated at match limit");
  });
});
