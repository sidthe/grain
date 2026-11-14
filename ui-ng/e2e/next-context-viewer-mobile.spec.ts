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

import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dims = await page.evaluate(() => {
    const doc = document.documentElement;
    const panel = document.querySelector<HTMLElement>(".view-panel.is-active");
    return {
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      panelScroll: panel?.scrollWidth ?? 0,
      panelClient: panel?.clientWidth ?? 0,
    };
  });
  expect(dims.docScroll).toBeLessThanOrEqual(dims.docClient + 1);
  if (dims.panelClient > 0) {
    expect(dims.panelScroll).toBeLessThanOrEqual(dims.panelClient + 1);
  }
}

async function scrollContextToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".view-panel.is-active");
    if (panel) panel.scrollTop = panel.scrollHeight;
  });
}

async function assertClearsMobileChrome(
  page: Page,
  target: Locator,
  label: string,
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await expect(target, `${label} should be visible`).toBeVisible();
  const box = await target.boundingBox();
  expect(box, `${label} bounding box`).not.toBeNull();
  if (!box) return;

  const overlap = await page.evaluate((elRect) => {
    const intersects = (a: DOMRect | typeof elRect, b: DOMRect) =>
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;
    const chromeSelectors = [
      ".phone-fab",
      ".bottom-bar",
      ".compact-nav",
      ".top-bar",
    ];
    const hits: string[] = [];
    for (const sel of chromeSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (intersects(elRect, r)) {
        hits.push(
          `${sel}(${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)})`,
        );
      }
    }
    return hits;
  }, box);
  expect(overlap, `${label} overlaps shell chrome`).toEqual([]);

  const hitTest = await page.evaluate((b) => {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    return {
      isFab: !!topEl?.closest(".phone-fab"),
      isBottomChrome: !!topEl?.closest(".bottom-bar, .compact-nav, .top-bar"),
    };
  }, box);
  expect(hitTest.isFab, `${label} center covered by .phone-fab`).toBe(false);
  expect(hitTest.isBottomChrome, `${label} center covered by nav bar`).toBe(
    false,
  );
}

test(
  "Context page hides all write actions for grain/viewer and passes axe",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    test.setTimeout(90_000);
    const docName = `viewer-gating-${testInfo.project.name}`;
    const put = await page.request.put("/api/memory/documents", {
      data: {
        repo: "",
        name: docName,
        summary: "Read-only verification document for viewer role.",
        text: "# Architecture\n\nAll viewers may read rendered markdown packs safely.",
      },
    });
    expect(put.ok()).toBe(true);

    try {
      await page.route(
        (url) => url.pathname === "/api/config",
        async (route) => {
          const response = await route.fetch();
          const json = {
            ...(await response.json()),
            access: {
              role: "grain/viewer",
              roles: ["grain/viewer"],
              full: false,
              scopes: ["memory:read", "settings:read"],
            },
          };
          await route.fulfill({ response, json });
        },
      );

      await page.goto("context");
      await expect(page.getByTestId("context-page")).toBeVisible();
      await expect(page.getByTestId("context-refresh")).toBeEnabled();

      // Scope add action and Standing Instructions editor actions must stay hidden.
      await expect(page.getByTestId("context-add-repo-btn")).toHaveCount(0);
      await expect(page.getByTestId("memory-mode-edit")).toHaveCount(0);
      await expect(page.getByTestId("memory-mode-split")).toHaveCount(0);
      await expect(page.getByTestId("memory-mode-preview")).toHaveCount(0);
      await expect(page.getByTestId("memory-textarea")).toHaveCount(0);
      await expect(page.getByTestId("memory-save-btn")).toHaveCount(0);
      await expect(page.getByTestId("memory-revert-btn")).toHaveCount(0);
      await expect(page.getByTestId("memory-dirty-pill")).toHaveCount(0);
      await expect(page.getByTestId("memory-preview")).toBeVisible();
      await expect(page.getByTestId("memory-write-denied")).toContainText(
        "grain/viewer",
      );
      await assertNoHorizontalOverflow(page);

      if ((page.viewportSize()?.width ?? 1440) <= 600) {
        await scrollContextToBottom(page);
        await assertClearsMobileChrome(
          page,
          page.getByTestId("memory-write-denied"),
          "viewer memory-write-denied",
        );
      }

      expect(await axe()).toEqual([]);

      // Documents tab: + New pack and create hint hidden; document renders read-only summary + preview.
      await page
        .getByRole("tab", { name: /Memory Documents \(Packs\)/i })
        .click();
      await expect(page.getByTestId("doc-new-btn")).toHaveCount(0);
      await expect(page.getByTestId("doc-placeholder")).not.toContainText(
        "create a new pack",
      );

      await page.getByTestId(`doc-row-${docName}`).locator("button").click();
      await expect(page.getByTestId("doc-mode-edit")).toHaveCount(0);
      await expect(page.getByTestId("doc-mode-split")).toHaveCount(0);
      await expect(page.getByTestId("doc-mode-preview")).toHaveCount(0);
      await expect(page.getByTestId("doc-summary-input")).toHaveCount(0);
      await expect(page.getByTestId("doc-text-input")).toHaveCount(0);
      await expect(page.getByTestId("doc-save-btn")).toHaveCount(0);
      await expect(page.getByTestId("doc-revert-btn")).toHaveCount(0);
      await expect(page.getByTestId("doc-delete-btn")).toHaveCount(0);
      await expect(page.getByTestId("doc-summary-readonly")).toContainText(
        "Read-only verification document for viewer role.",
      );
      await expect(page.getByTestId("doc-preview")).toContainText(
        "All viewers may read rendered markdown packs safely.",
      );
      await expect(page.getByTestId("doc-write-denied")).toContainText(
        "grain/viewer",
      );
      await assertNoHorizontalOverflow(page);

      if ((page.viewportSize()?.width ?? 1440) <= 600) {
        await scrollContextToBottom(page);
        await assertClearsMobileChrome(
          page,
          page.getByTestId("doc-write-denied"),
          "viewer doc-write-denied",
        );
      }

      expect(await axe()).toEqual([]);
    } finally {
      await page.request
        .put("/api/memory/documents", {
          data: { repo: "", name: docName, summary: "", text: "" },
        })
        .catch(() => undefined);
    }
  },
);

