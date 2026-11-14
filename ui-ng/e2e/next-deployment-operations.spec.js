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

// What the 2026-11-13 deployment-operations walkthrough found under /next/
// (docs/test-runs/2026-11-13-deployment-operations.md): the classic UI's
// System addresses fell through to the Inbox, Fleet's tabs were not in
// history, the build stamp led nowhere, Restart daemon reported a refused
// restart as under way, and a non-JSON error answer surfaced as a JSON
// parser message.

test("classic System addresses land on the matching /next/ page", async ({
  page,
}) => {
  const cases = [
    ["system/health", "/next/fleet"],
    ["system/sandboxes", "/next/fleet"],
    ["system/top", "/next/fleet"],
    ["system/logs", "/next/fleet?tab=logs"],
    ["system/pipeline", "/next/fleet?tab=controls"],
    ["system/power", "/next/fleet?tab=controls"],
    ["system/caches", "/next/settings/caches"],
    ["system/upgrade", "/next/settings/upgrade"],
    [
      "system/metrics?repo=acme%2Fwidgets",
      "/next/telemetry?repo=acme%2Fwidgets",
    ],
    ["admin/logs", "/next/fleet?tab=logs"],
    ["sandboxes", "/next/fleet"],
    ["caches", "/next/settings/caches"],
    [
      "metrics?repo=acme%2Fwidgets&window=30d",
      "/next/telemetry?repo=acme%2Fwidgets&window=30d",
    ],
  ];
  for (const [from, to] of cases) {
    await page.goto(from);
    await expect
      .poll(
        () => {
          const u = new URL(page.url());
          return u.pathname + u.search;
        },
        { message: from },
      )
      .toBe(to);
  }
  await expect(page.locator("#fleet-panel-logs")).toHaveCount(0);
  await page.goto("system/logs");
  await expect(page.locator("#fleet-panel-logs")).toBeVisible();
});

test("Fleet tabs are history entries: Back and Forward switch them", async ({
  page,
}) => {
  await page.goto("fleet");
  await expect(page.locator("#fleet-panel-sandboxes")).toBeVisible();
  await expect(page.getByTestId("fleet-tab-hostds")).toHaveText(/^\s*Hosts/);
  await page.getByTestId("fleet-tab-hostds").click();
  await expect(page.locator("#fleet-panel-hostds")).toBeVisible();
  await page.getByTestId("fleet-tab-logs").click();
  await expect(page).toHaveURL(/\/next\/fleet\?tab=logs$/);
  await expect(page.locator("#fleet-panel-logs")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/next\/fleet\?tab=hostds$/);
  await expect(page.locator("#fleet-panel-hostds")).toBeVisible();
  await expect(page.getByTestId("fleet-tab-hostds")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goBack();
  await expect(page).toHaveURL(/\/next\/fleet$/);
  await expect(page.locator("#fleet-panel-sandboxes")).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(page.locator("#fleet-panel-logs")).toBeVisible();
  await expect(page.getByTestId("logs-viewer")).toBeVisible();

  await page.reload();
  await expect(page.locator("#fleet-panel-logs")).toBeVisible();
});

test("the build stamp opens Settings -> Upgrade", async ({ page }) => {
  await page.goto("inbox");
  const stamp = page.getByTestId("build-stamp");
  await expect(stamp).toContainText(/grain \S+/);
  await stamp.click();
  await expect(page).toHaveURL(/\/next\/settings\/upgrade$/);
});

test("Restart daemon is off where restart is not enabled, and a refused restart says so", async ({
  page,
}) => {
  const posts = [];
  await page.route("**/api/host/restart", (route) => {
    posts.push(route.request().method());
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "sudo: a password is required" }),
    });
  });

  // The demo starts without a restart command (restartEnabled: false).
  await page.goto("fleet?tab=controls");
  await expect(page.getByTestId("daemon-restart-btn")).toBeDisabled();

  // Where it is enabled, a refusal is reported and nothing is restarting.
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: { ...body, restartEnabled: true },
    });
  });
  await page.reload();
  const restart = page.getByTestId("daemon-restart-btn");
  await expect(restart).toBeEnabled();
  await restart.click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Restart grain daemon?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(posts).toEqual([]);

  await restart.click();
  await dialog.getByRole("button", { name: "Restart daemon" }).click();
  await expect(
    page.getByText("Restart failed: sudo: a password is required"),
  ).toBeVisible();
  await expect(page.getByText("Restart requested.")).toHaveCount(0);
  await expect(page.getByTestId("fleet-daemon-card")).not.toContainText(
    "Restarting",
  );
  expect(posts).toEqual(["POST"]);
});

