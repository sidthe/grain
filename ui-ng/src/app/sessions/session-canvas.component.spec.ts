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
import { Router, provideRouter } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { Comment } from "../api/models";
import { AccessService } from "../services/access.service";
import { SessionCanvasComponent } from "./session-canvas.component";

class FakeApi {
  calls: { method: string; route: string; params?: unknown; body?: unknown }[] =
    [];
  createdCount = 0;

  config = () => Promise.resolve({});
  get = (route: string) => {
    if (route === "GET /api/tasks/{id}/tree") {
      return Promise.resolve({ nodes: [] });
    }
    if (route === "GET /api/memory/documents") {
      return Promise.resolve({
        documents: [
          {
            name: "architecture-with-long-unbroken-identifier",
            repo: "acme/widgets",
            summary: "Core boundaries",
            text: "Use REST.",
            length: 9,
          },
        ],
      });
    }
    if (route === "GET /api/memory/documents/{name}") {
      return Promise.resolve({
        name: "architecture-with-long-unbroken-identifier",
        repo: "acme/widgets",
        summary: "Core boundaries",
        text: "# Architecture\n\n| Key | Value |\n|---|---|\n| endpoint | https://example.com/very/long/path/without/spaces |",
        length: 105,
      });
    }
    return Promise.resolve({ sessions: [] });
  };
  getIfChanged = () => Promise.resolve({ body: [], changed: true });
  post = (route: string, params?: unknown, body?: unknown) => {
    this.calls.push({ method: "POST", route, params, body });
    this.createdCount += 1;
    return Promise.resolve({ id: String(100 + this.createdCount) });
  };
  put = (route: string, params?: unknown, body?: unknown) => {
    this.calls.push({ method: "PUT", route, params, body });
    return Promise.resolve({});
  };
}

describe("SessionCanvasComponent", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("renders markdown docs, sandboxed HTML mocks, and launches topological workstream plans", async () => {
    const api = new FakeApi();
    TestBed.configureTestingModule({
      imports: [SessionCanvasComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const navSpy = vi
      .spyOn(TestBed.inject(Router), "navigate")
      .mockResolvedValue(true);

    const comments: Comment[] = [
      {
        id: 10,
        author: "grain",
        authorKind: "automation",
        body: [
          "## Feature Spec",
          "",
          "Detailed architecture and step-by-step rollout across API and UI packages.",
          "```html",
          "<title>Prototype</title><button>Launch</button>",
          "```",
          "```grain-plan",
          JSON.stringify({
            title: "Feature Stream",
            repo: "acme/web",
            tasks: [
              { key: "ui", title: "Build view", dependsOn: ["api"] },
              { key: "api", title: "Build route" },
            ],
          }),
          "```",
        ].join("\n"),
      },
    ];

    const f = TestBed.createComponent(SessionCanvasComponent);
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/web");
    f.componentRef.setInput("comments", comments);
    f.autoDetectChanges();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    expect(
      el.querySelector('[data-testid="canvas-tab-docs"]')?.textContent,
    ).toContain("Docs (1)");
    expect(
      el.querySelector('[data-testid="canvas-tab-html"]')?.textContent,
    ).toContain("HTML Mock (1)");
    expect(
      el.querySelector('[data-testid="canvas-tab-plan"]')?.textContent,
    ).toContain("Workstream (1)");

    // Switch to HTML tab -> verify strict sandboxed iframe srcdoc.
    (
      el.querySelector('[data-testid="canvas-tab-html"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    const iframe = el.querySelector(
      '[data-testid="canvas-html-iframe"]',
    ) as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toContain("<button>Launch</button>");

    // Switch to Workstream tab -> Approve & Launch creates root + 2 ordered tasks.
    (
      el.querySelector('[data-testid="canvas-tab-plan"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    (
      el.querySelector(
        '[data-testid="canvas-launch-plan"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(navSpy).toHaveBeenCalledWith(["/workstreams", "task:101"]),
    );

    const taskPosts = api.calls.filter((c) => c.route === "POST /api/tasks");
    expect(taskPosts).toHaveLength(3);
    expect(taskPosts[0].body).toMatchObject({
      title: "Feature Stream",
      approved: false,
    });
    expect(taskPosts[1].body).toMatchObject({
      title: "Build route",
      origin: "task:101",
      approved: true,
    });
    expect(taskPosts[2].body).toMatchObject({
      title: "Build view",
      origin: "task:101",
      dependsOn: ["102"],
      approved: true,
    });
    f.destroy();
  });

  it("renders overflow wrapper classes across Docs, HTML Mock, Workstream, and read-only Memory tabs", async () => {
    const api = new FakeApi();
    TestBed.configureTestingModule({
      imports: [SessionCanvasComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig({
      access: {
        role: "viewer",
        roles: ["viewer"],
        full: false,
        scopes: ["memory:read"],
      },
    });

    const comments: Comment[] = [
      {
        id: 20,
        author: "grain",
        authorKind: "automation",
        body: [
          "## Wide Spec",
          "",
          "Detailed architectural notes covering mobile canvas containment, horizontal scroll isolation, and narrow-viewport wrapping behavior across tables and blocks.",
          "",
          "| Column | URL |",
          "|---|---|",
          "| alpha | https://example.com/a/very/long/unbroken/segment/for/390px |",
          "",
          "```html",
          "<title>Wide Mock</title><div>Preview</div>",
          "```",
        ].join("\n"),
      },
    ];

    const f = TestBed.createComponent(SessionCanvasComponent);
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/widgets");
    f.componentRef.setInput("comments", comments);
    f.autoDetectChanges();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    const aside = el.querySelector("aside.session-canvas");
    expect(aside).not.toBeNull();
    expect(aside?.querySelector(".canvas-head .canvas-tabs")).not.toBeNull();
    const body = aside?.querySelector(".canvas-body");
    expect(body).not.toBeNull();

    // Docs tab wraps rendered markdown inside .canvas-markdown-wrap within .canvas-card.
    const docWrap = body?.querySelector(
      '.canvas-card .canvas-markdown-wrap[data-testid="canvas-doc-markdown"]',
    );
    expect(docWrap).not.toBeNull();
    expect(docWrap?.querySelector(".msg-body table")).not.toBeNull();

    // HTML Mock preview wraps the sandboxed iframe inside .canvas-preview-wrap.
    (
      el.querySelector('[data-testid="canvas-tab-html"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    const previewWrap = body?.querySelector(
      '.canvas-preview-wrap[data-testid="canvas-preview-wrap"]',
    );
    expect(previewWrap).not.toBeNull();
    expect(
      previewWrap?.querySelector(
        'iframe.canvas-iframe[data-testid="canvas-html-iframe"]',
      ),
    ).not.toBeNull();

    (
      el.querySelector('[data-testid="html-mode-source"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(
      body?.querySelector(
        'pre.canvas-source[data-testid="canvas-html-source"]',
      ),
    ).not.toBeNull();

    // Memory tab renders selector chips and wraps read-only markdown in .canvas-markdown-wrap.
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    const memChip = body?.querySelector(
      ".canvas-selector .canvas-chip",
    ) as HTMLButtonElement;
    expect(memChip).not.toBeNull();
    memChip.click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(
        body?.querySelector(
          '[data-testid="canvas-memory-editor"].canvas-card .canvas-markdown-wrap[data-testid="canvas-memory-markdown"] .msg-body table',
        ),
      ).not.toBeNull();
    });
    f.destroy();
  });
});
