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
import { ActivatedRoute, provideRouter } from "@angular/router";
import { GrainApi } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { QaFlowsPanelComponent } from "./qa-flows-panel.component";
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("QaFlowsPanelComponent", () => {
  let api: {
    get: import("vitest").Mock;
    post: import("vitest").Mock;
    put: import("vitest").Mock;
  };
  let access: { can: import("vitest").Mock };
  let snackbar: { show: import("vitest").Mock };

  beforeEach(() => {
    api = {
      get: vi.fn().mockResolvedValue({ versions: [] }),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
    };
    access = { can: vi.fn().mockReturnValue(true) };
    snackbar = { show: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: GrainApi, useValue: api },
        { provide: AccessService, useValue: access },
        { provide: SnackbarService, useValue: snackbar },
      ],
    });
  });

  it("loads and groups versions", async () => {
    api.get.mockResolvedValue({
      versions: [
        { key: "golden-v1", version: 1, hash: "h1", summary: "test1" },
        { key: "golden-v1", version: 2, hash: "h2", summary: "test2" },
        { key: "other", version: 1, hash: "h3", summary: "test3" },
      ],
    });
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    await comp.loadVersions();

    const groups = comp.groupedVersions();
    expect(groups.length).toBe(2);
    expect(groups[0].key).toBe("golden-v1");
    expect(groups[0].versions.length).toBe(2);
    expect(groups[0].versions[0].version).toBe(2);
    expect(groups[1].key).toBe("other");
  });

  it("enforces floor check locks", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "test",
      hash: "h1",
      version: 1,
      label: "",
      summary: "",
      qaEngineRev: 1,
    });
    comp.newVersion();

    expect(comp.draftChecks()["golden:test-integrity-guard"].enabled).toBe(
      true,
    );
    expect(comp.draftChecks()["golden:test-integrity-guard"].severity).toBe(
      "blocking",
    );

    const draft = comp.prepareDraft();
    expect(draft.checks["golden:test-integrity-guard"]).toBeUndefined();
  });

  it("fork / new version", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "test",
      hash: "h1",
      version: 1,
      label: "",
      summary: "",
      qaEngineRev: 1,
    });

    comp.forkFlow();
    expect(comp.isFork()).toBe(true);
    expect(comp.draftDeclaration().key).toBe("test-fork");

    comp.newVersion();
    expect(comp.isFork()).toBe(false);
    expect(comp.draftDeclaration().key).toBe("test");
  });

  it("validates skill byte limit", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "test",
      hash: "h1",
      version: 1,
      label: "",
      summary: "",
      qaEngineRev: 1,
    });
    comp.newVersion();

    comp.draftDeclaration.update((d) => ({
      ...d,
      skill: { mode: "replace", text: "a".repeat(2000), maxBytes: 1800 },
    }));
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector(".byte-counter");
    expect(el).toBeTruthy();
    expect(el.classList.contains("error")).toBe(true);
  });

  it("parent diff toggle", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "test",
      hash: "h1",
      version: 1,
      label: "",
      summary: "",
      qaEngineRev: 1,
    });
    comp.newVersion();

    expect(comp.showParentDiff()).toBe(false);
    comp.showParentDiff.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("g-diff-viewer")).not.toBeNull();
  });

  it("dry-run results rendering", async () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;

    api.post.mockResolvedValue({
      dryRun: true,
      valid: true,
      hash: "test",
      sampledPRs: 10,
      wouldBlockPRs: 2,
      byCheck: [{ ruleId: "rule1", wouldBlock: 2, warnCount: 0 }],
    });

    comp.selectedDetail.set({
      key: "test",
      hash: "h1",
      version: 1,
      label: "",
      summary: "",
      qaEngineRev: 1,
    });
    comp.newVersion();
    await comp.dryRunDraft();
    fixture.detectChanges();

    expect(comp.dryRunResult()).not.toBeNull();
    const txt = fixture.nativeElement.textContent;
    expect(txt).toContain("Sampled PRs: 10");
    expect(txt).toContain("rule1");
  });

  it("publish confirm API call", async () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "test",
      hash: "h1",
      version: 1,
      label: "",
      summary: "",
      qaEngineRev: 1,
    });
    comp.newVersion();

    comp.confirmPublish();
    expect(comp.confirmRequest()).not.toBeNull();

    comp.onConfirmDone(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.post).toHaveBeenCalled();
  });

  it("unsaved changes guard", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.isEditing.set(true);

    comp.selectVersion("h2");
    const req = comp.confirmRequest();
    expect(req).not.toBeNull();
    expect(req?.title).toBe("Unsaved changes");
  });

  it("?from= deep link", async () => {
    api.get.mockResolvedValue({
      versions: [{ key: "target", version: 1, hash: "h1", summary: "test" }],
    });

    TestBed.overrideProvider(ActivatedRoute, {
      useValue: {
        snapshot: {
          queryParamMap: {
            get: (k: string) => (k === "from" ? "target@1" : null),
          },
        },
      },
    });

    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    await comp.loadVersions();

    fixture.detectChanges();
    expect(comp.selectedHash()).toBe("h1");
  });

  it("renders v5 3-column progressive studio in read-only mode with zero disabled inputs and sentence-case stages", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "engineering-workflow-v4",
      version: 1,
      hash: "sha256:v4001",
      label: "8-Stage Engineering Workflow (V4)",
      summary: "Full 8-stage AI software workflow with readability packs",
      schema: "grain.dev/qa-flow/v4",
      builtIn: true,
      qaEngineRev: 4,
      declarationV4: {
        schema: "grain.dev/qa-flow/v4",
        key: "engineering-workflow-v4",
        version: 1,
        label: "8-Stage Engineering Workflow (V4)",
        decompose: { enabled: true, "max-subtasks": 5, "require-tdd": true },
        context: {
          enabled: true,
          "require-design-doc": true,
          "blast-radius-preview": true,
        },
        "readability-packs": [
          {
            id: "go",
            label: "Go Readability Pack",
            enabled: true,
            globs: ["**/*.go"],
            text: "Wrap returned errors with %w.",
            "max-bytes": 900,
          },
          {
            id: "ts-angular",
            label: "TypeScript & Angular Pack",
            enabled: true,
            globs: ["ui-ng/**/*.ts"],
            text: "Use standalone OnPush components.",
            "max-bytes": 900,
          },
        ],
        "pr-contract": {
          enabled: true,
          "conventional-commits": true,
          "max-subject-chars": 72,
          "required-sections": ["Summary", "Testing"],
          "audit-lint-suppressions": true,
        },
      },
    });
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('[data-testid="qa-studio-toolbar"]'),
    ).toBeTruthy();
    expect(root.querySelector('[data-testid="qa-prompt-budget"]')).toBeTruthy();
    expect(
      root.querySelector('[data-testid="qa-schema-pill"]')?.textContent?.trim(),
    ).toBe("v4");

    // Read-only inspect mode has zero disabled form inputs and explicit Customize as v2 CTA
    expect(
      root.querySelectorAll(
        "input:disabled, textarea:disabled, select:disabled",
      ).length,
    ).toBe(0);
    expect(
      root
        .querySelector('[data-testid="qa-new-version-btn"]')
        ?.textContent?.trim(),
    ).toBe("Customize as v2");

    const stageTree = root.querySelector('[data-testid="qa-stage-tree"]');
    expect(stageTree).toBeTruthy();
    expect(stageTree?.querySelectorAll(".qa-stage-group").length).toBe(8);
    expect(stageTree?.textContent).toContain("1 · Goal & subtask breakdown");
    expect(stageTree?.textContent).toContain("8 · Scorecard & merge triage");
    expect(
      root.querySelector('[data-testid="qa-step-inspector"]'),
    ).toBeTruthy();
    expect(
      root.querySelector('[data-testid="qa-workflow-guide"]'),
    ).toBeTruthy();
  });

  it("tucks benchmark & archived variants behind toggle and auto-expands on ?flow= deep link", async () => {
    api.get.mockImplementation(async (route: string) => {
      if (route === "GET /api/qa/flow-versions") {
        return {
          versions: [
            {
              key: "engineering-workflow-v4",
              version: 1,
              hash: "h-v4",
              label: "8-Stage Engineering Workflow",
              summary: "Primary workflow",
            },
            {
              key: "deterministic-s3-only",
              version: 1,
              hash: "h-det",
              label: "Deterministic S3 Only",
              summary: "Ablation seed",
            },
            {
              key: "retired-custom",
              version: 1,
              hash: "h-ret",
              label: "Old Flow",
              summary: "Retired variant",
              retiredAt: "2026-05-01T00:00:00Z",
            },
          ],
        };
      }
      if (route === "GET /api/qa/flow-versions/:hash") {
        return {
          key: "deterministic-s3-only",
          version: 1,
          hash: "h-det",
          label: "Deterministic S3 Only",
          summary: "Ablation seed",
          qaEngineRev: 1,
        };
      }
      return {
        qaEnabled: true,
        qaFlowId: "engineering-workflow-v4",
        qaRolloutPct: 100,
      };
    });

    TestBed.overrideProvider(ActivatedRoute, {
      useValue: {
        snapshot: {
          queryParamMap: {
            get: (k: string) => (k === "flow" ? "deterministic-s3-only" : null),
          },
        },
      },
    });

    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    await comp.loadVersions();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const primaryList = root.querySelector(
      '[data-testid="quality-flows-list"]',
    );
    expect(
      primaryList?.querySelector(
        '[data-testid="qa-flow-row-engineering-workflow-v4"]',
      ),
    ).toBeTruthy();
    expect(
      primaryList?.querySelector(
        '[data-testid="qa-flow-row-deterministic-s3-only"]',
      ),
    ).toBeNull();

    const archivedToggle = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-toggle-archived-flows"]',
    );
    expect(archivedToggle).toBeTruthy();
    expect(archivedToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(comp.selectedHash()).toBe("h-det");
  });

  it("renders rollout status pills and sets default workflow via PUT /api/settings with undo", async () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.qaEnabled.set(false);
    comp.activeFlowId.set("golden-v3");
    comp.activeRolloutPct.set(0);
    comp.selectedDetail.set({
      key: "golden-v3",
      version: 1,
      hash: "h-g3",
      label: "Golden V3",
      summary: "Balanced workflow",
      qaEngineRev: 3,
    });
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const statusPill = root.querySelector(
      '[data-testid="qa-rollout-status-pill"]',
    );
    expect(statusPill?.textContent?.trim()).toBe("Default · Paused (0%)");

    const setDefaultBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-set-default-btn"]',
    );
    expect(setDefaultBtn).toBeTruthy();
    setDefaultBtn?.click();
    fixture.detectChanges();

    expect(comp.confirmRequest()?.title).toContain("Set Golden V3 as default");
    comp.onConfirmDone(true);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(api.put).toHaveBeenCalledWith(
      "PUT /api/settings",
      undefined,
      expect.objectContaining({
        qaEnabled: true,
        qaFlowId: "golden-v3",
        qaRolloutPct: 100,
        qaShadowOnControl: true,
      }),
    );
    expect(comp.rolloutStatusLabel("golden-v3")).toBe("Active (100%)");
    expect(snackbar.show).toHaveBeenCalledWith(
      expect.stringContaining("Golden V3"),
      expect.objectContaining({ label: "Undo" }),
    );
  });

  it("keeps mobile inspector closed on cold load and opens it on user workflow selection", async () => {
    api.get.mockResolvedValue({
      versions: [
        { key: "golden-v3", version: 1, hash: "h-g3", summary: "Balanced" },
      ],
    });
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    await comp.loadVersions();
    fixture.detectChanges();

    expect(comp.mobileInspectorOpen()).toBe(false);
    comp.selectVersion("h-g3", true);
    fixture.detectChanges();
    expect(comp.mobileInspectorOpen()).toBe(true);
  });

  it("publishes a V4 flow version preserving stages, readability packs, skill steps, PR contract, and custom checks", async () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "engineering-workflow-v4",
      version: 1,
      hash: "sha256:v4001",
      label: "8-Stage Engineering Workflow (V4)",
      summary: "V4 workflow",
      schema: "grain.dev/qa-flow/v4",
      qaEngineRev: 4,
      declarationV4: {
        schema: "grain.dev/qa-flow/v4",
        key: "engineering-workflow-v4",
        version: 1,
        decompose: { enabled: true, "max-subtasks": 5, "require-tdd": true },
        context: {
          enabled: true,
          "require-design-doc": true,
          "blast-radius-preview": true,
        },
        "skill-steps": [
          {
            id: "step:tdd",
            label: "TDD Step",
            stage: "3-implementation",
            enabled: true,
            globs: ["**/*.go"],
            text: "Write tests before implementation.",
          },
        ],
        "readability-packs": [
          {
            id: "go",
            label: "Go Readability Pack",
            enabled: true,
            globs: ["**/*.go"],
            text: "Wrap errors with %w.",
            "max-bytes": 900,
          },
        ],
        "pr-contract": {
          enabled: true,
          "conventional-commits": true,
          "max-subject-chars": 72,
          "required-sections": ["Summary", "Testing"],
          "audit-lint-suppressions": true,
        },
        "custom-checks": [
          {
            id: "custom:no-fmt-print",
            kind: "pattern",
            severity: "warn",
            forbid: "fmt\\.Print",
            fixtures: {
              fail: [{ name: "bad", added: ["fmt.Println(1)"] }],
              pass: [{ name: "good", added: ["log.Info(1)"] }],
            },
          },
        ],
      },
    });

    comp.newVersion();
    fixture.detectChanges();

    const prepared = comp.prepareDraft();
    expect(prepared.schema).toBe("grain.dev/qa-flow/v4");
    expect(prepared.decompose).toBeTruthy();
    expect(prepared.context).toBeTruthy();
    expect(prepared.readabilityPacks?.length).toBeGreaterThanOrEqual(4);
    expect(prepared.skillSteps?.length).toBe(1);
    expect(prepared.prContract).toBeTruthy();
    expect(prepared.customChecks?.length).toBe(1);

    api.post.mockResolvedValueOnce({ hash: "sha256:v4002" });
    comp.confirmPublish();
    comp.onConfirmDone(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.post).toHaveBeenCalledWith(
      "POST /api/qa/flow-versions",
      undefined,
      expect.objectContaining({
        declaration: expect.objectContaining({
          schema: "grain.dev/qa-flow/v4",
          key: "engineering-workflow-v4",
        }),
      }),
    );
  });
});