test("a non-JSON error answer names its HTTP status", async ({ page }) => {
  test.info().annotations.push({ type: "allows-page-error" });
  await page.route("**/api/metrics?**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<html><body>Bad Gateway</body></html>",
    }),
  );
  await page.goto("telemetry");
  const err = page.getByTestId("telemetry-error");
  await expect(err).toContainText("The server answered 502");
  await expect(err).not.toContainText("Unexpected token");
});

// The demo runs no grain CI, so the runs are stubbed at /api/ci/runs; the
// page, its router and the user's clicks are real.
test("Re-run failed follows to the run it starts", async ({ page }) => {
  const at = new Date(Date.now() - 3600e3).toISOString();
  let runs = [
    {
      id: "ci-fail-1",
      provider: "grain",
      repo: "acme/widgets",
      branch: "feature/audit-log",
      workflow: "tests",
      taskId: "6",
      status: "completed",
      conclusion: "failure",
      startedAt: at,
      finishedAt: at,
      jobs: [
        { jobId: "go", name: "go", conclusion: "success", status: "completed" },
        {
          jobId: "e2e",
          name: "e2e",
          conclusion: "failure",
          status: "completed",
        },
      ],
    },
  ];
  const posted = [];
  await page.route(/\/api\/ci\/runs(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      runs = [
        {
          id: "ci-rerun-2",
          provider: "grain",
          repo: "acme/widgets",
          branch: "feature/audit-log",
          workflow: "tests",
          taskId: "6",
          status: "queued",
          startedAt: new Date().toISOString(),
          jobs: [],
        },
        ...runs,
      ];
      return route.fulfill({ status: 201, json: { id: "ci-rerun-2" } });
    }
    return route.fulfill({
      json: { enabled: true, runs, matched: runs.length, stored: runs.length },
    });
  });
  await page.route(/\/api\/ci\/runs\/[^/?]+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const run = runs.find((r) => r.id === id);
    return run
      ? route.fulfill({ json: run })
      : route.fulfill({ status: 404, json: { error: `no CI run ${id}` } });
  });
  await page.route(/\/api\/ci\/runs\/[^/]+\/artifacts/, (route) =>
    route.fulfill({ json: { available: false, artifacts: [] } }),
  );

  await page.goto("ci/runs/ci-fail-1");
  await expect(page.getByTestId("ci-detail-status")).toContainText("Failed");
  await page.getByTestId("ci-rerun-failed-btn").click();
  await expect(page).toHaveURL(/\/next\/ci\/runs\/ci-rerun-2$/);
  await expect(page.getByTestId("ci-run-row-ci-rerun-2")).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(posted).toEqual([
    expect.objectContaining({
      taskId: "6",
      recheck: true,
      recheckFailed: true,
    }),
  ]);
});

