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

import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ demoArgs: ["-fake-ci", "-github-sim"] });

async function ok<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  what: string,
): Promise<T> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test("appends provider=github-actions across CI filters, deep links, Back/Forward, and Task Changes links", async ({
  page,
  pageErrors,
}) => {
  const prevMode = await ok<{ ciMode?: string }>(
    await page.request.get("/api/repos/acme/widgets/ci-mode"),
    "read ci-mode",
  );
  let grainRunId = "";
  const simRunId = 9401;
  const ghaId = `gha:acme:widgets:${simRunId}`;

  try {
    await ok(
      await page.request.put("/api/repos/acme/widgets/ci-mode", {
        data: { ciMode: "grain" },
      }),
      "set grain ci-mode",
    );
    const grainRun = await ok<{ id: string }>(
      await page.request.post("/api/ci/runs", {
        data: { repo: "acme/widgets", ref: "main", commit: "abc1234" },
      }),
      "start fake grain ci run",
    );
    grainRunId = grainRun.id;

    // Switch acme/widgets to ci_mode="github" so pkg/ui/ci_actions.go permits
    // listing GitHub Actions runs while the previously started Grain run remains readable.
    await ok(
      await page.request.put("/api/repos/acme/widgets/ci-mode", {
        data: { ciMode: "github" },
      }),
      "set github ci-mode",
    );

    await ok(
      await page.request.post(
        "/api/e2e/github-sim/repos/acme/widgets/actions/runs",
        {
          data: {
            id: simRunId,
            name: "Actions E2E",
            path: ".github/workflows/e2e.yml",
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "failure",
            jobs: [
              {
                name: "playwright",
                conclusion: "failure",
                failing_step: "Run tests",
                log: "2026-11-14T00:00:00.0000000Z FAIL e2e check\n",
              },
            ],
          },
        },
      ),
      "seed simulated GitHub Actions run",
    );

    const runApiQueries: URLSearchParams[] = [];
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (req.method() === "GET" && u.pathname === "/api/ci/runs") {
        runApiQueries.push(u.searchParams);
      }
    });

    await page.goto("ci");
    await expect(page.getByTestId(`ci-run-row-${grainRunId}`)).toBeVisible();

    // Filtering by GitHub Actions appends ?provider=github-actions and queries the backend with it.
    await page.getByTestId("ci-provider-github").click();
    await expect(page).toHaveURL(/\/next\/ci\?provider=github-actions$/);
    await expect(page.getByTestId("ci-provider-github")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId(`ci-run-row-${ghaId}`)).toBeVisible();
    expect(
      runApiQueries.some(
        (qp) =>
          qp.get("provider") === "github-actions" &&
          qp.get("repo") === "acme/widgets",
      ),
    ).toBe(true);

    // Reloading on /next/ci?provider=github-actions preserves filter and displays GitHub Actions runs.
    runApiQueries.length = 0;
    await page.reload();
    await expect(page.getByTestId("ci-provider-github")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId(`ci-run-row-${ghaId}`)).toBeVisible();
    expect(
      runApiQueries.some(
        (qp) =>
          qp.get("provider") === "github-actions" &&
          qp.get("repo") === "acme/widgets",
      ),
    ).toBe(true);

    // Selecting a repo retains provider=github-actions alongside repo=...
    await page.getByTestId("ci-repo-pill").click();
    await page
      .getByTestId("ci-repo-menu")
      .getByRole("option", { name: "acme/widgets" })
      .click();
    await expect(page).toHaveURL(
      /\/next\/ci\?.*provider=github-actions.*repo=acme%2Fwidgets|\/next\/ci\?.*repo=acme%2Fwidgets.*provider=github-actions/,
    );

    // Browser Back returns to /next/ci?provider=github-actions and then /next/ci cleanly.
    await page.goBack();
    await expect(page).toHaveURL(/\/next\/ci\?provider=github-actions$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/next\/ci$/);
    await expect(page.getByTestId("ci-provider-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.goForward();
    await expect(page).toHaveURL(/\/next\/ci\?provider=github-actions$/);
    await expect(page.getByTestId("ci-provider-github")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Navigating between runs while on /next/ci/runs/:id appends provider=github-actions for GitHub runs.
    await page.goto(`ci/runs/${grainRunId}?repo=acme%2Fwidgets`);
    await expect(page.getByTestId(`ci-run-row-${ghaId}`)).toBeVisible();
    await page.getByTestId(`ci-run-row-${ghaId}`).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/next/ci/runs/${ghaId.replace(/:/g, ":")}\\?.*provider=github-actions`,
      ),
    );
    await expect(page.getByTestId("ci-detail-status")).toContainText("Failed");

    // Task Changes tab fetches GitHub Actions runs with provider=github-actions and links with ?provider=github-actions.
    const tasks = await ok<
      Array<{ id: string; repo?: string; branch?: string }>
    >(await page.request.get("/api/tasks"), "list tasks");
    const taskWithBranch = tasks.find(
      (t) => t.repo === "acme/widgets" && Boolean(t.branch),
    );
    expect(
      taskWithBranch,
      "demo seeds an acme/widgets task with branch",
    ).toBeTruthy();

    const branchRunId = 9402;
    const branchGhaId = `gha:acme:widgets:${branchRunId}`;
    await ok(
      await page.request.put("/api/repos/acme/widgets/ci-mode", {
        data: { ciMode: "github" },
      }),
      "set github ci-mode",
    );
    await ok(
      await page.request.post(
        "/api/e2e/github-sim/repos/acme/widgets/actions/runs",
        {
          data: {
            id: branchRunId,
            name: "PR Checks",
            path: ".github/workflows/pr.yml",
            head_branch: taskWithBranch!.branch,
            event: "pull_request",
            status: "completed",
            conclusion: "success",
          },
        },
      ),
      "seed branch-matched GitHub Actions run",
    );

    runApiQueries.length = 0;
    await page.goto(`tasks/${taskWithBranch!.id}?tab=changes`);
    const runLink = page.getByTestId(`ci-run-link-${branchGhaId}`);
    await expect(runLink).toBeVisible();
    await expect(runLink).toHaveAttribute(
      "href",
      `/next/ci/runs/${branchGhaId}?provider=github-actions`,
    );
    expect(
      runApiQueries.some(
        (qp) =>
          qp.get("repo") === "acme/widgets" &&
          qp.get("provider") === "github-actions",
      ),
    ).toBe(true);

    await runLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/next/ci/runs/${branchGhaId}\\?provider=github-actions$`),
    );
    await expect(page.getByTestId("ci-provider-github")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(pageErrors).toEqual([]);
  } finally {
    if (grainRunId) {
      await page.request
        .delete(`/api/ci/runs/${grainRunId}`)
        .catch(() => undefined);
    }
    await page.request
      .put("/api/repos/acme/widgets/ci-mode", {
        data: { ciMode: prevMode?.ciMode ?? "" },
      })
      .catch(() => undefined);
  }
});

