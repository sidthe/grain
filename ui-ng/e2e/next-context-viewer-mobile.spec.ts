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

import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function mockViewerAccess(page: Page): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json["access"] = {
      role: "grain/viewer",
      roles: ["grain/viewer"],
      full: false,
      scopes: [
        "agents:read",
        "boards:read",
        "ci:read",
        "config:read",
        "memory:read",
        "repos:read",
        "schedules:read",
        "settings:read",
        "suites:read",
        "tasks:read",
        "templates:read",
      ],
      repoLimits: {},
    };
    await route.fulfill({ response: resp, json });
  });
}

async function scrollContextPanelToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(
      "g-context-page .view-panel.is-active",
    );
    if (panel) panel.scrollTop = panel.scrollHeight;
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function expectClearsMobileChrome(
  page: Page,
  target: Locator,
  viewportWidth: number,
): Promise<void> {
  const box = await target.boundingBox();
  const fabBox = await page.getByTestId("phone-new-task").boundingBox();
  const navBox = await page
    .getByRole("navigation", { name: "Primary destinations (compact)" })
    .boundingBox();
  expect(box, "target bounding box missing").not.toBeNull();
  expect(fabBox, "phone FAB bounding box missing").not.toBeNull();
  expect(navBox, "compact bottom nav bounding box missing").not.toBeNull();

  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
  expect(box!.y + box!.height).toBeLessThanOrEqual(fabBox!.y);
  expect(box!.y + box!.height).toBeLessThanOrEqual(navBox!.y);

  const bottomBar = page.locator(".bottom-bar");
  if (await bottomBar.isVisible()) {
    const barBox = await bottomBar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(barBox!.y);
  }
}

test("hides context write actions for grain/viewer and preserves read-only previews @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  const seedSlug = "e2e-viewer-read-pack";
  const seedRes = await page.request.put("/api/memory/documents", {
    data: {
      repo: "",
      name: seedSlug,
      summary: "Viewer-visible prompt index summary for read verification.",
      text: "## Viewer Pack\n\nInspect `GET /api/memory` read-only output.",
    },
  });
  expect(seedRes.ok(), `seed doc failed: ${seedRes.status()}`).toBe(true);

  try {
    await mockViewerAccess(page);
    const writeMethods: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/api/memory") &&
        !["GET", "HEAD"].includes(req.method())
      ) {
        writeMethods.push(`${req.method()} ${req.url()}`);
      }
    });

    await page.addInitScript(() => {
      localStorage.setItem("grain.next.contextMode.v1", "edit");
    });

    for (const vp of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto("context");
      await expect(page.getByTestId("context-headline")).toBeVisible();
      await expect(page.getByTestId("memory-write-denied")).toBeVisible();
      await expect(page.getByTestId("memory-preview")).toBeVisible();

      for (const tid of [
        "context-add-repo-btn",
        "context-add-repo-input",
        "memory-mode-edit",
        "memory-mode-split",
        "memory-mode-preview",
        "memory-textarea",
        "memory-revert-btn",
        "memory-save-btn",
      ]) {
        await expect(
          page.getByTestId(tid),
          `${tid} must be hidden for viewer (${vp.width}x${vp.height})`,
        ).toHaveCount(0);
      }
      await expectNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);

      await page.getByTestId("context-tab-documents").click();
      await expect(page.getByTestId("doc-new-btn")).toHaveCount(0);
      await page.getByTestId(`doc-row-${seedSlug}`).locator("button").click();
      await expect(page.getByTestId("doc-summary-readonly")).toContainText(
        "Viewer-visible prompt index summary",
      );
      await expect(page.getByTestId("doc-preview")).toContainText(
        "GET /api/memory",
      );
      await expect(page.getByTestId("doc-write-denied")).toBeVisible();

      for (const tid of [
        "doc-mode-edit",
        "doc-mode-split",
        "doc-mode-preview",
        "doc-name-input",
        "doc-summary-input",
        "doc-text-input",
        "doc-save-btn",
        "doc-revert-btn",
        "doc-delete-btn",
      ]) {
        await expect(
          page.getByTestId(tid),
          `${tid} must be hidden on documents for viewer (${vp.width}x${vp.height})`,
        ).toHaveCount(0);
      }
      await expectNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);
    }

    expect(writeMethods).toEqual([]);
  } finally {
    await page.request.put("/api/memory/documents", {
      data: { repo: "", name: seedSlug, summary: "", text: "" },
    });
  }
});

