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

import { test, expect } from "./fixtures.js";

test("M16 Director overlay: top-bar toggle, d/Alt+D/Escape, coplanar selection context, and Shape with Director in New/Edit Task", async ({
  page,
  axe,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/next/tasks");
  await page.waitForSelector(".main-stage > *:not(router-outlet)");

  // Top-bar trigger exposes aria-expanded/aria-controls and opens coplanar Director drawer.
  const trigger = page.getByTestId("director-trigger");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-controls", "director-drawer");
  await trigger.click();
  const drawer = page.getByTestId("director-drawer");
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toHaveAttribute("role", "complementary");
  await expect(drawer).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#main")).not.toHaveAttribute("inert", "");

  const boxRect = await drawer.boundingBox();
  expect(boxRect).toBeTruthy();
  expect(boxRect.width).toBeGreaterThanOrEqual(380);
  expect(Math.abs(boxRect.x + boxRect.width - 1440)).toBeLessThanOrEqual(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await axe({ disableRules: ["color-contrast"] })).toEqual([]);

  // Tab and Shift+Tab trap keyboard focus inside the open side drawer.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          document.activeElement?.closest('[data-testid="director-drawer"]'),
        ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() =>
      Boolean(
        document.activeElement?.closest('[data-testid="director-drawer"]'),
      ),
    ),
  ).toBe(true);
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        Boolean(
          document.activeElement?.closest('[data-testid="director-drawer"]'),
        ),
      ),
    ).toBe(true);
  }

  // Selecting rows in Tasks updates the drawer context toggle live.
  const rows = page.locator('[data-testid^="open-"]');
  await expect(rows.first()).toBeVisible();
  const rowCount = await rows.count();
  if (rowCount >= 2) {
    await rows.nth(1).click();
    await expect(page.getByTestId("director-context-toggle")).toContainText(
      "Task #",
    );
  }

  // Send a message with context attached and assert POST /api/tasks/{id}/comments carries provenance quote.
  const commentReq = page.waitForRequest(
    (req) =>
      /\/api\/tasks\/[^/]+\/comments$/.test(req.url()) &&
      req.method() === "POST",
  );
  const box = drawer.getByTestId("task-composer");
  await box.fill("Check why this task is queued.");
  await box.press("Control+Enter");
  const req = await commentReq;
  const payload = JSON.parse(req.postData() || "{}");
  expect(payload.body).toContain("> [Context:");
  expect(payload.body).toContain("Check why this task is queued.");

  // Escape closes, restores trigger aria-expanded=false and focus, d opens, Alt+D toggles even while typing.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await page.getByTestId("view-filter").blur();
  await page.keyboard.press("d");
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  await page.getByTestId("view-filter").focus();
  await page.keyboard.press("Alt+d");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // Coplanar Shape with Director inside New Task sheet; wider sheet + single-row footer buttons.
  await page.getByTestId("rail-new-task").click();
  const sheet = page.getByTestId("new-task-sheet");
  await expect(sheet).toBeVisible();
  const sheetLayout = await sheet.evaluate((el) => {
    const btns = [...el.querySelectorAll(".sheet-actions > button")].filter(
      (b) => b.getBoundingClientRect().height > 0,
    );
    const tops = btns.map((b) => Math.round(b.getBoundingClientRect().top));
    return {
      width: Math.round(el.getBoundingClientRect().width),
      rowSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : 0,
      count: btns.length,
    };
  });
  expect(sheetLayout.width).toBeGreaterThanOrEqual(700);
  expect(sheetLayout.count).toBeGreaterThanOrEqual(3);
  expect(sheetLayout.rowSpread).toBeLessThanOrEqual(4);
  await page.getByTestId("shape-director-btn").click();
  await expect(sheet.getByTestId("director-shaper-pane")).toBeVisible();
  const shaperRowSpread = await sheet.evaluate((el) => {
    const tops = [...el.querySelectorAll(".sheet-actions > button")]
      .filter((b) => b.getBoundingClientRect().height > 0)
      .map((b) => Math.round(b.getBoundingClientRect().top));
    return tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
  });
  expect(shaperRowSpread).toBeLessThanOrEqual(4);
  await page.getByTestId("new-task-close").click();
  await expect(sheet).toHaveCount(0);

  // Coplanar Shape with Director inside Task Edit panel.
  await page.getByTestId("act-edit").click();
  const editPanel = page.getByTestId("task-edit-panel");
  await expect(editPanel).toBeVisible();
  await page.getByTestId("edit-shape-director").click();
  await expect(editPanel.getByTestId("director-shaper-pane")).toBeVisible();
});

test(
  "compact modal Director drawer",
  { tag: ["@phone"] },
  async ({ page, axe }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/next/inbox");
    await page.waitForSelector(".main-stage > *:not(router-outlet)");

    const trigger = page.getByTestId("director-trigger");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();

    const drawer = page.getByTestId("director-drawer");
    await expect(drawer).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await expect(drawer).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator(".drawer-scrim")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.getByTestId("director-drawer-wide")).toBeHidden();

    const rect = await drawer.boundingBox();
    expect(rect).toBeTruthy();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(390);
    expect(rect.height).toBeCloseTo(844, 0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(await axe({ disableRules: ["color-contrast"] })).toEqual([]);

    // Both Shift+Tab and forward Tab stay trapped inside the compact modal drawer.
    for (const key of ["Shift+Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Tab"]) {
      await page.keyboard.press(key);
      expect(
        await page.evaluate(() =>
          Boolean(
            document.activeElement?.closest('[data-testid="director-drawer"]'),
          ),
        ),
      ).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  },
);
