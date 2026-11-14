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
  "Context Namespace grep renders component-scoped [truncated] footer notice on limit overflow and walk truncation",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    test.setTimeout(120_000);
    const docName = `grep-limit-e2e-${testInfo.project.name}`;
    const overflowToken = `overflow-token-${testInfo.project.name}`;
    const singleToken = `single-token-${testInfo.project.name}`;

    const overflowLines = Array.from(
      { length: 120 },
      (_, i) => `- ${overflowToken} entry #${i + 1}`,
    ).join("\n");

    const putRes = await page.request.put("/api/memory/documents", {
      data: {
        repo: "",
        name: docName,
        summary: "Temporary E2E fixture exceeding 100 grep matches",
        text: `# Truncated Grep Fixture\n\n${singleToken} unique line\n${overflowLines}\n`,
      },
    });
    expect(putRes.ok()).toBe(true);

    try {
      await page.goto("context?tab=namespace");
      const searchInput = page.getByRole("searchbox", {
        name: "Grep namespace files",
      });
      const grepBtn = page.getByRole("button", { name: "Grep", exact: true });
      await expect(searchInput).toBeVisible();

      // 1. Non-truncated search must not display the footer notice.
      await searchInput.fill(singleToken);
      await grepBtn.click();
      const resultsList = page.getByTestId("fs-grep-results");
      await expect(resultsList.locator("li")).toHaveCount(1);
      await expect(page.getByTestId("fs-grep-truncated")).toHaveCount(0);

      // 2. Real backend match-limit truncation (>100 matches) sets X-Grain-Truncated and renders footer notice.
      const grepResponsePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/fs/memory/") &&
          res.url().includes(`grep=${encodeURIComponent(overflowToken)}`),
      );
      await searchInput.fill(overflowToken);
      await grepBtn.click();
      const grepRes = await grepResponsePromise;
      expect(grepRes.headers()["x-grain-truncated"]).toBe("true");
      expect(grepRes.headers()["x-grain-matches"]).toBe("100");

      await expect(resultsList.locator("li")).toHaveCount(100);
      const notice = page.getByRole("status").filter({
        hasText: /Search results truncated/i,
      });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(
        "[truncated at match limit (100 matches)",
      );
      await expect(page.getByTestId("fs-grep-count")).toContainText(
        "100 matches (truncated)",
      );

      // Layout & bounding-box checks: footer sits below list, stays inside left pane, and never overflows viewport.
      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(sideways).toBe(0);

      const paneBox = await page
        .getByRole("region", { name: "Context index" })
        .boundingBox();
      const listBox = await resultsList.boundingBox();
      const noticeBox = await notice.boundingBox();
      expect(paneBox).not.toBeNull();
      expect(listBox).not.toBeNull();
      expect(noticeBox).not.toBeNull();

      expect(noticeBox!.x).toBeGreaterThanOrEqual(paneBox!.x - 1);
      expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(
        paneBox!.x + paneBox!.width + 1,
      );
      expect(noticeBox!.y).toBeGreaterThanOrEqual(
        listBox!.y + listBox!.height - 1,
      );
      expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(
        paneBox!.y + paneBox!.height + 1,
      );

      // Verify CSS styling for .ctx-grep-truncated is scoped to g-context-page and leaves outside elements unstyled.
      const outsideStyled = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "ctx-grep-truncated";
        document.body.appendChild(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return bg;
      });
      expect(outsideStyled).toBe("rgba(0, 0, 0, 0)");

      // Axe accessibility + WCAG contrast on the truncation notice and page.
      expect(await axe()).toEqual([]);
      const contrast = await new AxeBuilder({ page })
        .include('[data-testid="fs-grep-truncated"]')
        .withRules(["color-contrast"])
        .analyze();
      expect(contrast.violations).toEqual([]);

      // 3. Clearing search removes both the results and the truncation notice.
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(resultsList).toHaveCount(0);
      await expect(notice).toHaveCount(0);

      // 4. Walk-limit truncation with 0 matches still alerts the user.
      const walkToken = "walk-limit-zero-matches";
      await page.route("**/api/fs/memory/**", async (route) => {
        const url = route.request().url();
        if (url.includes(`grep=${walkToken}`)) {
          await route.fulfill({
            status: 200,
            contentType: "text/plain; charset=utf-8",
            headers: {
              "X-Grain-Truncated": "true",
              "X-Grain-Walk-Truncated": "true",
              "X-Grain-Matches": "0",
            },
            body: "[truncated: walked 2000 entries and stopped at repos/acme/z.md; it and everything after it were not searched, so finding no match here does not mean there is none: narrow the path or pass --glob]\n",
          });
          return;
        }
        await route.continue();
      });

      await searchInput.fill(walkToken);
      await grepBtn.click();
      const walkNotice = page.getByRole("status").filter({
        hasText: /Search walk truncated/i,
      });
      await expect(walkNotice).toBeVisible();
      await expect(walkNotice).toContainText("walked 2000 entries");
      await expect(page.getByTestId("fs-grep-count")).toContainText(
        "0 matches (truncated)",
      );
      expect(await axe()).toEqual([]);
    } finally {
      await page.request.put("/api/memory/documents", {
        data: { repo: "", name: docName, summary: "", text: "" },
      });
    }
  },
);
