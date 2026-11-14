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

test("process templates list and detail clear phone FAB and avoid horizontal overflow on 390px @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route("**/api/templates/*/composition*", async (route) => {
    await route.fulfill({
      json: {
        kind: "template",
        repo: "organization-with-long-name/repository-with-a-very-long-name",
        base: "main",
        tasks: [
          {
            title: "Deploy_super_long_unbreakable_service_title_without_spaces",
            templateName: "super_long_unbreakable_template_identifier",
            fields: [
              {
                name: "very_long_parameter_name_without_spaces",
                values: [
                  "unbreakable_composition_field_value_1234567890_abcdefghijklmnop",
                ],
                source: "template",
              },
            ],
          },
        ],
      },
    });
  });

  await page.route("**/api/templates", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resp = await route.fetch();
    const orig = (await resp.json()) as unknown;
    const baseList = Array.isArray(orig)
      ? orig
      : (((orig as Record<string, unknown>)["templates"] as unknown[]) ?? []);
    const seed = (baseList[0] as Record<string, unknown>) ?? {};
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...seed,
      id: `mock-tmpl-${i}`,
      name:
        i === 0
          ? "super_long_unbreakable_template_identifier_for_mobile_overflow_testing_v2"
          : `Template #${i}`,
      title:
        i === 0
          ? "Deploy_super_long_unbreakable_service_title_without_spaces_to_test_wrapping"
          : `Run maintenance task #${i}`,
      description:
        "Run {{very_long_parameter_name_without_spaces}} against {{target_environment_name}}",
      repo: "organization-with-long-name/repository-with-a-very-long-name",
      base: "main",
      declaredIn: undefined,
      system: false,
      autoMerge: true,
      capabilities: [],
      fields: [
        {
          name: "very_long_parameter_name_without_spaces",
          label: "Target environment parameter",
          default: "default_value_without_any_spaces_at_all_1234567890",
          required: true,
        },
        {
          name: "target_environment_name",
          options: ["prod-us-east1", "staging-eu-west1", "canary-ap-east1"],
        },
      ],
    }));
    await route.fulfill({
      response: resp,
      json: Array.isArray(orig) ? many : { templates: many },
    });
  });

  await page.goto("processes/templates");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const lastRow = page.getByTestId("tmpl-row-mock-tmpl-11");
  await expect(lastRow).toBeVisible();

  const list = page.getByTestId("proc-list-pane").getByRole("list");
  const listMetrics = await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return {
      paddingBottom: parseFloat(getComputedStyle(el).paddingBottom),
      overflowX: el.scrollWidth - el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
  expect(listMetrics.paddingBottom).toBeGreaterThanOrEqual(108);
  expect(listMetrics.overflowX).toBeLessThanOrEqual(0);

  const fab = page.getByTestId("phone-new-task");
  await expect(fab).toBeVisible();
  const fabBox = await fab.boundingBox();
  const navBox = await page
    .getByRole("navigation", { name: "Primary destinations (compact)" })
    .boundingBox();
  const lastRowBox = await lastRow.boundingBox();
  expect(fabBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(lastRowBox).not.toBeNull();

  // Last template row clears both the floating FAB and the compact bottom nav.
  expect(lastRowBox!.y + lastRowBox!.height).toBeLessThanOrEqual(fabBox!.y);
  expect(lastRowBox!.y + lastRowBox!.height).toBeLessThanOrEqual(navBox!.y);
  expect(lastRowBox!.x).toBeGreaterThanOrEqual(0);
  expect(lastRowBox!.x + lastRowBox!.width).toBeLessThanOrEqual(390);

  // Clicking the right side of the last row opens its detail without FAB interception.
  await lastRow.click({
    position: {
      x: Math.floor(lastRowBox!.width - 24),
      y: Math.floor(lastRowBox!.height / 2),
    },
  });
  await expect(page.getByTestId("tmpl-detail-title")).toHaveText(
    "Template #11",
  );

  // Return to list, open the long unbreakable template, and verify detail containment & clearance.
  await page.getByRole("button", { name: "← Back" }).click();
  const firstRow = page.getByTestId("tmpl-row-mock-tmpl-0");
  await firstRow.scrollIntoViewIfNeeded();
  await firstRow.click();
  await expect(page.getByTestId("tmpl-detail-title")).toContainText(
    "super_long_unbreakable_template_identifier",
  );

  const inspector = page.getByTestId("proc-inspector");
  const inspMetrics = await inspector.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return {
      paddingBottom: parseFloat(getComputedStyle(el).paddingBottom),
      overflowX: el.scrollWidth - el.clientWidth,
    };
  });
  expect(inspMetrics.paddingBottom).toBeGreaterThanOrEqual(108);
  expect(inspMetrics.overflowX).toBeLessThanOrEqual(0);

  const compBox = await page.getByTestId("composition-preview").boundingBox();
  expect(compBox).not.toBeNull();
  expect(compBox!.y + compBox!.height).toBeLessThanOrEqual(fabBox!.y);

  // Scroll back to top of inspector to verify action buttons stay inside 390px bounds.
  await inspector.evaluate((el) => {
    el.scrollTop = 0;
  });
  for (const tid of ["tmpl-launch-btn", "tmpl-edit-btn", "tmpl-delete-btn"]) {
    const btnBox = await page.getByTestId(tid).boundingBox();
    expect(btnBox, `${tid} missing`).not.toBeNull();
    expect(btnBox!.x).toBeGreaterThanOrEqual(0);
    expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(390);
  }

  const docSideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(docSideways).toBeLessThanOrEqual(0);
  expect(await axe()).toEqual([]);
});

