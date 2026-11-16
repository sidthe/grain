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
      if (route === "GET /api/qa/flow-versions/{hash}") {
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

  it("customizes golden-v1-minimal (V2): syncs skill inherit mode, stopNudge, verifier, disabled built-in check overrides, and upgrades to v4 when stages are edited", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "golden-v1-minimal",
      version: 1,
      hash: "sha256:g1",
      label: "golden-v1-minimal (Recommended)",
      summary: "270-token coding contract and deterministic gates",
      qaEngineRev: 1,
      resolved: {
        id: "golden-v1-minimal",
        label: "golden-v1-minimal (Recommended)",
        summary: "270-token coding contract",
        injectSkill: true,
        skillBytes: 900,
        stopNudge: true,
        stagingIsolation: true,
        enableS4: true,
        maxS4RepairRounds: 1,
        rules: [
          {
            id: "golden:sibling-export-hazard",
            label: "Sibling caller hazard",
            stage: "S3",
            severity: "warn",
            summary: "Sweep callers",
            targetPaths: ["**/*.go"],
            enabled: true,
          },
          {
            id: "golden:pr-description-contract",
            label: "PR contract",
            stage: "S3",
            severity: "warn",
            summary: "PR sections",
            targetPaths: ["PR metadata"],
            enabled: true,
          },
        ],
      },
    });
    fixture.detectChanges();

    comp.newVersion();
    fixture.detectChanges();

    const st = comp.studio();
    expect(st).toBeTruthy();

    // Switch coding skill to inherit -> 0 draftSkillBytes and mode="inherit", text=""
    st?.codingSkillMode.set("inherit");
    st?.codingSkillText.set("");
    st?.stopNudge.set(false);
    st?.verifierEnabled.set(false);
    comp.toggleCheckEnabled("golden:sibling-export-hazard");
    comp.toggleCheckEnabled("golden:pr-description-contract");
    fixture.detectChanges();

    expect(comp.draftSkillBytes()).toBe(0);
    const v2Draft = comp.prepareDraft();
    expect(v2Draft.schema).toBe("grain.dev/qa-flow/v2");
    expect(v2Draft.skill.mode).toBe("inherit");
    expect(v2Draft.skill.text).toBe("");
    expect(v2Draft.stopNudge).toBe(false);
    expect(v2Draft.verifier.enabled).toBe(false);
    expect(v2Draft.checks["golden:sibling-export-hazard"]).toEqual({
      enabled: false,
    });
    expect(v2Draft.checks["golden:pr-description-contract"]).toEqual({
      enabled: false,
    });

    // Enabling a V4 stage upgrades draft.schema to grain.dev/qa-flow/v4
    st?.s0Intent.set(true);
    fixture.detectChanges();
    const upgradedDraft = comp.prepareDraft();
    expect(upgradedDraft.schema).toBe("grain.dev/qa-flow/v4");
    expect(upgradedDraft.stages?.["s0-intent"]).toEqual({ enabled: true });
  });

  it("customizes engineering-workflow-v4 with exclude fixtures losslessly and delegates dry-run in read-only vs draft modes", async () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.selectedDetail.set({
      key: "engineering-workflow-v4",
      version: 1,
      hash: "sha256:v4-base",
      label: "8-Stage Engineering Workflow",
      summary: "V4 workflow",
      schema: "grain.dev/qa-flow/v4",
      qaEngineRev: 4,
      sourceYaml:
        "schema: grain.dev/qa-flow/v4\nkey: engineering-workflow-v4\n",
      declarationV4: {
        schema: "grain.dev/qa-flow/v4",
        key: "engineering-workflow-v4",
        "custom-checks": [
          {
            id: "custom:no-fmt-println-pkg",
            label: "No debug fmt.Println in pkg/",
            kind: "pattern",
            severity: "warn",
            paths: ["pkg/**/*.go"],
            exclude: ["**/*_test.go"],
            "forbid-added": "\\bfmt\\.Println\\(",
            message: "Use structured logging.",
            fixtures: {
              fail: [
                {
                  name: "added fmt.Println in handler",
                  file: "pkg/ui/server.go",
                  "added-lines": ['\tfmt.Println("debug", req.URL)'],
                },
              ],
              pass: [
                {
                  name: "fmt.Println in unit test ignored",
                  file: "pkg/ui/server_test.go",
                  "added-lines": ['\tfmt.Println("test output")'],
                },
              ],
            },
          },
        ],
      },
    });
    fixture.detectChanges();

    // Read-only mode: Lineage & YAML shows sourceYaml and drawer dry-run sends { hash }
    expect(comp.studio()?.yamlPreviewText()).toContain(
      "key: engineering-workflow-v4",
    );
    await comp.studio()?.verifyDryRun();
    expect(api.post).toHaveBeenCalledWith(
      "POST /api/qa/flow-versions",
      undefined,
      { hash: "sha256:v4-base" },
      "dryRun=1&limit=20",
    );

    // Customize mode: edit fail example line, verify exclude & server_test.go pass fixture stay intact
    comp.newVersion();
    fixture.detectChanges();

    const st = comp.studio();
    const cc = st?.customChecks()[0];
    expect(cc?.exclude).toBe("**/*_test.go");
    if (cc) {
      st?.updatePatternExample(cc.uid, "fail", '\tfmt.Println("bad")');
    }
    fixture.detectChanges();

    const prepared = comp.prepareDraft();
    const exportedCheck = prepared.customChecks?.[0];
    expect(exportedCheck?.exclude).toEqual(["**/*_test.go"]);
    expect(JSON.stringify(exportedCheck?.fixtures?.pass)).toContain(
      "pkg/ui/server_test.go",
    );

    api.post.mockClear();
    await st?.verifyDryRun();
    expect(api.post).toHaveBeenCalledWith(
      "POST /api/qa/flow-versions",
      undefined,
      expect.objectContaining({
        declaration: expect.objectContaining({
          schema: "grain.dev/qa-flow/v4",
        }),
      }),
      "dryRun=1&limit=20",
    );
  });

  it("handles version switcher @vN query params, v-prefixed deep links, non-retired preference, qa-flow-switcher family key, and race guard", async () => {
    let resolveSlowV1: ((v: unknown) => void) | undefined;
    api.get.mockImplementation((route: string, params?: { hash?: string }) => {
      if (route === "GET /api/qa/flow-versions") {
        return Promise.resolve({
          versions: [
            {
              key: "golden-v3",
              version: 1,
              hash: "h-v1",
              label: "Golden V3",
              summary: "v1 summary",
            },
            {
              key: "golden-v3",
              version: 2,
              hash: "h-v2",
              label: "Golden V3",
              summary: "v2 summary",
            },
            {
              key: "golden-v3",
              version: 3,
              hash: "h-v3-ret",
              label: "Golden V3",
              summary: "v3 retired",
              retiredAt: "2026-06-01T00:00:00Z",
            },
          ],
        });
      }
      if (route === "GET /api/qa/flow-versions/{hash}") {
        if (params?.hash === "h-v1") {
          return new Promise((resolve) => {
            resolveSlowV1 = resolve;
          });
        }
        return Promise.resolve({
          key: "golden-v3",
          version: 2,
          hash: "h-v2",
          label: "Golden V3 v2",
          summary: "v2 summary",
          qaEngineRev: 3,
        });
      }
      return Promise.resolve({});
    });

    TestBed.overrideProvider(ActivatedRoute, {
      useValue: {
        snapshot: {
          queryParamMap: {
            get: (k: string) => (k === "flow" ? "golden-v3@v2" : null),
          },
        },
        queryParamMap: {
          subscribe: () => ({ unsubscribe: () => undefined }),
        },
      },
    });

    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    await comp.loadVersions();
    fixture.detectChanges();

    // @v2 (leading v stripped) resolved to h-v2, and flowSwitcherOptions uses key "golden-v3"
    expect(comp.selectedHash()).toBe("h-v2");
    expect(comp.flowSwitcherOptions()[0]?.value).toBe("golden-v3");

    // Start slow selection of h-v1, then immediately select h-v2: race guard prevents h-v1 from overwriting h-v2
    const p1 = comp.doSelectVersion("h-v1", true);
    const p2 = comp.doSelectVersion("h-v2", true);
    await p2;
    resolveSlowV1?.({
      key: "golden-v3",
      version: 1,
      hash: "h-v1",
      label: "Stale V1",
      summary: "v1 summary",
    });
    await p1;
    expect(comp.selectedHash()).toBe("h-v2");
    expect(comp.selectedDetail()?.label).toBe("Golden V3 v2");
  });

  it("prioritizes published overrides over same-version built-ins and prevents V4 draft declarations from leaking into read-only V2 views", () => {
    const fixture = TestBed.createComponent(QaFlowsPanelComponent);
    const comp = fixture.componentInstance;
    comp.versions.set([
      {
        key: "engineering-workflow-v4",
        version: 1,
        hash: "h-builtin-v4",
        label: "8-Stage Built-in",
        summary: "built-in",
        builtIn: true,
      },
      {
        key: "engineering-workflow-v4",
        version: 1,
        hash: "h-custom-v4",
        label: "8-Stage Custom",
        summary: "custom override",
        builtIn: false,
      },
    ]);
    comp.selectedHash.set("h-custom-v4");
    comp.selectedDetail.set({
      key: "engineering-workflow-v4",
      version: 1,
      hash: "h-custom-v4",
      label: "8-Stage Custom",
      summary: "custom override",
      schema: "grain.dev/qa-flow/v4",
      declarationV4: {
        schema: "grain.dev/qa-flow/v4",
        key: "engineering-workflow-v4",
        stages: { "s0-intent": { enabled: true } },
      },
    });
    fixture.detectChanges();

    expect(comp.groupedVersions()[0]?.latestActiveHash).toBe("h-custom-v4");
    expect(comp.versionSwitcherOptions().map((o) => o.label)).toEqual([
      "@v1",
      "@v1 (built-in)",
    ]);

    // Enter V4 edit mode, cancel back to read-only, then switch to a V2 workflow: declV4 must not leak
    comp.newVersion();
    fixture.detectChanges();
    comp.isEditing.set(false);
    comp.selectedDetail.set({
      key: "golden-v1-minimal",
      version: 1,
      hash: "h-v2-min",
      label: "Recommended baseline",
      summary: "V2 minimal",
      schema: "grain.dev/qa-flow/v2",
    });
    fixture.detectChanges();

    expect(comp.studio()?.declV4()).toBeUndefined();
    expect(comp.studio()?.s0Intent()).toBe(false);
  });
});
