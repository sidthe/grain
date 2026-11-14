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

  it("confirms discarding unsaved Pin to Memory changes on Cancel, doc switch, close, and Escape", async () => {
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
        role: "dev",
        roles: ["dev"],
        full: false,
        scopes: ["memory:read", "memory:write"],
      },
    });

    const opener = document.createElement("button");
    opener.textContent = "Open canvas";
    document.body.appendChild(opener);
    opener.focus();

    const comments: Comment[] = [
      {
        id: 1,
        author: "grain",
        authorKind: "automation",
        body: [
          "```grain-doc",
          "# Alpha Spec",
          "",
          "First doc body.",
          "```",
          "```grain-doc",
          "# Beta Spec",
          "",
          "Second doc body.",
          "```",
        ].join("\n"),
      },
    ];

    const f = TestBed.createComponent(SessionCanvasComponent);
    document.body.appendChild(f.nativeElement);
    let closeCount = 0;
    const sub = f.componentInstance.closed.subscribe(() => {
      closeCount += 1;
    });
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/web");
    f.componentRef.setInput("comments", comments);
    f.autoDetectChanges();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    const toggleBtn = el.querySelector(
      '[data-testid="canvas-pin-memory-toggle"]',
    ) as HTMLButtonElement;

    // Opening and cancelling without edits closes immediately without confirmation.
    toggleBtn.focus();
    toggleBtn.click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).not.toBeNull();
    toggleBtn.click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(document.activeElement).toBe(toggleBtn);

    // Edit Pin form -> Cancel triggers confirm dialog and keeps aside inert.
    toggleBtn.click();
    await f.whenStable();
    const nameInput = el.querySelector(
      '[data-testid="pin-memory-name"]',
    ) as HTMLInputElement;
    nameInput.value = "edited-slug";
    nameInput.dispatchEvent(new Event("input"));
    await f.whenStable();
    expect(el.querySelector('[data-testid="pin-dirty-pill"]')).not.toBeNull();

    toggleBtn.focus();
    toggleBtn.click();
    await f.whenStable();
    const dlg = el.querySelector(
      '[data-testid="confirm-dialog"]',
    ) as HTMLElement;
    expect(dlg).not.toBeNull();
    expect(dlg.closest("[inert]")).toBeNull();
    expect(el.querySelector(".session-canvas")?.hasAttribute("inert")).toBe(
      true,
    );
    expect(document.activeElement).toBe(
      el.querySelector('[data-testid="confirm-cancel"]'),
    );

    // Tab wraps cleanly inside the confirmation dialog.
    dlg.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(document.activeElement).toBe(
      el.querySelector('[data-testid="confirm-accept"]'),
    );

    // Cancel keeps edited Pin draft intact.
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      (el.querySelector('[data-testid="pin-memory-name"]') as HTMLInputElement)
        .value,
    ).toBe("edited-slug");

    // Switching to another doc asks confirmation; cancelling stays on Beta, confirming switches to Alpha.
    const alphaChip = Array.from(
      el.querySelectorAll<HTMLButtonElement>("[data-doc-id]"),
    ).find((b) => b.textContent?.includes("Alpha Spec"))!;
    alphaChip.click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(
      (el.querySelector('[data-testid="pin-memory-name"]') as HTMLInputElement)
        .value,
    ).toBe("edited-slug");

    alphaChip.click();
    await f.whenStable();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(el.querySelector(".canvas-card strong")?.textContent).toContain(
      "Alpha Spec",
    );

    // Dirty Pin form + Close button asks confirmation; accepting emits closed and returns focus to opener.
    (
      el.querySelector(
        '[data-testid="canvas-pin-memory-toggle"]',
      ) as HTMLButtonElement
    ).click();
    await f.whenStable();
    const summaryInput = el.querySelector(
      '[data-testid="pin-memory-summary"]',
    ) as HTMLInputElement;
    summaryInput.value = "Changed summary";
    summaryInput.dispatchEvent(new Event("input"));
    await f.whenStable();

    (
      el.querySelector('[data-testid="canvas-close"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(closeCount).toBe(0);
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(closeCount).toBe(1);
    expect(document.activeElement).toBe(opener);

    sub.unsubscribe();
    f.destroy();
    opener.remove();
  });

  it("confirms discarding Memory document edits on doc switch, Discard button, Save reset, and Escape", async () => {
    const api = new FakeApi();
    api.get = (route: string, params?: unknown) => {
      if (route === "GET /api/tasks/{id}/tree") {
        return Promise.resolve({ nodes: [] });
      }
      if (route === "GET /api/memory/documents") {
        return Promise.resolve([
          {
            name: "architecture",
            repo: "acme/web",
            summary: "Core boundaries",
            text: "Initial arch body",
            length: 17,
          },
          {
            name: "runbook",
            repo: "acme/web",
            summary: "On-call steps",
            text: "Initial runbook body",
            length: 20,
          },
        ]);
      }
      if (route === "GET /api/memory/documents/{name}") {
        const name = (params as { name?: string })?.name;
        return Promise.resolve(
          name === "runbook"
            ? {
                name: "runbook",
                repo: "acme/web",
                summary: "On-call steps",
                text: "Initial runbook body",
                length: 20,
              }
            : {
                name: "architecture",
                repo: "acme/web",
                summary: "Core boundaries",
                text: "Initial arch body",
                length: 17,
              },
        );
      }
      return Promise.resolve({ sessions: [] });
    };

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
        role: "dev",
        roles: ["dev"],
        full: false,
        scopes: ["memory:read", "memory:write"],
      },
    });

    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const f = TestBed.createComponent(SessionCanvasComponent);
    document.body.appendChild(f.nativeElement);
    let closeCount = 0;
    const sub = f.componentInstance.closed.subscribe(() => {
      closeCount += 1;
    });
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/web");
    f.componentRef.setInput("comments", []);
    f.autoDetectChanges();
    await f.whenStable();

    const el = f.nativeElement as HTMLElement;
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();

    const chips = Array.from(
      el.querySelectorAll<HTMLButtonElement>("[data-doc-key]"),
    );
    chips[0].click();
    await f.whenStable();

    const textInput = () =>
      el.querySelector(
        '[data-testid="memory-text-input"]',
      ) as HTMLTextAreaElement;
    textInput().focus();
    textInput().value = "Unsaved arch edits";
    textInput().dispatchEvent(new Event("input"));
    await f.whenStable();
    expect(
      el.querySelector('[data-testid="memory-dirty-pill"]'),
    ).not.toBeNull();
    expect(
      el.querySelector('[data-testid="canvas-memory-discard"]'),
    ).not.toBeNull();

    // Switching Memory docs while dirty asks confirmation; Cancel keeps edits.
    chips[1].click();
    await f.whenStable();
    expect(
      el.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("architecture");
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(textInput().value).toBe("Unsaved arch edits");

    // Discard button reverts edits after confirmation.
    (
      el.querySelector(
        '[data-testid="canvas-memory-discard"]',
      ) as HTMLButtonElement
    ).click();
    await f.whenStable();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(textInput().value).toBe("Initial arch body");
    expect(el.querySelector('[data-testid="memory-dirty-pill"]')).toBeNull();

    // Edit and Save clears dirty state so switching docs requires no confirmation.
    textInput().value = "Saved arch body";
    textInput().dispatchEvent(new Event("input"));
    await f.whenStable();
    (
      el.querySelector(
        '[data-testid="canvas-memory-save"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(
        api.calls.filter((c) => c.route === "PUT /api/memory/documents"),
      ).toHaveLength(1);
      expect(el.querySelector('[data-testid="memory-dirty-pill"]')).toBeNull();
    });
    chips[1].click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(textInput().value).toBe("Initial runbook body");

    // Edit runbook, switch to Docs tab (preserving dirty draft), press Escape -> confirms;
    // Escape on confirmation dialog cancels only the dialog and returns focus to textarea.
    textInput().value = "Dirty runbook body";
    textInput().dispatchEvent(new Event("input"));
    await f.whenStable();

    (
      el.querySelector('[data-testid="canvas-tab-docs"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(textInput().value).toBe("Dirty runbook body");

    textInput().focus();
    textInput().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.whenStable();
    const dlg = el.querySelector(
      '[data-testid="confirm-dialog"]',
    ) as HTMLElement;
    expect(dlg).not.toBeNull();
    expect(closeCount).toBe(0);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(closeCount).toBe(0);
    expect(document.activeElement).toBe(textInput());
    expect(textInput().value).toBe("Dirty runbook body");

    // Pressing Escape again and accepting closes canvas and restores focus to opener.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.whenStable();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(closeCount).toBe(1);
    expect(document.activeElement).toBe(opener);

    sub.unsubscribe();
    f.destroy();
    opener.remove();
  });

  it("handles Escape focus restoration, external modals, and Workstream launch guard", async () => {
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
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "dev",
        roles: ["dev"],
        full: false,
        scopes: ["memory:read", "memory:write", "tasks:write"],
      },
    });

    const comments: Comment[] = [
      {
        id: 1,
        author: "grain",
        authorKind: "automation",
        body: [
          "```grain-doc",
          "# Plan Spec",
          "",
          "Details",
          "```",
          "```grain-plan",
          JSON.stringify({
            title: "Guarded Stream",
            tasks: [{ key: "a", title: "Step A" }],
          }),
          "```",
        ].join("\n"),
      },
    ];

    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const f = TestBed.createComponent(SessionCanvasComponent);
    document.body.appendChild(f.nativeElement);
    let closeCount = 0;
    const sub = f.componentInstance.closed.subscribe(() => {
      closeCount += 1;
    });
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/web");
    f.componentRef.setInput("comments", comments);
    f.autoDetectChanges();
    await f.whenStable();

    const el = f.nativeElement as HTMLElement;
    const pinBtn = el.querySelector(
      '[data-testid="canvas-pin-memory-toggle"]',
    ) as HTMLButtonElement;

    // External modal prevents canvas Escape from firing.
    const extModal = document.createElement("div");
    extModal.setAttribute("aria-modal", "true");
    document.body.appendChild(extModal);
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.whenStable();
    expect(closeCount).toBe(0);
    extModal.remove();

    // Clean Escape inside open Pin form closes only Pin form and returns focus to pin toggle button.
    pinBtn.focus();
    pinBtn.click();
    await f.whenStable();
    expect(document.activeElement).toBe(
      el.querySelector('[data-testid="pin-memory-name"]'),
    );
    el.querySelector('[data-testid="pin-memory-name"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.whenStable();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(closeCount).toBe(0);
    expect(document.activeElement).toBe(pinBtn);

    // Dirty Pin form guards Workstream launch; cancelling sends zero POST /api/tasks.
    pinBtn.click();
    await f.whenStable();
    const nameInput = el.querySelector(
      '[data-testid="pin-memory-name"]',
    ) as HTMLInputElement;
    nameInput.value = "unsaved-pin";
    nameInput.dispatchEvent(new Event("input"));
    await f.whenStable();

    (
      el.querySelector('[data-testid="canvas-tab-plan"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    (
      el.querySelector(
        '[data-testid="canvas-launch-plan"]',
      ) as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(api.calls.filter((c) => c.route === "POST /api/tasks")).toHaveLength(
      0,
    );
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    expect(navSpy).not.toHaveBeenCalled();

    // Confirming Workstream discard launches and navigates.
    (
      el.querySelector(
        '[data-testid="canvas-launch-plan"]',
      ) as HTMLButtonElement
    ).click();
    await f.whenStable();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(navSpy).toHaveBeenCalledWith(["/workstreams", "task:101"]),
    );

    // Clean Escape closes canvas and returns focus to opener.
    opener.focus();
    (
      el.querySelector('[data-testid="canvas-tab-docs"]') as HTMLButtonElement
    ).focus();
    el.querySelector('[data-testid="canvas-tab-docs"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.whenStable();
    expect(closeCount).toBe(1);
    expect(document.activeElement).toBe(opener);

    sub.unsubscribe();
    f.destroy();
    opener.remove();
  });
});
