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
import { provideRouter } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { ConsoleSessionList, Task, TaskDetail } from "../api/models";
import { SessionsStore } from "../sessions/sessions.store";
import { DirectorContextService } from "./director-context.service";
import { DirectorDrawerComponent } from "./director-drawer.component";

class FakeApi {
  sessions = [{ id: "director", title: "Director", taskId: "1" }];
  tasks: Task[] = [{ id: "1", title: "Director", state: "running" }];
  details: Record<string, TaskDetail> = {
    "1": {
      id: "1",
      title: "Director",
      state: "running",
      attempts: [{ number: 2, startedAt: "2026-11-12T00:00:00Z" }],
      comments: [
        {
          id: 1,
          author: "grain",
          authorKind: "automation",
          body: "How can I help?",
        },
      ],
    },
  };
  posted: unknown[] = [];

  config = () => Promise.resolve({ models: ["gemini-2.5-pro"] });
  get = (route: string) => {
    if (route === "GET /api/tasks/{id}/attempts/{number}/transcript") {
      return Promise.resolve({ transcript: "Inspecting workstream DAG..." });
    }
    const list: ConsoleSessionList = { sessions: this.sessions };
    return Promise.resolve(list);
  };
  getIfChanged = (route: string, params?: { id: string }) => {
    if (route === "GET /api/tasks") {
      return Promise.resolve({ body: this.tasks, changed: true });
    }
    return Promise.resolve({
      body: this.details[params?.id ?? "1"],
      changed: true,
    });
  };
  post = (route: string, params?: unknown, body?: unknown) => {
    this.posted.push({ route, params, body });
    return Promise.resolve({});
  };
}

