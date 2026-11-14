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

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test(
  "Context editor intercepts navigation and file/scope/tab switching when holding unsaved changes",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = testInfo.project.name;
    const docA = `unsaved-alpha-${suffix}`;
    const docB = `unsaved-beta-${suffix}`;

    const putA = await page.request.put("/api/memory/documents", {
      data: {
        repo: "",
        name: docA,
        summary: "Alpha unsaved-guard test document",
        text: "# Alpha\n\nInitial alpha body.",
      },
    });
    const putB = await page.request.put("/api/memory/documents", {
      data: {
        repo: "",
        name: docB,
        summary: "Beta unsaved-guard test document",
        text: "# Beta\n\nInitial beta body.",
      },
    });
    expect(putA.ok()).toBe(true);
    expect(putB.ok()).toBe(true);

    try {
      // Visit Inbox first, then navigate to Context via the app nav so browser Back is a SPA popstate.
      await page.goto("inbox");
      await expect(page.getByTestId("next-inbox-headline")).toBeVisible();

      const compactMore = page.getByTestId("compact-more");
      if (await compactMore.isVisible()) {
        await compactMore.click();
        await page
          .getByTestId("more-sheet")
          .getByRole("link", { name: /^Context$/i })
          .click();
      } else {
        await page
          .getByRole("navigation", { name: "Primary destinations" })
          .getByRole("link", { name: /^Context$/i })
          .click();
      }
      await expect(page.getByTestId("context-page")).toBeVisible();

      const memTextarea = page.getByRole("textbox", {
        name: "Standing memory markdown",
      });
      await expect(memTextarea).toBeVisible();
      const origMem = await memTextarea.inputValue();

      // 1. Clean state: switching tabs and back causes no dialog.
      await page
        .getByRole("tab", { name: /Memory Documents \(Packs\)/i })
        .click();
      await expect(
        page.getByRole("dialog", { name: /Discard unsaved changes\?/i }),
      ).toHaveCount(0);
      await page.getByRole("tab", { name: /Standing Instructions/i }).click();

      // 2. Edit Standing Instructions -> switch tab -> confirm dialog intercepts, Cancel keeps edits.
      const dirtyMem = `${origMem}\n\n- Unsaved rule (${suffix})`;
      await memTextarea.fill(dirtyMem);
      await expect(page.getByTestId("memory-dirty-pill")).toBeVisible();

      await page
        .getByRole("tab", { name: /Memory Documents \(Packs\)/i })
        .click();
      const dialog = page.getByRole("dialog", {
        name: /Discard unsaved changes\?/i,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(
        "You have unsaved changes here. Leave and discard them?",
      );

      // Cancel must be focused by default on destructive confirm, and dialog must fit viewport cleanly.
      const cancelBtn = dialog.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      const discardBtn = dialog.getByRole("button", {
        name: "Discard changes",
      });
      await expect(cancelBtn).toBeFocused();

      const vp = page.viewportSize()!;
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(vp.width);
      for (const btn of [cancelBtn, discardBtn]) {
        const b = await btn.boundingBox();
        expect(b).not.toBeNull();
        expect(b!.x).toBeGreaterThanOrEqual(dialogBox!.x);
        expect(b!.x + b!.width).toBeLessThanOrEqual(
          dialogBox!.x + dialogBox!.width,
        );
      }

      expect(await axe()).toEqual([]);
      const contrast = await new AxeBuilder({ page })
        .include('[data-testid="confirm-dialog"]')
        .withRules(["color-contrast"])
        .analyze();
      expect(contrast.violations).toEqual([]);

      await cancelBtn.click();
      await expect(dialog).toHaveCount(0);
      await expect(memTextarea).toHaveValue(dirtyMem);

      // 3. Route navigation via nav link & browser Back while dirty -> Cancel keeps user on /next/context.
      const inboxLink = page
        .getByRole("navigation", { name: /^Primary destinations/i })
        .getByRole("link", { name: /Inbox/i })
        .filter({ visible: true })
        .first();
      await inboxLink.click();
      await expect(dialog).toBeVisible();
      await cancelBtn.click();
      await expect(dialog).toHaveCount(0);
      expect(page.url()).toContain("/next/context");
      await expect(memTextarea).toHaveValue(dirtyMem);

      // Browser Back is intercepted by canDeactivate and restores /next/context on Cancel.
      await page.goBack();
      await expect(dialog).toBeVisible();
      await cancelBtn.click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/next\/context/);
      await expect(memTextarea).toHaveValue(dirtyMem);

      // 4. Full-page unload / reload triggers beforeunload when dirty.
      let beforeUnloadSeen = false;
      const onDialog = async (d: import("@playwright/test").Dialog) => {
        if (d.type() === "beforeunload") {
          beforeUnloadSeen = true;
          await d.dismiss();
        }
      };
      page.on("dialog", onDialog);
      await page.reload({ timeout: 5_000 }).catch(() => {});
      page.off("dialog", onDialog);
      expect(beforeUnloadSeen).toBe(true);
      await expect(memTextarea).toHaveValue(dirtyMem);

      // 5. Switch to Documents tab by confirming Discard, then guard switching between documents and + New pack.
      await page
        .getByRole("tab", { name: /Memory Documents \(Packs\)/i })
        .click();
      await expect(dialog).toBeVisible();
      await discardBtn.click();
      await expect(dialog).toHaveCount(0);

      await page.getByTestId(`doc-row-${docA}`).locator("button").click();
      const docBody = page.getByRole("textbox", {
        name: "Memory document markdown body",
      });
      await expect(docBody).toHaveValue("# Alpha\n\nInitial alpha body.");

      const dirtyAlpha = "# Alpha\n\nUnsaved edits to alpha.";
      await docBody.fill(dirtyAlpha);
      await expect(page.getByTestId("doc-dirty-pill")).toBeVisible();

      // Clicking docB while docA is dirty prompts; Cancel keeps docA and its edits.
      await page.getByTestId(`doc-row-${docB}`).locator("button").click();
      await expect(dialog).toBeVisible();
      await cancelBtn.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("doc-editor-title")).toContainText(docA);
      await expect(docBody).toHaveValue(dirtyAlpha);

      // Clicking + New pack while docA is dirty prompts; Escape dismisses without losing edits.
      await page.getByRole("button", { name: "+ New pack" }).click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(docBody).toHaveValue(dirtyAlpha);

      // Confirming Discard switches to docB cleanly.
      await page.getByTestId(`doc-row-${docB}`).locator("button").click();
      await expect(dialog).toBeVisible();
      await discardBtn.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("doc-editor-title")).toContainText(docB);
      await expect(docBody).toHaveValue("# Beta\n\nInitial beta body.");
      await expect(page.getByTestId("doc-dirty-pill")).toHaveCount(0);

      // Switching repository scope while docB is dirty prompts; Cancel keeps deployment scope & edits.
      const savedBeta = `# Beta\n\nSaved beta update (${suffix}).`;
      await docBody.fill(savedBeta);
      await expect(page.getByTestId("doc-dirty-pill")).toBeVisible();
      await page.getByRole("button", { name: /Select repository/i }).click();
      await page.getByRole("option", { name: "acme/widgets" }).click();
      await expect(dialog).toBeVisible();
      await cancelBtn.click();
      await expect(dialog).toHaveCount(0);
      await expect(docBody).toHaveValue(savedBeta);

      // Saving document clears dirty state so switching files and navigating away succeed without prompt.
      await page.getByRole("button", { name: "Save document" }).click();
      await expect(page.getByTestId("doc-dirty-pill")).toHaveCount(0);
      await page.getByTestId(`doc-row-${docA}`).locator("button").click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("doc-editor-title")).toContainText(docA);

      // 6. Clean navigation away succeeds without prompt.
      await inboxLink.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("next-inbox-headline")).toBeVisible();
    } finally {
      await page.request.put("/api/memory/documents", {
        data: { repo: "", name: docA, summary: "", text: "" },
      });
      await page.request.put("/api/memory/documents", {
        data: { repo: "", name: docB, summary: "", text: "" },
      });
    }
  },
);
