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

async function getUnfixableChecks(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
): Promise<string[]> {
  const res = await page.request.get(
    "/api/repos/acme/widgets/unfixable-checks",
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { unfixableChecks?: string[] | null };
  return Array.isArray(body.unfixableChecks) ? body.unfixableChecks : [];
}

test("Branches tab displays honest empty state when no Grain-managed branches exist @phone @dark", async ({
  page,
  axe,
}) => {
  await page.goto("/next/repos/acme/widgets/branches");
  await expect(
    page.getByRole("heading", { name: "Repository branches" }),
  ).toBeVisible();
  await expect(page.getByText("No Grain-managed branches yet")).toBeVisible();

  const sideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(sideways).toBe(0);
  expect(await axe()).toEqual([]);
});

test("Merge Queue Unfixable Checks editor validates, saves, persists across reload, and removes checks", async ({
  page,
  axe,
}) => {
  const before = await getUnfixableChecks(page);
  try {
    await page.goto("/next/repos/acme/widgets/merge-queue");
    await expect(
      page.getByRole("heading", { name: "Checks no commit here can clear" }),
    ).toBeVisible();
    await expect(page.getByText("This does not exempt them.")).toBeVisible();
    await expect(
      page.getByText(
        "grain treats every check acme/widgets reports as one a commit could turn green.",
      ),
    ).toBeVisible();

    const input = page.getByLabel("Check that cannot pass");
    const addBtn = page.getByRole("button", { name: "Add" });
    await expect(addBtn).toBeDisabled();

    // Refuse grain CI inline without sending PUT.
    await input.fill("grain ci");
    await expect(addBtn).toBeEnabled();
    await addBtn.click();
    await expect(page.getByRole("alert")).toContainText(
      "grain CI judges one exact commit on the branch",
    );
    expect(await getUnfixableChecks(page)).toEqual(before);

    // Typing clears warning; comma is also refused inline.
    await input.fill("a,b");
    await expect(page.getByTestId("unfixable-checks-warning")).toHaveCount(0);
    await addBtn.click();
    await expect(page.getByRole("alert")).toContainText("comma-separated list");
    expect(await getUnfixableChecks(page)).toEqual(before);

    // Valid add persists across reload.
    await input.fill("cla/google");
    const putAdd = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/repos/acme/widgets/unfixable-checks") &&
        r.request().method() === "PUT",
    );
    await addBtn.click();
    expect((await putAdd).status()).toBe(200);
    await expect(input).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Stop declaring cla/google unfixable" }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Stop declaring cla/google unfixable" }),
    ).toBeVisible();
    expect(await getUnfixableChecks(page)).toEqual(["cla/google"]);

    // Case-insensitive duplicate refused inline.
    await input.fill("CLA/Google");
    await addBtn.click();
    await expect(page.getByRole("alert")).toContainText(
      "acme/widgets already declares CLA/Google unfixable",
    );

    // Withdraw check and verify persistence after reload.
    const putRemove = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/repos/acme/widgets/unfixable-checks") &&
        r.request().method() === "PUT",
    );
    await page
      .getByRole("button", { name: "Stop declaring cla/google unfixable" })
      .click();
    expect((await putRemove).status()).toBe(200);
    await expect(
      page.getByText(
        "grain treats every check acme/widgets reports as one a commit could turn green.",
      ),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByText(
        "grain treats every check acme/widgets reports as one a commit could turn green.",
      ),
    ).toBeVisible();
    expect(await getUnfixableChecks(page)).toEqual([]);
    expect(await axe()).toEqual([]);
  } finally {
    await page.request.put("/api/repos/acme/widgets/unfixable-checks", {
      data: { unfixableChecks: before },
    });
  }
});

test("390px mobile Merge Queue Unfixable Checks editor clears the phone FAB with zero horizontal overflow @phone @dark", async ({
  page,
  axe,
}) => {
  const before = await getUnfixableChecks(page);
  const longCheck =
    "ci/very-long-external-status-check-name-that-wraps-cleanly-on-mobile";
  try {
    await page.request.put("/api/repos/acme/widgets/unfixable-checks", {
      data: { unfixableChecks: [longCheck] },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/next/repos/acme/widgets/merge-queue");

    const card = page.getByTestId("card-repo-unfixable-checks");
    await expect(card).toBeVisible();
    await expect(page.getByText(longCheck)).toBeVisible();

    // Scroll the scrollable container holding the card all the way to the bottom.
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

    const cardBox = await card.boundingBox();
    const addBtnBox = await page
      .getByRole("button", { name: "Add" })
      .boundingBox();
    const fabBox = await fab.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(addBtnBox).not.toBeNull();
    expect(fabBox).not.toBeNull();

    // Bottom of the editor card and its Add button sit cleanly above the floating FAB.
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(fabBox!.y);
    expect(addBtnBox!.y + addBtnBox!.height).toBeLessThanOrEqual(fabBox!.y);
    expect(addBtnBox!.x + addBtnBox!.width).toBeLessThanOrEqual(390);

    // Verify Add button is actually clickable on 390px viewport without FAB intercepting.
    await page.getByLabel("Check that cannot pass").fill("cla/mobile-check");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(
      page.getByRole("button", {
        name: "Stop declaring cla/mobile-check unfixable",
      }),
    ).toBeVisible();

    const docSideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(docSideways).toBe(0);
    expect(await axe()).toEqual([]);
  } finally {
    await page.request.put("/api/repos/acme/widgets/unfixable-checks", {
      data: { unfixableChecks: before },
    });
  }
});

test("read-only viewer sees Unfixable Checks controls disabled without delete icons", async ({
  page,
}) => {
  const before = await getUnfixableChecks(page);
  try {
    await page.request.put("/api/repos/acme/widgets/unfixable-checks", {
      data: { unfixableChecks: ["cla/google"] },
    });
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
            scopes: ["repos:read", "ci:read", "tasks:read"],
          },
        },
      });
    });

    await page.goto("/next/repos/acme/widgets/merge-queue");
    await expect(page.getByText("cla/google")).toBeVisible();
    await expect(page.getByLabel("Check that cannot pass")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Stop declaring cla/google unfixable" }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("unfixable-checks-write-denied"),
    ).toContainText("repos:write");
  } finally {
    await page.request.put("/api/repos/acme/widgets/unfixable-checks", {
      data: { unfixableChecks: before },
    });
  }
});
