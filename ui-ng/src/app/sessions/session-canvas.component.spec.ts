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

import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { Comment, MemoryDocument } from "../api/models";
import { AccessService } from "../services/access.service";
import { SessionCanvasComponent } from "./session-canvas.component";

class FakeApi {
  calls: { method: string; route: string; params?: unknown; body?: unknown }[] =
    [];
  createdCount = 0;
  documents: MemoryDocument[] = [
    {
      name: "architecture-with-long-unbroken-identifier",
      repo: "acme/widgets",
      summary: "Core boundaries",
      text: "Use REST.",
      length: 9,
    },
  ];
  fullDocuments: Record<string, MemoryDocument> = {
    "architecture-with-long-unbroken-identifier": {
      name: "architecture-with-long-unbroken-identifier",
      repo: "acme/widgets",
      summary: "Core boundaries",
      text: "# Architecture\n\n| Key | Value |\n|---|---|\n| endpoint | https://example.com/very/long/path/without/spaces |",
      length: 105,
    },
  };

  config = () => Promise.resolve({});
  get = (route: string, params?: { name?: string }) => {
    if (route === "GET /api/tasks/{id}/tree") {
      return Promise.resolve({ nodes: [] });
    }
    if (route === "GET /api/memory/documents") {
      return Promise.resolve({
        documents: structuredClone(this.documents),
      });
    }
    if (route === "GET /api/memory/documents/{name}") {
      const name = params?.name ?? "";
      const full =
        this.fullDocuments[name] ??
        this.documents.find((d) => d.name === name) ??
        this.fullDocuments["architecture-with-long-unbroken-identifier"];
      return Promise.resolve(structuredClone(full));
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

  it("confirms before discarding unsaved Memory editor or Pin to Memory changes across switch, cancel, close, and launch", async () => {
    const api = new FakeApi();
    api.documents = [
      {
        name: "doc-alpha",
        repo: "acme/widgets",
        summary: "Alpha summary",
        text: "Alpha body",
        length: 10,
      },
      {
        name: "doc-beta",
        repo: "acme/widgets",
        summary: "Beta summary",
        text: "Beta body",
        length: 9,
      },
    ];
    api.fullDocuments = {
      "doc-alpha": {
        name: "doc-alpha",
        repo: "acme/widgets",
        summary: "Alpha summary",
        text: "Alpha full body",
        length: 15,
      },
      "doc-beta": {
        name: "doc-beta",
        repo: "acme/widgets",
        summary: "Beta summary",
        text: "Beta full body",
        length: 14,
      },
    };

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
        role: "dev",
        roles: ["dev"],
        full: true,
        scopes: [],
      },
    });
    const navSpy = vi
      .spyOn(TestBed.inject(Router), "navigate")
      .mockResolvedValue(true);

    const comments: Comment[] = [
      {
        id: 30,
        author: "grain",
        authorKind: "automation",
        body: [
          "```grain-doc",
          "# Spec One\n\nFirst spec body.",
          "```",
          "```grain-doc",
          "# Spec Two\n\nSecond spec body.",
          "```",
          "```grain-plan",
          JSON.stringify({
            title: "Guarded Plan",
            repo: "acme/widgets",
            tasks: [{ key: "one", title: "Ship fix" }],
          }),
          "```",
        ].join("\n"),
      },
    ];

    const f = TestBed.createComponent(SessionCanvasComponent);
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/widgets");
    f.componentRef.setInput("comments", comments);
    let closedCount = 0;
    const closeSub = f.componentInstance.closed.subscribe(() => {
      closedCount += 1;
    });
    f.autoDetectChanges();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    const aside = el.querySelector("aside.session-canvas") as HTMLElement;

    // 1. Clean Pin to Memory toggle opens and closes immediately without confirming.
    (
      el.querySelector(
        '[data-testid="canvas-pin-memory-toggle"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="canvas-pin-dirty"]')).toBeNull();
    (
      el.querySelector(
        '[data-testid="canvas-pin-memory-toggle"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();

    // 2. Dirty Pin to Memory form confirms on Cancel, doc switch, and close; preserves draft across tab switches.
    (
      el.querySelector(
        '[data-testid="canvas-pin-memory-toggle"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    const pinNameInput = el.querySelector(
      '[data-testid="pin-memory-name"]',
    ) as HTMLInputElement;
    pinNameInput.value = "edited-spec-slug";
    pinNameInput.dispatchEvent(new Event("input"));
    f.detectChanges();
    expect(
      el.querySelector('[data-testid="canvas-pin-dirty"]')?.textContent,
    ).toContain("Unsaved");

    // Tab switch preserves draft without discarding or prompting.
    (
      el.querySelector('[data-testid="canvas-tab-html"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    (
      el.querySelector('[data-testid="canvas-tab-docs"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(
      (el.querySelector('[data-testid="pin-memory-name"]') as HTMLInputElement)
        .value,
    ).toBe("edited-spec-slug");

    // Cancel Pin form opens ConfirmDialogComponent outside [inert].
    (
      el.querySelector(
        '[data-testid="canvas-pin-memory-toggle"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    await f.whenStable();
    const pinCancelDlg = el.querySelector('[data-testid="confirm-dialog"]')!;
    expect(pinCancelDlg).not.toBeNull();
    expect(pinCancelDlg.closest("[inert]")).toBeNull();
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(
      el.querySelector('[data-testid="confirm-cancel"]'),
    );

    // Dismissing confirmation keeps Pin form open with edited text.
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(
      (el.querySelector('[data-testid="pin-memory-name"]') as HTMLInputElement)
        .value,
    ).toBe("edited-spec-slug");

    // Switching doc chip confirms before discarding Pin form; accepting switches doc.
    const docChips = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".canvas-selector .canvas-chip"),
    );
    expect(docChips.length).toBe(2);
    docChips[0].click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(el.querySelector(".canvas-toolbar strong")?.textContent).toContain(
      "Spec One",
    );

    // Saving Pin form clears dirty state so closing does not prompt.
    (
      el.querySelector(
        '[data-testid="canvas-pin-memory-toggle"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    const pinSum = el.querySelector(
      '[data-testid="pin-memory-summary"]',
    ) as HTMLInputElement;
    pinSum.value = "Updated summary";
    pinSum.dispatchEvent(new Event("input"));
    f.detectChanges();
    el.querySelector("form.canvas-pin-form")!.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await f.whenStable();
    f.detectChanges();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();

    // 3. Memory editor: switching doc, closing, and launching plan confirm when dirty.
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();

    const memChips = () =>
      Array.from(
        el.querySelectorAll<HTMLButtonElement>(".canvas-selector .canvas-chip"),
      );
    memChips()[0].click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(
        (
          el.querySelector(
            '[data-testid="canvas-memory-text"]',
          ) as HTMLTextAreaElement
        )?.value,
      ).toBe("Alpha full body");
    });

    const memTa = el.querySelector(
      '[data-testid="canvas-memory-text"]',
    ) as HTMLTextAreaElement;
    memTa.value = "Alpha unsaved edit";
    memTa.dispatchEvent(new Event("input"));
    f.detectChanges();
    expect(
      el.querySelector('[data-testid="canvas-memory-dirty"]')?.textContent,
    ).toContain("Unsaved");

    // Clicking the already-active chip is a no-op and keeps unsaved edits.
    memChips()[0].click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      (
        el.querySelector(
          '[data-testid="canvas-memory-text"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Alpha unsaved edit");

    // Clicking doc-beta prompts; cancelling preserves doc-alpha and unsaved edits.
    memChips()[1].click();
    f.detectChanges();
    expect(
      el.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("doc-alpha");
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(
      (
        el.querySelector(
          '[data-testid="canvas-memory-text"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Alpha unsaved edit");

    // Switching to Workstream and clicking Launch confirms before discarding & navigating.
    (
      el.querySelector('[data-testid="canvas-tab-plan"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    (
      el.querySelector(
        '[data-testid="canvas-launch-plan"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(api.calls.filter((c) => c.route === "POST /api/tasks")).toEqual([]);
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(navSpy).not.toHaveBeenCalled();

    // Returning to Memory and saving clears dirty flag; subsequent doc switch requires no confirmation.
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    (
      el.querySelector(
        '[data-testid="canvas-memory-save"]',
      ) as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(el.querySelector('[data-testid="canvas-memory-dirty"]')).toBeNull();

    memChips()[1].click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(
        (
          el.querySelector(
            '[data-testid="canvas-memory-text"]',
          ) as HTMLTextAreaElement
        )?.value,
      ).toBe("Beta full body");
    });
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();

    // Editing doc-beta then clicking Close confirms; Cancel keeps open, Discard emits closed.
    const memTaBeta = el.querySelector(
      '[data-testid="canvas-memory-text"]',
    ) as HTMLTextAreaElement;
    memTaBeta.value = "Beta dirty";
    memTaBeta.dispatchEvent(new Event("input"));
    f.detectChanges();

    (
      el.querySelector('[data-testid="canvas-close"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(
      el.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("doc-beta");
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(closedCount).toBe(0);

    (
      el.querySelector('[data-testid="canvas-close"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(closedCount).toBe(1);
    expect(f.componentInstance.hasUnsavedChanges()).toBe(false);

    closeSub.unsubscribe();
    f.destroy();
  });

  it("handles Escape to dismiss Pin form or Canvas, integrates discard confirmation on Escape, and restores focus to previous element", async () => {
    @Component({
      selector: "g-canvas-escape-host-test",
      imports: [SessionCanvasComponent],
      template: `
        <button
          type="button"
          data-testid="external-opener"
          (click)="open.set(true)"
        >
          Open Canvas
        </button>
        <input type="text" data-testid="outside-input" />
        @if (open()) {
          <g-session-canvas
            [sessionTaskId]="'1'"
            [repo]="'acme/widgets'"
            [comments]="comments"
            (closed)="open.set(false)"
          />
        }
        @if (higherModal()) {
          <div role="dialog" aria-modal="true" data-testid="higher-modal"></div>
        }
      `,
    })
    class CanvasEscapeHostComponent {
      readonly open = signal(false);
      readonly higherModal = signal(false);
      readonly comments: Comment[] = [
        {
          id: 40,
          author: "grain",
          authorKind: "automation",
          body: "```grain-doc\n# Canvas Spec\n\nDetails for Escape focus restoration.\n```",
        },
      ];
    }

    const api = new FakeApi();
    TestBed.configureTestingModule({
      imports: [CanvasEscapeHostComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig({
      access: {
        role: "dev",
        roles: ["dev"],
        full: true,
        scopes: [],
      },
    });

    const f = TestBed.createComponent(CanvasEscapeHostComponent);
    f.autoDetectChanges();
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    const opener = el.querySelector(
      '[data-testid="external-opener"]',
    ) as HTMLButtonElement;
    const outsideInput = el.querySelector(
      '[data-testid="outside-input"]',
    ) as HTMLInputElement;

    // 1. Focus opener -> open canvas -> focus inside canvas -> Escape closes and returns focus to opener.
    opener.focus();
    opener.click();
    f.detectChanges();
    await f.whenStable();
    const htmlTab = el.querySelector(
      '[data-testid="canvas-tab-html"]',
    ) as HTMLButtonElement;
    expect(htmlTab).not.toBeNull();
    htmlTab.focus();
    expect(document.activeElement).toBe(htmlTab);

    htmlTab.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    expect(el.querySelector('[data-testid="session-canvas"]')).toBeNull();
    expect(document.activeElement).toBe(opener);

    // 2. Yield to typing targets outside canvas and higher [aria-modal="true"] dialogs.
    opener.focus();
    opener.click();
    f.detectChanges();
    await f.whenStable();

    outsideInput.focus();
    outsideInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    expect(el.querySelector('[data-testid="session-canvas"]')).not.toBeNull();

    f.componentInstance.higherModal.set(true);
    f.detectChanges();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    expect(el.querySelector('[data-testid="session-canvas"]')).not.toBeNull();
    f.componentInstance.higherModal.set(false);
    f.detectChanges();

    // 3. Layered Escape with Pin to Memory form: clean closes Pin form & restores focus to toggle; dirty confirms first.
    opener.focus();
    const pinToggle = el.querySelector(
      '[data-testid="canvas-pin-memory-toggle"]',
    ) as HTMLButtonElement;
    pinToggle.focus();
    pinToggle.click();
    f.detectChanges();
    const pinInput = el.querySelector(
      '[data-testid="pin-memory-name"]',
    ) as HTMLInputElement;
    expect(pinInput).not.toBeNull();
    pinInput.focus();

    // Clean Pin form Escape closes form and focuses pinToggle without closing canvas.
    pinInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(el.querySelector('[data-testid="session-canvas"]')).not.toBeNull();
    expect(document.activeElement).toBe(pinToggle);

    // Dirty Pin form Escape opens confirm dialog; Escape on confirm dialog keeps form & restores pinInput focus.
    pinToggle.click();
    f.detectChanges();
    const dirtyPinInput = el.querySelector(
      '[data-testid="pin-memory-name"]',
    ) as HTMLInputElement;
    dirtyPinInput.focus();
    dirtyPinInput.value = "unsaved-pin-slug";
    dirtyPinInput.dispatchEvent(new Event("input"));
    f.detectChanges();

    dirtyPinInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(
      el.querySelector('[data-testid="confirm-cancel"]'),
    );

    el.querySelector('[data-testid="confirm-dialog"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      (el.querySelector('[data-testid="pin-memory-name"]') as HTMLInputElement)
        .value,
    ).toBe("unsaved-pin-slug");
    expect(document.activeElement).toBe(dirtyPinInput);

    // Second Escape + Accept discards Pin form and restores focus to pinToggle; third Escape closes canvas -> opener.
    dirtyPinInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(el.querySelector('[data-testid="pin-memory-name"]')).toBeNull();
    expect(document.activeElement).toBe(pinToggle);

    // 4. Dirty Memory editor Escape confirms; document-level Escape cancels dialog & restores textarea focus; Discard closes canvas & restores opener.
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    (
      el.querySelector(".canvas-selector .canvas-chip") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(
        el.querySelector('[data-testid="canvas-memory-text"]'),
      ).not.toBeNull();
    });
    const memTa = el.querySelector(
      '[data-testid="canvas-memory-text"]',
    ) as HTMLTextAreaElement;
    memTa.focus();
    memTa.value = "Unsaved memory body";
    memTa.dispatchEvent(new Event("input"));
    f.detectChanges();

    memTa.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    await f.whenStable();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();

    // Document-level Escape dismisses confirm dialog and restores memTa focus.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(memTa);
    expect(memTa.value).toBe("Unsaved memory body");

    // Escape + Discard closes canvas and returns focus to opener (last valid outside focus).
    opener.focus();
    memTa.focus();
    memTa.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    f.detectChanges();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(el.querySelector('[data-testid="session-canvas"]')).toBeNull();
    expect(document.activeElement).toBe(opener);

    f.destroy();
  });

  it("keeps dirty state when save fails and confirms Workstream launch and proposed-task navigation when dirty", async () => {
    const api = new FakeApi();
    const baseGet = api.get;
    api.get = (route: string, params?: { name?: string }) => {
      if (route === "GET /api/tasks/{id}/tree") {
        return Promise.resolve({
          nodes: [
            { id: "1", title: "Root", status: "running", root: true },
            { id: "77", title: "Proposed child", status: "proposed" },
          ],
        });
      }
      return baseGet(route, params);
    };
    const basePut = api.put;
    let failSave = true;
    api.put = (route: string, params?: unknown, body?: unknown) => {
      if (failSave) {
        return new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("save failed"))),
        );
      }
      return basePut(route, params, body);
    };

    TestBed.configureTestingModule({
      imports: [SessionCanvasComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig({
      access: { role: "dev", roles: ["dev"], full: true, scopes: [] },
    });
    const navSpy = vi
      .spyOn(TestBed.inject(Router), "navigate")
      .mockResolvedValue(true);

    const f = TestBed.createComponent(SessionCanvasComponent);
    f.componentRef.setInput("sessionTaskId", "1");
    f.componentRef.setInput("repo", "acme/widgets");
    f.componentRef.setInput("comments", [
      {
        id: 50,
        author: "grain",
        authorKind: "automation",
        body: [
          "```grain-plan",
          JSON.stringify({
            title: "Guarded Launch",
            repo: "acme/widgets",
            tasks: [{ key: "k1", title: "Task 1" }],
          }),
          "```",
        ].join("\n"),
      },
    ]);
    f.autoDetectChanges();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    (
      el.querySelector('[data-testid="canvas-tab-memory"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    (
      el.querySelector(".canvas-selector .canvas-chip") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(
        el.querySelector('[data-testid="canvas-memory-text"]'),
      ).not.toBeNull();
    });

    const memTa = el.querySelector(
      '[data-testid="canvas-memory-text"]',
    ) as HTMLTextAreaElement;
    memTa.value = "Failed save edit";
    memTa.dispatchEvent(new Event("input"));
    f.detectChanges();

    // Failed save keeps dirty state and user edits intact.
    (
      el.querySelector(
        '[data-testid="canvas-memory-save"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(f.componentInstance.hasUnsavedChanges()).toBe(true);
      expect(
        (
          el.querySelector(
            '[data-testid="canvas-memory-save"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    expect(
      el.querySelector('[data-testid="canvas-memory-dirty"]'),
    ).not.toBeNull();
    expect(memTa.value).toBe("Failed save edit");
    failSave = false;

    // Proposed task link confirms before discarding & navigating.
    (
      el.querySelector('[data-testid="canvas-tab-plan"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    const taskLink = el.querySelector(
      '[data-testid="canvas-tree-proposals"] a',
    ) as HTMLAnchorElement;
    expect(taskLink).not.toBeNull();
    taskLink.click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(navSpy).not.toHaveBeenCalled();
    (
      el.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(navSpy).not.toHaveBeenCalled();

    // Accepting Workstream launch confirmation discards dirty state and launches workstream.
    (
      el.querySelector(
        '[data-testid="canvas-launch-plan"]',
      ) as HTMLButtonElement
    ).click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    (
      el.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement
    ).click();
    await f.whenStable();
    f.detectChanges();
    expect(f.componentInstance.hasUnsavedChanges()).toBe(false);
    expect(
      api.calls.filter((c) => c.route === "POST /api/tasks").length,
    ).toBeGreaterThan(0);
    expect(navSpy).toHaveBeenCalledWith(["/workstreams", "task:101"]);

    f.destroy();
  });
});
