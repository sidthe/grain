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

import { TestBed, type ComponentFixture } from "@angular/core/testing";
import {
  Router,
  provideRouter,
  withComponentInputBinding,
} from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { NEVER } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { Task, TaskDetail } from "../api/models";
import { CreateTaskService } from "../create/create-task.service";
import { AccessService } from "../services/access.service";
import { PHONE_QUERY } from "../shared/split";
import {
  WS_VIEW_STORAGE_KEY,
  WorkstreamsPageComponent,
} from "./workstreams-page.component";
import { WS_INSPECTOR_RATIO_KEY } from "./workstream-detail.component";
import { STARTED_STORAGE_KEY, WorkstreamsStore } from "./workstreams.store";

function t(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    state: "queued",
    repo: "sidthe/grain-scratch-repo",
    author: "alice",
    authorKind: "human",
    owner: "alice",
    createdAt: "2026-11-11T09:00:00Z",
    updatedAt: "2026-11-11T10:00:00Z",
    ...over,
  };
}

class FakeApi {
  open: Task[] = [];
  closed: Task[] = [];
  details: Record<string, TaskDetail> = {};
  calls: { route: string; params?: unknown; body?: unknown; query?: string }[] =
    [];

  config = () => Promise.resolve({ access: null, viewerOwner: "alice" });
  openNotifications = () => Promise.resolve([]);
  localScriptApprovals = () => Promise.resolve([]);
  tasks = () => Promise.resolve(this.open);
  task = (id: string) =>
    Promise.resolve(
      this.details[id] ?? {
        ...([...this.open, ...this.closed].find((x) => x.id === id) ?? t(id)),
        description: `Description for #${id}`,
        comments: [],
        attempts: [],
      },
    );

  getIfChanged = vi.fn(async (route: string) => {
    this.calls.push({ route });
    if (route.includes("{id}")) {
      const m = /tasks\/([^/?]+)/.exec(route);
      const id = m?.[1] ?? "1";
      return { body: await this.task(id), changed: true };
    }
    return { body: this.open, changed: true };
  });

  get = vi.fn(
    async (route: string, params?: { id?: string }, query?: string) => {
      this.calls.push({ route, params, query });
      if (route === "GET /api/tasks") {
        const isFirst = !query || !query.includes("cursor=");
        return { tasks: isFirst ? this.closed : [] };
      }
      if (route === "GET /api/tasks/{id}" && params?.id) {
        return this.task(params.id);
      }
      if (route === "GET /api/tasks/{id}/tree" && params?.id) {
        return { origin: `task:${params.id}`, done: 0, total: 1, nodes: [] };
      }
      return {};
    },
  );

  post = vi.fn(async (route: string, params?: unknown, body?: unknown) => {
    this.calls.push({ route, params, body });
    return {};
  });
}

