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

test("M17 Sessions workspace: inline model picker and coplanar Artifact/Memory Canvas", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/next/sessions/director");
  await page.waitForSelector(".main-stage > *:not(router-outlet)");

  // Workspace Canvas toggles open from chat header and switches between Docs, HTML Mock, Workstream, and Memory.
  const toggle = page.getByTestId("session-canvas-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();

  const canvas = page.getByTestId("session-canvas");
  await expect(canvas).toBeVisible();

  await page.getByTestId("canvas-tab-html").click();
  await page.getByTestId("canvas-tab-plan").click();
  await page.getByTestId("canvas-tab-docs").click();
  const memTab = page.getByTestId("canvas-tab-memory");
  if ((await memTab.count()) > 0) {
    await memTab.click();
  }

  // Inline header model picker renders when models exist on deployment.
  const headModel = page.getByTestId("chat-head-model");
  if ((await headModel.count()) > 0) {
    await expect(headModel).toBeVisible();
  }

  await page.getByTestId("canvas-close").click();
  await expect(canvas).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(
    `Sessions canvas confirms unsaved discard, fits ${width}px viewport above chrome, and restores focus on Escape`,
    { tag: width === 390 ? ["@phone"] : [] },
    async ({ page, demoServer, accessCode, axe }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 844 });

      const headers = {
        Authorization: `Bearer ${accessCode}`,
        "Content-Type": "application/json",
      };
      for (const doc of [
        {
          repo: "",
          name: "canvas-arch",
          summary: "Architecture baseline",
          text: "Initial architecture text",
        },
        {
          repo: "",
          name: "canvas-ops",
          summary: "Operations baseline",
          text: "Initial ops text",
        },
      ]) {
        const res = await fetch(`${demoServer}/api/memory/documents`, {
          method: "PUT",
          headers,
          body: JSON.stringify(doc),
        });
        expect(res.ok).toBe(true);
      }

      await page.goto("/next/sessions/director");
      await page.waitForSelector(".main-stage > *:not(router-outlet)");

      const toggle = page.getByTestId("session-canvas-toggle");
      await toggle.focus();
      await toggle.click();

      const canvas = page.getByTestId("session-canvas");
      await expect(canvas).toBeVisible();

      // Clean Escape closes canvas and returns focus to the opener button.
      await page.getByTestId("canvas-tab-docs").focus();
      await page.keyboard.press("Escape");
      await expect(canvas).toHaveCount(0);
      await expect(toggle).toBeFocused();

      // Reopen, switch to Memory, edit a doc, and test discard confirmation + viewport fit.
      await toggle.click();
      await expect(canvas).toBeVisible();
      await page.getByTestId("canvas-tab-memory").click();
      await page.locator('[data-doc-key="::canvas-arch"]').click();

      const bodyInput = page.getByTestId("memory-text-input");
      await expect(bodyInput).toHaveValue("Initial architecture text");
      await bodyInput.fill("Unsaved browser edit");
      await expect(page.getByTestId("memory-dirty-pill")).toBeVisible();

      // Escape while dirty opens confirm-dialog instead of discarding or closing canvas.
      await page.keyboard.press("Escape");
      const dialog = page.getByTestId("confirm-dialog");
      await expect(dialog).toBeVisible();

      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
      for (const tid of ["confirm-cancel", "confirm-accept"]) {
        const b = await page.getByTestId(tid).boundingBox();
        expect(b.x).toBeGreaterThanOrEqual(box.x);
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
      }
      const centerTop = await page.evaluate(() => {
        const dlg = document.querySelector('[data-testid="confirm-dialog"]');
        if (!dlg) return false;
        const r = dlg.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return !!hit && dlg.contains(hit);
      });
      expect(centerTop).toBe(true);
      expect(await axe()).toEqual([]);

      // Escape dismisses confirmation dialog, keeps edits intact, and restores focus to textarea.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(canvas).toBeVisible();
      await expect(bodyInput).toHaveValue("Unsaved browser edit");
      await expect(bodyInput).toBeFocused();

      // Switching Memory doc while dirty confirms; cancelling preserves edits.
      await page.locator('[data-doc-key="::canvas-ops"]').click();
      await expect(dialog).toBeVisible();
      await page.getByTestId("confirm-cancel").click();
      await expect(bodyInput).toHaveValue("Unsaved browser edit");

      // Discard button reverts edits after confirmation.
      await page.getByTestId("canvas-memory-discard").click();
      await expect(dialog).toBeVisible();
      await page.getByTestId("confirm-accept").click();
      await expect(bodyInput).toHaveValue("Initial architecture text");
      await expect(page.getByTestId("memory-dirty-pill")).toHaveCount(0);

      // Clean Escape closes canvas and returns focus to toggle.
      await page.keyboard.press("Escape");
      await expect(canvas).toHaveCount(0);
      await expect(toggle).toBeFocused();
    },
  );
}