test(
  "provider filter bar, deep-linked GitHub Actions view, and mobile back preserve layout and zero axe violations",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe, pageErrors }, testInfo) => {
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    await ok(
      await page.request.post(
        "/api/e2e/github-sim/repos/acme/widgets/actions/runs",
        {
          data: {
            id: 9403,
            name: "Release Gate",
            path: ".github/workflows/release-gate.yml",
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        },
      ),
      "seed Actions run for layout check",
    );

    const ghaId = "gha:acme:widgets:9403";
    await page.goto(`ci/runs/${ghaId}?provider=github-actions`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", wantTheme);
    await expect(page.getByTestId("ci-provider-github")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const vp = page.viewportSize()!;
    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(sideways, "no sideways overflow").toBeLessThanOrEqual(0);

    // Check provider strip button bounds & alignment
    const allBtn = await page.getByTestId("ci-provider-all").boundingBox();
    const grainBtn = await page.getByTestId("ci-provider-grain").boundingBox();
    const ghBtn = await page.getByTestId("ci-provider-github").boundingBox();
    expect(allBtn).not.toBeNull();
    expect(grainBtn).not.toBeNull();
    expect(ghBtn).not.toBeNull();
    for (const box of [allBtn!, grainBtn!, ghBtn!]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    }
    if (vp.width >= 600) {
      expect(Math.abs(allBtn!.y - ghBtn!.y)).toBeLessThan(2);
      expect(grainBtn!.x).toBeGreaterThanOrEqual(allBtn!.x + allBtn!.width - 1);
      expect(ghBtn!.x).toBeGreaterThanOrEqual(
        grainBtn!.x + grainBtn!.width - 1,
      );
    } else {
      // On phone, < All runs back button returns to /next/ci while preserving ?provider=github-actions.
      const backBtn = page.locator(".ci-mobile-back");
      await expect(backBtn).toBeVisible();
      await backBtn.click();
      await expect(page).toHaveURL(/\/next\/ci\?provider=github-actions$/);
      const listSideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(
        listSideways,
        "no sideways overflow on mobile list",
      ).toBeLessThanOrEqual(0);
    }

    // Pre-existing <ul class="ci-run-list"><li role="button"> triggers axe's "list" rule
    // on any populated CI run list (unrelated to query-param serialization).
    expect(await axe({ disableRules: ["list"] })).toEqual([]);
    expect(pageErrors).toEqual([]);
  },
);