test("declarations inspector bottom workflow action button clears phone FAB and dialog actions fit 390px @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route("**/api/repos/*/*/workflows", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        repo: "acme/widgets",
        workflows: [
          {
            name: "CI Pipeline",
            path: ".github/workflows/ci.yml",
            yaml: "name: CI\n",
          },
          {
            name: "Release Pipeline",
            path: ".github/workflows/release.yml",
            yaml: "name: Release\n",
          },
          {
            name: "Nightly Workflow",
            path: ".github/workflows/nightly-long-workflow.yml",
            yaml: "name: Nightly\n",
          },
        ],
      },
    });
  });

  await page.goto("processes/declarations");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByTestId("decl-repo-row-acme/widgets").click();

  const inspector = page.getByTestId("proc-inspector");
  const wfBtn = page.getByTestId(
    "decl-inspect-wf-.github/workflows/nightly-long-workflow.yml",
  );
  await expect(wfBtn).toBeVisible();

  await inspector.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const fabBox = await page.getByTestId("phone-new-task").boundingBox();
  const wfBtnBox = await wfBtn.boundingBox();
  expect(fabBox).not.toBeNull();
  expect(wfBtnBox).not.toBeNull();
  expect(wfBtnBox!.y + wfBtnBox!.height).toBeLessThanOrEqual(fabBox!.y);
  expect(wfBtnBox!.x + wfBtnBox!.width).toBeLessThanOrEqual(390);

  await wfBtn.click();
  const dlg = page.getByTestId("repo-workflow-dialog");
  await expect(dlg).toBeVisible();

  const dlgMetrics = await dlg.evaluate((el) => ({
    overflowX: el.scrollWidth - el.clientWidth,
  }));
  expect(dlgMetrics.overflowX).toBeLessThanOrEqual(0);

  const dlgBox = await dlg.boundingBox();
  expect(dlgBox).not.toBeNull();
  for (const tid of ["wf-delete-btn", "wf-save-btn"]) {
    const b = await page.getByTestId(tid).boundingBox();
    expect(b).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(dlgBox!.x);
    expect(b!.x + b!.width).toBeLessThanOrEqual(dlgBox!.x + dlgBox!.width + 1);
  }
  await page.keyboard.press("Escape");

  const docSideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(docSideways).toBeLessThanOrEqual(0);
  expect(await axe()).toEqual([]);
});

test("process templates list and inspector render side-by-side cleanly on desktop", async ({
  page,
  axe,
}) => {
  await page.goto("processes/templates");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const listPane = page.getByTestId("proc-list-pane");
  const inspector = page.getByTestId("proc-inspector");
  await expect(listPane).toBeVisible();
  await expect(inspector).toBeVisible();

  const listBox = await listPane.boundingBox();
  const inspBox = await inspector.boundingBox();
  expect(listBox).not.toBeNull();
  expect(inspBox).not.toBeNull();
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(inspBox!.x + 2);

  const docSideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(docSideways).toBeLessThanOrEqual(0);
  expect(await axe()).toEqual([]);
});