describe("DirectorDrawerComponent", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("renders Director thread, live transcript, context pill, and prepends active context on send", async () => {
    const api = new FakeApi();
    TestBed.configureTestingModule({
      imports: [DirectorDrawerComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const ctx = TestBed.inject(DirectorContextService);
    ctx.setSelection({
      kind: "task",
      id: "42",
      title: "Fix retry",
      state: "failed",
    });
    ctx.open();

    const f = TestBed.createComponent(DirectorDrawerComponent);
    f.autoDetectChanges();
    await TestBed.inject(SessionsStore).refresh();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    expect(
      el.querySelector('[data-testid="director-context-toggle"]')?.textContent,
    ).toContain("Task #42: Fix retry");
    expect(el.textContent).toContain("How can I help?");

    const ta = el.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "Diagnose why retry failed";
    ta.dispatchEvent(new Event("input"));
    f.detectChanges();
    const sendBtn = el.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    sendBtn.click();
    await f.whenStable();

    expect(api.posted).toContainEqual({
      route: "POST /api/tasks/{id}/comments",
      params: { id: "1" },
      body: {
        body: "> [Context: Task #42: Fix retry (failed)]\n\nDiagnose why retry failed",
        attachments: [],
      },
    });
    f.destroy();
  });

  function setupDrawer(open = false, api = new FakeApi()) {
    TestBed.configureTestingModule({
      imports: [DirectorDrawerComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const ctx = TestBed.inject(DirectorContextService);
    if (open) ctx.open();
    const f = TestBed.createComponent(DirectorDrawerComponent);
    f.autoDetectChanges();
    return { f, ctx, api };
  }

  function dispatchKey(
    key: string,
    opts: { shiftKey?: boolean; target?: EventTarget } = {},
  ): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", {
      key,
      shiftKey: !!opts.shiftKey,
      bubbles: true,
      cancelable: true,
    });
    (opts.target ?? document).dispatchEvent(ev);
    return ev;
  }

  it("toggles aria-expanded, aria-hidden, inert, and hidden attributes on open and close", async () => {
    const { f, ctx } = setupDrawer(false);
    await TestBed.inject(SessionsStore).refresh();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    const drawer = el.querySelector(
      '[data-testid="director-drawer"]',
    ) as HTMLElement;
    expect(drawer).toBeTruthy();
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(drawer.hidden).toBe(true);

    ctx.open();
    f.detectChanges();
    await f.whenStable();
    expect(drawer.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.getAttribute("aria-hidden")).toBe("false");
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(drawer.hidden).toBe(false);

    ctx.close(true);
    f.detectChanges();
    await f.whenStable();
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(drawer.hidden).toBe(true);
    f.destroy();
  });

  it("traps Tab and Shift+Tab keyboard focus inside the drawer while open and skips hidden/disabled controls", async () => {
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    try {
      const { f, ctx } = setupDrawer(false);
      await TestBed.inject(SessionsStore).refresh();
      await f.whenStable();
      f.detectChanges();

      outside.focus();
      ctx.open();
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();

      const el = f.nativeElement as HTMLElement;
      const drawer = el.querySelector(
        '[data-testid="director-drawer"]',
      ) as HTMLElement;
      expect(drawer.contains(document.activeElement)).toBe(true);

      const first = drawer.querySelector(
        '[data-testid="director-drawer-stop"]',
      ) as HTMLButtonElement;
      const attach = drawer.querySelector(
        '[data-testid="task-attach"]',
      ) as HTMLButtonElement;
      const ta = drawer.querySelector(
        '[data-testid="task-composer"]',
      ) as HTMLTextAreaElement;
      const sendBtn = drawer.querySelector(
        '[data-testid="act-send"]',
      ) as HTMLButtonElement;
      expect(first).toBeTruthy();
      expect(attach).toBeTruthy();
      expect(ta).toBeTruthy();
      expect(sendBtn.disabled).toBe(true);

      // With draft empty, Send is disabled and hidden file input is skipped:
      // last focusable item is Attach (rendered after textarea in composer).
      attach.focus();
      const wrapForward = dispatchKey("Tab", { target: attach });
      expect(wrapForward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      const wrapBackward = dispatchKey("Tab", {
        shiftKey: true,
        target: first,
      });
      expect(wrapBackward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(attach);

      // Typing enables Send, making it the new last focusable element.
      ta.value = "Check queue";
      ta.dispatchEvent(new Event("input"));
      f.detectChanges();
      expect(sendBtn.disabled).toBe(false);

      sendBtn.focus();
      const wrapToFirst = dispatchKey("Tab", { target: sendBtn });
      expect(wrapToFirst.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      const wrapToSend = dispatchKey("Tab", {
        shiftKey: true,
        target: first,
      });
      expect(wrapToSend.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(sendBtn);

      // Non-tabbable container focus (tabindex="-1") wraps safely too.
      drawer.focus();
      expect(document.activeElement).toBe(drawer);
      const fromHostBack = dispatchKey("Tab", {
        shiftKey: true,
        target: drawer,
      });
      expect(fromHostBack.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(sendBtn);

      // Focus outside the open drawer is pulled back inside on Tab / Shift+Tab.
      outside.focus();
      const fromOutside = dispatchKey("Tab", { target: outside });
      expect(fromOutside.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      outside.focus();
      const fromOutsideBack = dispatchKey("Tab", {
        shiftKey: true,
        target: outside,
      });
      expect(fromOutsideBack.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(sendBtn);

      f.destroy();
    } finally {
      outside.remove();
    }
  });

  it("closes on Escape, restores focus to opener, stops trapping once closed, and suppresses restore on Open full", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open Director";
    document.body.appendChild(opener);
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    try {
      const { f, ctx } = setupDrawer(false);
      await TestBed.inject(SessionsStore).refresh();
      await f.whenStable();
      f.detectChanges();

      opener.focus();
      ctx.open(opener);
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();

      const el = f.nativeElement as HTMLElement;
      const drawer = el.querySelector(
        '[data-testid="director-drawer"]',
      ) as HTMLElement;
      expect(drawer.contains(document.activeElement)).toBe(true);

      const esc = dispatchKey("Escape", { target: document.activeElement! });
      expect(esc.defaultPrevented).toBe(true);
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();

      expect(ctx.isOpen()).toBe(false);
      expect(drawer.getAttribute("aria-expanded")).toBe("false");
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement).toBe(opener);

      // Once closed, Tab outside the drawer must not be trapped.
      outside.focus();
      const tabClosed = dispatchKey("Tab", { target: outside });
      expect(tabClosed.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);

      // Clicking "Open full" closes without returning focus to the opener.
      opener.focus();
      ctx.open(opener);
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();

      const fullLink = drawer.querySelector(
        '[data-testid="director-drawer-full"]',
      ) as HTMLAnchorElement;
      fullLink.click();
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();
      expect(ctx.isOpen()).toBe(false);
      expect(document.activeElement).not.toBe(opener);

      f.destroy();
    } finally {
      opener.remove();
      outside.remove();
    }
  });

  it("uses compact modal dialog semantics under 1080px, skips hidden wide toggle in Tab order, and closes on scrim click", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Trigger";
    document.body.appendChild(opener);
    const origMatchMedia = window.matchMedia;
    const origGetComputedStyle = window.getComputedStyle;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 1079px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.getComputedStyle = ((target: Element) => {
      const style = origGetComputedStyle(target);
      if (target.classList.contains("drawer-wide-btn")) {
        return { ...style, display: "none" } as CSSStyleDeclaration;
      }
      return style;
    }) as typeof window.getComputedStyle;

    try {
      const api = new FakeApi();
      api.tasks = [{ id: "1", title: "Director", state: "awaiting_reply" }];
      api.details["1"].state = "awaiting_reply";
      const { f, ctx } = setupDrawer(false, api);
      await TestBed.inject(SessionsStore).refresh();
      await f.whenStable();
      f.detectChanges();

      opener.focus();
      ctx.open(opener);
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();

      const el = f.nativeElement as HTMLElement;
      const drawer = el.querySelector(
        '[data-testid="director-drawer"]',
      ) as HTMLElement;
      const scrim = el.querySelector(".drawer-scrim") as HTMLElement;
      expect(drawer.getAttribute("role")).toBe("dialog");
      expect(drawer.getAttribute("aria-modal")).toBe("true");
      expect(drawer.getAttribute("aria-expanded")).toBe("true");
      expect(drawer.getAttribute("aria-hidden")).toBe("false");
      expect(scrim).toBeTruthy();
      expect(scrim.getAttribute("aria-hidden")).toBe("true");

      // First visible focusable is Open full because .drawer-wide-btn is display:none.
      const wideBtn = drawer.querySelector(
        '[data-testid="director-drawer-wide"]',
      ) as HTMLButtonElement;
      const openFull = drawer.querySelector(
        '[data-testid="director-drawer-full"]',
      ) as HTMLAnchorElement;
      const attach = drawer.querySelector(
        '[data-testid="task-attach"]',
      ) as HTMLButtonElement;
      expect(wideBtn).toBeTruthy();
      expect(openFull).toBeTruthy();
      expect(attach).toBeTruthy();
      openFull.focus();
      dispatchKey("Tab", { shiftKey: true, target: openFull });
      expect(document.activeElement).toBe(attach);
      expect(document.activeElement).not.toBe(wideBtn);

      dispatchKey("Tab", { target: attach });
      expect(document.activeElement).toBe(openFull);

      scrim.click();
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();
      expect(ctx.isOpen()).toBe(false);
      expect(el.querySelector(".drawer-scrim")).toBeNull();
      expect(document.activeElement).toBe(opener);

      f.destroy();
    } finally {
      window.matchMedia = origMatchMedia;
      window.getComputedStyle = origGetComputedStyle;
      opener.remove();
    }
  });

  it("yields focus trap to nested fullscreen conversation and higher aria-modal dialogs", async () => {
    const proto = HTMLDialogElement.prototype as unknown as Record<
      string,
      unknown
    >;
    if (!proto["showModal"]) {
      proto["showModal"] = function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      };
    }
    if (!proto["close"]) {
      proto["close"] = function (this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      };
    }
    const outerModal = document.createElement("div");
    outerModal.setAttribute("role", "dialog");
    outerModal.setAttribute("aria-modal", "true");
    try {
      const { f, ctx } = setupDrawer(true);
      await TestBed.inject(SessionsStore).refresh();
      await f.whenStable();
      f.detectChanges();

      const el = f.nativeElement as HTMLElement;
      const fsBtn = el.querySelector(
        '[data-testid="convo-fullscreen"]',
      ) as HTMLButtonElement;
      fsBtn.click();
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();

      expect(el.querySelector(".convo-modal-inner")).toBeTruthy();

      // Escape exits fullscreen conversation without closing the Director drawer.
      dispatchKey("Escape");
      f.detectChanges();
      await Promise.resolve();
      await f.whenStable();
      expect(el.querySelector(".convo-modal-inner")).toBeNull();
      expect(ctx.isOpen()).toBe(true);

      // When a higher aria-modal dialog (e.g. New task sheet) is open, drawer trap yields.
      document.body.appendChild(outerModal);
      const esc = dispatchKey("Escape");
      expect(esc.defaultPrevented).toBe(false);
      expect(ctx.isOpen()).toBe(true);

      f.destroy();
    } finally {
      outerModal.remove();
    }
  });
});