test("keeps context editor, previews, and action bars clear of mobile navigation on 390px and landscape @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  const longSlug = "e2e-long-unbreakable-mobile-context-pack-identifier-check";
  const longToken =
    "https://internal.example.invalid/very_long_unbreakable_endpoint_path_0123456789_abcdef";
  const seedRes = await page.request.put("/api/memory/documents", {
    data: {
      repo: "",
      name: longSlug,
      summary:
        "Mobile containment check for long_unbreakable_summary_tokens_without_spaces.",
      text: [
        `## Mobile Wrapping`,
        ``,
        `Inline long token: \`${longToken}\``,
        ``,
        "```bash",
        `grain run --flag="${longToken}" --verify-no-viewport-blowout`,
        "```",
        "",
        "| ColumnOne | ColumnTwo | ColumnThree | ColumnFour |",
        "| --- | --- | --- | --- |",
        `| alpha_long_cell | beta_long_cell | ${longToken} | omega |`,
      ].join("\n"),
    },
  });
  expect(seedRes.ok(), `seed long doc failed: ${seedRes.status()}`).toBe(true);

  try {
    // 1. Portrait 390x844 across Standing Instructions and Documents.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("context");
    await expect(page.getByTestId("context-headline")).toBeVisible();
    await expect(page.getByTestId("memory-save-btn")).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await page.getByTestId("memory-save-btn").scrollIntoViewIfNeeded();
    await expectClearsMobileChrome(
      page,
      page.getByTestId("memory-save-btn"),
      390,
    );
    await expectClearsMobileChrome(
      page,
      page.getByTestId("memory-revert-btn"),
      390,
    );
    await scrollContextPanelToBottom(page);
    await expectClearsMobileChrome(
      page,
      page.getByTestId("memory-save-btn"),
      390,
    );
    expect(await axe()).toEqual([]);

    // Switch to Documents tab and open the long unbreakable pack.
    await page.getByTestId("context-tab-documents").click();
    await page.getByTestId(`doc-row-${longSlug}`).locator("button").click();
    await expect(page.getByTestId("doc-save-btn")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const previewBox = await page.getByTestId("doc-preview").boundingBox();
    expect(previewBox).not.toBeNull();
    expect(previewBox!.x).toBeGreaterThanOrEqual(0);
    expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);

    await scrollContextPanelToBottom(page);
    await expectClearsMobileChrome(page, page.getByTestId("doc-save-btn"), 390);
    await expectClearsMobileChrome(
      page,
      page.getByTestId("doc-delete-btn"),
      390,
    );

    // Ensure the Delete button also has clean hit-testing and opens its dialog when clicked.
    await page.getByTestId("doc-delete-btn").scrollIntoViewIfNeeded();
    await expectClearsMobileChrome(
      page,
      page.getByTestId("doc-delete-btn"),
      390,
    );
    expect(await axe()).toEqual([]);

    // 2. Landscape 844x390: editor must not collapse to a sliver and footer clears phone FAB.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("context");
    await expect(page.getByTestId("memory-textarea")).toBeVisible();
    const splitBox = await page.locator(".ctx-split").boundingBox();
    expect(splitBox).not.toBeNull();
    expect(splitBox!.height).toBeGreaterThanOrEqual(180);
    await expectNoHorizontalOverflow(page);
    await scrollContextPanelToBottom(page);
    await expectClearsMobileChrome(
      page,
      page.getByTestId("memory-save-btn"),
      844,
    );
    expect(await axe()).toEqual([]);
  } finally {
    await page.request.put("/api/memory/documents", {
      data: { repo: "", name: longSlug, summary: "", text: "" },
    });
  }
});
