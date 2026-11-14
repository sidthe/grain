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
import { test, expect } from "./fixtures.js";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const THEMES = ["light", "dark"];
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function settleSettings(page) {
  await page.waitForSelector('[data-testid="settings-section-heading"]', {
    timeout: 30_000,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
}

async function assertNoOverflowAndFitsCards(page, label) {
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const sw = doc.scrollWidth;
    const clipped = [];
    for (const card of document.querySelectorAll(".s-card")) {
      const cr = card.getBoundingClientRect();
      if (cr.width === 0) continue;
      if (cr.right > vw + 1) {
        clipped.push(`card-right(${cr.right}>${vw})`);
      }
      for (const el of card.querySelectorAll(
        ".s-banner, .s-field-error, .s-input",
      )) {
        const er = el.getBoundingClientRect();
        if (er.width === 0) continue;
        if (er.right > cr.right + 1 || er.left < cr.left - 1) {
          clipped.push(
            `${el.getAttribute("data-testid") || el.className}:${er.left}..${er.right} vs card ${cr.left}..${cr.right}`,
          );
        }
      }
    }
    return { vw, sw, clipped };
  });
  expect(layout.sw, `${label}: horizontal overflow`).toBeLessThanOrEqual(
    layout.vw,
  );
  expect(layout.clipped, `${label}: elements clipped outside card`).toEqual([]);
}

async function assertWcagClean(page, label) {
  const res = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const severe = res.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(severe, `${label}: a11y violations`).toEqual([]);
}

test("Settings Security - validates missing/invalid token scopes on mint, handles empty GCP keys, and passes layout + a11y across viewports and themes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/next/settings/access");
  await settleSettings(page);

  // Fresh demo has no GCP keys configured: shows explicit empty/missing-key state.
  await expect(page.getByTestId("gcp-keys-empty")).toBeVisible();

  const nameInput = page.getByTestId("input-gma-token-name");
  const scopesInput = page.getByTestId("input-gma-token-scopes");
  const mintBtn = page.getByTestId("mint-gma-token-btn");

  // Empty scopes show inline field error and block submission with card error state.
  await nameInput.fill("e2e-bot");
  await scopesInput.fill("");
  await expect(scopesInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("gma-token-scopes-error")).toContainText(
    "Enter at least one token scope",
  );
  await mintBtn.click();
  await expect(page.getByTestId("tokens-error")).toContainText(
    "Enter at least one token scope",
  );
  await expect(page.getByTestId("minted-gma-token")).toHaveCount(0);
  await expect(nameInput).toHaveValue("e2e-bot");

  // Reserved 'internal' and malformed @repo scopes also surface clear validation errors.
  await scopesInput.fill("internal");
  await expect(page.getByTestId("gma-token-scopes-error")).toContainText(
    "reserved for Grain internals",
  );
  await scopesInput.fill("tasks:read@invalidrepo");
  await expect(page.getByTestId("gma-token-scopes-error")).toContainText(
    "owner/name",
  );

  await assertNoOverflowAndFitsCards(page, "validation error state");
  await assertWcagClean(page, "validation error state");

  // Fixing scopes clears errors and mints cleanly against live grain demo backend.
  await scopesInput.fill("tasks:read,ci:read");
  await expect(page.getByTestId("gma-token-scopes-error")).toHaveCount(0);
  await mintBtn.click();
  await expect(page.getByTestId("minted-gma-token")).toBeVisible();
  await expect(page.getByTestId("minted-gma-token")).toContainText("gma_");
  await expect(page.getByTestId("card-external-agent-tokens")).toContainText(
    "e2e-bot",
  );
  await expect(page.getByTestId("card-external-agent-tokens")).toContainText(
    "tasks:read, ci:read",
  );

  // Check responsive layout & contrast in desktop/phone x light/dark.
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const theme of THEMES) {
      await page.evaluate(
        (t) => localStorage.setItem("grain.themeMode", t),
        theme,
      );
      await page.reload();
      await settleSettings(page);
      await assertNoOverflowAndFitsCards(page, `${vp.name}-${theme}`);
      await assertWcagClean(page, `${vp.name}-${theme}`);
    }
  }
});

