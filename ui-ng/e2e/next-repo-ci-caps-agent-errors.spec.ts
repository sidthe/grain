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

import { expect, test, type Page } from "./fixtures";

async function ciCapsOf(page: Page) {
  const res = await page.request.get("/api/repos/acme/widgets/ci-capabilities");
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{
    ciCapabilities?: string[] | null;
    availableCICapabilities?: string[];
  }>;
}

async function settingsOf(page: Page) {
  const res = await page.request.get("/api/repos/acme/widgets/settings");
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{
    setupCommand?: string;
    promptExtension?: string;
    defaultCapabilities?: string[];
  }>;
}

test(
  "CI capabilities card & Agent settings error state render cleanly with aligned controls, zero horizontal overflow, and no axe violations",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }) => {
    // 1. Check CI tab card, open "+ Add CI grant" builder, verify layout, hit targets, and axe
    await page.goto("repos/acme/widgets/ci");
    const ciCard = page.getByTestId("card-repo-ci-capabilities");
    await expect(
      ciCard.getByRole("heading", { name: "CI capabilities" }),
    ).toBeVisible();
    await expect(page.getByTestId("repo-ci-grants")).toBeVisible();

    const addOpenBtn = page.getByTestId("repo-ci-grants-add-open");
    await expect(addOpenBtn).toBeVisible();
    await addOpenBtn.click();
    await expect(page.getByTestId("repo-ci-grants-builder")).toBeVisible();
    await expect(page.getByTestId("repo-ci-grants-mode-api")).toHaveCount(0);

    const ciSideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(ciSideways, "CI tab scrolls sideways").toBeLessThanOrEqual(0);

    const ciCardBox = await ciCard.boundingBox();
    expect(ciCardBox).not.toBeNull();
    const attachBtn = page.getByTestId("repo-ci-grants-attach");
    const attachBox = await attachBtn.boundingBox();
    expect(attachBox).not.toBeNull();
    expect(attachBox!.height).toBeGreaterThanOrEqual(24);
    expect(attachBox!.x).toBeGreaterThanOrEqual(ciCardBox!.x);
    expect(attachBox!.x + attachBox!.width).toBeLessThanOrEqual(
      ciCardBox!.x + ciCardBox!.width + 1,
    );

    const ciViolations = await axe();
    expect(
      ciViolations.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`),
    ).toEqual([]);

    // 2. Check Agents tab error alert & inline errors layout, hit targets, and axe
    await page.goto("repos/acme/widgets/agents");
    const agentsCard = page.getByTestId("card-repo-agents");
    await expect(agentsCard.getByTestId("save-repo-agents-btn")).toBeVisible();

    const capsInput = agentsCard.getByTestId("input-repo-caps");
    await capsInput.fill("grain-ci, bad token");
    await agentsCard.getByTestId("save-repo-agents-btn").click();
    await expect(agentsCard.getByTestId("repo-agents-error")).toBeVisible();
    await expect(agentsCard.getByTestId("error-repo-caps")).toBeVisible();

    const agentsSideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(agentsSideways, "Agents tab scrolls sideways").toBeLessThanOrEqual(
      0,
    );

    const agentsCardBox = await agentsCard.boundingBox();
    const saveBox = await agentsCard
      .getByTestId("save-repo-agents-btn")
      .boundingBox();
    expect(agentsCardBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    expect(saveBox!.width).toBeGreaterThanOrEqual(24);
    expect(saveBox!.height).toBeGreaterThanOrEqual(24);
    expect(saveBox!.x).toBeGreaterThanOrEqual(agentsCardBox!.x);
    expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(
      agentsCardBox!.x + agentsCardBox!.width + 1,
    );

    const agentViolations = await axe();
    expect(
      agentViolations.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`),
    ).toEqual([]);
  },
);