test("Fleet persistent sandbox Logs button enforces deployment:read scope context", async ({
  page,
}) => {
  const logRequests = [];
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...body,
        access: {
          role: "repo-reader",
          roles: ["repo-reader"],
          full: false,
          scopes: ["sandboxes:read", "deployment:read"],
          repoLimits: { "deployment:read": ["acme/allowed"] },
        },
      },
    });
  });
  await page.route(/\/api\/persistent-sandboxes(\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          name: "sb-allowed",
          repo: "acme/allowed",
          ref: "main",
          command: "npm run preview",
          state: "running",
          enabled: true,
          restarts: 0,
        },
        {
          name: "sb-other",
          repo: "acme/other",
          ref: "main",
          command: "npm run preview",
          state: "running",
          enabled: true,
          restarts: 0,
        },
        {
          name: "sb-norepo",
          repo: "",
          ref: "",
          command: "npm run preview",
          state: "running",
          enabled: true,
          restarts: 0,
        },
      ],
    }),
  );
  await page.route(/\/api\/persistent-sandboxes\/[^/]+\/logs/, (route) => {
    logRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "> preview\n  Local: http://localhost:4281/\n",
    });
  });

  await page.goto("fleet");
  await expect(page.getByTestId("persistent-card-sb-allowed")).toBeVisible();

  const allowedBtn = page.getByTestId("persistent-logs-btn-sb-allowed");
  const otherBtn = page.getByTestId("persistent-logs-btn-sb-other");
  const noRepoBtn = page.getByTestId("persistent-logs-btn-sb-norepo");

  await expect(allowedBtn).toBeEnabled();
  await expect(otherBtn).toBeDisabled();
  await expect(noRepoBtn).toBeDisabled();

  await allowedBtn.click();
  const logWell = page.getByTestId("persistent-logs-sb-allowed");
  await expect(logWell).toContainText("Local: http://localhost:4281/");

  const cardBox = await page
    .getByTestId("persistent-card-sb-allowed")
    .boundingBox();
  const logBox = await logWell.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(logBox).not.toBeNull();
  expect(logBox.x).toBeGreaterThanOrEqual(cardBox.x);
  expect(logBox.x + logBox.width).toBeLessThanOrEqual(
    cardBox.x + cardBox.width + 1,
  );

  await expect
    .poll(() =>
      logRequests.some((u) =>
        u.endsWith("/api/persistent-sandboxes/sb-allowed/logs?format=text"),
      ),
    )
    .toBe(true);
  expect(logRequests).toHaveLength(1);
});

test(
  "Fleet Hosts gates enrollment codes and pending approvals on scope: null for non-operators",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }) => {
    const blockedRequests = [];
    page.on("request", (req) => {
      const p = new URL(req.url()).pathname;
      if (
        p.startsWith("/api/hostds/enrollment-codes") ||
        p.startsWith("/api/hostds/pending")
      ) {
        blockedRequests.push(`${req.method()} ${p}`);
      }
    });
    await page.route("**/api/config", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: {
          ...body,
          access: {
            role: "host-admin",
            roles: ["host-admin"],
            full: false,
            scopes: ["capabilities:read", "capabilities:admin"],
          },
        },
      });
    });

    await page.goto("fleet?tab=hostds");
    await expect(page.getByTestId("hostd-row-local")).toBeVisible();
    await expect(page.getByTestId("fleet-enrollment-denied")).toContainText(
      "grain/operator",
    );
    await expect(page.getByTestId("fleet-pending-denied")).toContainText(
      "grain/operator",
    );
    await expect(
      page.getByTestId("fleet-enrollment-settings-link"),
    ).toHaveCount(0);
    expect(blockedRequests).toEqual([]);

    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
    expect(await axe({ disableRules: ["color-contrast"] })).toEqual([]);
  },
);

