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

import { ComponentFixture, TestBed } from "@angular/core/testing";
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
  let fixtures: ComponentFixture<unknown>[] = [];
  let cleanupNodes: HTMLElement[] = [];
  const origMatchMedia = window.matchMedia;

  function setupTestBed(api = new FakeApi()) {
    TestBed.configureTestingModule({
      imports: [DirectorDrawerComponent],
      providers: [
        provideRouter([{ path: "**", children: [] }]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    return {
      api,
      ctx: TestBed.inject(DirectorContextService),
    };
  }

  function mountDrawer(): ComponentFixture<DirectorDrawerComponent> {
    const f = TestBed.createComponent(DirectorDrawerComponent);
    document.body.appendChild(f.nativeElement);
    fixtures.push(f);
    f.autoDetectChanges();
    return f;
  }

  function createOutsideButton(label = "Open Director"): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    document.body.appendChild(btn);
    cleanupNodes.push(btn);
    return btn;
  }

  function pressKey(
    target: EventTarget,
    key: string,
    opts: KeyboardEventInit = {},
  ): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    target.dispatchEvent(ev);
    return ev;
  }

  afterEach(() => {
    for (const f of fixtures) {
      f.destroy();
      (f.nativeElement as HTMLElement).remove();
    }
    fixtures = [];
    for (const n of cleanupNodes) n.remove();
    cleanupNodes = [];
    if (origMatchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: origMatchMedia,
      });
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
    TestBed.resetTestingModule();
  });

  it("renders Director thread, live transcript, context pill, and prepends active context on send", async () => {
    const { api, ctx } = setupTestBed();
    ctx.setSelection({
      kind: "task",
      id: "42",
      title: "Fix retry",
      state: "failed",
    });
    ctx.open();

    const f = mountDrawer();
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
  });

  it("toggles aria-expanded, aria-hidden, hidden, and inert states on open, wide toggle, and close", async () => {
    const { ctx } = setupTestBed();
    const opener = createOutsideButton();
    opener.focus();

    const f = mountDrawer();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    const drawer = el.querySelector(
      '[data-testid="director-drawer"]',
    ) as HTMLElement;
    const closeBtn = el.querySelector(
      '[data-testid="director-drawer-close"]',
    ) as HTMLButtonElement;
    const wideBtn = el.querySelector(
      '[data-testid="director-drawer-wide"]',
    ) as HTMLButtonElement;

    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.hidden).toBe(true);
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(closeBtn.getAttribute("aria-expanded")).toBe("false");
    expect(wideBtn.getAttribute("aria-expanded")).toBe("false");
    // Closed drawer must not steal focus or swallow Escape.
    expect(document.activeElement).toBe(opener);
    const escWhileClosed = pressKey(document, "Escape");
    expect(escWhileClosed.defaultPrevented).toBe(false);

    ctx.open(opener);
    f.detectChanges();
    await f.whenStable();

    expect(drawer.getAttribute("aria-hidden")).toBe("false");
    expect(drawer.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.hidden).toBe(false);
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(closeBtn.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.contains(document.activeElement)).toBe(true);

    wideBtn.click();
    f.detectChanges();
    expect(wideBtn.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.classList.contains("is-wide")).toBe(true);
    wideBtn.click();
    f.detectChanges();
    expect(wideBtn.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.classList.contains("is-wide")).toBe(false);

    closeBtn.click();
    f.detectChanges();
    await f.whenStable();

    expect(ctx.isOpen()).toBe(false);
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.hidden).toBe(true);
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(closeBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab and Shift+Tab inside the drawer, handles non-tabbable elements, and closes on Escape", async () => {
    const { ctx } = setupTestBed();
    const opener = createOutsideButton();
    opener.focus();

    const f = mountDrawer();
    await TestBed.inject(SessionsStore).refresh();
    await f.whenStable();
    f.detectChanges();

    ctx.open();
    f.detectChanges();
    await f.whenStable();

    const el = f.nativeElement as HTMLElement;
    const drawer = el.querySelector(
      '[data-testid="director-drawer"]',
    ) as HTMLElement;
    const stopBtn = el.querySelector(
      '[data-testid="director-drawer-stop"]',
    ) as HTMLButtonElement;
    const composer = el.querySelector(
      '[data-testid="task-composer"]',
    ) as HTMLTextAreaElement;
    const attachBtn = el.querySelector(
      '[data-testid="task-attach"]',
    ) as HTMLButtonElement;
    const sendBtn = el.querySelector(
      '[data-testid="act-send"]',
    ) as HTMLButtonElement;

    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(sendBtn.disabled).toBe(true);

    // Tab from last enabled focusable control (Attach file while Send is disabled)
    // skips hidden file input and disabled Send, wrapping to first focusable control.
    attachBtn.focus();
    expect(document.activeElement).toBe(attachBtn);
    const forwardEv = pressKey(attachBtn, "Tab");
    expect(forwardEv.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stopBtn);

    // Shift+Tab from first focusable control wraps to last enabled focusable control.
    const backwardEv = pressKey(stopBtn, "Tab", { shiftKey: true });
    expect(backwardEv.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(attachBtn);

    // Enabling Send makes Send the last focusable boundary.
    composer.value = "Check status";
    composer.dispatchEvent(new Event("input"));
    f.detectChanges();
    expect(sendBtn.disabled).toBe(false);
    sendBtn.focus();
    pressKey(sendBtn, "Tab");
    expect(document.activeElement).toBe(stopBtn);
    pressKey(stopBtn, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(sendBtn);

    // Shift+Tab / Tab when focus sits on the drawer host container stays trapped.
    drawer.focus();
    expect(document.activeElement).toBe(drawer);
    pressKey(drawer, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(sendBtn);
    drawer.focus();
    pressKey(drawer, "Tab");
    expect(document.activeElement).toBe(stopBtn);

    // Tab while an outside element holds focus pulls focus back into the drawer.
    opener.focus();
    pressKey(opener, "Tab");
    expect(document.activeElement).toBe(stopBtn);

    // Escape closes the drawer and restores focus to the opener.
    const escEv = pressKey(drawer, "Escape");
    expect(escEv.defaultPrevented).toBe(true);
    f.detectChanges();
    await f.whenStable();

    expect(ctx.isOpen()).toBe(false);
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(opener);
  });

  it("traps focus in compact modal mode, closes on scrim click, and skips restore on Open full", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({
        matches: true,
        media: "(max-width: 1079px)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const { api, ctx } = setupTestBed();
    // Idle Director hides Stop so Open full becomes the first focusable after Wide is hidden.
    api.tasks = [{ id: "1", title: "Director", state: "completed" }];
    api.details["1"] = {
      ...api.details["1"],
      state: "completed",
    };
    const opener = createOutsideButton();
    opener.focus();
    ctx.open(opener);

    const f = mountDrawer();
    await TestBed.inject(SessionsStore).refresh();
    await f.whenStable();
    f.detectChanges();

    const el = f.nativeElement as HTMLElement;
    const drawer = el.querySelector(
      '[data-testid="director-drawer"]',
    ) as HTMLElement;
    const wideBtn = el.querySelector(
      '[data-testid="director-drawer-wide"]',
    ) as HTMLButtonElement;
    const fullLink = el.querySelector(
      '[data-testid="director-drawer-full"]',
    ) as HTMLAnchorElement;
    const attachBtn = el.querySelector(
      '[data-testid="task-attach"]',
    ) as HTMLButtonElement;
    const scrim = el.querySelector(".drawer-scrim") as HTMLElement;

    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.classList.contains("is-overlay")).toBe(true);
    expect(wideBtn.hidden).toBe(true);
    expect(scrim).toBeTruthy();

    // Hidden wide button is skipped in compact mode; first focusable is Open full.
    attachBtn.focus();
    pressKey(attachBtn, "Tab");
    expect(document.activeElement).toBe(fullLink);
    pressKey(fullLink, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(attachBtn);

    // Scrim click closes and restores focus to opener.
    scrim.click();
    f.detectChanges();
    await f.whenStable();
    expect(ctx.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);

    // Reopen and click Open full: closes without restoring focus to opener.
    const other = createOutsideButton("Other");
    other.focus();
    ctx.open(opener);
    f.detectChanges();
    await f.whenStable();
    fullLink.click();
    f.detectChanges();
    await f.whenStable();
    expect(ctx.isOpen()).toBe(false);
    expect(document.activeElement).not.toBe(opener);
  });

  it("yields Tab and Escape when a higher modal dialog is open", async () => {
    const { ctx } = setupTestBed();
    const opener = createOutsideButton();
    ctx.open(opener);

    const f = mountDrawer();
    await f.whenStable();
    f.detectChanges();

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const modalBtn = document.createElement("button");
    modalBtn.type = "button";
    modalBtn.textContent = "Modal action";
    modal.appendChild(modalBtn);
    document.body.appendChild(modal);
    cleanupNodes.push(modal);
    modalBtn.focus();

    const tabEv = pressKey(modalBtn, "Tab");
    const escEv = pressKey(modalBtn, "Escape");
    expect(tabEv.defaultPrevented).toBe(false);
    expect(escEv.defaultPrevented).toBe(false);
    expect(ctx.isOpen()).toBe(true);
  });
});
