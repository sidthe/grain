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

test(
  "renders live demo shared-fault runIds cleanly across desktop, phone, and dark mode",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe, pageErrors }, testInfo) => {
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    await page.goto("ci");
    await expect(page.locator("html")).toHaveAttribute("data-theme", wantTheme);

    const banner = page.getByTestId("ci-faults-banner");
    await expect(banner).toBeVisible();
    const faultLinks = banner.locator('[data-testid^="ci-fault-run-link-"]');
    expect(await faultLinks.count()).toBeGreaterThan(0);

    const vp = page.viewportSize()!;
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(
      overflow,
      "no horizontal overflow on demo /next/ci",
    ).toBeLessThanOrEqual(0);

    const firstLink = faultLinks.first();
    const box = await firstLink.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);

    // Pre-existing <ul class="ci-run-list"><li role="button"> triggers axe's "list" rule
    // on any populated CI run list; our new fault/artifact lists use plain semantic <li>s.
    expect(await axe({ disableRules: ["list"] })).toEqual([]);
    expect(pageErrors).toEqual([]);
  },
);

test(
  "inspects shared-fault runIds, toggles inline fault artifact inspection with pagination, and shows job + detail artifacts",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe, pageErrors }, testInfo) => {
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    const runs = [
      {
        id: "run-fault-401",
        provider: "grain",
        repo: "acme/widgets",
        ref: "refs/heads/grain/task-101",
        commit: "aaa111122223333",
        event: "push",
        requestedBy: "101",
        status: "completed",
        conclusion: "errored",
        error: "sandbox boot failed: granule image pull timeout",
        startedAt: "2026-11-12T00:00:00Z",
        finishedAt: "2026-11-12T00:01:15Z",
        jobs: [
          {
            jobId: "test",
            name: "Unit tests",
            workflow: "CI",
            conclusion: "errored",
            error: "sandbox boot failed",
            steps: [],
          },
        ],
      },
      {
        id: "run-fault-402",
        provider: "grain",
        repo: "acme/widgets",
        ref: "refs/heads/grain/task-109",
        commit: "bbb222233334444",
        event: "push",
        requestedBy: "109",
        status: "completed",
        conclusion: "errored",
        error: "sandbox boot failed: granule image pull timeout",
        startedAt: "2026-11-12T00:02:00Z",
        finishedAt: "2026-11-12T00:03:15Z",
        jobs: [
          {
            jobId: "test",
            name: "Unit tests",
            workflow: "CI",
            conclusion: "errored",
            artifacts: [
              {
                run: "run-fault-402",
                job: "",
                name: "evicted-heap.prof",
                stored: false,
                bytes: 8192,
                note: "evicted after 7d",
              },
            ],
            steps: [
              {
                name: "Boot sandbox",
                conclusion: "errored",
                exitCode: 1,
                output:
                  "pulling granule image...\nHTTP 503 Service Unavailable",
              },
            ],
          },
        ],
      },
      {
        id: "gha:acme:widgets:9001",
        provider: "github-actions",
        repo: "acme/widgets",
        ref: "refs/heads/main",
        commit: "ccc333344445555",
        status: "completed",
        conclusion: "failure",
        actions: {
          runId: 9001,
          workflowName: "GitHub E2E",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/acme/widgets/actions/runs/9001",
        },
        jobs: [
          {
            jobId: "e2e",
            name: "Playwright E2E",
            conclusion: "failure",
            steps: [{ name: "npx playwright test", conclusion: "failure" }],
          },
        ],
      },
    ];

    const faults = [
      {
        source: "grain",
        digest: "fault-granule-registry",
        repo: "acme/widgets",
        jobId: "test",
        jobName: "Unit tests",
        step: "Boot sandbox",
        kind: "errored",
        paths: ["deploy/helm/values.yaml", "pkg/sandbox/boot.go"],
        runCount: 2,
        refCount: 2,
        ownerTaskId: "88",
        ownerRef: "grain/fix-88",
        fixes: [
          {
            pullRequest: "acme/widgets#42",
            title: "Retry granule registry pulls",
            files: ["pkg/sandbox/boot.go"],
          },
        ],
        runs: [
          {
            runId: "run-fault-401",
            ref: "grain/task-101",
            commit: "aaa111122223333",
            taskId: "101",
          },
          {
            runId: "run-fault-402",
            ref: "grain/task-109",
            commit: "bbb222233334444",
            taskId: "109",
          },
        ],
        refs: ["grain/task-101", "grain/task-109"],
      },
    ];

    const artifactCalls: string[] = [];

    await page.route("**/api/ci/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });

      if (path === "/api/ci/runs") {
        const prov = url.searchParams.get("provider");
        const list =
          prov === "github-actions"
            ? runs.filter((r) => r.provider === "github-actions")
            : runs.filter((r) => r.provider === "grain");
        return json({
          enabled: true,
          runs: list,
          total: list.length,
          faults,
        });
      }
      if (path === "/api/ci/faults") {
        return json({ enabled: true, faults, total: faults.length });
      }
      if (path === "/api/ci/runs/run-fault-401/artifacts") {
        const cursor = url.searchParams.get("cursor") || "";
        artifactCalls.push(`${path}?cursor=${cursor}`);
        if (cursor === "page-2") {
          return json({
            enabled: true,
            available: true,
            total: 2,
            artifacts: [
              {
                run: "run-fault-401",
                job: "test",
                name: "expired-core.dmp",
                stored: false,
                bytes: 512,
                note: "expired under 7d retention",
              },
            ],
          });
        }
        return json({
          enabled: true,
          available: true,
          total: 2,
          truncated: true,
          nextCursor: "page-2",
          artifacts: [
            {
              run: "run-fault-401",
              job: "test",
              name: "boot-log.txt",
              stored: true,
              bytes: 4096,
            },
          ],
        });
      }
      if (path === "/api/ci/runs/run-fault-402/artifacts") {
        artifactCalls.push(path);
        return json({
          enabled: true,
          available: true,
          total: 1,
          artifacts: [
            {
              run: "run-fault-402",
              job: "test",
              name: "coverage-report.tgz",
              stored: true,
              bytes: 24576,
            },
          ],
        });
      }
      if (path.endsWith("/artifacts")) {
        artifactCalls.push(path);
        return json({
          enabled: true,
          available: true,
          artifacts: [],
          total: 0,
        });
      }
      const runMatch = path.match(/^\/api\/ci\/runs\/([^/]+)$/);
      if (runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        const found = runs.find((r) => r.id === id);
        if (found) return json(found);
      }
      return route.continue();
    });

    await page.goto("ci");
    await expect(page.locator("html")).toHaveAttribute("data-theme", wantTheme);

    const card = page.getByTestId("ci-fault-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("ci-fault-source-grain")).toContainText(
      "Grain CI",
    );
    await expect(card.getByTestId("ci-fault-paths")).toContainText(
      "pkg/sandbox/boot.go",
    );
    await expect(card.getByTestId("ci-fault-owner")).toContainText(
      "grain/fix-88",
    );

    const run1Link = card.getByTestId("ci-fault-run-link-run-fault-401");
    const run2Link = card.getByTestId("ci-fault-run-link-run-fault-402");
    await expect(run1Link).toHaveText("run-fault-401");
    await expect(run2Link).toHaveText("run-fault-402");

    // Layout check: fault card and runId links fit inside viewport with zero overflow.
    const vp = page.viewportSize()!;
    const cardBox = await card.boundingBox();
    const run2Box = await run2Link.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(run2Box).not.toBeNull();
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(vp.width);
    expect(run2Box!.x + run2Box!.width).toBeLessThanOrEqual(vp.width);

    // Inline fault artifact toggle: fetches GET /api/ci/runs/run-fault-401/artifacts & paginates.
    const artBtn = card.getByTestId("ci-fault-run-artifacts-btn-run-fault-401");
    await expect(artBtn).toHaveAttribute("aria-expanded", "false");
    await artBtn.click();
    await expect(artBtn).toHaveAttribute("aria-expanded", "true");

    const artPanel = card.getByTestId("ci-fault-run-artifacts-run-fault-401");
    await expect(artPanel).toBeVisible();
    const inlineDl = artPanel.getByTestId(
      "ci-fault-artifact-download-run-fault-401-boot-log.txt",
    );
    await expect(inlineDl).toHaveAttribute(
      "href",
      "/api/ci/runs/run-fault-401/artifacts/test/boot-log.txt",
    );

    await artPanel.getByRole("button", { name: /Load more/ }).click();
    await expect(artPanel).toContainText("expired-core.dmp");
    await expect(artPanel).toContainText("expired under 7d retention");
    expect(artifactCalls).toContain(
      "/api/ci/runs/run-fault-401/artifacts?cursor=",
    );
    expect(artifactCalls).toContain(
      "/api/ci/runs/run-fault-401/artifacts?cursor=page-2",
    );

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      "no sideways overflow after expanding inline fault artifacts",
    ).toBeLessThanOrEqual(0);
    expect(await axe({ disableRules: ["list"] })).toEqual([]);

    // Navigate via exact shared-fault runId link to run-fault-402.
    await run2Link.click();
    await expect(page).toHaveURL(/\/next\/ci\/runs\/run-fault-402/);

    const detailRunId = page.getByTestId("ci-detail-run-id");
    await expect(detailRunId).toContainText("run-fault-402");
    await expect(page.getByTestId("ci-errored-callout-runs")).toContainText(
      "run-fault-401",
    );

    // Inline job-level artifacts render above steps inside expanded failing job.
    const jobArts = page.getByTestId("ci-job-artifacts");
    await expect(jobArts).toBeVisible();
    await expect(jobArts).toContainText("coverage-report.tgz");
    await expect(jobArts).toContainText("evicted-heap.prof");
    await expect(
      jobArts.getByTestId("ci-job-artifact-download"),
    ).toHaveAttribute(
      "href",
      "/api/ci/runs/run-fault-402/artifacts/test/coverage-report.tgz",
    );

    // Detail Artifacts section honors stored downloads and unstored notes.
    const artSection = page.getByTestId("ci-artifacts-section");
    await expect(artSection).toContainText("coverage-report.tgz");
    await expect(artSection).toContainText("evicted-heap.prof");
    await expect(
      artSection.getByTestId("ci-artifact-download"),
    ).toHaveAttribute(
      "href",
      "/api/ci/runs/run-fault-402/artifacts/test/coverage-report.tgz",
    );

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      "no sideways overflow in run inspector",
    ).toBeLessThanOrEqual(0);
    expect(await axe({ disableRules: ["list"] })).toEqual([]);
    expect(pageErrors).toEqual([]);
  },
);
