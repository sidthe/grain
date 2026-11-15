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

import { TestBed } from "@angular/core/testing";
import { CompositionViewComponent } from "./composition-view.component";
import type { Composition } from "./processes.models";

describe("CompositionViewComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CompositionViewComponent],
    }).compileComponents();
  });

  it("omits redundant title, separates scalar metadata and wide list rows, and renders body in a full-width well", () => {
    const fixture = TestBed.createComponent(CompositionViewComponent);
    const comp: Composition = {
      kind: "task",
      repo: "acme/widgets",
      base: "main",
      tasks: [
        {
          title: "Audit dependencies",
          templateName: "dep-audit",
          fields: [
            {
              name: "title",
              values: ["Audit dependencies"],
              source: "template",
            },
            { name: "repo", values: ["acme/widgets"], source: "schedule" },
            { name: "model", values: ["smart"], source: "deployment" },
            { name: "autoMerge", values: ["on"], source: "schedule" },
            { name: "reads", values: [], source: "default" },
            {
              name: "capabilities",
              values: ["repo#write", "gcp#key"],
              source: "template",
            },
            {
              name: "body",
              values: ["Paragraph one.\n\nParagraph two with details."],
              source: "template",
            },
          ],
        },
      ],
    };
    fixture.componentRef.setInput("composition", comp);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="comp-field-title"]')).toBeNull();

    const repoRow = root.querySelector('[data-testid="comp-field-repo"]')!;
    expect(repoRow).not.toBeNull();
    expect(repoRow.classList.contains("comp-row-wide")).toBe(false);
    expect(repoRow.textContent).toContain("acme/widgets");

    const emptyReadsRow = root.querySelector(
      '[data-testid="comp-field-reads"]',
    )!;
    expect(emptyReadsRow).not.toBeNull();
    expect(emptyReadsRow.classList.contains("comp-row-wide")).toBe(false);
    expect(emptyReadsRow.textContent).toContain("—");

    const capsRow = root.querySelector(
      '[data-testid="comp-field-capabilities"]',
    )!;
    expect(capsRow).not.toBeNull();
    expect(capsRow.classList.contains("comp-row-wide")).toBe(true);
    expect(capsRow.textContent).toContain("repo#write, gcp#key");

    const bodyRow = root.querySelector('[data-testid="comp-field-body"]')!;
    expect(bodyRow).not.toBeNull();
    expect(bodyRow.classList.contains("comp-row-wide")).toBe(true);

    const bodyWell = root.querySelector(
      '[data-testid="composition-body-well"]',
    )!;
    expect(bodyWell).not.toBeNull();
    expect(bodyWell.classList.contains("comp-body-well")).toBe(true);
    expect(bodyWell.classList.contains("is-clamped")).toBe(false);
    expect(bodyWell.textContent).toContain(
      "Paragraph one.\n\nParagraph two with details.",
    );
    expect(
      root.querySelector('[data-testid="composition-body-toggle"]'),
    ).toBeNull();
  });

  it("clamps body when exceeding 600 chars or 12 lines and toggles expand/collapse", () => {
    const fixture = TestBed.createComponent(CompositionViewComponent);
    const longBody = Array.from(
      { length: 16 },
      (_, i) =>
        `Step ${i + 1}: verify module boundaries and run targeted regression checks across packages.`,
    ).join("\n");
    const comp: Composition = {
      kind: "task",
      repo: "acme/widgets",
      tasks: [
        {
          title: "Long prompt task",
          fields: [
            { name: "repo", values: ["acme/widgets"], source: "template" },
            { name: "body", values: [longBody], source: "template" },
          ],
        },
      ],
    };
    fixture.componentRef.setInput("composition", comp);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const bodyWell = root.querySelector(
      '[data-testid="composition-body-well"]',
    )!;
    const toggleBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="composition-body-toggle"]',
    )!;

    expect(bodyWell).not.toBeNull();
    expect(bodyWell.classList.contains("is-clamped")).toBe(true);
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.textContent?.trim()).toBe("Expand full prompt");
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");

    toggleBtn.click();
    fixture.detectChanges();

    expect(bodyWell.classList.contains("is-clamped")).toBe(false);
    expect(toggleBtn.textContent?.trim()).toBe("Collapse prompt");
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");

    toggleBtn.click();
    fixture.detectChanges();

    expect(bodyWell.classList.contains("is-clamped")).toBe(true);
    expect(toggleBtn.textContent?.trim()).toBe("Expand full prompt");
  });
});