describe("WorkstreamsPageComponent", () => {
  let api: FakeApi;

  beforeEach(() => {
    localStorage.removeItem(WS_VIEW_STORAGE_KEY);
    localStorage.removeItem(STARTED_STORAGE_KEY);
    localStorage.removeItem(WS_INSPECTOR_RATIO_KEY);
    localStorage.removeItem("grain.ws.treeRatio");
    api = new FakeApi();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  afterEach(() => {
    try {
      TestBed.inject(WorkstreamsStore).stop();
    } catch {
      // Ignore if test did not inject store.
    }
    TestBed.resetTestingModule();
  });

  async function mount(url = "/workstreams"): Promise<{
    fixture: ComponentFixture<WorkstreamsPageComponent>;
    router: Router;
    harness: RouterTestingHarness;
  }> {
    TestBed.configureTestingModule({
      imports: [WorkstreamsPageComponent],
      providers: [
        provideRouter(
          [
            { path: "workstreams", component: WorkstreamsPageComponent },
            { path: "workstreams/:key", component: WorkstreamsPageComponent },
            { path: "inbox", component: WorkstreamsPageComponent },
            { path: "**", children: [] },
          ],
          withComponentInputBinding(),
        ),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig({
      access: null,
      viewerOwner: "alice",
    });
    const router = TestBed.inject(Router);
    const harness = await RouterTestingHarness.create(
      url,
      WorkstreamsPageComponent,
    );
    const fixture =
      harness.fixture as ComponentFixture<WorkstreamsPageComponent>;
    harness.detectChanges();
    await TestBed.inject(WorkstreamsStore).refresh(true);
    harness.detectChanges();
    await fixture.whenStable();
    harness.detectChanges();
    return { fixture, router, harness };
  }

  it("renders People scope with promoted system streams and collapsed System activity footer", async () => {
    api.open = [
      t("10", { title: "User goal", state: "completed" }),
      t("11", {
        title: "Subtask running",
        state: "running",
        origin: "task:10",
        generatedFrom: "10",
      }),
      t("20", {
        title: "Imported PR stream",
        state: "completed",
        origin: "sidthe/repo#7",
        imported: true,
      }),
      t("21", {
        title: "Proposed import step",
        state: "proposed",
        origin: "sidthe/repo#7",
        imported: true,
      }),
      t("30", {
        title: "Nightly suite",
        state: "completed",
        suiteRun: true,
        author: "suite",
        authorKind: "automation",
      }),
      t("31", {
        title: "Run tests",
        state: "running",
        origin: "task:30",
        generatedFrom: "30",
      }),
    ];

    const { fixture, harness } = await mount();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="ws-row-task:10"]')).not.toBeNull();
    expect(
      el.querySelector('[data-testid="ws-row-sidthe/repo#7"]'),
    ).not.toBeNull();
    expect(el.querySelector('[data-testid="ws-row-task:30"]')).toBeNull();
    expect(el.querySelector('[data-testid="ws-system-footer"]')).not.toBeNull();

    // Switch to Cards layout and verify SVG miniature trees render.
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-view-cards"]',
    )!.click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(el.querySelector('[data-testid="ws-cards"]')).not.toBeNull();
    expect(el.querySelectorAll(".ws-thumb rect").length).toBeGreaterThan(0);

    // Reveal System scope and its kind chips.
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-scope-system"]',
    )!.click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    await new Promise((r) => setTimeout(r));
    harness.detectChanges();
    expect(el.querySelector('[data-testid="ws-card-task:30"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ws-sub-suite"]')).not.toBeNull();
  });

  it("opens Start a workstream sheet from CTA button", async () => {
    const { fixture } = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const createSvc = TestBed.inject(CreateTaskService);
    const spy = vi.spyOn(createSvc, "open");

    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-start-btn"]',
    )!.click();
    expect(spy).toHaveBeenCalledWith(
      { workstream: true, origin: "" },
      expect.anything(),
    );
  });

  it("renders detail tree, tidy graph, blocking chain, embedded inspector, and batch proposal approval", async () => {
    api.open = [
      t("100", { title: "Upstream stream", state: "completed" }),
      t("101", {
        title: "Blocker in upstream",
        state: "running",
        origin: "task:100",
        generatedFrom: "100",
      }),
      t("200", { title: "Voice stream", state: "completed" }),
      t("201", {
        title: "Proposed step",
        state: "proposed",
        origin: "task:200",
        generatedFrom: "200",
        dependsOn: ["101"],
      }),
      t("202", {
        title: "Second proposed step",
        state: "proposed",
        origin: "task:200",
        generatedFrom: "200",
      }),
    ];

    const { fixture, router } = await mount("/workstreams/task:200?node=201");
    const el = fixture.nativeElement as HTMLElement;

    expect(
      el.querySelector('[data-testid="ws-detail-title"]')?.textContent,
    ).toContain("Voice stream");
    expect(el.querySelector('[data-testid="ws-tree-node-201"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ws-gnode-201"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ws-portal-101"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ws-blocker-101"]')).not.toBeNull();
    expect(el.querySelector("g-task-detail")).not.toBeNull();

    // Approve 2 proposals via confirmation modal while .ws-detail is inert.
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-approve-proposals"]',
    )!.click();
    fixture.detectChanges();
    expect(
      el.querySelector('[data-testid="ws-detail"]')?.hasAttribute("inert"),
    ).toBe(true);
    expect(el.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();

    el.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-accept"]',
    )!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      api.calls.filter((c) => c.route === "POST /api/tasks/{id}/approve")
        .length,
    ).toBe(2);

    // Open in Inbox button navigates with ?ws=task:200.
    const navSpy = vi.spyOn(router, "navigate");
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-open-inbox"]',
    )!.click();
    expect(navSpy).toHaveBeenCalledWith(["/inbox"], {
      queryParams: { ws: "task:200" },
    });
  });

  it("preserves list query params when opening a stream and passes NO_REPO for no-repo streams", async () => {
    api.open = [
      t("300", { title: "No-repo stream", state: "completed", repo: "" }),
      t("301", {
        title: "Subtask",
        state: "proposed",
        repo: "",
        origin: "task:300",
        generatedFrom: "300",
      }),
    ];

    const { fixture, router } = await mount("/workstreams?scope=all&st=person");
    const navSpy = vi.spyOn(router, "navigate");
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-row-task:300"]',
    )!.click();
    expect(navSpy).toHaveBeenCalledWith(["/workstreams", "task:300"], {
      queryParams: { node: null },
      queryParamsHandling: "merge",
    });

    const createSvc = TestBed.inject(CreateTaskService);
    const openSpy = vi.spyOn(createSvc, "open");
    await router.navigateByUrl("/workstreams/task:300?scope=all");
    await fixture.whenStable();
    fixture.detectChanges();

    el.querySelector<HTMLButtonElement>('[data-testid="ws-add-task"]')!.click();
    expect(openSpy).toHaveBeenCalledWith({
      origin: "task:300",
      repo: "__none__",
    });
  });

  it("uses <g-pill-select> with zero native <select> elements and supports 3-column inspector resizer + running halos", async () => {
    api.open = [
      t("500", {
        title: "Observability rollout",
        state: "completed",
        repo: "sidthe/grain",
      }),
      t("501", {
        title: "Add Prometheus exporter",
        state: "running",
        repo: "sidthe/grain",
        origin: "task:500",
        generatedFrom: "500",
      }),
    ];

    const { fixture, router } = await mount("/workstreams");
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll("select")).toHaveLength(0);

    // Filter by repository via <g-pill-select>
    const navSpy = vi.spyOn(router, "navigate");
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-repo-filter"]',
    )!.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-repo-filter-opt-sidthe/grain"]',
    )!.click();
    expect(navSpy).toHaveBeenCalledWith([], {
      queryParams: { repo: "sidthe/grain" },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });

    // Open workstream detail: verify 21% tree, 42% inspector default, running node halos, and widening up to 55%
    await router.navigateByUrl("/workstreams/task:500?node=501");
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelectorAll("select")).toHaveLength(0);
    expect(el.querySelectorAll("rect.ws-run-halo").length).toBe(3);

    const treeResizer = el.querySelector<HTMLElement>(
      '[data-testid="ws-tree-resizer"]',
    )!;
    const inspResizer = el.querySelector<HTMLElement>(
      '[data-testid="ws-inspector-resizer"]',
    )!;
    expect(treeResizer.getAttribute("aria-valuenow")).toBe("21");
    expect(inspResizer.getAttribute("aria-valuenow")).toBe("42");

    inspResizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    fixture.detectChanges();
    expect(inspResizer.getAttribute("aria-valuenow")).toBe("55");
    expect(localStorage.getItem(WS_INSPECTOR_RATIO_KEY)).toBe("0.5500");

    inspResizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    fixture.detectChanges();
    expect(inspResizer.getAttribute("aria-valuenow")).toBe("42");

    // Collapsing the tree via Enter exposes the "Show tree" button in .ws-dtoolbar
    expect(el.querySelector('[data-testid="ws-show-tree"]')).toBeNull();
    treeResizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    fixture.detectChanges();
    const showTreeBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-show-tree"]',
    );
    expect(showTreeBtn?.textContent?.trim()).toBe("Show tree");
    showTreeBtn!.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="ws-show-tree"]')).toBeNull();
  });

  it("marks selected list rows and cards with is-selected, aria-current='true', and tabindex='0'", async () => {
    api.open = [
      t("10", {
        title: "First stream",
        state: "running",
        updatedAt: "2026-11-11T12:00:00Z",
      }),
      t("11", {
        title: "First sub",
        state: "queued",
        origin: "task:10",
        generatedFrom: "10",
        updatedAt: "2026-11-11T12:00:00Z",
      }),
      t("20", {
        title: "Second stream",
        state: "running",
        updatedAt: "2026-11-11T10:00:00Z",
      }),
      t("21", {
        title: "Second sub",
        state: "queued",
        origin: "task:20",
        generatedFrom: "20",
        updatedAt: "2026-11-11T10:00:00Z",
      }),
    ];

    const { fixture } = await mount("/workstreams");
    const el = fixture.nativeElement as HTMLElement;

    const row1 = el.querySelector<HTMLElement>(
      '[data-testid="ws-row-task:10"]',
    )!;
    const row2 = el.querySelector<HTMLElement>(
      '[data-testid="ws-row-task:20"]',
    )!;
    expect(row1.getAttribute("tabindex")).toBe("0");
    expect(row2.getAttribute("tabindex")).toBe("0");
    expect(row1.classList.contains("is-selected")).toBe(false);
    expect(row1.hasAttribute("aria-current")).toBe(false);
    expect(row2.hasAttribute("aria-current")).toBe(false);

    // Stepping with j/ArrowDown moves focus and marks only the active row selected.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "j",
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(row1);
    expect(row1.classList.contains("is-selected")).toBe(true);
    expect(row1.getAttribute("aria-current")).toBe("true");
    expect(row2.classList.contains("is-selected")).toBe(false);
    expect(row2.hasAttribute("aria-current")).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(row2);
    expect(row1.classList.contains("is-selected")).toBe(false);
    expect(row1.hasAttribute("aria-current")).toBe(false);
    expect(row2.classList.contains("is-selected")).toBe(true);
    expect(row2.getAttribute("aria-current")).toBe("true");

    // Switching to Cards preserves selection and applies the same attributes to cards.
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-view-cards"]',
    )!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const card1 = el.querySelector<HTMLElement>(
      '[data-testid="ws-card-task:10"]',
    )!;
    const card2 = el.querySelector<HTMLElement>(
      '[data-testid="ws-card-task:20"]',
    )!;
    expect(card1.getAttribute("tabindex")).toBe("0");
    expect(card2.getAttribute("tabindex")).toBe("0");
    expect(card1.classList.contains("is-selected")).toBe(false);
    expect(card1.hasAttribute("aria-current")).toBe(false);
    expect(card2.classList.contains("is-selected")).toBe(true);
    expect(card2.getAttribute("aria-current")).toBe("true");

    // Stepping backward with k moves focus and selection back to card1.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(card1);
    expect(card1.classList.contains("is-selected")).toBe(true);
    expect(card1.getAttribute("aria-current")).toBe("true");
    expect(card2.classList.contains("is-selected")).toBe(false);
    expect(card2.hasAttribute("aria-current")).toBe(false);
  });

  it("opens cards and list rows on click, Enter, and Space without double-firing page Enter", async () => {
    api.open = [
      t("10", { title: "First stream", state: "running" }),
      t("11", {
        title: "First sub",
        state: "queued",
        origin: "task:10",
        generatedFrom: "10",
      }),
      t("20", { title: "Second stream", state: "running" }),
      t("21", {
        title: "Second sub",
        state: "queued",
        origin: "task:20",
        generatedFrom: "20",
      }),
    ];

    const { fixture, router } = await mount("/workstreams?selected=task:10");
    const el = fixture.nativeElement as HTMLElement;
    const nav = vi.spyOn(router, "navigate").mockResolvedValue(true);

    const row1 = el.querySelector<HTMLElement>(
      '[data-testid="ws-row-task:10"]',
    )!;
    const row2 = el.querySelector<HTMLElement>(
      '[data-testid="ws-row-task:20"]',
    )!;
    expect(row1.classList.contains("is-selected")).toBe(true);
    expect(row1.getAttribute("aria-current")).toBe("true");

    // Enter on a toolbar button must not trigger the page-level openStream.
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-view-cards"]',
    )!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(nav).not.toHaveBeenCalled();

    // Enter on the page body opens the currently selected stream.
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith(["/workstreams", "task:10"], {
      queryParams: { node: null },
      queryParamsHandling: "merge",
    });
    nav.mockClear();

    const enterRow = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    row2.dispatchEvent(enterRow);
    const spaceRow = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    row2.dispatchEvent(spaceRow);
    fixture.detectChanges();

    expect(enterRow.defaultPrevented).toBe(true);
    expect(spaceRow.defaultPrevented).toBe(true);
    expect(nav).toHaveBeenCalledTimes(2);
    for (const call of nav.mock.calls) {
      expect(call).toEqual([
        ["/workstreams", "task:20"],
        { queryParams: { node: null }, queryParamsHandling: "merge" },
      ]);
    }
    expect(row2.classList.contains("is-selected")).toBe(true);
    expect(row2.getAttribute("aria-current")).toBe("true");
    expect(row1.hasAttribute("aria-current")).toBe(false);

    // Keydown originating on a nested child does not activate pickKey.
    nav.mockClear();
    row2.querySelector(".ws-ttl")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(nav).not.toHaveBeenCalled();

    // Cards view: click, Enter, and Space activate the card itself.
    nav.mockClear();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-view-cards"]',
    )!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    nav.mockClear();

    const card1 = el.querySelector<HTMLElement>(
      '[data-testid="ws-card-task:10"]',
    )!;
    card1.click();
    card1.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    card1.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();

    expect(nav).toHaveBeenCalledTimes(3);
    for (const call of nav.mock.calls) {
      expect(call).toEqual([
        ["/workstreams", "task:10"],
        { queryParams: { node: null }, queryParamsHandling: "merge" },
      ]);
    }
    expect(card1.classList.contains("is-selected")).toBe(true);
    expect(card1.getAttribute("aria-current")).toBe("true");
  });

  it("retains selection when returning from workstream detail and clears it on reset", async () => {
    api.open = [
      t("10", { title: "First stream", state: "running" }),
      t("11", {
        title: "First sub",
        state: "queued",
        origin: "task:10",
        generatedFrom: "10",
      }),
    ];

    const { fixture, router } = await mount("/workstreams");
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('[data-testid="ws-row-task:10"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(router.url).toContain("/workstreams/task:10");
    el.querySelector<HTMLButtonElement>('[data-testid="ws-back"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const row = el.querySelector<HTMLElement>(
      '[data-testid="ws-row-task:10"]',
    )!;
    expect(row.classList.contains("is-selected")).toBe(true);
    expect(row.getAttribute("aria-current")).toBe("true");

    // Reset filters clears the selection.
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-state-done"]',
    )!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="ws-reset-filters"]',
    )!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const rowAfterReset = el.querySelector<HTMLElement>(
      '[data-testid="ws-row-task:10"]',
    )!;
    expect(rowAfterReset.classList.contains("is-selected")).toBe(false);
    expect(rowAfterReset.hasAttribute("aria-current")).toBe(false);
  });

  it("stops propagation on Enter and Space selection so ancestor and document shortcuts do not double-fire", async () => {
    api.open = [
      t("10", {
        title: "First stream",
        state: "running",
        updatedAt: "2026-11-11T12:00:00Z",
      }),
      t("11", {
        title: "First sub",
        state: "queued",
        origin: "task:10",
        generatedFrom: "10",
        updatedAt: "2026-11-11T12:00:00Z",
      }),
      t("20", {
        title: "Second stream",
        state: "running",
        updatedAt: "2026-11-11T10:00:00Z",
      }),
      t("21", {
        title: "Second sub",
        state: "queued",
        origin: "task:20",
        generatedFrom: "20",
        updatedAt: "2026-11-11T10:00:00Z",
      }),
    ];

    const { fixture, router } = await mount("/workstreams?selected=task:10");
    const el = fixture.nativeElement as HTMLElement;
    const nav = vi.spyOn(router, "navigate").mockResolvedValue(true);
    const hostKeySpy = vi.fn();
    const docKeySpy = vi.fn();
    el.addEventListener("keydown", hostKeySpy);
    document.addEventListener("keydown", docKeySpy);

    try {
      const row2 = el.querySelector<HTMLElement>(
        '[data-testid="ws-row-task:20"]',
      )!;
      row2.focus();

      for (const init of [
        { key: "Enter", bubbles: true, cancelable: true },
        { key: " ", bubbles: true, cancelable: true },
        // Even non-cancelable synthetic Enter/Space events must not bubble to document.
        { key: "Enter", bubbles: true, cancelable: false },
        { key: " ", bubbles: true, cancelable: false },
      ]) {
        nav.mockClear();
        hostKeySpy.mockClear();
        docKeySpy.mockClear();
        const ev = new KeyboardEvent("keydown", init);
        const stopSpy = vi.spyOn(ev, "stopPropagation");
        row2.dispatchEvent(ev);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        if (init.cancelable) expect(ev.defaultPrevented).toBe(true);
        expect(hostKeySpy).not.toHaveBeenCalled();
        expect(docKeySpy).not.toHaveBeenCalled();
        expect(nav).toHaveBeenCalledTimes(1);
        expect(nav).toHaveBeenCalledWith(["/workstreams", "task:20"], {
          queryParams: { node: null },
          queryParamsHandling: "merge",
        });
      }

      // Held-down key repeats stop propagation and prevent default without re-navigating.
      nav.mockClear();
      for (const key of ["Enter", " "]) {
        const rep = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          repeat: true,
        });
        row2.dispatchEvent(rep);
        expect(rep.defaultPrevented).toBe(true);
      }
      expect(hostKeySpy).not.toHaveBeenCalled();
      expect(docKeySpy).not.toHaveBeenCalled();
      expect(nav).not.toHaveBeenCalled();

      // Modified keys do not trigger pickKey.
      row2.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      row2.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(nav).not.toHaveBeenCalled();

      // Cards view: Enter and Space on a card also stop propagation and fire once.
      el.querySelector<HTMLButtonElement>(
        '[data-testid="ws-view-cards"]',
      )!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      nav.mockClear();
      hostKeySpy.mockClear();
      docKeySpy.mockClear();

      const card1 = el.querySelector<HTMLElement>(
        '[data-testid="ws-card-task:10"]',
      )!;
      card1.focus();
      for (const key of ["Enter", " "]) {
        nav.mockClear();
        const ev = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        const stopSpy = vi.spyOn(ev, "stopPropagation");
        card1.dispatchEvent(ev);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
        expect(hostKeySpy).not.toHaveBeenCalled();
        expect(docKeySpy).not.toHaveBeenCalled();
        expect(nav).toHaveBeenCalledTimes(1);
        expect(nav).toHaveBeenCalledWith(["/workstreams", "task:10"], {
          queryParams: { node: null },
          queryParamsHandling: "merge",
        });
      }
    } finally {
      el.removeEventListener("keydown", hostKeySpy);
      document.removeEventListener("keydown", docKeySpy);
    }
  });

  it("handles keyboard stepping, shortcuts, and page-level Enter while stopping window propagation", async () => {
    api.open = [
      t("10", {
        title: "First stream",
        state: "running",
        updatedAt: "2026-11-11T12:00:00Z",
      }),
      t("11", {
        title: "First sub",
        state: "queued",
        origin: "task:10",
        generatedFrom: "10",
        updatedAt: "2026-11-11T12:00:00Z",
      }),
    ];

    const { fixture, router } = await mount("/workstreams");
    const el = fixture.nativeElement as HTMLElement;
    const nav = vi.spyOn(router, "navigate").mockResolvedValue(true);
    const winKeySpy = vi.fn();
    const docKeySpy = vi.fn();
    window.addEventListener("keydown", winKeySpy);
    document.addEventListener("keydown", docKeySpy);

    try {
      // j focuses the first row and stops propagation to window; Enter opens once without reaching document.
      const stepEv = new KeyboardEvent("keydown", {
        key: "j",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(stepEv);
      fixture.detectChanges();
      expect(stepEv.defaultPrevented).toBe(true);
      expect(winKeySpy).not.toHaveBeenCalled();

      const row1 = el.querySelector<HTMLElement>(
        '[data-testid="ws-row-task:10"]',
      )!;
      expect(document.activeElement).toBe(row1);

      docKeySpy.mockClear();
      winKeySpy.mockClear();
      nav.mockClear();
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(docKeySpy).not.toHaveBeenCalled();
      expect(winKeySpy).not.toHaveBeenCalled();
      expect(nav).toHaveBeenCalledTimes(1);
      expect(nav).toHaveBeenCalledWith(["/workstreams", "task:10"], {
        queryParams: { node: null },
        queryParamsHandling: "merge",
      });

      // Page shortcuts (v, /, p, s, a) stop propagation to window.
      nav.mockClear();
      for (const key of ["v", "p", "s", "a", "/"]) {
        const ev = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
      }
      expect(winKeySpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(
        el.querySelector('[data-testid="ws-search"]'),
      );

      // Enter on page body opens selected stream and stops propagation to window,
      // while Enter on a role="button" widget does not activate openStream.
      nav.mockClear();
      const roleBtn = document.createElement("div");
      roleBtn.setAttribute("role", "button");
      el.appendChild(roleBtn);
      roleBtn.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(nav).not.toHaveBeenCalled();
      expect(winKeySpy).toHaveBeenCalledTimes(1);
      roleBtn.remove();
      winKeySpy.mockClear();

      const bodyEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(bodyEnter);
      expect(bodyEnter.defaultPrevented).toBe(true);
      expect(winKeySpy).not.toHaveBeenCalled();
      expect(nav).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", winKeySpy);
      document.removeEventListener("keydown", docKeySpy);
    }
  });

  it("toggles is-mobile class across < 600px matchMedia changes and window resize boundaries", async () => {
    const origWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const setWidth = (w: number) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: w,
      });
    };

    try {
      // Initial desktop width (>= 600px) and non-matching media query: no is-mobile.
      setWidth(1024);
      const listeners = new Set<(ev: MediaQueryListEvent) => void>();
      let mqlMatches = false;
      const removeSpy = vi.fn(
        (type: string, cb: EventListenerOrEventListenerObject) => {
          if (type === "change" && typeof cb === "function") {
            listeners.delete(cb as (ev: MediaQueryListEvent) => void);
          }
        },
      );
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
          get matches() {
            return query === PHONE_QUERY ? mqlMatches : false;
          },
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: (
            type: string,
            cb: EventListenerOrEventListenerObject,
          ) => {
            if (type === "change" && typeof cb === "function") {
              listeners.add(cb as (ev: MediaQueryListEvent) => void);
            }
          },
          removeEventListener: removeSpy,
          dispatchEvent: () => false,
        }),
      });

      const { fixture, harness } = await mount("/workstreams");
      const host = harness.routeNativeElement as HTMLElement;
      const page = () =>
        host.querySelector<HTMLElement>('[data-testid="ws-page"]')!;

      expect(host.tagName.toLowerCase()).toBe("g-workstreams-page");
      expect(host.classList.contains("is-mobile")).toBe(false);
      expect(page().classList.contains("is-mobile")).toBe(false);

      // MediaQueryList change -> true applies is-mobile to host and .ws-page.
      mqlMatches = true;
      for (const cb of listeners) {
        cb({ matches: true, media: PHONE_QUERY } as MediaQueryListEvent);
      }
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(page().classList.contains("is-mobile")).toBe(true);

      // MediaQueryList change -> false clears is-mobile when width >= 600px.
      mqlMatches = false;
      for (const cb of listeners) {
        cb({ matches: false, media: PHONE_QUERY } as MediaQueryListEvent);
      }
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(false);
      expect(page().classList.contains("is-mobile")).toBe(false);

      // Window resize across the 600px boundary (599 -> 600 -> 390).
      setWidth(599);
      window.dispatchEvent(new Event("resize"));
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(page().classList.contains("is-mobile")).toBe(true);

      setWidth(600);
      window.dispatchEvent(new Event("resize"));
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(false);
      expect(page().classList.contains("is-mobile")).toBe(false);

      setWidth(390);
      window.dispatchEvent(new Event("resize"));
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(page().classList.contains("is-mobile")).toBe(true);

      // Not-found .ws-page variant also receives is-mobile on < 600px.
      await harness.navigateByUrl(
        "/workstreams/task:999999",
        WorkstreamsPageComponent,
      );
      harness.detectChanges();
      await fixture.whenStable();
      harness.detectChanges();
      const notFoundHost = harness.routeNativeElement as HTMLElement;
      const notFound = notFoundHost.querySelector<HTMLElement>(
        '[data-testid="ws-not-found"]',
      )!;
      expect(notFoundHost.classList.contains("is-mobile")).toBe(true);
      expect(notFound.classList.contains("is-mobile")).toBe(true);

      fixture.destroy();
      expect(removeSpy).toHaveBeenCalledWith("change", expect.any(Function));
      expect(listeners.size).toBe(0);
    } finally {
      if (origWidth) {
        Object.defineProperty(window, "innerWidth", origWidth);
      } else {
        setWidth(1024);
      }
    }
  });

  it("applies is-mobile on initial mount when viewport starts < 600px across loading, list, and detail views", async () => {
    const origWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const win = window as { matchMedia?: unknown };
    const origMatchMedia = win.matchMedia;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    win.matchMedia = undefined;
    api.open = [
      t("10", { title: "Mobile stream", state: "running" }),
      t("11", {
        title: "Mobile subtask",
        state: "queued",
        origin: "task:10",
        generatedFrom: "10",
      }),
    ];
    let releaseLoad!: () => void;
    const holdLoad = new Promise<void>((r) => {
      releaseLoad = r;
    });
    const origGetIfChanged = api.getIfChanged;
    api.getIfChanged = vi.fn(async (route: string) => {
      await holdLoad;
      return origGetIfChanged(route);
    });
    try {
      // Loading view before store refresh completes still marks host and ws-loading.
      TestBed.configureTestingModule({
        imports: [WorkstreamsPageComponent],
        providers: [
          provideRouter(
            [
              { path: "workstreams", component: WorkstreamsPageComponent },
              { path: "workstreams/:key", component: WorkstreamsPageComponent },
              { path: "**", children: [] },
            ],
            withComponentInputBinding(),
          ),
          { provide: GrainApi, useValue: api },
          { provide: GrainEvents, useValue: { events: () => NEVER } },
        ],
      });
      TestBed.inject(AccessService).setConfig({
        access: null,
        viewerOwner: "alice",
      });
      const harness = await RouterTestingHarness.create(
        "/workstreams/task:10",
        WorkstreamsPageComponent,
      );
      harness.detectChanges();
      const loadingHost = harness.routeNativeElement as HTMLElement;
      const loadingEl = loadingHost.querySelector<HTMLElement>(
        '[data-testid="ws-loading"]',
      )!;
      expect(loadingHost.classList.contains("is-mobile")).toBe(true);
      expect(loadingEl.classList.contains("is-mobile")).toBe(true);

      // Once loaded on detail route, host keeps is-mobile around g-workstream-detail.
      releaseLoad();
      await TestBed.inject(WorkstreamsStore).refresh(true);
      harness.detectChanges();
      await harness.fixture.whenStable();
      harness.detectChanges();
      expect(loadingHost.classList.contains("is-mobile")).toBe(true);
      expect(loadingHost.querySelector("g-workstream-detail")).not.toBeNull();

      // List view (/workstreams) applies is-mobile to both host and .ws-page.
      await harness.navigateByUrl("/workstreams", WorkstreamsPageComponent);
      harness.detectChanges();
      await harness.fixture.whenStable();
      harness.detectChanges();
      const listHost = harness.routeNativeElement as HTMLElement;
      const page = listHost.querySelector<HTMLElement>(
        '[data-testid="ws-page"]',
      )!;
      expect(listHost.tagName.toLowerCase()).toBe("g-workstreams-page");
      expect(listHost.classList.contains("is-mobile")).toBe(true);
      expect(page.classList.contains("is-mobile")).toBe(true);
    } finally {
      if (origWidth) {
        Object.defineProperty(window, "innerWidth", origWidth);
      }
      win.matchMedia = origMatchMedia;
    }
  });
});

