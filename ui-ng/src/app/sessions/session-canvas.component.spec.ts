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
            name: "architecture",
            repo: "acme/widgets-with-long-repo-name",
            summary: "Core boundaries",
            text: "| Col1 | Col2 |\n|---|---|\n| https://ghe.example.com/extremely_long_token | ok |",
            length: 84,
          },
        ],
      });
    }
    if (route === "GET /api/memory/documents/{name}") {
      return Promise.resolve({
        name: "architecture",
        repo: "acme/widgets-with-long-repo-name",
        summary: "Core boundaries",
        text: "| Col1 | Col2 |\n|---|---|\n| https://ghe.example.com/extremely_long_token | ok |",
        length: 84,
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

  it("renders overflow wrapper classes across Docs, HTML source, and Memory tabs for 390px containment", async () => {
    const api = new FakeApi();
    TestBed.configureTestingModule({
      imports: [SessionCanvasComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "viewer",
        roles: ["viewer"],
        full: false,
        scopes: ["memory:read"],
      },
    });

    const comments: Comment[] = [
      {
        id: 21,
        author: "grain",
        authorKind: "automation",
        body: [
          "```markdown",
          "# LongTokenSpec",
          "",
          "| HeaderA | HeaderB |",
          "|---|---|",
          "| extremely_long_unbroken_identifier_for_390px_mobile_canvas_check | value |",
          "```",
          "```html",
          '<title>WideMock</title><div data-url="https://ghe.example.com/very/long/path/without/spaces">Mock</div>',
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
    expect(el.querySelector(".session-canvas")).not.toBeNull();
    expect(el.querySelector(".canvas-body")).not.toBeNull();
    const docsCard = el.querySelector(".canvas-body .canvas-card");
    expect(docsCard).not.toBeNull();
    const docsWrap = docsCard?.querySelector(".canvas-overflow-wrap");
    expect(docsWrap).not.toBeNull();
    expect(docsWrap?.querySelector(".msg-body table")).not.toBeNull();

    // Switch to HTML tab -> Source view wraps <pre class="canvas-source"> in .canvas-overflow-wrap.
    (
      el.querySelector('[data-testid="canvas-tab-html"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    (
      el.querySelector('[data-testid="html-mode-source"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    const sourceWrap = el.querySelector(
      ".canvas-body .canvas-overflow-wrap .canvas-source",
    );
    expect(sourceWrap).not.toBeNull();

    // Switch to Memory tab -> read-only markdown view uses .canvas-overflow-wrap inside .canvas-card.
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    const memChip = el.querySelector(
      ".canvas-selector .canvas-chip",
    ) as HTMLButtonElement;
    expect(memChip).not.toBeNull();
    memChip.click();
    await f.whenStable();
    f.detectChanges();

    const memCard = el.querySelector('[data-testid="canvas-memory-editor"]');
    expect(memCard).not.toBeNull();
    expect(memCard?.classList.contains("canvas-card")).toBe(true);
    const memWrap = memCard?.querySelector(".canvas-overflow-wrap");
    expect(memWrap).not.toBeNull();
    expect(memWrap?.querySelector(".msg-body table")).not.toBeNull();
    f.destroy();
  });
});
