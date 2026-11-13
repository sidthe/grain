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

import { expect, test } from "./fixtures";

test("schedule editor validates required fields before POST/PATCH and resets all state across close/reopen", async ({
  page,
}) => {
  const postRequests: string[] = [];
  const patchRequests: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (req.method() === "POST" && pathname === "/api/schedules") {
      postRequests.push(pathname);
    } else if (
      req.method() === "PATCH" &&
      pathname.startsWith("/api/schedules/")
    ) {
      patchRequests.push(pathname);
    }
  });

  await page.goto("processes/schedules");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // 1. Open New schedule -> submit empty -> required field errors block POST and focus first invalid field
  await page.getByTestId("proc-new-schedule-btn").click();
  const dialog = page.getByTestId("schedule-dialog");
  await expect(dialog).toBeVisible();

  await page.getByTestId("sched-save-btn").click();
  expect(postRequests).toHaveLength(0);
  await expect(page.getByTestId("sched-title-error")).toContainText(
    "Task title is required",
  );
  await expect(page.getByTestId("sched-title-input")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByTestId("sched-title-input")).toBeFocused();

  // Switch cadence, trigger workflow validation, and enter dirty draft values
  await page.getByTestId("sched-title-input").fill("Stale draft title");
  await page.getByTestId("sched-desc-input").fill("Stale draft prompt");
  await page.getByTestId("sched-kind-github_workflow_run").click();
  await page.getByTestId("sched-save-btn").click();
  expect(postRequests).toHaveLength(0);
  await expect(page.getByTestId("sched-trigger-workflow-error")).toContainText(
    "Workflow name or file is required",
  );
  await page.getByTestId("sched-trigger-workflow-input").fill("stale-ci.yml");

  // 2. Close via Cancel -> reopen New schedule -> all controls, cadence, and errors are cleared
  await page.getByTestId("sched-cancel-btn").click();
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("proc-new-schedule-btn").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("sched-title-error")).toHaveCount(0);
  await expect(page.getByTestId("sched-trigger-workflow-error")).toHaveCount(0);
  await expect(page.getByTestId("sched-title-input")).toHaveValue("");
  await expect(page.getByTestId("sched-desc-input")).toHaveValue("");
  await expect(page.getByTestId("sched-kind-daily")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("sched-kind-github_workflow_run").click();
  await expect(page.getByTestId("sched-trigger-workflow-input")).toHaveValue(
    "",
  );
  await expect(page.getByTestId("sched-trigger-workflow-error")).toHaveCount(0);

  // 3. Switch back to daily, fill valid inputs -> real POST /api/schedules succeeds
  await page.getByTestId("sched-kind-daily").click();
  const createdTitle = `E2E Reset Schedule ${Date.now()}`;
  await page.getByTestId("sched-title-input").fill(createdTitle);
  await page.getByTestId("sched-desc-input").fill("Verify clean creation");
  const createResp = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      new URL(res.url()).pathname === "/api/schedules",
  );
  await page.getByTestId("sched-save-btn").click();
  const created = await createResp;
  expect(created.ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  expect(postRequests).toHaveLength(1);

  // 4. Open Edit on created schedule, mutate cadence to invalid min (<10), verify PATCH blocked
  await expect(page.getByTestId("sched-edit-btn")).toBeVisible();
  await page.getByTestId("sched-edit-btn").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("sched-title-input")).toHaveValue(createdTitle);

  await page.getByTestId("sched-kind-everyNMinutes").click();
  await page.getByTestId("sched-every-min-input").fill("5");
  await page.getByTestId("sched-save-btn").click();
  expect(patchRequests).toHaveLength(0);
  await expect(page.getByTestId("sched-every-min-error")).toContainText(
    "between 10 and",
  );

  // Close via Escape -> reopen Edit -> invalid draft & errors are cleared
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("sched-edit-btn").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("sched-every-min-error")).toHaveCount(0);
  await expect(page.getByTestId("sched-kind-daily")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("sched-title-input")).toHaveValue(createdTitle);

  // Mutate description, dismiss via scrim, reopen New -> Edit state does not leak into New
  await page.getByTestId("sched-desc-input").fill("Should vanish on scrim");
  await page.locator(".scrim").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("proc-new-schedule-btn").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("sched-title-input")).toHaveValue("");
  await expect(page.getByTestId("sched-desc-input")).toHaveValue("");
  await page.getByTestId("sched-cancel-btn").click();
  await expect(dialog).toHaveCount(0);

  // 5. Reopen Edit and save valid update -> PATCH /api/schedules/{id} succeeds
  await page.getByTestId("sched-edit-btn").click();
  const updatedTitle = `${createdTitle} Updated`;
  await page.getByTestId("sched-title-input").fill(updatedTitle);
  const patchResp = page.waitForResponse(
    (res) =>
      res.request().method() === "PATCH" &&
      new URL(res.url()).pathname.startsWith("/api/schedules/"),
  );
  await page.getByTestId("sched-save-btn").click();
  const patched = await patchResp;
  expect(patched.ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  expect(patchRequests).toHaveLength(1);
});

test(
  "schedule editor dialog and inline validation errors fit phone/desktop viewports with no serious axe violations",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    await page.goto("processes/schedules?new=1");
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    await expect(page.locator("html")).toHaveAttribute("data-theme", wantTheme);

    const dialog = page.getByTestId("schedule-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("sched-save-btn").click();
    await expect(page.getByTestId("sched-title-error")).toBeVisible();

    const viewportWidth = page.viewportSize()?.width ?? 1440;
    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(sideways, "the page scrolls sideways").toBeLessThanOrEqual(0);

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewportWidth);

    const errBox = await page.getByTestId("sched-title-error").boundingBox();
    expect(errBox).not.toBeNull();
    expect(errBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
    expect(errBox!.x + errBox!.width).toBeLessThanOrEqual(
      dialogBox!.x + dialogBox!.width + 1,
    );

    const saveBox = await page.getByTestId("sched-save-btn").boundingBox();
    expect(saveBox).not.toBeNull();
    expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(viewportWidth);

    const violations = await axe();
    expect(
      violations.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`),
    ).toEqual([]);
  },
);