test("Settings Security - displays clear missing-scope and missing-key states when caller/token metadata is incomplete", async ({
  page,
}) => {
  test.setTimeout(90_000);

  // 1. Missing API keys in server payloads (missing token scopes, missing token id, missing GCP fields)
  await page.route("**/api/external-agents/tokens", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "tok-no-scopes", name: "no-scopes-bot", active: true },
          { id: "", name: "", scopes: ["tasks:read"], active: true },
        ]),
      });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/gcp-keys", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ name: "partial-gcp", projectId: "" }]),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/next/settings/access");
  await settleSettings(page);

  await expect(
    page.getByTestId("gma-token-missing-scopes-tok-no-scopes"),
  ).toContainText("Missing scopes");
  await expect(page.getByTestId("gma-token-missing-id-1")).toContainText(
    "Missing token ID",
  );
  await expect(page.getByTestId("gcp-key-pill-partial-gcp")).toContainText(
    "missing projectId, serviceAccountEmail",
  );

  // Missing res.token key on mint shows error banner instead of false success.
  await page.getByTestId("input-gma-token-name").fill("omitted-secret");
  await page.getByTestId("mint-gma-token-btn").click();
  await expect(page.getByTestId("tokens-error")).toContainText(
    "missing the issued token secret key",
  );
  await expect(page.getByTestId("minted-gma-token")).toHaveCount(0);

  await assertNoOverflowAndFitsCards(page, "missing API key rows");
  await assertWcagClean(page, "missing API key rows");

  // 2. Caller token lacking required scopes renders explicit restriction banners across access & audit
  await page.unrouteAll();
  await page.route("**/api/config", async (route) => {
    const resp = await route.fetch();
    const cfg = await resp.json();
    cfg.access = {
      role: "grain/viewer",
      roles: ["grain/viewer"],
      full: false,
      missing: ["ops-custom-set"],
      scopes: ["settings:read", "access:read"],
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(cfg),
    });
  });

  await page.goto("/next/settings/access");
  await settleSettings(page);
  await expect(page.getByTestId("access-missing-role-sets")).toContainText(
    "ops-custom-set",
  );
  await expect(page.getByTestId("principals-write-restricted")).toContainText(
    "access:write",
  );
  await expect(page.getByTestId("tokens-restricted")).toContainText(
    "capabilities:read",
  );
  await expect(page.getByTestId("tokens-admin-restricted")).toContainText(
    "capabilities:admin",
  );
  await expect(page.getByTestId("gcp-keys-restricted")).toContainText(
    "secrets:read",
  );
  await expect(page.getByTestId("gcp-keys-write-restricted")).toContainText(
    "secrets:write",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoOverflowAndFitsCards(page, "viewer missing scopes phone");
  await assertWcagClean(page, "viewer missing scopes phone");

  // Partial audit scopes notice on /next/settings/audit
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/next/settings/audit");
  await settleSettings(page);
  await expect(page.getByTestId("audit-partial-restricted")).toContainText(
    "secrets:read",
  );
  await assertNoOverflowAndFitsCards(page, "audit partial scopes");
  await assertWcagClean(page, "audit partial scopes");
});

test("Settings Security - external agent tokens switch exposes accessible ARIA state across keyboard toggle and persistence", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/next/settings/access");
  await settleSettings(page);

  const toggle = page.getByRole("switch", {
    name: "Accept external agent tokens",
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute(
    "aria-describedby",
    "external-agent-api-hint",
  );
  await expect(toggle).toHaveAccessibleDescription(/gma_ tokens/);

  const box = await toggle.boundingBox();
  const rowBox = await page
    .locator(".s-toggle-row", { has: toggle })
    .boundingBox();
  expect(box).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  expect(box.x).toBeGreaterThanOrEqual(rowBox.x);

  const initial = await toggle.getAttribute("aria-checked");
  expect(["true", "false"]).toContain(initial);
  const toggled = initial === "true" ? "false" : "true";

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", toggled);
  await expect(page.getByTestId("settings-save-bar")).toBeVisible();

  await page.getByTestId("settings-save-btn").click();
  await expect(page.getByTestId("settings-save-bar")).toHaveCount(0);
  await page.reload();
  await settleSettings(page);

  await expect(
    page.getByRole("switch", { name: "Accept external agent tokens" }),
  ).toHaveAttribute("aria-checked", toggled);
  await assertWcagClean(page, "security toggle toggled");

  // Restore initial setting so demo state remains clean.
  await page
    .getByRole("switch", { name: "Accept external agent tokens" })
    .click();
  await expect(
    page.getByRole("switch", { name: "Accept external agent tokens" }),
  ).toHaveAttribute("aria-checked", initial);
  await page.getByTestId("settings-save-btn").click();
  await expect(page.getByTestId("settings-save-bar")).toHaveCount(0);
});