test(
  "Fleet Hosts manages enrollment codes and renders pending approvals cleanly for operators",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }) => {
    await page.goto("fleet?tab=hostds");
    await expect(
      page.getByTestId("fleet-enrollment-settings-link"),
    ).toBeVisible();
    await expect(
      page.getByTestId("fleet-enrollment-row-default"),
    ).toBeVisible();

    const pendingCard = page.getByTestId("fleet-hostds-pending");
    await expect(pendingCard).toContainText("carol@example.com");
    await expect(pendingCard).toContainText("SHA256:");
    await expect(pendingCard).not.toContainText(/pairing code/i);

    const viewportWidth = page.viewportSize()?.width ?? 1440;
    for (const tid of [
      "fleet-hostds-enrollment",
      "fleet-hostds-pending",
      "fleet-enrollment-row-default",
    ]) {
      const box = await page.getByTestId(tid).boundingBox();
      expect(box, tid).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);
    }

    const nameInput = page.getByTestId("fleet-enrollment-name-input");
    const uniqueName = `e2e-fleet-${Date.now()}`;
    await nameInput.fill(uniqueName);
    await page.getByTestId("fleet-enrollment-create-btn").click();
    await expect(page.getByTestId("fleet-enrollment-secret")).toBeVisible();
    await expect(
      page.getByTestId(`fleet-enrollment-row-${uniqueName}`),
    ).toBeVisible();

    await page.getByTestId(`fleet-enrollment-rotate-${uniqueName}`).click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toContainText(`Rotate enrollment code ${uniqueName}?`);
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("fleet-enrollment-secret")).toContainText(
      `Rotated enrollment invite for ${uniqueName}`,
    );

    await page.getByTestId(`fleet-enrollment-revoke-${uniqueName}`).click();
    await expect(dialog).toContainText(`Revoke enrollment code ${uniqueName}?`);
    await page.getByTestId("confirm-accept").click();
    await expect(
      page.getByTestId(`fleet-enrollment-row-${uniqueName}`),
    ).toContainText("revoked");

    // Verify Reject opens confirm dialog and Cancel preserves seeded pending row.
    const rejectBtn = page
      .locator('[data-testid^="fleet-pending-reject-"]')
      .first();
    await rejectBtn.click();
    await expect(dialog).toContainText("Reject join request");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(pendingCard).toContainText("carol@example.com");

    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
    expect(await axe({ disableRules: ["color-contrast"] })).toEqual([]);
  },
);

test(
  "Fleet confirms destructive sandbox, persistent lifecycle, and host token rotate actions",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }) => {
    const writes = [];
    await page.route(/\/api\/sandboxes(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: {
          ...body,
          sandboxes: [
            {
              sandbox: "42-1",
              name: "42-1",
              kind: "agent",
              backend: "granule",
              ready: true,
              cpus: 2,
              memoryMB: 4096,
            },
          ],
        },
      });
    });
    await page.route(/\/api\/persistent-sandboxes(\?.*)?$/, (route) =>
      route.fulfill({
        json: [
          {
            name: "staging-web",
            repo: "acme/widgets",
            ref: "main",
            command: "npm run preview",
            state: "running",
            enabled: true,
            restarts: 0,
          },
        ],
      }),
    );
    await page.route("**/api/tasks/42/sandbox/recreate", (route) => {
      writes.push(`POST ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ json: { sandbox: "42-1" } });
    });
    await page.route("**/api/persistent-sandboxes/staging-web/*", (route) => {
      writes.push(`POST ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ json: { status: "ok" } });
    });
    await page.route("**/api/hostds/cloudtop-alice/rotate", (route) => {
      writes.push(`POST ${new URL(route.request().url()).pathname}`);
      return route.fulfill({
        json: {
          hostd: { name: "cloudtop-alice", state: "connected" },
          token: "ghd_e2e_rotated_token",
        },
      });
    });

    const viewportWidth = page.viewportSize()?.width ?? 1440;
    await page.goto("fleet");
    await expect(page.getByTestId("sandbox-recreate-42")).toBeVisible();

    const dialog = page.getByTestId("confirm-dialog");

    // Task sandbox Recreate confirms, Cancel sends nothing, Accept posts.
    await page.getByTestId("sandbox-recreate-42").click();
    await expect(dialog).toContainText("Recreate sandbox for task #42?");
    const dlgBox = await dialog.boundingBox();
    expect(dlgBox).not.toBeNull();
    expect(dlgBox.x).toBeGreaterThanOrEqual(0);
    expect(dlgBox.x + dlgBox.width).toBeLessThanOrEqual(viewportWidth);
    await expect(page.getByTestId("confirm-cancel")).toBeFocused();
    await page.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    expect(writes).toEqual([]);

    await page.getByTestId("sandbox-recreate-42").click();
    await page.getByTestId("confirm-accept").click();
    await expect(
      page.getByText("Recreated sandbox for task #42."),
    ).toBeVisible();
    expect(writes).toEqual(["POST /api/tasks/42/sandbox/recreate"]);

    // Persistent sandbox Rebuild confirms, Cancel sends nothing, Accept posts.
    await page.getByTestId("persistent-rebuild-staging-web").click();
    await expect(dialog).toContainText(
      "Rebuild persistent sandbox staging-web?",
    );
    await page.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    expect(writes).toHaveLength(1);

    await page.getByTestId("persistent-rebuild-staging-web").click();
    await page.getByTestId("confirm-accept").click();
    await expect(
      page.getByText("Persistent sandbox staging-web: rebuild requested."),
    ).toBeVisible();
    expect(writes).toEqual([
      "POST /api/tasks/42/sandbox/recreate",
      "POST /api/persistent-sandboxes/staging-web/rebuild",
    ]);

    // Host Rotate token confirms, Cancel sends nothing, Accept posts and shows banner.
    await page.goto("fleet?tab=hostds");
    await expect(page.getByTestId("hostd-rotate-cloudtop-alice")).toBeVisible();
    await page.getByTestId("hostd-rotate-cloudtop-alice").click();
    await expect(dialog).toContainText("Rotate host cloudtop-alice's token?");
    await page.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("hostd-issued-token")).toHaveCount(0);
    expect(writes).toHaveLength(2);

    await page.getByTestId("hostd-rotate-cloudtop-alice").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("hostd-issued-token")).toContainText(
      "ghd_e2e_rotated_token",
    );
    expect(writes).toEqual([
      "POST /api/tasks/42/sandbox/recreate",
      "POST /api/persistent-sandboxes/staging-web/rebuild",
      "POST /api/hostds/cloudtop-alice/rotate",
    ]);

    expect(await axe({ disableRules: ["color-contrast"] })).toEqual([]);
  },
);

