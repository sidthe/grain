// Copyright 2026 The Grain Authors
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

type Page = Parameters<Parameters<typeof test>[1]>[0]["page"];

async function getCiCapabilitiesState(page: Page) {
  const res = await page.request.get("/api/repos/acme/widgets/ci-capabilities");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    ciCapabilities?: string[] | null;
    availableCICapabilities?: string[];
  };
  return {
    ciCapabilities: Array.isArray(body.ciCapabilities)
      ? body.ciCapabilities
      : [],
    availableCICapabilities: Array.isArray(body.availableCICapabilities)
      ? body.availableCICapabilities
      : [],
  };
}

async function getAgentSettingsState(page: Page) {
  const [settingsRes, capsRes] = await Promise.all([
    page.request.get("/api/repos/acme/widgets/settings"),
    page.request.get("/api/repos/acme/widgets/capabilities"),
  ]);
  expect(settingsRes.ok()).toBe(true);
  expect(capsRes.ok()).toBe(true);
  const settings = (await settingsRes.json()) as {
    setupCommand?: string;
    promptExtension?: string;
  };
  const caps = (await capsRes.json()) as {
    defaultCapabilities?: string[] | null;
  };
  return {
    setupCommand: settings.setupCommand ?? "",
    promptExtension: settings.promptExtension ?? "",
    defaultCapabilities: Array.isArray(caps.defaultCapabilities)
      ? caps.defaultCapabilities
      : [],
  };
}

test("CI capabilities editor toggles offered items, manages CI grants without API scopes, and persists across reload", async ({
  page,
  axe,
}) => {
  const before = await getCiCapabilitiesState(page);
  const methodsRes = await page.request.get(
    "/api/capability-methods?kind=ci&repo=acme/widgets",
  );
  expect(methodsRes.ok()).toBe(true);
  const methodsBody = (await methodsRes.json()) as
    | { ref: string; policyRefusal?: string; requiresArgs?: boolean }[]
    | {
        items?: {
          ref: string;
          policyRefusal?: string;
          requiresArgs?: boolean;
        }[];
        methods?: {
          ref: string;
          policyRefusal?: string;
          requiresArgs?: boolean;
        }[];
      };
  const methodList = Array.isArray(methodsBody)
    ? methodsBody
    : (methodsBody.items ?? methodsBody.methods ?? []);
  const availableSet = new Set(before.availableCICapabilities);
  const extraGrantMethod = methodList.find(
    (m) =>
      !m.requiresArgs &&
      !m.policyRefusal &&
      !m.ref.startsWith("https://grain.dev/capabilities/api#") &&
      m.ref !== "https://grain.dev/capabilities/grain#ci" &&
      m.ref !== "https://grain.dev/capabilities/repo#target" &&
      m.ref !== "https://grain.dev/capabilities/repo#credential" &&
      !availableSet.has(m.ref) &&
      !availableSet.has(`${m.ref}={}`),
  );
  expect(extraGrantMethod).toBeDefined();

  try {
    await page.goto("/next/repos/acme/widgets/ci");
    const card = page.getByTestId("card-repo-ci-capabilities");
    await expect(card).toBeVisible();
    await expect(page.locator("select")).toHaveCount(0);

    // Toggle the first offered CI capability pill if the demo offers any.
    const capBtns = card.locator('[data-testid^="ci-cap-option-"]');
    const capCount = await capBtns.count();
    if (capCount > 0) {
      const firstBtn = capBtns.first();
      const wasPressed =
        (await firstBtn.getAttribute("aria-pressed")) === "true";
      const putPromise = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await firstBtn.click();
      expect((await putPromise).status()).toBe(200);
      await expect(firstBtn).toHaveAttribute(
        "aria-pressed",
        wasPressed ? "false" : "true",
      );

      await page.reload();
      await expect(
        card.locator('[data-testid^="ci-cap-option-"]').first(),
      ).toHaveAttribute("aria-pressed", wasPressed ? "false" : "true");

      // Restore pill toggle before testing grant workflow.
      const restorePut = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await card.locator('[data-testid^="ci-cap-option-"]').first().click();
      expect((await restorePut).status()).toBe(200);
    }

    // Open CI grants builder: API scope tab must not exist for CI jobs.
    await page.getByTestId("repo-ci-grants-add-open").click();
    await expect(page.getByTestId("repo-ci-grants-builder")).toBeVisible();
    await expect(page.getByTestId("repo-ci-grants-mode-api")).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);

    // Switching to Raw mode rejects api: scope grants inline without sending PUT.
    await page.getByTestId("repo-ci-grants-mode-raw").click();
    await page.getByTestId("repo-ci-grants-raw-input").fill("api:tasks-read");
    let putSentOnInvalidGrant = false;
    const onReq = (req: { url(): string; method(): string }) => {
      if (
        req.url().endsWith("/api/repos/acme/widgets/ci-capabilities") &&
        req.method() === "PUT"
      ) {
        putSentOnInvalidGrant = true;
      }
    };
    page.on("request", onReq);
    await page.getByTestId("repo-ci-grants-attach").click();
    await expect(page.getByTestId("repo-ci-grants-error")).toContainText(
      "CI jobs cannot hold API scope grants.",
    );
    expect(putSentOnInvalidGrant).toBe(false);
    page.off("request", onReq);

    // If an extra non-picker CI method is offered, add it in Method mode, reload, and remove it.
    if (extraGrantMethod) {
      await page.getByTestId("repo-ci-grants-mode-method").click();
      await page.getByTestId("repo-ci-grants-method-ref").click();
      await page
        .getByRole("option", {
          name: new RegExp(
            extraGrantMethod.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          ),
        })
        .click();
      const putGrant = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await page.getByTestId("repo-ci-grants-attach").click();
      expect((await putGrant).status()).toBe(200);
      await expect(page.getByTestId("remove-grant-0")).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("remove-grant-0")).toBeVisible();

      const removePut = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/repos/acme/widgets/ci-capabilities") &&
          r.request().method() === "PUT",
      );
      await page.getByTestId("remove-grant-0").click();
      expect((await removePut).status()).toBe(200);
      await expect(page.getByTestId("remove-grant-0")).toHaveCount(0);
    }

    expect(await axe()).toEqual([]);
  } finally {
    await page.request.put("/api/repos/acme/widgets/ci-capabilities", {
      data: { ciCapabilities: before.ciCapabilities },
    });
  }
});

