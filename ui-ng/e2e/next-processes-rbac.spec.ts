// Copyright 2026 The Grain Authors
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

import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function mockConfigAccess(
  page: Page,
  access: Record<string, unknown>,
  targetRepos?: string[],
): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json["access"] = access;
    if (targetRepos) json["targetRepos"] = targetRepos;
    await route.fulfill({ response: resp, json });
  });
}

async function openMobileDetailIfNeeded(
  page: Page,
  rowSelector: string,
): Promise<void> {
  const row = page.locator(rowSelector).first();
  if ((await row.count()) === 0) return;
  const insp = page
    .locator(
      '[data-testid="schedule-inspector"], [data-testid="template-inspector"], [data-testid="suite-inspector"], [data-testid="decl-inspector"]',
    )
    .first();
  if (await insp.isVisible().catch(() => false)) return;
  await row.click();
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function hoverAndExpectTip(
  page: Page,
  control: Locator,
  substring: string,
): Promise<void> {
  // Disabled native buttons may not dispatch pointer mouseenter across all browsers;
  // also verify via DOM mouseenter event so gTip renders cleanly without overlapping.
  await control.dispatchEvent("mouseenter");
  const tip = page.locator("#g-tip");
  await expect(tip).toBeVisible({ timeout: 2000 });
  await expect(tip).toContainText(substring);
  await control.dispatchEvent("mouseleave");
}

test("viewer role disables processes mutations and blocks deep-link dialogs @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  await mockConfigAccess(page, {
    role: "grain/viewer",
    roles: ["grain/viewer"],
    full: false,
    scopes: [
      "boards:read",
      "ci:read",
      "repos:read",
      "schedules:read",
      "settings:read",
      "suites:read",
      "tasks:read",
      "templates:read",
      "capabilities:read",
    ],
    repoLimits: {},
  });

  // 1. Schedules + blocked ?new=1 deep link
  await page.goto("processes/schedules?new=1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("schedule-dialog")).toHaveCount(0);
  await expect(page.getByTestId("proc-new-schedule-btn")).toHaveCount(0);
  await openMobileDetailIfNeeded(page, '[data-testid^="sched-row-"]');
  if ((await page.getByTestId("sched-run-now-btn").count()) > 0) {
    await expect(page.getByTestId("sched-run-now-btn")).toBeDisabled();
    await expect(page.getByTestId("sched-toggle-enabled-btn")).toBeDisabled();
  }
  await assertNoHorizontalOverflow(page);
  expect(await axe()).toEqual([]);

  // 2. Templates + blocked ?launch=1 deep link
  await page.goto("processes/templates?launch=1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("launch-dialog")).toHaveCount(0);
  await expect(page.getByTestId("proc-launch-template-btn")).toHaveCount(0);
  await expect(page.getByTestId("proc-new-template-btn")).toHaveCount(0);
  await openMobileDetailIfNeeded(page, '[data-testid^="tmpl-row-"]');
  if ((await page.getByTestId("tmpl-launch-btn").count()) > 0) {
    await expect(page.getByTestId("tmpl-launch-btn")).toBeDisabled();
  }
  await assertNoHorizontalOverflow(page);
  expect(await axe()).toEqual([]);

  // 3. Suites + blocked ?run=1 deep link
  await page.goto("processes/suites?run=1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("run-suite-dialog")).toHaveCount(0);
  await expect(page.getByTestId("proc-run-suite-btn")).toHaveCount(0);
  await expect(page.getByTestId("proc-new-suite-btn")).toHaveCount(0);
  await openMobileDetailIfNeeded(page, '[data-testid^="suite-row-"]');
  if ((await page.getByTestId("suite-open-run-dialog-btn").count()) > 0) {
    await expect(page.getByTestId("suite-open-run-dialog-btn")).toBeDisabled();
  }
  await assertNoHorizontalOverflow(page);
  expect(await axe()).toEqual([]);
});

test("repo-scoped suites:write enforces canGlobalScope for cross-repo/multi-repo suites and allows authorized single-repo suite @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  await mockConfigAccess(
    page,
    {
      role: "widgets-operator",
      roles: ["widgets-operator"],
      full: false,
      scopes: [
        "boards:read",
        "ci:read",
        "repos:read",
        "schedules:read",
        "suites:read",
        "suites:write",
        "tasks:read",
        "tasks:write",
        "templates:read",
      ],
      repoLimits: {
        "suites:write": ["acme/widgets"],
        "tasks:write": ["acme/widgets"],
      },
    },
    ["acme/gadgets", "acme/widgets"],
  );

  await page.route("**/api/templates", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resp = await route.fetch();
    const raw = (await resp.json()) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : (((raw as Record<string, unknown>)["templates"] as unknown[]) ?? []);
    const augmented = [
      ...list,
      {
        id: "e2e-tmpl-widgets",
        name: "Widgets pass",
        title: "Widgets pass",
        description: "Single-repo widgets template",
        repo: "acme/widgets",
        autoMerge: false,
        capabilities: [],
      },
      {
        id: "e2e-tmpl-gadgets",
        name: "Gadgets pass",
        title: "Gadgets pass",
        description: "Single-repo gadgets template",
        repo: "acme/gadgets",
        autoMerge: false,
        capabilities: [],
      },
    ];
    await route.fulfill({
      response: resp,
      json: Array.isArray(raw) ? augmented : { templates: augmented },
    });
  });

  await page.route("**/api/suites", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resp = await route.fetch();
    const raw = (await resp.json()) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : (((raw as Record<string, unknown>)["suites"] as unknown[]) ?? []);
    const augmented = [
      ...list,
      {
        id: "e2e-suite-unbound",
        name: "E2E Unbound Suite",
        items: [{ templateId: "e2e-tmpl-none" }],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
      },
      {
        id: "e2e-suite-multi",
        name: "E2E Multi-Repo Suite",
        items: [
          { templateId: "e2e-tmpl-widgets" },
          { templateId: "e2e-tmpl-gadgets" },
        ],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
      },
      {
        id: "e2e-suite-gadgets",
        name: "E2E Gadgets Suite",
        items: [{ templateId: "e2e-tmpl-gadgets" }],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
      },
      {
        id: "e2e-suite-widgets",
        name: "E2E Widgets Suite",
        items: [{ templateId: "e2e-tmpl-widgets" }],
        mode: "count",
        count: 1,
        requireApproval: false,
        autoMerge: false,
        autoApproveProposals: false,
      },
    ];
    await route.fulfill({
      response: resp,
      json: Array.isArray(raw) ? augmented : { suites: augmented },
    });
  });

  await page.goto("processes/suites");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("proc-new-suite-btn")).toHaveCount(0);
  await expect(page.getByTestId("proc-run-suite-btn")).toBeVisible();

  const phoneBack = page.locator(".proc-mobile-back");
  const goBackIfPhone = async () => {
    if (await phoneBack.isVisible().catch(() => false)) {
      await phoneBack.click();
    }
  };

  // Unbound ("any") suite: Run suite, Edit, Delete disabled with global suites:write tooltip
  await page.getByTestId("suite-row-e2e-suite-unbound").click();
  const runSuiteBtn = page.getByTestId("suite-open-run-dialog-btn");
  await expect(runSuiteBtn).toBeDisabled();
  await expect(page.getByTestId("suite-edit-btn")).toBeDisabled();
  await expect(page.getByTestId("suite-delete-btn")).toBeDisabled();
  await hoverAndExpectTip(page, runSuiteBtn, "global suites:write");

  // Multi-repo ("several") suite: Run suite disabled
  await goBackIfPhone();
  await page.getByTestId("suite-row-e2e-suite-multi").click();
  await expect(runSuiteBtn).toBeDisabled();

  // Unauthorized single-repo suite: Run suite disabled with repository reason
  await goBackIfPhone();
  await page.getByTestId("suite-row-e2e-suite-gadgets").click();
  await expect(runSuiteBtn).toBeDisabled();
  await hoverAndExpectTip(page, runSuiteBtn, "on this repository");

  // Authorized single-repo suite: Run suite enabled, Edit/Delete still disabled
  await goBackIfPhone();
  await page.getByTestId("suite-row-e2e-suite-widgets").click();
  await expect(runSuiteBtn).toBeEnabled();
  await expect(page.getByTestId("suite-edit-btn")).toBeDisabled();
  await expect(page.getByTestId("suite-delete-btn")).toBeDisabled();

  // Action cluster bounding boxes fit within viewport without clipping
  const actionsBox = await page
    .locator('[data-testid="suite-inspector"] .headline-actions')
    .boundingBox();
  const vp = page.viewportSize()!;
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.x).toBeGreaterThanOrEqual(0);
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(vp.width + 1);

  await runSuiteBtn.click();
  const dlg = page.getByTestId("run-suite-dialog");
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId("run-suite-repo-input")).toHaveValue(
    "acme/widgets",
  );
  await expect(page.getByTestId("run-suite-submit")).toBeEnabled();
  await page.getByTestId("run-suite-picker").click();
  const options = dlg.locator('[role="listbox"] [role="option"]');
  await expect(options.filter({ hasText: "E2E Widgets Suite" })).toHaveCount(1);
  await expect(options.filter({ hasText: "E2E Unbound Suite" })).toHaveCount(0);
  await expect(options.filter({ hasText: "E2E Multi-Repo Suite" })).toHaveCount(
    0,
  );
  await expect(options.filter({ hasText: "E2E Gadgets Suite" })).toHaveCount(0);
  await page.getByTestId("run-suite-dialog").press("Escape");

  await assertNoHorizontalOverflow(page);
  expect(await axe()).toEqual([]);
});
