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

import { expect, test } from "./fixtures.js";

async function setIdentity(
  demoServer: string,
  accessCode: string,
  body: {
    environmentName?: string;
    headerColor?: string;
    headerPattern?: string;
  },
): Promise<void> {
  const res = await fetch(`${demoServer}/api/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessCode}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `POST /api/settings failed (${res.status}): ${await res.text()}`,
    );
  }
}

test.describe("instance identity, header theming, and quick-name popover", () => {
  test("names and styles an instance from the top-bar popover with live preview, revert, persistence, and WCAG contrast @dark", async ({
    page,
    axe,
    demoServer,
    accessCode,
  }) => {
    test.setTimeout(90_000);
    await setIdentity(demoServer, accessCode, {
      environmentName: "",
      headerColor: "",
      headerPattern: "",
    });
    try {
      await page.goto("inbox");
      const cue = page.getByTestId("instance-name-cue");
      await expect(cue).toBeVisible();
      await expect(cue).toHaveText("+ Name instance");
      await expect(page.getByTestId("instance-identity-badge")).toBeHidden();

      // Open popover from unnamed cue.
      await cue.click();
      const popover = page.getByTestId("instance-identity-popover");
      await expect(popover).toBeVisible();

      const topBar = page.locator("header.top-bar");
      const nameInput = page.getByTestId("identity-popover-name");
      await expect(nameInput).toBeFocused();

      // Live preview unsaved name, coral color, and grid pattern.
      await nameInput.fill("preview-only");
      await page.getByTestId("identity-color-coral").click();
      await page.getByTestId("identity-pattern-grid").click();

      await expect(topBar).toHaveAttribute("data-header-color", "coral");
      await expect(topBar).toHaveAttribute("data-header-pattern", "grid");
      await expect(page.getByTestId("instance-identity-badge")).toContainText(
        "preview-only",
      );
      await expect(page).toHaveTitle(/^\[preview-only\] /);
      const previewFavicon = await page
        .locator("#grain-favicon-svg")
        .getAttribute("href");
      expect(previewFavicon).toMatch(/^data:image\/svg\+xml,/);

      // Axe check with popover open (including color-contrast).
      expect(await axe()).toEqual([]);

      // Escape reverts cleanly and restores focus to the swapped + Name instance cue.
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await expect(topBar).not.toHaveAttribute("data-header-color", /.+/);
      await expect(topBar).not.toHaveAttribute("data-header-pattern", /.+/);
      await expect(cue).toBeVisible();
      await expect(cue).toBeFocused();
      await expect(page).not.toHaveTitle(/^\[preview-only\] /);

      // Re-open, set real identity, and save.
      await cue.click();
      await expect(popover).toBeVisible();
      await nameInput.fill("staging · eu");
      await page.getByTestId("identity-color-ocean").click();
      await page.getByTestId("identity-pattern-waves").click();
      await page.getByTestId("identity-popover-save").click();

      await expect(popover).toBeHidden();
      await expect(topBar).toHaveAttribute("data-header-color", "ocean");
      await expect(topBar).toHaveAttribute("data-header-pattern", "waves");
      const badge = page.getByTestId("instance-identity-badge");
      await expect(badge).toBeVisible();
      await expect(badge).toBeFocused();
      await expect(badge).toContainText("staging · eu");
      await expect(page).toHaveTitle(/^\[staging · eu\] /);

      // Persists across full reload.
      await page.reload();
      await expect(topBar).toHaveAttribute("data-header-color", "ocean");
      await expect(topBar).toHaveAttribute("data-header-pattern", "waves");
      await expect(page.getByTestId("instance-identity-badge")).toContainText(
        "staging · eu",
      );
      await expect(page).toHaveTitle(/^\[staging · eu\] /);
      const savedFavicon = await page
        .locator("#grain-favicon-svg")
        .getAttribute("href");
      expect(savedFavicon).toMatch(/^data:image\/svg\+xml,/);

      // Desktop bounding boxes: no overlap or clipping in top bar.
      const barBox = await topBar.boundingBox();
      const brandBox = await page.locator(".top-brand-cluster").boundingBox();
      const actionsBox = await page.locator(".top-actions").boundingBox();
      const badgeBox = await page
        .getByTestId("instance-identity-badge")
        .boundingBox();
      expect(barBox).not.toBeNull();
      expect(brandBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(badgeBox).not.toBeNull();
      expect(brandBox!.x + brandBox!.width).toBeLessThanOrEqual(
        actionsBox!.x + 1,
      );
      expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(
        barBox!.x + barBox!.width + 1,
      );
      expect(
        Math.abs(
          badgeBox!.y + badgeBox!.height / 2 - (barBox!.y + barBox!.height / 2),
        ),
      ).toBeLessThan(3);

      expect(await axe()).toEqual([]);
    } finally {
      await setIdentity(demoServer, accessCode, {
        environmentName: "",
        headerColor: "",
        headerPattern: "",
      });
    }
  });

  test("edits instance name, header color, and pattern from /next/settings/general with live preview and plan diff @dark", async ({
    page,
    axe,
    demoServer,
    accessCode,
  }) => {
    test.setTimeout(90_000);
    await setIdentity(demoServer, accessCode, {
      environmentName: "staging",
      headerColor: "teal",
      headerPattern: "dots",
    });
    try {
      await page.goto("/next/settings/general");
      await expect(
        page.locator('[data-testid="card-general"] .s-card-title'),
      ).toContainText("Instance identity & header appearance");
      await expect(page.getByTestId("identity-preview-tab")).toContainText(
        "[staging] Inbox — Grain",
      );

      // Update name, color, and pattern.
      await page.getByTestId("input-environment-name").fill("prod-cluster-01");
      await page.getByTestId("settings-header-color-forest").click();
      await page.getByTestId("settings-header-pattern-diagonal").click();

      await expect(page.getByTestId("identity-preview-tab")).toContainText(
        "[prod-cluster-01] Inbox — Grain",
      );
      await expect(page.getByTestId("identity-preview-topbar")).toHaveAttribute(
        "data-header-color",
        "forest",
      );
      await expect(page.getByTestId("identity-preview-topbar")).toHaveAttribute(
        "data-header-pattern",
        "diagonal",
      );

      // Preview plan diff shows human-readable labels.
      await page.getByTestId("settings-plan-btn").click();
      const plan = page.getByTestId("settings-plan-preview");
      await expect(plan).toBeVisible();
      await expect(plan).toContainText("Instance name");
      await expect(plan).toContainText("Header color theme");
      await expect(plan).toContainText("Header pattern");

      // Save changes updates top bar, title, and favicon immediately.
      await page.getByTestId("settings-save-btn").click();
      await expect(page.getByTestId("settings-save-bar")).toBeHidden();

      const topBar = page.locator("header.top-bar");
      await expect(topBar).toHaveAttribute("data-header-color", "forest");
      await expect(topBar).toHaveAttribute("data-header-pattern", "diagonal");
      await expect(page.getByTestId("instance-identity-badge")).toContainText(
        "prod-cluster-01",
      );
      await expect(page).toHaveTitle(/^\[prod-cluster-01\] /);

      expect(await axe()).toEqual([]);
    } finally {
      await setIdentity(demoServer, accessCode, {
        environmentName: "",
        headerColor: "",
        headerPattern: "",
      });
    }
  });

  test("hides unnamed cue on phone and ellipsizes long instance names without clipping top-bar actions @phone", async ({
    page,
    demoServer,
    accessCode,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await setIdentity(demoServer, accessCode, {
      environmentName: "",
      headerColor: "",
      headerPattern: "",
    });
    try {
      await page.goto("inbox");
      // Unnamed cue is hidden below 600px to preserve mobile header space.
      await expect(page.getByTestId("instance-name-cue")).toBeHidden();

      // Now configure a max-length 32-character name + plum + dots.
      await setIdentity(demoServer, accessCode, {
        environmentName: "production-us-central-cluster-01",
        headerColor: "plum",
        headerPattern: "dots",
      });
      await page.reload();

      const topBar = page.locator("header.top-bar");
      const badge = page.getByTestId("instance-identity-badge");
      await expect(topBar).toHaveAttribute("data-header-color", "plum");
      await expect(topBar).toHaveAttribute("data-header-pattern", "dots");
      await expect(badge).toBeVisible();

      const barBox = await topBar.boundingBox();
      const brandBox = await page.locator(".top-brand-cluster").boundingBox();
      const actionsBox = await page.locator(".top-actions").boundingBox();
      const badgeBox = await badge.boundingBox();
      const avatarBox = await page.getByTestId("avatar-btn").boundingBox();

      expect(barBox).not.toBeNull();
      expect(brandBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(badgeBox).not.toBeNull();
      expect(avatarBox).not.toBeNull();

      // Badge ellipsizes cleanly and never overlaps .top-actions or clips off screen.
      expect(badgeBox!.width).toBeLessThanOrEqual(86);
      expect(brandBox!.x + brandBox!.width).toBeLessThanOrEqual(
        actionsBox!.x + 1,
      );
      expect(avatarBox!.x + avatarBox!.width).toBeLessThanOrEqual(390);
      expect(actionsBox!.y).toBeGreaterThanOrEqual(barBox!.y);
      expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(
        barBox!.y + barBox!.height + 1,
      );

      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(sideways).toBe(0);

      // General settings pickers also fit cleanly on phone with zero horizontal overflow.
      await page.goto("/next/settings/general");
      await expect(page.getByTestId("identity-settings-preview")).toBeVisible();
      const settingsSideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(settingsSideways).toBe(0);
    } finally {
      await setIdentity(demoServer, accessCode, {
        environmentName: "",
        headerColor: "",
        headerPattern: "",
      });
    }
  });
});