test(
  "Context editor keeps clear separation from navigation and action chrome at 390px portrait and landscape",
  { tag: ["@phone", "@dark"] },
  async ({ page, axe }, testInfo) => {
    test.setTimeout(90_000);
    const docName = `mobile-layout-${testInfo.project.name}`;
    const put = await page.request.put("/api/memory/documents", {
      data: {
        repo: "",
        name: docName,
        summary: "Mobile layout clearance check for 390px viewports.",
        text: "# Release Checklist\n\n- Verify 390px mobile padding.\n- Verify safe clearance from .phone-fab and .compact-nav.",
      },
    });
    expect(put.ok()).toBe(true);

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("context");
      await expect(page.getByTestId("context-page")).toBeVisible();
      await expect(page.getByTestId("memory-textarea")).toBeVisible();

      // Add-repo inline form must not overflow 390px viewport.
      await page.getByTestId("context-add-repo-btn").click();
      await expect(page.getByTestId("context-add-repo-input")).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Cancel" }).click();

      // Standing Instructions scrolled to bottom clears .phone-fab, .bottom-bar, .compact-nav.
      await scrollContextToBottom(page);
      await assertClearsMobileChrome(
        page,
        page.getByTestId("memory-textarea"),
        "portrait memory-textarea",
      );
      await assertClearsMobileChrome(
        page,
        page.getByTestId("memory-save-btn"),
        "portrait memory-save-btn",
      );
      await assertClearsMobileChrome(
        page,
        page.getByTestId("memory-revert-btn"),
        "portrait memory-revert-btn",
      );
      await assertNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);

      // Memory Documents editor scrolled to bottom clears mobile chrome too.
      await page
        .getByRole("tab", { name: /Memory Documents \(Packs\)/i })
        .click();
      await page.getByTestId(`doc-row-${docName}`).locator("button").click();
      await expect(page.getByTestId("doc-text-input")).toBeVisible();
      await scrollContextToBottom(page);
      await assertClearsMobileChrome(
        page,
        page.getByTestId("doc-text-input"),
        "portrait doc-text-input",
      );
      await assertClearsMobileChrome(
        page,
        page.getByTestId("doc-save-btn"),
        "portrait doc-save-btn",
      );
      await assertClearsMobileChrome(
        page,
        page.getByTestId("doc-delete-btn"),
        "portrait doc-delete-btn",
      );
      await assertNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);

      // Landscape phone (844x390): split stacks vertically and editor/actions stay clear of chrome.
      await page.setViewportSize({ width: 844, height: 390 });
      await scrollContextToBottom(page);
      await assertClearsMobileChrome(
        page,
        page.getByTestId("doc-save-btn"),
        "landscape doc-save-btn",
      );
      await assertClearsMobileChrome(
        page,
        page.getByTestId("doc-delete-btn"),
        "landscape doc-delete-btn",
      );
      await assertNoHorizontalOverflow(page);

      await page.getByRole("tab", { name: /Standing Instructions/i }).click();
      await scrollContextToBottom(page);
      const memBox = await page.getByTestId("memory-textarea").boundingBox();
      expect(memBox?.height ?? 0).toBeGreaterThanOrEqual(140);
      await assertClearsMobileChrome(
        page,
        page.getByTestId("memory-save-btn"),
        "landscape memory-save-btn",
      );
      await assertNoHorizontalOverflow(page);
    } finally {
      await page.request
        .put("/api/memory/documents", {
          data: { repo: "", name: docName, summary: "", text: "" },
        })
        .catch(() => undefined);
    }
  },
);