test(
  "manages repo CI capabilities via method/custom grants and persists across reload",
  { tag: ["@desktop"] },
  async ({ page }) => {
    const initial = await ciCapsOf(page);
    const beforeCaps = initial.ciCapabilities ?? [];

    try {
      await page.goto("repos/acme/widgets/ci");
      const ciCard = page.getByTestId("card-repo-ci-capabilities");
      await expect(ciCard).toBeVisible();

      // Toggle offered "Package publish" CI capability pill on -> auto-saves via PUT & persists
      const pkgPill = ciCard.getByRole("button", { name: /Package publish/i });
      await expect(pkgPill).toHaveAttribute("aria-pressed", "false");
      const putToggleOn = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await pkgPill.click();
      expect((await putToggleOn).status()).toBe(200);
      await expect(pkgPill).toHaveAttribute("aria-pressed", "true");

      // Open "+ Add CI grant", confirm no API scope mode is exposed
      await page.getByTestId("repo-ci-grants-add-open").click();
      await expect(page.getByTestId("repo-ci-grants-builder")).toBeVisible();
      await expect(page.getByTestId("repo-ci-grants-mode-api")).toHaveCount(0);

      // Client rejects api:* custom grant without sending PUT
      await page.getByTestId("repo-ci-grants-mode-raw").click();
      await page.getByTestId("repo-ci-grants-raw-input").fill("api:tasks-read");
      await page.getByTestId("repo-ci-grants-attach").click();
      await expect(page.getByTestId("repo-ci-grants-error")).toContainText(
        "API scope",
      );

      // Attach a parameterized repo#read CI grant via Custom grant -> validated & saved via PUT as a held chip
      const readGrant =
        'https://grain.dev/capabilities/repo#read={"repo":"acme/widgets"}';
      const putAdd = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await page.getByTestId("repo-ci-grants-raw-input").fill(readGrant);
      await page.getByTestId("repo-ci-grants-attach").click();
      expect((await putAdd).status()).toBe(200);

      await expect
        .poll(async () => (await ciCapsOf(page)).ciCapabilities ?? [])
        .toContain(readGrant);

      // Reload and confirm both the ticked pill and the held chip persist
      await page.reload();
      await expect(
        ciCard.getByRole("button", { name: /Package publish/i }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(ciCard.locator(".grant-held-chip")).toContainText([
        /acme\/widgets/,
      ]);

      // Remove newly attached grant chip and untick pill -> removals persist
      const chips = ciCard.locator(".grant-held-chip");
      const count = await chips.count();
      expect(count).toBeGreaterThan(0);
      let targetIdx = -1;
      for (let i = 0; i < count; i++) {
        const text = await chips.nth(i).textContent();
        if (text?.includes("acme/widgets")) {
          targetIdx = i;
          break;
        }
      }
      expect(targetIdx).toBeGreaterThanOrEqual(0);
      const putRemove = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await page.getByTestId(`remove-grant-${targetIdx}`).click();
      expect((await putRemove).status()).toBe(200);

      await expect
        .poll(async () => (await ciCapsOf(page)).ciCapabilities ?? [])
        .not.toContain(readGrant);

      const putToggleOff = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await ciCard.getByRole("button", { name: /Package publish/i }).click();
      expect((await putToggleOff).status()).toBe(200);
      await expect(
        ciCard.getByRole("button", { name: /Package publish/i }),
      ).toHaveAttribute("aria-pressed", "false");
    } finally {
      await page.request.put("/api/repos/acme/widgets/ci-capabilities", {
        data: { ciCapabilities: beforeCaps },
      });
    }
  },
);

test(
  "reports client validation and sequential server errors explicitly on Save agent settings",
  { tag: ["@desktop"] },
  async ({ page }) => {
    const initial = await settingsOf(page);

    try {
      await page.goto("repos/acme/widgets/agents");
      const card = page.getByTestId("card-repo-agents");
      const setupInput = card.getByTestId("input-repo-setup-cmd");
      const promptInput = card.getByTestId("input-repo-prompt-ext");
      const capsInput = card.getByTestId("input-repo-caps");
      const saveBtn = card.getByTestId("save-repo-agents-btn");

      // 1. Client validation blocks save cleanly with zero PUTs and focuses invalid field
      let putCount = 0;
      const listener = (req: import("@playwright/test").Request) => {
        if (
          req.url().includes("/api/repos/acme/widgets/") &&
          req.method() === "PUT"
        ) {
          putCount++;
        }
      };
      page.on("request", listener);

      await setupInput.fill("npm ci");
      await promptInput.fill("Verify unit tests before PR.");
      await capsInput.fill("package-publish");
      await saveBtn.click();

      await expect(card.getByTestId("repo-agents-error")).toContainText(
        "Default capabilities",
      );
      await expect(capsInput).toHaveAttribute("aria-invalid", "true");
      await expect(card.getByTestId("error-repo-caps")).toBeVisible();
      await expect(capsInput).toBeFocused();
      expect(putCount).toBe(0);
      page.off("request", listener);

      // 2. Real server sequential failure: setup & prompt save 200, capabilities 400
      const setupResPromise = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/setup-command") &&
          r.request().method() === "PUT",
      );
      const promptResPromise = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/prompt-extension") &&
          r.request().method() === "PUT",
      );
      const capsResPromise = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/capabilities") &&
          r.request().method() === "PUT",
      );

      await capsInput.fill("nonexistent-capability-xyz");
      await saveBtn.click();

      expect((await setupResPromise).status()).toBe(200);
      expect((await promptResPromise).status()).toBe(200);
      expect((await capsResPromise).status()).toBe(400);

      const errBanner = card.getByTestId("repo-agents-error");
      await expect(errBanner).toBeVisible();
      await expect(errBanner).toContainText("Saved Sandbox setup command");
      await expect(errBanner).toContainText("Standing prompt extension");
      await expect(errBanner).toContainText("Default capabilities");
      await expect(capsInput).toHaveAttribute("aria-invalid", "true");
      await expect(capsInput).toBeFocused();

      // 3. Clearing invalid capability saves cleanly and persists across reload
      const validCapPut = page.waitForResponse(
        (r) =>
          r.url().includes("/api/repos/acme/widgets/capabilities") &&
          r.request().method() === "PUT",
      );
      await capsInput.fill("");
      await saveBtn.click();
      expect((await validCapPut).status()).toBe(200);
      await expect(errBanner).toBeHidden();

      await page.reload();
      await expect(setupInput).toHaveValue("npm ci");
      await expect(promptInput).toHaveValue("Verify unit tests before PR.");
    } finally {
      await page.request.put("/api/repos/acme/widgets/setup-command", {
        data: { setupCommand: initial.setupCommand ?? "" },
      });
      await page.request.put("/api/repos/acme/widgets/prompt-extension", {
        data: { promptExtension: initial.promptExtension ?? "" },
      });
      await page.request.put("/api/repos/acme/widgets/capabilities", {
        data: { defaultCapabilities: initial.defaultCapabilities ?? [] },
      });
    }
  },
);
