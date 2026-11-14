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

test("shows [truncated] grep footer notice when memory search exceeds match limit and hides it when cleared or non-truncated", async ({
  page,
  axe,
}) => {
  const docName = "e2e-grep-limit-notice";
  const lines = Array.from(
    { length: 112 },
    (_, i) => `Line ${String(i + 1).padStart(3, "0")}: truncated-needle-match`,
  ).join("\n");

  const putRes = await page.request.put("/api/memory/documents", {
    data: {
      repo: "",
      name: docName,
      summary: "E2E fixture exceeding grep match limit.",
      text: lines,
    },
  });
  expect(putRes.ok(), `seed memory doc: ${putRes.status()}`).toBe(true);

  try {
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto("context?tab=namespace");

      const grepInput = page.getByLabel("Grep namespace files");
      const grepBtn = page.getByRole("button", { name: "Grep", exact: true });

      const grepRespPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/fs/memory/") &&
          res.url().includes("grep=truncated-needle-match"),
      );
      await grepInput.fill("truncated-needle-match");
      await grepBtn.click();
      const grepResp = await grepRespPromise;
      expect(grepResp.headers()["x-grain-truncated"]).toBe("true");
      expect(grepResp.headers()["x-grain-matches"]).toBe("100");

      const results = page.getByTestId("fs-grep-results");
      await expect(results).toBeVisible();
      await expect(results.getByRole("listitem")).toHaveCount(100);
      await expect(results).not.toContainText("[truncated");

      const footer = page.getByTestId("fs-grep-truncated");
      await expect(footer).toBeVisible();
      await expect(footer).toHaveAttribute("role", "status");
      await expect(footer).toContainText(
        "[truncated at match limit (100 matches)",
      );

      // Layout check: results list has non-collapsed height, footer sits below it inside the viewport with zero horizontal overflow.
      const listBox = await results.boundingBox();
      const footerBox = await footer.boundingBox();
      expect(listBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect(listBox!.height).toBeGreaterThan(40);
      expect(footerBox!.height).toBeGreaterThan(20);
      expect(footerBox!.y).toBeGreaterThanOrEqual(
        listBox!.y + listBox!.height - 1,
      );
      expect(footerBox!.x).toBeGreaterThanOrEqual(0);
      expect(footerBox!.x + footerBox!.width).toBeLessThanOrEqual(vp.width);
      expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(vp.height);

      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(sideways).toBe(0);
      expect(await axe()).toEqual([]);

      // Non-truncated search hides the footer notice.
      await grepInput.fill("Line 001: truncated-needle-match");
      await grepBtn.click();
      await expect(results.getByRole("listitem")).toHaveCount(1);
      await expect(footer).toBeHidden();

      // Clear search hides both results and footer.
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(results).toBeHidden();
      await expect(footer).toBeHidden();
    }
  } finally {
    await page.request
      .put("/api/memory/documents", {
        data: { repo: "", name: docName, summary: "", text: "" },
      })
      .catch(() => undefined);
  }
});
