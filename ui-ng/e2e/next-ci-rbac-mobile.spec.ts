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

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ demoArgs: ["-fake-ci"] });

const VIEWER_ACCESS = {
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
  ],
  repoLimits: {},
};

async function mockConfigAccess(
  page: Page,
  access: Record<string, unknown>,
): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json["access"] = access;
    await route.fulfill({ response: resp, json });
  });
}

test(
  "hides all ci:write and mutable CI action buttons for grain/viewer across desktop, phone, and dark mode",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe, pageErrors }, testInfo) => {
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    await mockConfigAccess(page, VIEWER_ACCESS);

    const sampleRuns = [
      {
        id: "run-active-viewer-1",
        provider: "grain",
        repo: "acme/widgets",
        ref: "refs/heads/grain/task-101",
        commit: "aaa111122223333",
        status: "running",
        startedAt: "2026-11-14T00:00:00Z",
        jobs: [],
      },
      {
        id: "run-failed-viewer-2",
        provider: "grain",
        repo: "acme/widgets",
        ref: "refs/heads/grain/task-102",
        commit: "bbb222233334444",
        status: "completed",
        conclusion: "failure",
        startedAt: "2026-11-14T00:01:00Z",
        finishedAt: "2026-11-14T00:03:00Z",
        jobs: [
          {
            jobId: "unit",
            name: "Unit tests",
            conclusion: "failure",
            failureSummary: { failedTests: ["TestViewerGating"] },
            steps: [],
          },
        ],
      },
    ];
    await page.route(/\/api\/ci\/runs(\?.*)?$/, (route) =>
      route.fulfill({
        json: { enabled: true, runs: sampleRuns, faults: [] },
      }),
    );
    await page.route(/\/api\/ci\/runs\/[^/]+$/, (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop();
      const found = sampleRuns.find((r) => r.id === id) ?? sampleRuns[0];
      return route.fulfill({ json: found });
    });
    await page.route(/\/api\/ci\/runs\/[^/]+\/artifacts/, (route) =>
      route.fulfill({
        json: { enabled: true, available: false, artifacts: [] },
      }),
    );
    await page.route("**/api/ci/faults", (route) =>
      route.fulfill({ json: { enabled: true, faults: [], total: 0 } }),
    );

    await page.goto("ci/runs/run-active-viewer-1");
    await expect(page.locator("html")).toHaveAttribute("data-theme", wantTheme);
    await expect(page.getByTestId("ci-headline")).toBeVisible();
    await expect(page.getByTestId("ci-detail-title")).toBeVisible();

    // Header and inspector mutable buttons must be completely absent (not merely disabled).
    await expect(page.getByTestId("ci-open-run-dialog")).toHaveCount(0);
    await expect(page.getByTestId("ci-caches-menu-btn")).toHaveCount(0);
    await expect(page.getByTestId("ci-cancel-run-btn")).toHaveCount(0);
    await expect(page.getByTestId("ci-rerun-btn")).toHaveCount(0);
    await expect(page.getByTestId("ci-rerun-failed-btn")).toHaveCount(0);
    await expect(page.getByTestId("ci-open-quarantine-btn")).toHaveCount(0);

    // Failed run must also hide Re-run all, Re-run failed, and Quarantine test.
    await page.goto("ci/runs/run-failed-viewer-2");
    await expect(page.getByTestId("ci-failed-callout")).toBeVisible();
    await expect(page.getByTestId("ci-rerun-btn")).toHaveCount(0);
    await expect(page.getByTestId("ci-rerun-failed-btn")).toHaveCount(0);
    await expect(page.getByTestId("ci-open-quarantine-btn")).toHaveCount(0);

    // Read-only filters remain accessible.
    await page.goto("ci");
    await expect(page.getByTestId("ci-filter-failed")).toBeVisible();
    await page.getByTestId("ci-filter-failed").click();
    await expect(
      page.getByTestId("ci-run-row-run-failed-viewer-2"),
    ).toBeVisible();

    expect(await axe({ disableRules: ["list"] })).toEqual([]);
    expect(pageErrors).toEqual([]);
  },
);

