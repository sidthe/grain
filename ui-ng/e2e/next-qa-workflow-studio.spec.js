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

test.use({ demoArgs: ["-as", "demo-operator"] });

const createdScheduleIds = [];

test.afterEach(async ({ demoServer, accessCode }) => {
  const headers = {
    Authorization: `Bearer ${accessCode}`,
    "Content-Type": "application/json",
  };
  while (createdScheduleIds.length > 0) {
    const id = createdScheduleIds.pop();
    await fetch(`${demoServer}/api/schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    }).catch(() => {});
  }
  await fetch(`${demoServer}/api/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      qaEnabled: false,
      qaFlowId: "golden-v1-minimal",
      qaRolloutPct: 0,
      qaShadowOnControl: true,
    }),
  });
});

test("Telemetry tab-strip, Processes full-width composition well, and Software Workflow & QA Studio render cleanly", async ({
  page,
  demoServer,
  accessCode,
}) => {
  test.setTimeout(120_000);
  const authHeaders = {
    Authorization: `Bearer ${accessCode}`,
    "Content-Type": "application/json",
  };

  // (a) /next/telemetry renders .tab-strip inside .stage-header with >= 2px active bottom border and zero horizontal overflow at 1440x900 and 390x844.
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(vp);
    await page.goto("/next/telemetry");
    await expect(page.getByTestId("telemetry-page")).toBeVisible();

    const activeTab = page.locator(
      '.stage-header .tab-strip .tab-link[aria-selected="true"], .stage-header .tab-strip .tab-link[aria-current="page"], .stage-header .tab-strip .tab-link.is-active',
    );
    await expect(activeTab.first()).toBeVisible();

    const borderBottomWidth = await activeTab
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).borderBottomWidth));
    expect(borderBottomWidth).toBeGreaterThanOrEqual(2);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  // (b) /next/processes/schedules renders .comp-body-well at >= 85% of .comp-task clientWidth (never crushed to ~220px).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/next/processes/schedules");
  await expect(page.getByTestId("processes-headline")).toBeVisible();
  await expect(page.getByTestId("proc-tab-quality")).toContainText(
    "Software Workflow & QA",
  );

  // Ensure a schedule with a composed body well is selected (or create one if none has a body well yet).
  const bodyWell = page.locator(".comp-task .comp-body-well").first();
  if (!(await bodyWell.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const createRes = await fetch(`${demoServer}/api/schedules`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "Nightly V4 workflow audit",
        description:
          "Audit all workflow stages and open a pull request if any drift is detected.",
        repo: "acme/widgets",
        base: "main",
        qaFlowRef: "engineering-workflow-v4@1",
        recurrence: { kind: "daily", timeOfDay: "09:00", timeZone: "UTC" },
        overlap: "skip",
      }),
    });
    expect(createRes.ok).toBe(true);
    const created = await createRes.json();
    if (created?.id) {
      createdScheduleIds.push(created.id);
    }
    await page.goto("/next/processes/schedules");
    if (created?.id) {
      await page.getByTestId(`sched-row-${created.id}`).click();
    }
  }

  await expect(bodyWell).toBeVisible();
  const widthRatio = await bodyWell.evaluate((well) => {
    const taskCard = well.closest(".comp-task");
    if (!taskCard || !taskCard.clientWidth) return 0;
    return well.clientWidth / taskCard.clientWidth;
  });
  expect(widthRatio).toBeGreaterThanOrEqual(0.85);

  // Verify the Software workflow <g-pill-select> picker in the Schedule drawer.
  await page.getByTestId("proc-new-schedule-btn").click();
  await expect(page.getByTestId("schedule-dialog")).toBeVisible();
  const qaFlowSelect = page.getByTestId("process-qa-flow-select");
  await expect(qaFlowSelect).toBeVisible();
  await expect(qaFlowSelect).toContainText("Deployment default");
  await qaFlowSelect.click();
  await expect(
    page.getByTestId("process-qa-flow-select-opt-engineering-workflow-v4@1"),
  ).toBeVisible();
  await page
    .getByTestId("process-qa-flow-select-opt-engineering-workflow-v4@1")
    .click();
  await expect(qaFlowSelect).toContainText("engineering-workflow-v4@1");
  await page.keyboard.press("Escape");

  // (c) /next/processes/quality renders the Software Workflow & QA workbench and switches cleanly.
  await page.getByTestId("proc-tab-quality").click();
  await expect(page).toHaveURL(/\/next\/processes\/quality/);
  const panel = page.getByTestId("qa-flows-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("qa-studio-toolbar")).toBeVisible();

  const tabPrompts = page.getByTestId("studio-tab-prompts");
  if (await tabPrompts.isVisible().catch(() => false)) {
    await tabPrompts.click();
    await expect(page.getByTestId("studio-prompts-pane")).toBeVisible();
    await page.getByTestId("studio-tab-pipeline").click();
    await expect(page.getByTestId("studio-pipeline-pane")).toBeVisible();
  }
});
