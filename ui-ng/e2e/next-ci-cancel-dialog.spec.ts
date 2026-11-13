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

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ demoArgs: ["-fake-ci"] });

async function ok<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  what: string,
): Promise<T> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function withFakeRun(
  page: Page,
  fn: (runId: string) => Promise<void>,
): Promise<void> {
  const prev = await ok<{ ciMode?: string }>(
    await page.request.get("/api/repos/acme/widgets/ci-mode"),
    "read ci-mode",
  );
  await ok(
    await page.request.put("/api/repos/acme/widgets/ci-mode", {
      data: { ciMode: "grain" },
    }),
    "enable grain ci-mode",
  );
  let runId = "";
  try {
    const run = await ok<{ id: string }>(
      await page.request.post("/api/ci/runs", {
        data: { repo: "acme/widgets", ref: "main", commit: "abc1234" },
      }),
      "start fake ci run",
    );
    runId = run.id;
    await fn(runId);
  } finally {
    if (runId) {
      await page.request.delete(`/api/ci/runs/${runId}`).catch(() => undefined);
    }
    await page.request.put("/api/repos/acme/widgets/ci-mode", {
      data: { ciMode: prev?.ciMode ?? "" },
    });
  }
}

test("cancels a running CI run with an optional reason or empty body, and aborts on Cancel/Escape", async ({
  page,
}) => {
  const prev = await ok<{ ciMode?: string }>(
    await page.request.get("/api/repos/acme/widgets/ci-mode"),
    "read ci-mode",
  );
  await ok(
    await page.request.put("/api/repos/acme/widgets/ci-mode", {
      data: { ciMode: "grain" },
    }),
    "enable grain ci-mode",
  );

  let run1Id = "";
  let run2Id = "";
  try {
    const run1 = await ok<{ id: string }>(
      await page.request.post("/api/ci/runs", {
        data: { repo: "acme/widgets", ref: "main", commit: "abc1234" },
      }),
      "start first fake run",
    );
    const run2 = await ok<{ id: string }>(
      await page.request.post("/api/ci/runs", {
        data: { repo: "acme/widgets", ref: "feature/test", commit: "def5678" },
      }),
      "start second fake run",
    );
    run1Id = run1.id;
    run2Id = run2.id;

    const deletes: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "DELETE" && req.url().includes("/api/ci/runs/")) {
        deletes.push(new URL(req.url()).pathname);
      }
    });

    await page.goto(`ci/runs/${run1Id}`);
    const cancelBtn = page.getByRole("button", { name: "Cancel run" });
    await expect(cancelBtn).toBeVisible();

    // Opening focuses the optional reason field; Enter inserts a newline without submitting.
    await cancelBtn.click();
    const dialog = page.getByRole("dialog", { name: "Cancel CI run?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("acme/widgets");
    await expect(dialog).toContainText("main");

    const reasonInput = dialog.getByLabel("Reason (optional)");
    await expect(reasonInput).toBeFocused();
    await reasonInput.press("Enter");
    await expect(dialog).toBeVisible();
    expect(deletes).toEqual([]);

    // Cancel dismisses without sending DELETE and restores focus to the trigger.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cancelBtn).toBeFocused();
    expect(deletes).toEqual([]);

    // Escape also dismisses without sending DELETE and restores focus.
    await cancelBtn.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(cancelBtn).toBeFocused();
    expect(deletes).toEqual([]);

    // Focus trap cycles Tab inside the dialog.
    await cancelBtn.click();
    await expect(reasonInput).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "Stop run", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(reasonInput).toBeFocused();

    // Submitting a non-empty reason sends { reason } trimmed and updates the run.
    await reasonInput.fill("  wrong branch  ");
    const [delReq1, delRes1] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === "DELETE" && r.url().endsWith(`/api/ci/runs/${run1Id}`),
      ),
      page.waitForResponse(
        (r) =>
          r.request().method() === "DELETE" &&
          r.url().endsWith(`/api/ci/runs/${run1Id}`),
      ),
      dialog.getByRole("button", { name: "Stop run", exact: true }).click(),
    ]);
    expect(delRes1.status()).toBe(202);
    expect(delReq1.postDataJSON()).toEqual({ reason: "wrong branch" });

    await expect(dialog).toBeHidden();
    await expect(page.getByText("CI run cancelled.")).toBeVisible();
    await expect(page.getByTestId("ci-detail-status")).toContainText(
      "Cancelled",
    );
    await expect(cancelBtn).toHaveCount(0);
    await expect(page.getByTestId("ci-cancel-reason")).toContainText(
      "Cancel note: wrong branch",
    );

    const saved1 = await ok<{ conclusion?: string; cancelReason?: string }>(
      await page.request.get(`/api/ci/runs/${run1Id}`),
      "fetch cancelled run 1",
    );
    expect(saved1.conclusion).toBe("cancelled");
    expect(saved1.cancelReason).toBe("wrong branch");

    // Submitting with an empty reason omits the body and still cancels cleanly.
    await page.goto(`ci/runs/${run2Id}`);
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(dialog).toBeVisible();
    await reasonInput.fill("   ");
    const [delReq2, delRes2] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === "DELETE" && r.url().endsWith(`/api/ci/runs/${run2Id}`),
      ),
      page.waitForResponse(
        (r) =>
          r.request().method() === "DELETE" &&
          r.url().endsWith(`/api/ci/runs/${run2Id}`),
      ),
      dialog.getByRole("button", { name: "Stop run", exact: true }).click(),
    ]);
    expect(delRes2.status()).toBe(202);
    expect(delReq2.postData()).toBeNull();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("ci-detail-status")).toContainText(
      "Cancelled",
    );
    await expect(page.getByTestId("ci-cancel-reason")).toHaveCount(0);

    const saved2 = await ok<{ conclusion?: string; cancelReason?: string }>(
      await page.request.get(`/api/ci/runs/${run2Id}`),
      "fetch cancelled run 2",
    );
    expect(saved2.conclusion).toBe("cancelled");
    expect(saved2.cancelReason ?? "").toBe("");
  } finally {
    if (run1Id) {
      await page.request
        .delete(`/api/ci/runs/${run1Id}`)
        .catch(() => undefined);
    }
    if (run2Id) {
      await page.request
        .delete(`/api/ci/runs/${run2Id}`)
        .catch(() => undefined);
    }
    await page.request.put("/api/repos/acme/widgets/ci-mode", {
      data: { ciMode: prev?.ciMode ?? "" },
    });
  }
});

