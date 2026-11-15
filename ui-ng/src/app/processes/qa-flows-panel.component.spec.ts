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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrainApi } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { QaFlowsPanelComponent } from "./qa-flows-panel.component";
import type { FlowDeclarationV4, QAFlowVersionDetail } from "./qa-flows.models";

const SAMPLE_V4_DETAIL: QAFlowVersionDetail = {
  hash: "sha256:v4-eng-1",
  key: "engineering-workflow-v4",
  version: 1,
  label: "Engineering Workflow v4",
  summary:
    "8-stage AI software workflow with readability packs and PR contract",
  qaEngineRev: 4,
  builtIn: true,
  schemaVer: "grain.dev/qa-flow/v4",
  declaration: {
    schema: "grain.dev/qa-flow/v4",
    key: "engineering-workflow-v4",
    extends: "golden-v3@1",
    label: "Engineering Workflow v4",
    summary: "8-stage AI software workflow",
    skill: {
      mode: "replace",
      text: "Verify callers and write deterministic tests.",
      maxBytes: 1800,
    },
    stopNudge: true,
    stagingIsolation: true,
    checks: {
      "golden:ui-budget-and-spec-floor": {
        enabled: true,
        severity: "blocking",
      },
    },
    verifier: {
      enabled: true,
      tiers: ["T2", "T3"],
      maxRepairRounds: 1,
      maxSeconds: 60,
      maxTokens: 50000,
      checklist: "escape-classes-v1",
    },
  },
  declarationV4: {
    schema: "grain.dev/qa-flow/v4",
    key: "engineering-workflow-v4",
    extends: "golden-v3@1",
    label: "Engineering Workflow v4",
    decompose: {
      enabled: true,
      mode: "slice_plan",
      complexities: ["high"],
      maxSubtasks: 5,
      targetDiffLines: 400,
    },
    context: {
      enabled: true,
      includeCallers: true,
      includeMemory: true,
      maxTokens: 12000,
      extraPaths: ["pkg/**", "ui-ng/src/**"],
    },
    readabilityPacks: [
      { id: "go", enabled: true, activation: "auto" },
      { id: "ts-angular", enabled: true, activation: "auto" },
      { id: "python", enabled: true, activation: "auto" },
      { id: "cpp", enabled: true, activation: "auto" },
    ],
    skillSteps: [
      {
        id: "step:caller-sweep",
        label: "Sibling caller & route registration sweep",
        stage: "coding",
        enabled: true,
        maxBytes: 600,
        text: "Sweep all sibling callers by import path.",
      },
    ],
    prContract: {
      enabled: true,
      mode: "warn",
      maxSubjectChars: 72,
      requiredSections: ["Summary", "Verification"],
      auditLintSuppressions: true,
      guidanceText: "Structure PR body with Summary and Verification.",
    },
    stages: {
      "s0-intent": { enabled: true },
      "s2-plan-critic": { enabled: true },
      "s5-merge-triage": { mode: "shadow" },
    },
    "custom-checks": [
      {
        id: "custom:no-fmt-println",
        label: "No debug fmt.Println in pkg/",
        kind: "pattern",
        severity: "warn",
        paths: ["pkg/**/*.go"],
        exclude: ["**/*_test.go"],
        "forbid-added": "\\bfmt\\.Println\\(",
        message: "Use structured logging instead of fmt.Println.",
        fixtures: {
          fail: [
            {
              name: "added fmt.Println in handler",
              file: "pkg/ui/server.go",
              "added-lines": ['\tfmt.Println("debug")'],
            },
          ],
          pass: [
            {
              name: "fmt.Println in unit test ignored",
              file: "pkg/ui/server_test.go",
              "added-lines": ['\tfmt.Println("test")'],
            },
          ],
        },
      },
    ],
  },
};

