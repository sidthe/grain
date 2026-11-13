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

// Verifies [G-04] deployment-wide memory repoLimits enforcement in /next/context
// against a real `grain demo` backend + real namespace projection (/api/fs/).

import { test, expect } from "./fixtures.js";

test("enforces deployment memory repoLimits", async ({ page }) => {
  const memResp = await page.request.get("/api/memory");
  expect(memResp.ok()).toBe(true);
  const existing = (await memResp.json()) ?? [];
  const origGlobal = existing.find((m) => !m.repo)?.text ?? "";
  const origWidgets =
    existing.find((m) => m.repo === "acme/widgets")?.text ?? "";

  await page.request.put("/api/memory", {
    data: { repo: "", text: "DEPLOYMENT_ONLY_SENTINEL" },
  });
  await page.request.put("/api/memory", {
    data: { repo: "acme/widgets", text: "WIDGETS_ONLY_SENTINEL" },
  });

  try {
    const requestedUrls = [];
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/")) requestedUrls.push(u);
    });

    await page.route("**/api/config", async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.targetRepos = ["acme/widgets"];
      body.access = {
        role: "widgets-dev",
        roles: ["widgets-dev"],
        full: false,
        scopes: ["memory:read", "memory:write", "settings:read"],
        repoLimits: {
          "memory:read": ["acme/widgets"],
          "memory:write": ["acme/widgets"],
        },
      };
      await route.fulfill({ response: resp, json: body });
    });

    await page.goto("/next/context");
    await expect(page.getByTestId("memory-scope-title")).toContainText(
      "acme/widgets",
    );
    await expect(page.getByTestId("context-scope-deployment")).toBeDisabled();
    await expect(page.getByTestId("memory-textarea")).toHaveValue(
      /WIDGETS_ONLY_SENTINEL/,
    );

    // Switch to Namespace Browser and verify config:// and global memory:// are blocked.
    await page.getByTestId("context-tab-namespace").click();
    await expect(page.getByTestId("fs-entry-repos")).toBeVisible();
    await expect(page.getByTestId("fs-scheme-config")).toHaveCount(0);

    if ((await page.getByTestId("fs-entry-global").count()) > 0) {
      await page.getByTestId("fs-entry-global").click();
      expect(
        requestedUrls.some((u) => u.includes("/api/fs/memory/global")),
      ).toBe(false);
    }

    await page.getByTestId("fs-grep-input").fill("SENTINEL");
    await page.getByTestId("fs-grep-btn").click();
    await expect(page.getByTestId("fs-grep-results")).toContainText(
      "WIDGETS_ONLY_SENTINEL",
    );
    await expect(page.getByTestId("fs-grep-results")).not.toContainText(
      "DEPLOYMENT_ONLY_SENTINEL",
    );
    expect(
      requestedUrls.some(
        (u) =>
          u.includes("/api/fs/config/") ||
          (u.includes("/api/fs/memory/") &&
            u.includes("grep=") &&
            !u.includes("/api/fs/memory/repos/acme/widgets")),
      ),
    ).toBe(false);

    // Switch to write-only repoLimits: deployment scope readable, writes disabled.
    await page.unroute("**/api/config");
    await page.route("**/api/config", async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.targetRepos = ["acme/widgets"];
      body.access = {
        role: "widgets-writer",
        roles: ["widgets-writer"],
        full: false,
        scopes: ["memory:read", "memory:write", "settings:read"],
        repoLimits: {
          "memory:write": ["acme/widgets"],
          "settings:read": ["acme/widgets"],
        },
      };
      await route.fulfill({ response: resp, json: body });
    });

    await page.goto("/next/context");
    await page.getByTestId("context-scope-deployment").click();
    await expect(page.getByTestId("memory-textarea")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(page.getByTestId("memory-write-denied")).toBeVisible();
    await expect(page.getByTestId("memory-save-btn")).toHaveCount(0);

    await page.getByTestId("context-tab-documents").click();
    await expect(page.getByTestId("doc-new-btn")).toBeDisabled();
  } finally {
    await page.request.put("/api/memory", {
      data: { repo: "", text: origGlobal },
    });
    await page.request.put("/api/memory", {
      data: { repo: "acme/widgets", text: origWidgets },
    });
  }
});