test(
  "cancel CI run dialog fits desktop and phone viewports with zero axe violations",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    const wantTheme = testInfo.project.name === "dark" ? "dark" : "light";
    await withFakeRun(page, async (runId) => {
      await page.goto(`ci/runs/${runId}`);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        wantTheme,
      );

      await page.getByRole("button", { name: "Cancel run" }).click();
      const dialog = page.getByRole("dialog", { name: "Cancel CI run?" });
      await expect(dialog).toBeVisible();

      const assertGeometry = async (vpWidth: number, vpHeight: number) => {
        const sideways = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(sideways, "no sideways scroll").toBeLessThanOrEqual(0);

        const db = await dialog.boundingBox();
        expect(db).not.toBeNull();
        expect(db!.x).toBeGreaterThanOrEqual(0);
        expect(db!.y).toBeGreaterThanOrEqual(0);
        expect(db!.x + db!.width).toBeLessThanOrEqual(vpWidth);
        expect(db!.y + db!.height).toBeLessThanOrEqual(vpHeight);

        const tb = await dialog.getByLabel("Reason (optional)").boundingBox();
        expect(tb).not.toBeNull();
        expect(tb!.x).toBeGreaterThanOrEqual(db!.x);
        expect(tb!.x + tb!.width).toBeLessThanOrEqual(db!.x + db!.width);

        const cancelBtnBox = await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .boundingBox();
        const stopBtnBox = await dialog
          .getByRole("button", { name: "Stop run", exact: true })
          .boundingBox();
        expect(cancelBtnBox).not.toBeNull();
        expect(stopBtnBox).not.toBeNull();
        expect(cancelBtnBox!.x + cancelBtnBox!.width).toBeLessThanOrEqual(
          db!.x + db!.width,
        );
        expect(stopBtnBox!.x + stopBtnBox!.width).toBeLessThanOrEqual(
          db!.x + db!.width,
        );
        const midY = (b: NonNullable<typeof cancelBtnBox>) =>
          b.y + b.height / 2;
        expect(
          Math.abs(midY(cancelBtnBox!) - midY(stopBtnBox!)),
        ).toBeLessThanOrEqual(2);
      };

      const vp = page.viewportSize() ?? { width: 1440, height: 900 };
      await assertGeometry(vp.width, vp.height);

      const violations = await axe();
      expect(
        violations.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`),
      ).toEqual([]);

      if (testInfo.project.name === "phone") {
        await page.setViewportSize({ width: 320, height: 568 });
        await assertGeometry(320, 568);
      }
    });
  },
);