describe("QaFlowsPanelComponent", () => {
  let api: { get: import("vitest").Mock; post: import("vitest").Mock };
  let access: { can: import("vitest").Mock };
  let snackbar: { show: import("vitest").Mock };

  beforeEach(() => {
    api = {
      get: vi.fn().mockResolvedValue({ versions: [] }),
      post: vi.fn().mockResolvedValue({}),
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

    void comp.selectVersion("h2");
    expect(comp.confirmRequest()).not.toBeNull();
    expect(comp.confirmRequest()!.title).toBe("Unsaved changes");
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

  it("renders all 8 Software Lifecycle Stages in the 30/70 Studio Workbench", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set(SAMPLE_V4_DETAIL);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('[data-testid="qa-studio-toolbar"]'),
    ).toBeTruthy();
    expect(root.querySelector('[data-testid="qa-prompt-budget"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="qa-stage-tree"]')).toBeTruthy();
    expect(
      root.querySelector('[data-testid="qa-step-inspector"]'),
    ).toBeTruthy();

    const stageGroups = root.querySelectorAll(
      '[data-testid^="qa-stage-group-"]',
    );
    expect(stageGroups.length).toBe(8);
    expect(root.textContent).toContain("1 · Goal & Subtask Breakdown");
    expect(root.textContent).toContain("2 · Context & Blast Radius");
    expect(root.textContent).toContain("3 · Plan & Fresh Critique");
    expect(root.textContent).toContain("4 · Coding & Readability Rules");
    expect(root.textContent).toContain("5 · Pre-PR Deterministic Gates");
    expect(root.textContent).toContain("6 · PR Authoring & Self-Review");
    expect(root.textContent).toContain("7 · Adversarial Verification");
    expect(root.textContent).toContain("8 · Scorecard & Merge Triage");
  });

  it("filters stages and steps by search query and kind filter chips", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set(SAMPLE_V4_DETAIL);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const skillsChip = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-kind-chip-skills"]',
    )!;
    skillsChip.click();
    fixture.detectChanges();
    expect(comp.kindFilter()).toBe("skills");
    expect(
      root.querySelector('[data-testid="qa-tree-step-readability:go"]'),
    ).toBeTruthy();
    expect(
      root.querySelector(
        '[data-testid="qa-tree-step-golden:test-integrity-guard"]',
      ),
    ).toBeNull();

    const allChip = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-kind-chip-all"]',
    )!;
    allChip.click();
    const searchInput = root.querySelector<HTMLInputElement>(
      '[data-testid="qa-step-search"]',
    )!;
    searchInput.value = "no-fmt-println";
    searchInput.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(comp.filteredStages().length).toBe(1);
    expect(comp.filteredStages()[0].id).toBe("s3-checks");
    expect(
      root.querySelector('[data-testid="qa-tree-step-custom:no-fmt-println"]'),
    ).toBeTruthy();
  });

  it("inspects Readability Packs and runs 1-click Inline Fixture Self-Test Runner on a custom check", async () => {
    api.post.mockResolvedValue({
      dryRun: true,
      valid: true,
      hash: "sha256:dryrun",
      sampledPRs: 20,
      wouldBlockPRs: 1,
      byCheck: [],
    });

    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set(SAMPLE_V4_DETAIL);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;

    // Select Go Readability Pack
    const goPackNode = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-tree-step-readability:go"]',
    )!;
    expect(goPackNode).toBeTruthy();
    goPackNode.click();
    fixture.detectChanges();

    expect(
      root.querySelector('[data-testid="qa-readability-pack-inspector"]'),
    ).toBeTruthy();
    expect(
      root.querySelector('[data-testid="qa-pack-markdown"]')?.textContent,
    ).toContain("Go readability rules (pack: go)");

    // Select custom check and run inline fixture self-test
    const customCheckNode = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-tree-step-custom:no-fmt-println"]',
    )!;
    expect(customCheckNode).toBeTruthy();
    customCheckNode.click();
    fixture.detectChanges();

    const runBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="qa-run-fixtures-btn"]',
    )!;
    expect(runBtn).toBeTruthy();
    runBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const resultBanner = root.querySelector(
      '[data-testid="qa-fixture-test-result"]',
    );
    expect(resultBanner).toBeTruthy();
    expect(resultBanner?.textContent).toContain(
      "PASS · Fail trap caught & Clean pass green",
    );
    expect(api.post).toHaveBeenCalledWith(
      "POST /api/qa/flow-versions",
      undefined,
      expect.anything(),
      "dryRun=1",
    );
  });

  it("authors and publishes a V4 flow version preserving readability packs, skill steps, PR contract, and custom checks", async () => {
    api.post.mockResolvedValue({
      hash: "sha256:v4-published",
      version: SAMPLE_V4_DETAIL,
    });

    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set(SAMPLE_V4_DETAIL);
    fixture.detectChanges();

    comp.forkFlow();
    fixture.detectChanges();

    // Add a skill step and update PR contract required sections
    comp.addSkillStep("coding");
    comp.updatePRRequiredSections("Summary, Root Cause, Verification");
    comp.updateDraftPackActivation("ts-angular", "always");
    fixture.detectChanges();

    comp.confirmPublish();
    expect(comp.confirmRequest()).not.toBeNull();
    comp.onConfirmDone(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(api.post).toHaveBeenCalledWith(
      "POST /api/qa/flow-versions",
      undefined,
      expect.objectContaining({
        declaration: expect.objectContaining({
          schema: "grain.dev/qa-flow/v4",
          key: "engineering-workflow-v4-fork",
        }),
      }),
    );

    const sentDecl = (
      api.post.mock.calls[0][2] as { declaration: FlowDeclarationV4 }
    ).declaration;
    expect(sentDecl.decompose?.enabled).toBe(true);
    expect(sentDecl.context?.enabled).toBe(true);
    expect(sentDecl.prContract?.requiredSections).toEqual([
      "Summary",
      "Root Cause",
      "Verification",
    ]);
    expect(
      sentDecl.readabilityPacks?.find((p) => p.id === "ts-angular")?.activation,
    ).toBe("always");
    expect((sentDecl.skillSteps ?? []).length).toBe(2);
    expect(Array.isArray(sentDecl["custom-checks"])).toBe(true);
  });
});