test(
  "Fleet 390px mobile bottom clearance keeps scrolled content above the floating New task button",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }) => {
    for (const vp of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(vp);
      for (const tab of ["sandboxes", "hostds", "controls", "logs"]) {
        await page.goto(tab === "sandboxes" ? "fleet" : `fleet?tab=${tab}`);
        await expect(page.locator(`#fleet-panel-${tab}`)).toBeVisible();
        await expect(page.getByTestId("phone-new-task")).toBeVisible();

        const geom = await page.evaluate((panelId) => {
          const scroll = document.querySelector(".ops-scroll");
          const fabEl = document.querySelector(
            '[data-testid="phone-new-task"]',
          );
          const panel = document.getElementById(panelId);
          if (!scroll || !fabEl || !panel?.lastElementChild) return null;
          scroll.scrollTop = scroll.scrollHeight;
          const fabRect = fabEl.getBoundingClientRect();
          const lastRect = panel.lastElementChild.getBoundingClientRect();
          const sideways =
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth;
          return {
            fabTop: fabRect.top,
            lastBottom: lastRect.bottom,
            paddingBottom: parseFloat(getComputedStyle(scroll).paddingBottom),
            sideways,
          };
        }, `fleet-panel-${tab}`);

        expect(geom, `${vp.width}x${vp.height} ${tab}`).not.toBeNull();
        expect(
          geom.sideways,
          `${vp.width}x${vp.height} ${tab}`,
        ).toBeLessThanOrEqual(0);
        expect(
          geom.paddingBottom,
          `${vp.width}x${vp.height} ${tab}`,
        ).toBeGreaterThanOrEqual(108);
        expect(
          geom.lastBottom,
          `${vp.width}x${vp.height} ${tab}`,
        ).toBeLessThanOrEqual(geom.fabTop);
      }
    }
    expect(await axe({ disableRules: ["color-contrast"] })).toEqual([]);
  },
);