test("Agent settings prevents silent save on invalid input, shows sequential explicit errors, and saves valid values", async ({
  page,
  axe,
}) => {
  const before = await getAgentSettingsState(page);
  try {
    await page.goto("/next/repos/acme/widgets/agents");
    const setupInput = page.getByTestId("input-repo-setup-cmd");
    const promptInput = page.getByTestId("input-repo-prompt-ext");
    const capsInput = page.getByTestId("input-repo-caps");
    const saveBtn = page.getByTestId("save-repo-agents-btn");

    await expect(saveBtn).toBeVisible();
    await expect(page.locator("select")).toHaveCount(0);

    // 1. Single invalid capability (CI-only) blocks save with zero PUTs and inline + alert feedback.
    let mutatingRequests = 0;
    const trackMutations = (req: { url(): string; method(): string }) => {
      if (
        req.method() === "PUT" &&
        req.url().includes("/api/repos/acme/widgets/")
      ) {
        mutatingRequests++;
      }
    };
    page.on("request", trackMutations);

    await capsInput.fill("package-publish");
    await saveBtn.click();
    await expect(page.getByTestId("error-repo-caps")).toContainText(
      "CI-only capability",
    );
    await expect(capsInput).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("agents-save-error")).toContainText(
      "CI-only capability",
    );
    expect(mutatingRequests).toBe(0);

    // 2. Multi-field invalid state reports numbered sequential errors and focuses the first field.
    await setupInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = "npm\u0007ci";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await capsInput.fill("api:tasks-read, ,");
    await saveBtn.click();

    await expect(page.getByTestId("error-repo-setup-cmd")).toContainText(
      "invalid control characters",
    );
    await expect(page.getByTestId("error-repo-caps")).toContainText(
      "empty entry",
    );
    await expect(setupInput).toHaveAttribute("aria-invalid", "true");
    await expect(capsInput).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("agents-save-error")).toContainText(
      "1) Sandbox setup command:",
    );
    await expect(page.getByTestId("agents-save-error")).toContainText(
      "2) Default capabilities:",
    );
    await expect(setupInput).toBeFocused();
    expect(mutatingRequests).toBe(0);
    page.off("request", trackMutations);

    // 3. Valid values clear inline errors, save across PUT endpoints, and persist across reload.
    await setupInput.fill("echo e2e-setup");
    await expect(page.getByTestId("error-repo-setup-cmd")).toHaveCount(0);
    await promptInput.fill("Keep E2E assertions deterministic.");
    await capsInput.fill(before.defaultCapabilities.join(", "));
    await expect(page.getByTestId("error-repo-caps")).toHaveCount(0);

    const setupPut = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/repos/acme/widgets/setup-command") &&
        r.request().method() === "PUT",
    );
    const promptPut = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/repos/acme/widgets/prompt-extension") &&
        r.request().method() === "PUT",
    );
    const capsPut = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/repos/acme/widgets/capabilities") &&
        r.request().method() === "PUT",
    );
    await saveBtn.click();
    expect((await setupPut).status()).toBe(200);
    expect((await promptPut).status()).toBe(200);
    expect((await capsPut).status()).toBe(200);

    await page.reload();
    await expect(setupInput).toHaveValue("echo e2e-setup");
    await expect(promptInput).toHaveValue("Keep E2E assertions deterministic.");
    expect(await axe()).toEqual([]);
  } finally {
    await page.request.put("/api/repos/acme/widgets/setup-command", {
      data: { setupCommand: before.setupCommand },
    });
    await page.request.put("/api/repos/acme/widgets/prompt-extension", {
      data: { promptExtension: before.promptExtension },
    });
    await page.request.put("/api/repos/acme/widgets/capabilities", {
      data: { defaultCapabilities: before.defaultCapabilities },
    });
  }
});