describe("Workstreams detail embedded task pane", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = new FakeApi();
    localStorage.clear();
  });
  afterEach(() => TestBed.resetTestingModule());

  it("switches the embedded task pane's tabs without a [tab] binding", async () => {
    api.open = [
      t("200", { title: "Voice stream", state: "running" }),
      t("201", {
        title: "Step",
        state: "running",
        origin: "task:200",
        generatedFrom: "200",
      }),
    ];
    TestBed.configureTestingModule({
      imports: [WorkstreamsPageComponent],
      providers: [
        provideRouter(
          [
            { path: "workstreams/:key", component: WorkstreamsPageComponent },
            { path: "**", children: [] },
          ],
          withComponentInputBinding(),
        ),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig({
      access: null,
      viewerOwner: "alice",
    });
    const harness = await RouterTestingHarness.create(
      "/workstreams/task:200?node=201",
    );
    await TestBed.inject(WorkstreamsStore).refresh(true);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        harness.detectChanges();
        await harness.fixture.whenStable();
        await new Promise((r) => setTimeout(r, 0));
      }
      harness.detectChanges();
    };
    await settle();
    const el = harness.routeNativeElement as HTMLElement;
    const detail = () => el.querySelector("g-task-detail")!;
    const current = () =>
      detail()
        .querySelector(".task-tabs [aria-current]")
        ?.getAttribute("data-testid");
    expect(detail()).not.toBeNull();
    expect(current()).toBe("task-tab-conversation");
    detail()
      .querySelector<HTMLElement>('[data-testid="task-tab-runs"]')!
      .click();
    await settle();
    expect(TestBed.inject(Router).url).toContain("pane=runs");
    expect(current()).toBe("task-tab-runs");
    expect(detail().querySelector(".task-tab-body h2")!.textContent).toBe(
      "Runs",
    );
  });
});