test("hides ci:write inspector buttons on unauthorized repositories when ci:write is repo-scoped", async ({
  page,
  pageErrors,
}) => {
  await mockConfigAccess(page, {
    role: "grain/repo-ci",
    roles: ["grain/repo-ci"],
    full: false,
    scopes: ["ci:read", "ci:write"],
    repoLimits: { "ci:write": ["acme/infra"] },
  });

  const runs = [
    {
      id: "run-infra-1",
      provider: "grain",
      repo: "acme/infra",
      ref: "refs/heads/main",
      status: "running",
      startedAt: "2026-11-14T00:00:00Z",
      jobs: [],
    },
    {
      id: "run-widgets-2",
      provider: "grain",
      repo: "acme/widgets",
      ref: "refs/heads/main",
      status: "completed",
      conclusion: "failure",
      startedAt: "2026-11-14T00:01:00Z",
      finishedAt: "2026-11-14T00:02:00Z",
      jobs: [],
    },
  ];
  await page.route(/\/api\/ci\/runs(\?.*)?$/, (route) =>
    route.fulfill({ json: { enabled: true, runs, faults: [] } }),
  );
  await page.route(/\/api\/ci\/runs\/[^/]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ json: runs.find((r) => r.id === id) ?? runs[0] });
  });
  await page.route(/\/api\/ci\/runs\/[^/]+\/artifacts/, (route) =>
    route.fulfill({ json: { enabled: true, available: false, artifacts: [] } }),
  );
  await page.route("**/api/ci/faults", (route) =>
    route.fulfill({ json: { enabled: true, faults: [], total: 0 } }),
  );

  // Authorized repo (acme/infra): Cancel run and Re-run all are visible & enabled.
  await page.goto("ci/runs/run-infra-1");
  await expect(page.getByTestId("ci-cancel-run-btn")).toBeEnabled();
  await expect(page.getByTestId("ci-rerun-btn")).toBeEnabled();
  await expect(page.getByTestId("ci-open-quarantine-btn")).toHaveCount(0);

  // Unauthorized repo (acme/widgets): Cancel run, Re-run all, Re-run failed are hidden.
  await page.getByTestId("ci-run-row-run-widgets-2").click();
  await expect(page.getByTestId("ci-failed-callout")).toBeVisible();
  await expect(page.getByTestId("ci-cancel-run-btn")).toHaveCount(0);
  await expect(page.getByTestId("ci-rerun-btn")).toHaveCount(0);
  await expect(page.getByTestId("ci-rerun-failed-btn")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test(
  "wraps CI runs filter strip, scope pills, dropdown menus, and dialog test chips cleanly at 390px without horizontal overflow",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe, pageErrors }, testInfo) => {
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    const longRepo =
      "ai_on_gke/grain_enterprise_platform_long_repository_name_without_breaks";
    const longBranch =
      "grain_ee5afe06_task_429_g_15_ci_write_viewer_gating_very_long_branch_name";
    const longRun = {
      id: "run-mobile-filter-1",
      provider: "grain",
      repo: longRepo,
      ref: `refs/heads/${longBranch}`,
      status: "completed",
      conclusion: "failure",
      startedAt: "2026-11-14T00:00:00Z",
      finishedAt: "2026-11-14T00:04:00Z",
      jobs: [
        {
          jobId: "e2e",
          name: "Playwright E2E",
          conclusion: "failure",
          failureSummary: {
            failedTests: [
              "TestVeryLongMobileViewportOverflowRegressionSuite/SubtestWithLongUnbrokenIdentifier",
            ],
          },
          steps: [],
        },
      ],
    };
    await page.route(/\/api\/ci\/runs(\?.*)?$/, (route) =>
      route.fulfill({ json: { enabled: true, runs: [longRun], faults: [] } }),
    );
    await page.route(/\/api\/ci\/runs\/[^/]+$/, (route) =>
      route.fulfill({ json: longRun }),
    );
    await page.route(/\/api\/ci\/runs\/[^/]+\/artifacts/, (route) =>
      route.fulfill({
        json: { enabled: true, available: false, artifacts: [] },
      }),
    );
    await page.route("**/api/ci/faults", (route) =>
      route.fulfill({ json: { enabled: true, faults: [], total: 0 } }),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `ci?repo=${encodeURIComponent(longRepo)}&branch=${encodeURIComponent(longBranch)}`,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", wantTheme);
    await expect(page.getByTestId("ci-branch-pill")).toBeVisible();

    const assertNoOverflowAndBoundedFilters = async (vpWidth: number) => {
      const docOverflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(
        docOverflow,
        "document must not scroll sideways",
      ).toBeLessThanOrEqual(0);

      const headerBox = await page.locator(".stage-header").boundingBox();
      expect(headerBox).not.toBeNull();
      expect(headerBox!.x).toBeGreaterThanOrEqual(0);
      expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(
        vpWidth + 0.5,
      );

      // Filter strip chips wrap onto multiple rows cleanly inside stage-header.
      const chips = page.locator(".stage-header .filter-strip .filter-chip");
      const chipCount = await chips.count();
      expect(chipCount).toBe(6);
      const chipYs: number[] = [];
      for (let i = 0; i < chipCount; i++) {
        const b = await chips.nth(i).boundingBox();
        expect(b).not.toBeNull();
        expect(b!.x).toBeGreaterThanOrEqual(headerBox!.x - 0.5);
        expect(b!.x + b!.width).toBeLessThanOrEqual(
          headerBox!.x + headerBox!.width + 0.5,
        );
        chipYs.push(Math.round(b!.y));
      }
      expect(Math.max(...chipYs)).toBeGreaterThan(Math.min(...chipYs));

      // Scope toolbar controls wrap and truncate within stage-header.
      for (const sel of [
        '[data-testid="ci-repo-pill"]',
        '[data-testid="ci-branch-pill"]',
        ".ci-toolbar .segmented",
      ]) {
        const b = await page.locator(sel).boundingBox();
        expect(b, sel).not.toBeNull();
        expect(b!.x).toBeGreaterThanOrEqual(headerBox!.x - 0.5);
        expect(b!.x + b!.width).toBeLessThanOrEqual(
          headerBox!.x + headerBox!.width + 0.5,
        );
        expect(b!.x + b!.width).toBeLessThanOrEqual(vpWidth + 0.5);
      }
      const noElementOverflow = await page.evaluate(() => {
        const problems: string[] = [];
        for (const el of document.querySelectorAll(
          ".stage-header, .filter-strip, .ci-toolbar, .ci-toolbar .pill-trigger, .ci-toolbar .segmented",
        )) {
          if (el.scrollWidth > el.clientWidth + 1) {
            problems.push(
              `${el.className}: scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`,
            );
          }
        }
        return problems;
      });
      expect(noElementOverflow).toEqual([]);
    };

    await assertNoOverflowAndBoundedFilters(390);

    // Open branch menu on 390px and confirm menu stays inside viewport bounds.
    await page.getByTestId("ci-branch-pill").click();
    const branchMenu = page.getByTestId("ci-branch-menu");
    await expect(branchMenu).toBeVisible();
    const menuBox = await branchMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390.5);
    await page.keyboard.press("Escape");

    // Also verify at 320px minimum mobile width.
    await page.setViewportSize({ width: 320, height: 568 });
    await assertNoOverflowAndBoundedFilters(320);

    // Back to 390px, open run detail + Quarantine dialog and verify long test chip wraps inside dialog.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("ci-run-row-run-mobile-filter-1").click();
    await page.getByTestId("ci-open-quarantine-btn").click();
    const qDialog = page.getByTestId("ci-quarantine-dialog");
    await expect(qDialog).toBeVisible();
    const qDlgBox = await qDialog.boundingBox();
    const qChipBox = await qDialog
      .locator(".filter-chip")
      .first()
      .boundingBox();
    expect(qDlgBox).not.toBeNull();
    expect(qChipBox).not.toBeNull();
    expect(qChipBox!.x).toBeGreaterThanOrEqual(qDlgBox!.x - 0.5);
    expect(qChipBox!.x + qChipBox!.width).toBeLessThanOrEqual(
      qDlgBox!.x + qDlgBox!.width + 0.5,
    );
    expect(qChipBox!.x + qChipBox!.width).toBeLessThanOrEqual(390.5);
    await page.keyboard.press("Escape");

    expect(await axe({ disableRules: ["list"] })).toEqual([]);
    expect(pageErrors).toEqual([]);
  },
);