test("390px mobile CI capabilities and Agents cards clear the phone FAB with zero horizontal overflow @phone @dark", async ({
  page,
  axe,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, cardTestId, bottomTestId] of [
    [
      "/next/repos/acme/widgets/ci",
      "card-repo-ci-capabilities",
      "repo-ci-grants-add-open",
    ],
    [
      "/next/repos/acme/widgets/agents",
      "card-repo-agents",
      "save-repo-agents-btn",
    ],
  ] as const) {
    await page.goto(path);
    const card = page.getByTestId(cardTestId);
    await expect(card).toBeVisible();

    const scrollInfo = await card.evaluate((el) => {
      let cur: HTMLElement | null = el.parentElement;
      while (cur) {
        const style = getComputedStyle(cur);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          cur.scrollHeight > cur.clientHeight
        ) {
          cur.scrollTop = cur.scrollHeight;
          return {
            paddingBottom: parseFloat(style.paddingBottom),
            overflowX: cur.scrollWidth - cur.clientWidth,
          };
        }
        cur = cur.parentElement;
      }
      return null;
    });
    expect(scrollInfo).not.toBeNull();
    expect(scrollInfo!.paddingBottom).toBeGreaterThanOrEqual(100);
    expect(scrollInfo!.overflowX).toBeLessThanOrEqual(0);

    const fab = page.getByTestId("phone-new-task");
    await expect(fab).toBeVisible();
    const fabBox = await fab.boundingBox();
    const cardBox = await card.boundingBox();
    const bottomBox = await page.getByTestId(bottomTestId).boundingBox();
    expect(fabBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(bottomBox).not.toBeNull();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(fabBox!.y);
    expect(bottomBox!.y + bottomBox!.height).toBeLessThanOrEqual(fabBox!.y);
    expect(bottomBox!.x + bottomBox!.width).toBeLessThanOrEqual(390);

    const docSideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(docSideways).toBe(0);
    expect(await axe()).toEqual([]);
  }
});

test("read-only viewer sees CI capabilities and Agent settings controls disabled", async ({
  page,
}) => {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...json,
        access: {
          role: "grain/viewer",
          roles: ["grain/viewer"],
          full: false,
          scopes: ["repos:read", "ci:read", "tasks:read", "capabilities:read"],
        },
      },
    });
  });

  await page.goto("/next/repos/acme/widgets/ci");
  await expect(page.getByTestId("ci-capabilities-write-denied")).toContainText(
    "capabilities:admin",
  );
  await expect(page.getByTestId("repo-ci-grants-add-open")).toHaveCount(0);
  const pills = page
    .getByTestId("card-repo-ci-capabilities")
    .locator('[data-testid^="ci-cap-option-"]');
  for (let i = 0; i < (await pills.count()); i++) {
    await expect(pills.nth(i)).toBeDisabled();
  }

  await page.goto("/next/repos/acme/widgets/agents");
  await expect(page.getByTestId("agent-repos-write-denied")).toContainText(
    "repos:write",
  );
  await expect(page.getByTestId("agent-caps-write-denied")).toContainText(
    "capabilities:admin",
  );
  await expect(page.getByTestId("input-repo-setup-cmd")).toBeDisabled();
  await expect(page.getByTestId("input-repo-prompt-ext")).toBeDisabled();
  await expect(page.getByTestId("input-repo-caps")).toBeDisabled();
  await expect(page.getByTestId("save-repo-agents-btn")).toBeDisabled();
});
