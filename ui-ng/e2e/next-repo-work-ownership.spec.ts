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

async function workOwnershipOf(page: import("@playwright/test").Page) {
  const res = await page.request.get("/api/repos/acme/widgets/work-ownership");
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{
    default: string;
    defaultRuns: boolean;
    items: { item: string; override: string; runs: boolean; title?: string }[];
  }>;
}

test(
  "Work ownership card renders cleanly with aligned controls, zero horizontal overflow, and no axe violations",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }) => {
    await page.goto("repos/acme/widgets/releases");
    const card = page.getByTestId("card-repo-work-ownership");
    await expect(
      card.getByRole("heading", { name: "Work ownership" }),
    ).toBeVisible();
    await expect(
      card.getByRole("switch", { name: "Standing work on this deployment" }),
    ).toBeVisible();
    await expect(
      card.getByRole("group", { name: "the repository default" }),
    ).toBeVisible();

    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(sideways, "the page scrolls sideways").toBeLessThanOrEqual(0);

    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    const defaultButtons = [
      card.getByRole("button", { name: "the repository default: on" }),
      card.getByRole("button", { name: "the repository default: off" }),
      card.getByRole("button", { name: "the repository default: say nothing" }),
    ];
    const boxes = await Promise.all(defaultButtons.map((b) => b.boundingBox()));
    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(24);
      expect(box!.height).toBeGreaterThanOrEqual(24);
      expect(box!.x).toBeGreaterThanOrEqual(cardBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        cardBox!.x + cardBox!.width + 1,
      );
    }
    const centerY0 = boxes[0]!.y + boxes[0]!.height / 2;
    for (const box of boxes.slice(1)) {
      expect(Math.abs(box!.y + box!.height / 2 - centerY0)).toBeLessThan(2);
    }

    const violations = await axe();
    expect(
      violations.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`),
    ).toEqual([]);
  },
);

test(
  "edits work ownership, clears overrides, and syncs release settings",
  { tag: ["@desktop"] },
  async ({ page }) => {
    const initial = await workOwnershipOf(page);
    const initialRelease =
      initial.items.find((i) => i.item === "release")?.override ?? "";

    try {
      await page.goto("repos/acme/widgets/releases");
      const card = page.getByTestId("card-repo-work-ownership");
      const standingSwitch = card.getByRole("switch", {
        name: "Standing work on this deployment",
      });
      const releaseSwitch = page.getByRole("switch", {
        name: "Enable release workflow",
      });
      const releaseRow = page.getByTestId("wo-item-row-release");

      await expect(standingSwitch).toHaveAttribute("aria-checked", "true");
      await expect(
        card.getByRole("button", {
          name: "the repository default: say nothing",
        }),
      ).toHaveAttribute("aria-pressed", "true");

      // Set repository default to "off" via keyboard and verify focus stays intact
      const defaultOffBtn = card.getByRole("button", {
        name: "the repository default: off",
      });
      const putDefaultOff = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/work-ownership") &&
          r.request().method() === "PUT",
      );
      await defaultOffBtn.focus();
      await page.keyboard.press("Enter");
      expect((await putDefaultOff).status()).toBe(200);
      await expect(defaultOffBtn).toBeFocused();

      await expect(standingSwitch).toHaveAttribute("aria-checked", "false");
      await expect(
        card.getByText("Does not run this repository's work"),
      ).toBeVisible();
      await expect(releaseRow).toContainText("Nobody has said");
      await expect(releaseRow).toContainText("Not run");
      await expect(releaseSwitch).toHaveAttribute("aria-checked", "false");

      // Reload and verify persistence
      await page.reload();
      await expect(standingSwitch).toHaveAttribute("aria-checked", "false");
      await expect(
        card.getByRole("button", { name: "the repository default: off" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(releaseRow).toContainText("Not run");

      // Override Release item to "on" beneath a default of "off"
      const putReleaseOn = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/work-ownership") &&
          r.request().method() === "PUT",
      );
      await card.getByRole("button", { name: "Release: on" }).click();
      expect((await putReleaseOn).status()).toBe(200);

      await expect(
        card.getByRole("button", { name: "Release: on" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(releaseRow).toContainText("On, set here");
      await expect(releaseRow).toContainText("Runs");
      await expect(releaseSwitch).toHaveAttribute("aria-checked", "true");

      // Flip Standing work switch back on
      const putSwitchOn = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/work-ownership") &&
          r.request().method() === "PUT",
      );
      await standingSwitch.click();
      expect((await putSwitchOn).status()).toBe(200);
      await expect(standingSwitch).toHaveAttribute("aria-checked", "true");
      await expect(
        card.getByRole("button", { name: "the repository default: on" }),
      ).toHaveAttribute("aria-pressed", "true");

      // Clear both overrides back to "say nothing"
      await card.getByRole("button", { name: "Release: say nothing" }).click();
      await expect(releaseRow).toContainText("Nobody has said");
      await card
        .getByRole("button", { name: "the repository default: say nothing" })
        .click();
      await expect(
        card.getByRole("button", {
          name: "the repository default: say nothing",
        }),
      ).toHaveAttribute("aria-pressed", "true");

      await page.reload();
      await expect(
        card.getByRole("button", {
          name: "the repository default: say nothing",
        }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        card.getByRole("button", { name: "Release: say nothing" }),
      ).toHaveAttribute("aria-pressed", "true");

      // Verify Save release settings updates Work ownership Release row without reload
      await releaseSwitch.click();
      await page.getByTestId("save-repo-release-btn").click();
      await expect(releaseRow).toContainText("Off, set here");
      await expect(releaseRow).toContainText("Not run");
    } finally {
      await page.request.put("/api/repos/acme/widgets/work-ownership", {
        data: { default: initial.default },
      });
      await page.request.put("/api/repos/acme/widgets/work-ownership", {
        data: { item: "release", state: initialRelease },
      });
    }
  },
);
