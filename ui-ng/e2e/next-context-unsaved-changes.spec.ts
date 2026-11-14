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

test("confirms before discarding unsaved context changes across file switching, tab/scope switching, route navigation, browser Back, and page reload", async ({
  page,
  axe,
}) => {
  const docA = "e2e-unsaved-pack-a";
  const docB = "e2e-unsaved-pack-b";
  const seed = async (name: string, summary: string, text: string) => {
    const res = await page.request.put("/api/memory/documents", {
      data: { repo: "", name, summary, text },
    });
    expect(res.ok(), `seed ${name}: ${res.status()}`).toBe(true);
  };
  await seed(docA, "Pack A summary.", "Original body of pack A.");
  await seed(docB, "Pack B summary.", "Original body of pack B.");

  try {
    // 1. Desktop flow: route navigation (Inbox -> Context -> Inbox) + browser Back + reload beforeunload.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("inbox");
    await page.getByTestId("rail-context").click();
    await expect(page).toHaveURL(/\/next\/context/);

    const memBox = page.getByLabel("Standing memory markdown");
    await expect(memBox).toBeVisible();
    const originalMemory = await memBox.inputValue();
    await memBox.fill(`${originalMemory}\n\nUnsaved standing instruction.`);
    await expect(page.getByTestId("memory-dirty-pill")).toBeVisible();

    // Rail link click triggers confirmation dialog with Cancel focused by default.
    await page.getByTestId("rail-inbox").click();
    const leaveDialog = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await expect(leaveDialog).toBeVisible();
    await expect(
      leaveDialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    expect(await axe()).toEqual([]);

    // Cancel keeps us on Context with unsaved text intact.
    await leaveDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(leaveDialog).toBeHidden();
    await expect(page).toHaveURL(/\/next\/context/);
    await expect(memBox).toHaveValue(
      `${originalMemory}\n\nUnsaved standing instruction.`,
    );

    // Browser Back triggers confirmation dialog; Cancel stays on Context and restores URL.
    await page.goBack();
    await expect(leaveDialog).toBeVisible();
    await leaveDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(leaveDialog).toBeHidden();
    await expect(page).toHaveURL(/\/next\/context/);
    await expect(memBox).toHaveValue(
      `${originalMemory}\n\nUnsaved standing instruction.`,
    );

    // Browser Back again -> Discard changes navigates back to Inbox.
    await page.goBack();
    await expect(leaveDialog).toBeVisible();
    await leaveDialog
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(page).toHaveURL(/\/next\/inbox/);

    // 2. Documents tab: file switching, + New pack, scope switch, tab switch, and save clearing guard.
    await page.goto("context?tab=documents");
    await page.getByTestId(`doc-row-${docA}`).locator("button").click();
    const docBody = page.getByLabel("Memory document markdown body");
    await expect(docBody).toHaveValue("Original body of pack A.");

    await docBody.fill("Edited unsaved body of pack A.");
    await expect(page.getByTestId("doc-dirty-pill")).toBeVisible();

    // Switching to Pack B prompts; Cancel stays on Pack A with edited text.
    await page.getByTestId(`doc-row-${docB}`).locator("button").click();
    await expect(leaveDialog).toBeVisible();
    await expect(leaveDialog).toContainText(docA);
    await leaveDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(leaveDialog).toBeHidden();
    await expect(page.getByTestId("doc-editor-title")).toContainText(docA);
    await expect(docBody).toHaveValue("Edited unsaved body of pack A.");

    // Clicking + New pack while dirty prompts; Cancel preserves edits.
    await page.getByTestId("doc-new-btn").click();
    await expect(leaveDialog).toBeVisible();
    await leaveDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(docBody).toHaveValue("Edited unsaved body of pack A.");

    // Switching to Pack B and clicking Discard changes opens Pack B cleanly.
    await page.getByTestId(`doc-row-${docB}`).locator("button").click();
    await expect(leaveDialog).toBeVisible();
    await leaveDialog
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(page.getByTestId("doc-editor-title")).toContainText(docB);
    await expect(docBody).toHaveValue("Original body of pack B.");
    await expect(page.getByTestId("doc-dirty-pill")).toBeHidden();

    // Edit Pack B and save -> switching back to Pack A does NOT prompt.
    await docBody.fill("Saved update to pack B.");
    const savePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/memory/documents") &&
        res.request().method() === "PUT",
    );
    await page.getByTestId("doc-save-btn").click();
    await savePromise;
    await expect(page.getByTestId("doc-dirty-pill")).toBeHidden();

    await page.getByTestId(`doc-row-${docA}`).locator("button").click();
    await expect(leaveDialog).toHaveCount(0);
    await expect(page.getByTestId("doc-editor-title")).toContainText(docA);

    // beforeunload dialog fires on page reload when dirty, and dismissing keeps edits.
    await docBody.fill("Dirty before reload.");
    const unloadDialogPromise = page.waitForEvent("dialog");
    await page.evaluate(() => {
      setTimeout(() => window.location.reload(), 0);
    });
    const unloadDialog = await unloadDialogPromise;
    expect(unloadDialog.type()).toBe("beforeunload");
    await unloadDialog.dismiss();
    await page.waitForTimeout(200);
    await expect(docBody).toHaveValue("Dirty before reload.");
  } finally {
    await page.request
      .put("/api/memory/documents", {
        data: { repo: "", name: docA, summary: "", text: "" },
      })
      .catch(() => undefined);
    await page.request
      .put("/api/memory/documents", {
        data: { repo: "", name: docB, summary: "", text: "" },
      })
      .catch(() => undefined);
  }
});

for (const vp of [
  { width: 390, height: 844 },
  { width: 320, height: 800 },
]) {
  test(
    `unsaved-changes dialog fits ${vp.width}x${vp.height} phone viewport with long document name and zero axe violations`,
    { tag: ["@phone", "@dark"] },
    async ({ page, axe }) => {
      await page.setViewportSize(vp);
      await page.goto("context?tab=documents");

      await page.getByTestId("doc-new-btn").click();
      const longSlug = "a".repeat(64);
      await page.getByLabel("Memory document name").fill(longSlug);

      await page.getByTestId("context-tab-instructions").click();
      const dialog = page.getByRole("dialog", {
        name: "Discard unsaved changes?",
      });
      await expect(dialog).toBeVisible();

      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x, "dialog left edge stays on screen").toBeGreaterThanOrEqual(
        0,
      );
      expect(
        box!.x + box!.width,
        "dialog right edge stays inside viewport",
      ).toBeLessThanOrEqual(vp.width);
      expect(
        box!.y + box!.height,
        "dialog bottom edge stays inside viewport",
      ).toBeLessThanOrEqual(vp.height);

      for (const name of ["Cancel", "Discard changes"]) {
        const b = await dialog
          .getByRole("button", { name, exact: true })
          .boundingBox();
        expect(b).not.toBeNull();
        expect(b!.x).toBeGreaterThanOrEqual(box!.x);
        expect(b!.x + b!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      }

      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(sideways).toBe(0);
      expect(await axe()).toEqual([]);

      await dialog.getByRole("button", { name: "Discard changes" }).click();
      await expect(dialog).toBeHidden();
    },
  );
}
