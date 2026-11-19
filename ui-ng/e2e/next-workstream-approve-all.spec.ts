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

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Approve a submitted workstream's whole upstream set at once (task 635):
// the Workstreams list and cards, a closed root's task page, and a child's
// upstream chain, over a real `grain demo` server. Each layout check puts
// the approve button inside its row/card at desktop, tablet and phone.

type Seeded = {
  prereq: string;
  root: string;
  a: string;
  b: string;
  title: string;
};

async function api(
  baseURL: string,
  code: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${code}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// A closed root (as after propose_dag) with two proposed children in
// dependency order, the first waiting on a standalone proposed prerequisite.
async function seed(server: string, code: string): Promise<Seeded> {
  const stamp = Date.now();
  const title = `Approve-all stream ${stamp}`;
  const prereq = await api(server, code, "POST", "/api/tasks", {
    title: `Shared prerequisite ${stamp}`,
  });
  const root = await api(server, code, "POST", "/api/tasks", {
    title,
    approved: true,
  });
  const a = await api(server, code, "POST", "/api/tasks", {
    title: `Wave one ${stamp}`,
    origin: `task:${root.id}`,
    dependsOn: [prereq.id],
  });
  const b = await api(server, code, "POST", "/api/tasks", {
    title: `Wave two ${stamp}`,
    origin: `task:${root.id}`,
    dependsOn: [a.id],
  });
  await api(server, code, "POST", `/api/tasks/${root.id}/close`, {
    reason: "planned; children filed",
  });
  return { prereq: prereq.id, root: root.id, a: a.id, b: b.id, title };
}

async function expectInside(inner: Locator, outer: Locator) {
  const ib = await inner.boundingBox();
  const ob = await outer.boundingBox();
  expect(ib).not.toBeNull();
  expect(ob).not.toBeNull();
  expect(ib!.x).toBeGreaterThanOrEqual(ob!.x - 0.5);
  expect(ib!.y).toBeGreaterThanOrEqual(ob!.y - 0.5);
  expect(ib!.x + ib!.width).toBeLessThanOrEqual(ob!.x + ob!.width + 0.5);
  expect(ib!.y + ib!.height).toBeLessThanOrEqual(ob!.y + ob!.height + 0.5);
}

async function noHorizontalOverflow(el: Locator) {
  const [scroll, client] = await el.evaluate((n) => [
    n.scrollWidth,
    n.clientWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(client + 1);
}

// The demo operator does not own the demo repository, so the dialog asks
// for the other-owner acknowledgement the batch keeps from single approve.
async function accept(page: Page) {
  const tick = page.getByTestId("confirm-multi-repo");
  if (await tick.isVisible()) await tick.check();
  await page.getByTestId("confirm-accept").click();
}

function approvalsOf(page: Page): string[] {
  const ids: string[] = [];
  page.on("request", (req) => {
    const m = /\/api\/tasks\/([^/]+)\/approve$/.exec(
      new URL(req.url()).pathname,
    );
    if (req.method() === "POST" && m) ids.push(m[1]);
  });
  return ids;
}

const WIDTHS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 900, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

test.describe("Workstream approve all (/next/)", () => {
  test("list and card approve buttons fit their row at every width and approve upstream first", async ({
    page,
    demoServer,
    accessCode,
  }) => {
    test.setTimeout(120_000);
    const s = await seed(demoServer, accessCode);
    const key = `task:${s.root}`;
    const label = "Approve all 3 (1 upstream)";

    for (const view of ["list", "cards"] as const) {
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w.width, height: w.height });
        await page.goto(
          `/next/workstreams?view=${view}&q=${encodeURIComponent(s.title)}`,
        );
        const btn = page.getByTestId(
          `ws-${view === "list" ? "row" : "card"}-approve-${key}`,
        );
        await expect(btn, `${view} @ ${w.name}`).toBeVisible({
          timeout: 20_000,
        });
        await expect(btn).toHaveText(label);
        if (view === "list") {
          const row = page.locator(".ws-row", { has: btn });
          await expectInside(btn, row);
          await expectInside(btn, page.getByTestId("ws-list"));
        } else {
          const foot = page.locator(".ws-cfoot", { has: btn });
          await expectInside(btn, foot);
          await expectInside(foot, page.locator(".ws-card", { has: btn }));
          await noHorizontalOverflow(foot);
        }
      }
    }

    // Approving from the list does not navigate and goes upstream first.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/next/workstreams?view=list&q=${encodeURIComponent(s.title)}`,
    );
    const approved = approvalsOf(page);
    await page.getByTestId(`ws-row-approve-${key}`).click();
    await expect(page.getByTestId("confirm-dialog")).toContainText(
      `Shared prerequisite`,
    );
    await accept(page);
    await expect(page.getByTestId("snackbar")).toContainText(
      "Approved 3 tasks",
    );
    expect(approved).toEqual([s.prereq, s.a, s.b]);
    await expect(page).toHaveURL(/\/next\/workstreams/);
    for (const id of [s.prereq, s.a, s.b]) {
      const t = await api(demoServer, accessCode, "GET", `/api/tasks/${id}`);
      expect(t.state, `#${id}`).not.toBe("proposed");
    }

    // Undo withdraws all three again.
    await page.getByTestId("snackbar-action").click();
    await expect
      .poll(
        async () =>
          (await api(demoServer, accessCode, "GET", `/api/tasks/${s.b}`)).state,
      )
      .toBe("proposed");
  });

  test("a closed root's task page approves its stream, and a child approves its upstream chain @phone @dark", async ({
    page,
    demoServer,
    accessCode,
    axe,
  }) => {
    test.setTimeout(120_000);
    const s = await seed(demoServer, accessCode);

    // The child's own page: the chain above it, upstream first.
    await page.goto(`/next/task/${s.b}`);
    const up = page.getByTestId("act-approve-upstream");
    await expect(up).toBeVisible({ timeout: 20_000 });
    await expect(up).toHaveText("Approve with 2 upstream");

    // The closed root (outside the open feed) still offers its stream.
    await page.goto(`/next/task/${s.root}`);
    const ws = page.getByTestId("act-approve-workstream");
    await expect(ws).toBeVisible({ timeout: 20_000 });
    await expect(ws).toHaveText("Approve all 3 (1 upstream)");
    await expect(page.getByTestId("act-approve-upstream")).toHaveCount(0);
    expect(await axe()).toEqual([]);

    const approved = approvalsOf(page);
    await ws.click();
    await accept(page);
    await expect(page.getByTestId("snackbar")).toContainText(
      "Approved 3 tasks",
    );
    expect(approved).toEqual([s.prereq, s.a, s.b]);
    await expect(page.getByTestId("act-approve-workstream")).toHaveCount(0);
  });
});
