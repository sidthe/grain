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

// Dedicated demo store so testing real declaration acceptance never affects
// read-only specs running on the shared worker store.
test.use({ demoArgs: ["-open=false", "-as", "next-processes-declarations"] });

test("operator sees no scope warning and accepts an awaiting declaration end-to-end @phone @dark", async ({
  page,
  axe,
}) => {
  test.setTimeout(120_000);
  await page.goto("processes/declarations");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByTestId("decl-repo-row-acme/widgets").click();

  const item = page.getByTestId("decl-acc-item-ci:acme/widgets:deploy-preview");
  await expect(item).toBeVisible();
  await expect(
    page.getByTestId("decl-accept-warning-ci:acme/widgets:deploy-preview"),
  ).toHaveCount(0);

  const acceptBtn = page.getByTestId(
    "decl-accept-btn-ci:acme/widgets:deploy-preview",
  );
  await expect(acceptBtn).toBeEnabled();

  const [acceptResp] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/declarations/accept") &&
        res.request().method() === "POST",
    ),
    acceptBtn.click(),
  ]);
  expect(acceptResp.status()).toBe(200);
  const payload = acceptResp.request().postDataJSON() as {
    id: string;
    seen: string[];
  };
  expect(payload.id).toBe("ci:acme/widgets:deploy-preview");
  expect(payload.seen.length).toBeGreaterThan(0);

  await expect(item).toContainText("Accepted");
  await expect(
    page.getByTestId("decl-accept-btn-ci:acme/widgets:deploy-preview"),
  ).toHaveCount(0);

  const sideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(0);
  expect(await axe()).toEqual([]);
});
