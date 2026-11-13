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

import type { APIResponse, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Drives the real `grain demo -fake-ci` backend so DELETE /api/ci/runs/{id}
// with and without { reason } exercises handleCancelCIRun end to end.
test.use({ demoArgs: ["-fake-ci"] });

async function okJson<T>(res: APIResponse, label: string): Promise<T> {
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function setupGrainCIRuns(
  page: Page,
  count: number,
): Promise<{ ids: string[]; restore: () => Promise<void> }> {
  const prev = await okJson<{ ciMode?: string }>(
    await page.request.get("/api/repos/acme/widgets/ci-mode"),
    "read ci-mode",
  );
  await okJson(
    await page.request.put("/api/repos/acme/widgets/ci-mode", {
      data: { ciMode: "grain" },
    }),
    "enable grain ci-mode",
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = await okJson<{ id: string }>(
      await page.request.post("/api/ci/runs", {
        data: { repo: "acme/widgets", ref: "main", commit: `abc000${i}` },
      }),
      `start fake-ci run #${i + 1}`,
    );
    ids.push(created.id);
  }
  return {
    ids,
    restore: async () => {
      await page.request.put("/api/repos/acme/widgets/ci-mode", {
        data: { ciMode: prev.ciMode ?? "github" },
      });
    },
  };
}

function recordDeleteRequests(
  page: Page,
  out: { url: string; postData: string | null }[],
): void {
  page.on("request", (req) => {
    if (req.method() === "DELETE" && req.url().includes("/api/ci/runs/")) {
      out.push({ url: req.url(), postData: req.postData() });
    }
  });
}

test("prompts for optional reason on CI run cancel", async ({ page }) => {
  const {
    ids: [runWithReason, runWithoutReason],
    restore,
  } = await setupGrainCIRuns(page, 2);

  try {
    const deletePayloads: { url: string; postData: string | null }[] = [];
    recordDeleteRequests(page, deletePayloads);
    expect(deletePayloads).toEqual([]);

    // 1. Open active run and dismiss via Cancel and Escape (no DELETE sent)
    await page.goto(`ci/runs/${runWithReason}`);
    const cancelBtn = page.getByRole("button", { name: "Cancel run" });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    const dialog = page.getByRole("dialog", { name: "Cancel CI run?" });
    await expect(dialog).toBeVisible();
    const reasonInput = dialog.getByRole("textbox", {
      name: /Reason \(optional\)/i,
    });
    await expect(reasonInput).toBeFocused();
    await reasonInput.fill("draft that should reset");

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(deletePayloads).toEqual([]);
    await expect(cancelBtn).toBeFocused();

    // Reopen: draft cleared; Escape dismisses without DELETE
    await cancelBtn.click();
    await expect(reasonInput).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(deletePayloads).toEqual([]);

    // 2. Submit with an optional reason
    await cancelBtn.click();
    await reasonInput.fill("  wrong branch, retrying on main  ");
    const deleteRespPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "DELETE" &&
        res.url().endsWith(`/api/ci/runs/${runWithReason}`),
    );
    await dialog.getByRole("button", { name: "Cancel run" }).click();
    const deleteResp = await deleteRespPromise;
    expect(deleteResp.status()).toBe(202);
    await expect(dialog).toBeHidden();

    expect(deletePayloads).toHaveLength(1);
    expect(JSON.parse(deletePayloads[0].postData ?? "null")).toEqual({
      reason: "wrong branch, retrying on main",
    });

    await expect(page.getByTestId("ci-detail-status")).toContainText(
      "Cancelled",
    );
    await expect(page.getByTestId("ci-cancel-reason")).toContainText(
      "Cancel note: wrong branch, retrying on main",
    );
    await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(
      0,
    );

    // Persists across reload
    await page.reload();
    await expect(page.getByTestId("ci-cancel-reason")).toContainText(
      "Cancel note: wrong branch, retrying on main",
    );

    // 3. Submit without a reason (optional in the strongest sense)
    await page.goto(`ci/runs/${runWithoutReason}`);
    await page.getByRole("button", { name: "Cancel run" }).click();
    await expect(dialog).toBeVisible();
    const secondDeletePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "DELETE" &&
        res.url().endsWith(`/api/ci/runs/${runWithoutReason}`),
    );
    await dialog.getByRole("button", { name: "Cancel run" }).click();
    const secondResp = await secondDeletePromise;
    expect(secondResp.status()).toBe(202);
    await expect(dialog).toBeHidden();

    expect(deletePayloads).toHaveLength(2);
    expect(deletePayloads[1].postData).toBeNull();
    await expect(page.getByTestId("ci-detail-status")).toContainText(
      "Cancelled",
    );
    await expect(page.getByTestId("ci-cancel-reason")).toHaveCount(0);
  } finally {
    await restore();
  }
});

test(
  "cancel CI run dialog fits viewport with zero overflow and zero axe violations across sizes and themes",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    const {
      ids: [runId],
      restore,
    } = await setupGrainCIRuns(page, 1);

    try {
      const sizes =
        testInfo.project.name === "phone"
          ? [
              { width: 320, height: 568 },
              { width: 390, height: 844 },
            ]
          : [
              { width: 1024, height: 860 },
              { width: 1440, height: 900 },
              { width: 2048, height: 1200 },
            ];

      await page.goto(`ci/runs/${runId}`);
      await page.getByRole("button", { name: "Cancel run" }).click();
      const dialog = page.getByRole("dialog", { name: "Cancel CI run?" });
      await expect(dialog).toBeVisible();

      for (const sz of sizes) {
        await page.setViewportSize(sz);
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(16);
        expect(box!.x + box!.width).toBeLessThanOrEqual(sz.width - 16);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(sz.height);

        const textareaBox = await dialog
          .getByRole("textbox", { name: /Reason \(optional\)/i })
          .boundingBox();
        expect(textareaBox).not.toBeNull();
        expect(textareaBox!.x).toBeGreaterThanOrEqual(box!.x);
        expect(textareaBox!.x + textareaBox!.width).toBeLessThanOrEqual(
          box!.x + box!.width,
        );

        const dismissBtn = dialog.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        const submitBtn = dialog.getByRole("button", { name: "Cancel run" });
        const dismissBox = await dismissBtn.boundingBox();
        const submitBox = await submitBtn.boundingBox();
        expect(dismissBox).not.toBeNull();
        expect(submitBox).not.toBeNull();
        // Both buttons meet hit-target floor, share a height, and sit on one aligned row inside the dialog.
        expect(dismissBox!.height).toBeGreaterThanOrEqual(24);
        expect(submitBox!.height).toBeGreaterThanOrEqual(24);
        expect(Math.abs(dismissBox!.height - submitBox!.height)).toBeLessThan(
          2,
        );
        expect(
          Math.abs(
            dismissBox!.y +
              dismissBox!.height / 2 -
              (submitBox!.y + submitBox!.height / 2),
          ),
        ).toBeLessThan(2);
        expect(submitBox!.x + submitBox!.width).toBeLessThanOrEqual(
          box!.x + box!.width,
        );

        const sideways = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(sideways).toBeLessThanOrEqual(0);
      }

      const violations = await axe();
      expect(
        violations.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`),
      ).toEqual([]);

      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
    } finally {
      await restore();
    }
  },
);
