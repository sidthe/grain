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

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnDestroy,
  ViewEncapsulation,
  computed,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { Subscription } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import type {
  DiffPreviewFile,
  DiffPreviewLine,
  QAFlowsResponse,
} from "../api/models";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import {
  ConfirmDialogComponent,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import {
  type FlowDeclarationV2,
  type FlowDeclarationV4,
  MAX_PROMPT_BUDGET_BYTES,
  type QADryRunResponse,
  type QAFlowPublishResponse,
  type QAFlowVersionDetail,
  type QAFlowVersionItem,
  type QAFlowVersionsResponse,
  buildClientWorkflowStagesView,
  compareFlowVersionsDesc,
  computeActivePromptBytes,
  groupWorkflowFamilies,
  humanizeWorkflowKey,
  isLockedFloorRule,
  schemaShortLabel,
  utf8ByteCount,
} from "./qa-flows.models";
import { QaV3StudioComponent } from "./qa-v3-studio.component";
import { QaWorkflowCatalogComponent } from "./qa-workflow-catalog.component";

@Component({
  selector: "g-qa-flows-panel",
  imports: [
    QaWorkflowCatalogComponent,
    QaV3StudioComponent,
    PillSelectComponent,
    ConfirmDialogComponent,
    StatusIconComponent,
    TipDirective,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./qa-flows-panel.css",
  encapsulation: ViewEncapsulation.None,
  host: {
    "(document:click)": "onDocumentClick($event)",
    "(document:keydown.escape)": "closeMenus()",
  },
  template: `
    <div
      class="qa-flows-panel"
      [class.has-mobile-inspector]="mobileInspectorOpen()"
      data-testid="qa-flows-panel"
    >
      <div
        class="qa-studio-columns"
        [class.is-catalog-collapsed]="catalogCollapsed()"
      >
        <g-qa-workflow-catalog
          [primaryGroups]="catalogFamilies().primary"
          [archivedGroups]="catalogFamilies().archived"
          [selectedKey]="selectedDetail()?.key || ''"
          [selectedHash]="selectedHash() || ''"
          [flowQueryParam]="flowQueryParam()"
          [qaEnabled]="qaEnabled()"
          [activeFlowId]="activeFlowId()"
          [activeRolloutPct]="activeRolloutPct()"
          [collapsed]="catalogCollapsed()"
          (selectFamily)="selectVersion($event, true)"
          (toggleCollapsed)="catalogCollapsed.set(!catalogCollapsed())"
        />

        @if (selectedDetail(); as detail) {
          <g-qa-v3-studio
            [embedded]="true"
            [editing]="isEditing()"
            [canEdit]="canAdmin()"
            [isFork]="isFork()"
            [draftKey]="draftDeclaration().key"
            [draftExtends]="draftDeclaration().extends || ''"
            [draftLabel]="draftDeclaration().label"
            [draftSummary]="draftDeclaration().summary || ''"
            [draftSkill]="draftDeclaration().skill"
            [delegateDryRun]="true"
            [builtinCheckOverrides]="draftChecks()"
            [qaEnabled]="qaEnabled()"
            [activeFlowId]="activeFlowId()"
            [activeRolloutPct]="activeRolloutPct()"
            [detail]="detail"
            [decl]="
              (isEditing() ? draftDeclaration().declarationV3 : undefined) ??
              detail.declarationV3
            "
            [declV4]="
              (isEditing() ? draftDeclaration().declarationV4 : undefined) ??
              detail.declarationV4
            "
            [showParentDiff]="showParentDiff()"
            [diffFiles]="diffFiles()"
            [externalDryRun]="dryRunResult()"
            (adopted)="onFlowAdopted($event)"
            (dryRunReq)="runDryRun()"
            (toggleParentDiffReq)="toggleParentDiff()"
            (enterDraftReq)="enterDraftFromStudio()"
            (stepSelected)="onStudioStepSelected()"
            (draftKeyChange)="setDraftField('key', $event)"
            (draftLabelChange)="setDraftField('label', $event)"
            (draftSummaryChange)="setDraftField('summary', $event)"
            (skillChange)="onStudioSkillChange($event)"
            (builtinCheckToggle)="
              setBuiltinCheckEnabled($event.id, $event.enabled)
            "
            (builtinCheckSeverity)="
              updateCheckSeverity($event.id, $event.severity)
            "
          >
            <div
              qaCenterHeader
              class="qa-studio-toolbar"
              role="region"
              aria-label="Workflow studio toolbar"
              data-testid="qa-studio-toolbar"
            >
              <div class="qa-toolbar-row">
                <div class="qa-toolbar-identity">
                  <button
                    type="button"
                    class="btn-text qa-mobile-back"
                    data-testid="qa-mobile-back"
                    [hidden]="!mobileInspectorOpen()"
                    (click)="mobileInspectorOpen.set(false)"
                  >
                    ← Back
                  </button>

                  <span class="qa-flow-switcher-wrap">
                    <g-pill-select
                      align="left"
                      testid="qa-flow-switcher"
                      ariaLabel="Switch workflow"
                      [options]="flowSwitcherOptions()"
                      [value]="detail.key"
                      (valueChange)="selectFlowFamily($event)"
                    />
                  </span>

                  <h2 class="qa-toolbar-title" data-testid="qa-flow-insp-title">
                    {{ detail.label || detail.key }}
                  </h2>

                  <span
                    class="status-pill neutral"
                    data-testid="qa-schema-pill"
                    [gTip]="
                      'Workflow declaration schema ' + schemaShortBadge(detail)
                    "
                  >
                    {{ schemaShortBadge(detail) }}
                  </span>

                  @if (versionSwitcherOptions().length > 0) {
                    <g-pill-select
                      align="left"
                      testid="qa-version-switcher"
                      ariaLabel="Workflow version"
                      [options]="versionSwitcherOptions()"
                      [value]="selectedHash() || ''"
                      (valueChange)="selectVersion($event, true)"
                    />
                  }

                  <span
                    [class]="'status-pill ' + rolloutStatusTone(detail.key)"
                    data-testid="qa-rollout-status-pill"
                    [gTip]="rolloutStatusTip(detail.key)"
                  >
                    <g-status-icon [tone]="rolloutStatusTone(detail.key)" />
                    {{ rolloutStatusLabel(detail.key) }}
                  </span>

                  @if (isEditing()) {
                    <span class="status-pill reply" data-testid="qa-draft-pill">
                      <g-status-icon tone="reply" kind="proposal" />
                      {{
                        isFork() ? "Draft fork" : "Draft v" + nextVersionNum()
                      }}
                    </span>
                  }

                  @if (detail.retiredAt) {
                    <span class="status-pill warn">
                      <g-status-icon tone="warn" />
                      Retired
                    </span>
                  }
                </div>
              </div>

              <div class="qa-toolbar-row">
                <div
                  class="qa-prompt-budget byte-counter"
                  [class.is-overflow]="
                    skillByteOverflow() || promptBudgetOverflow()
                  "
                  [class.error]="skillByteOverflow() || promptBudgetOverflow()"
                  data-testid="qa-prompt-budget"
                  [gTip]="
                    'Active prompt guidance across enabled stages (' +
                    activePromptBytes() +
                    ' B of ' +
                    maxPromptBudgetBytes +
                    ' B budget).'
                  "
                >
                  <span>Prompt:</span>
                  <strong class="s-num">{{ activePromptBytes() }} B</strong>
                  <span>/ 8.0 kB</span>
                  <span class="qa-budget-track" aria-hidden="true">
                    <span
                      class="qa-budget-fill"
                      [style.width.%]="promptBudgetPct()"
                    ></span>
                  </span>
                </div>

                <div class="qa-toolbar-actions">
                  <button
                    type="button"
                    class="btn-text"
                    data-testid="qa-open-guide-btn"
                    gTip="Open the workflow quick-start guide and live stage insights."
                    (click)="openGuide()"
                  >
                    Guide
                  </button>

                  @if (!isEditing()) {
                    @if (canShowSetDefault(detail)) {
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="qa-set-default-btn"
                        gTip="Make this workflow the active default for eligible new tasks."
                        (click)="confirmSetAsDefault()"
                      >
                        Set as default…
                      </button>
                    }

                    @if (canAdmin()) {
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="qa-new-version-btn"
                        [gTip]="
                          'Start an editable draft for v' +
                          nextVersionNum() +
                          ' without affecting active tasks until published.'
                        "
                        (click)="newVersion()"
                      >
                        Customize as v{{ nextVersionNum() }}
                      </button>
                    }
                  } @else {
                    <span class="qa-menu-anchor">
                      <button
                        type="button"
                        class="btn-tonal"
                        data-testid="qa-test-menu-btn"
                        [attr.aria-expanded]="testMenuOpen()"
                        aria-haspopup="menu"
                        gTip="Dry-run this draft against recent pull requests or simulate touched file paths."
                        (click)="toggleTestMenu($event)"
                      >
                        Test on recent PRs ▾
                      </button>
                      @if (testMenuOpen()) {
                        <ul
                          class="pop-menu qa-action-pop align-left"
                          role="menu"
                          aria-label="Draft validation tools"
                        >
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="qa-dry-run-btn"
                              (click)="closeMenus(); dryRunDraft()"
                            >
                              Dry run on recent PRs
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="qa-v3-open-probe"
                              (click)="closeMenus(); openProbe()"
                            >
                              Simulate file paths…
                            </button>
                          </li>
                        </ul>
                      }
                    </span>

                    <button
                      type="button"
                      class="btn-tonal"
                      data-testid="qa-cancel-edit-btn"
                      gTip="Discard unpublished draft changes and return to read-only inspection."
                      (click)="cancelEdit()"
                    >
                      Discard draft
                    </button>

                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="qa-publish-version-btn"
                      [disabled]="skillByteOverflow() || promptBudgetOverflow()"
                      [gTip]="
                        'Validate custom check examples and publish ' +
                        (isFork() ? 'v1' : 'v' + nextVersionNum()) +
                        '.'
                      "
                      (click)="confirmPublish()"
                    >
                      Publish {{ isFork() ? "v1" : "v" + nextVersionNum() }}
                    </button>
                  }

                  <span class="qa-menu-anchor">
                    <button
                      type="button"
                      class="qa-more-btn"
                      data-testid="qa-more-actions-btn"
                      aria-label="More workflow actions"
                      aria-haspopup="menu"
                      [attr.aria-expanded]="moreMenuOpen()"
                      gTip="More workflow actions"
                      (click)="toggleMoreMenu($event)"
                    >
                      ⋯
                    </button>
                    @if (moreMenuOpen()) {
                      <ul
                        class="pop-menu qa-action-pop"
                        role="menu"
                        aria-label="More workflow actions"
                      >
                        @if (!isEditing()) {
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="qa-dry-run-btn"
                              (click)="closeMenus(); dryRun()"
                            >
                              Test on recent PRs
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="qa-v3-open-probe"
                              (click)="closeMenus(); openProbe()"
                            >
                              Simulate file paths…
                            </button>
                          </li>
                        }
                        @if (canAdmin()) {
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="qa-fork-flow-btn"
                              (click)="closeMenus(); forkFlow()"
                            >
                              Fork as new workflow
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="qa-v3-open-adopt"
                              (click)="closeMenus(); openAdopt()"
                            >
                              Import from git commit…
                            </button>
                          </li>
                        }
                        <li role="none">
                          <a
                            role="menuitem"
                            [routerLink]="['/telemetry']"
                            [queryParams]="{
                              tab: 'quality',
                              createExp: '1',
                              flow: detail.hash,
                            }"
                            (click)="closeMenus()"
                            >Compare in A/B experiment</a
                          >
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="qa-menu-view-yaml"
                            (click)="closeMenus(); openYamlTab()"
                          >
                            View YAML
                          </button>
                        </li>
                        <li role="none">
                          <a
                            role="menuitem"
                            routerLink="/settings/tasks"
                            (click)="closeMenus()"
                            >Settings → Tasks</a
                          >
                        </li>
                        @if (
                          canAdmin() && !detail.builtIn && !detail.retiredAt
                        ) {
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              class="is-danger"
                              data-testid="qa-retire-flow-btn"
                              (click)="closeMenus(); retireFlow()"
                            >
                              Retire version…
                            </button>
                          </li>
                        }
                      </ul>
                    }
                  </span>
                </div>
              </div>
            </div>
          </g-qa-v3-studio>
        } @else {
          <div class="qa-empty-detail">
            Select a workflow from the catalog to inspect its stages.
          </div>
        }
      </div>
    </div>

    @if (confirmRequest()) {
      <g-confirm-dialog
        [request]="confirmRequest()!"
        (done)="onConfirmDone($event)"
      />
    }
  `,
})
export class QaFlowsPanelComponent implements OnDestroy {
  private readonly api = inject(GrainApi);
  private readonly access = inject(AccessService);
  private readonly snackbar = inject(SnackbarService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router, { optional: true });
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly querySub?: Subscription;

  readonly studio = viewChild(QaV3StudioComponent);

  readonly maxPromptBudgetBytes = MAX_PROMPT_BUDGET_BYTES;

  readonly versions = signal<QAFlowVersionItem[]>([]);
  readonly selectedHash = signal<string | null>(null);
  readonly selectedDetail = signal<QAFlowVersionDetail | null>(null);
  readonly qaEnabled = signal(false);
  readonly activeFlowId = signal("");
  readonly activeRolloutPct = signal(0);
  readonly qaShadowOnControl = signal(true);
  readonly mobileInspectorOpen = signal(false);
  readonly catalogCollapsed = signal(false);
  readonly flowQueryParam = signal("");

  readonly isEditing = signal(false);
  readonly isFork = signal(false);
  readonly showParentDiff = signal(false);
  readonly testMenuOpen = signal(false);
  readonly moreMenuOpen = signal(false);

  readonly dryRunResult = signal<QADryRunResponse | null>(null);
  readonly confirmRequest = signal<ConfirmRequest | null>(null);

  readonly draftDeclaration = signal<FlowDeclarationV2>({
    schema: "grain.dev/qa-flow/v2",
    key: "",
    label: "",
    skill: { mode: "replace", text: "", maxBytes: 1800 },
    stopNudge: true,
    stagingIsolation: true,
    checks: {},
    verifier: {
      enabled: true,
      tiers: ["T1", "T2", "T3"],
      maxRepairRounds: 1,
      maxSeconds: 60,
      maxTokens: 50000,
      checklist: "escape-classes-v1",
    },
  });

  readonly draftChecks = signal<
    Record<
      string,
      { enabled: boolean; severity: string; params?: Record<string, unknown> }
    >
  >({});
  readonly draftCheckParams = signal<Record<string, Record<string, unknown>>>(
    {},
  );

  readonly builtInCheckKeys = [
    "golden:test-integrity-guard",
    "golden:strict-config-decoder",
    "golden:sibling-export-hazard",
    "golden:ui-budget-and-spec-floor",
    "golden:exported-surface-delta",
    "golden:test-hygiene",
    "golden:mutation-hardening",
    "golden:boundary-fuzz",
    "golden:pr-description-contract",
  ];

  readonly canAdmin = computed(() =>
    this.access.can("POST /api/qa/flow-versions"),
  );

  readonly canWriteSettings = computed(() =>
    this.access.can("PUT /api/settings"),
  );

  readonly draftSkillBytes = computed(() => {
    if (this.isEditing()) {
      const st = this.studio();
      if (st) {
        return st.codingSkillBytes();
      }
    }
    const sk = this.draftDeclaration().skill;
    return sk?.mode === "inherit" ? 0 : this.byteCount(sk?.text || "");
  });

  readonly skillByteOverflow = computed(
    () =>
      this.isEditing() &&
      this.draftSkillBytes() >
        (this.draftDeclaration().skill?.maxBytes || MAX_PROMPT_BUDGET_BYTES),
  );

  readonly activePromptBytes = computed(() => {
    const st = this.studio();
    if (st) {
      const studioBytes = st.activePromptBytes();
      if (this.isEditing()) {
        return Math.max(studioBytes, this.draftSkillBytes());
      }
      return studioBytes;
    }
    const det = this.selectedDetail();
    const stages = buildClientWorkflowStagesView(det);
    return computeActivePromptBytes(
      stages,
      this.isEditing()
        ? this.draftSkillBytes()
        : det
          ? this.readonlySkillBytes(det)
          : 0,
    );
  });

  readonly promptBudgetPct = computed(() =>
    Math.min(
      100,
      Math.round((this.activePromptBytes() / MAX_PROMPT_BUDGET_BYTES) * 100),
    ),
  );

  readonly promptBudgetOverflow = computed(
    () => this.activePromptBytes() > MAX_PROMPT_BUDGET_BYTES,
  );

  readonly catalogFamilies = computed(() =>
    groupWorkflowFamilies(this.versions()),
  );

  readonly groupedVersions = computed(() => {
    const list = this.versions();
    const groups = new Map<string, QAFlowVersionItem[]>();
    for (const v of list) {
      if (!groups.has(v.key)) groups.set(v.key, []);
      groups.get(v.key)!.push(v);
    }
    return Array.from(groups.entries())
      .map(([key, vers]) => {
        const sorted = [...vers].sort(compareFlowVersionsDesc);
        const latestActive = sorted.find((v) => !v.retiredAt);
        return {
          key,
          versions: sorted,
          latestActiveHash: latestActive?.hash,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  });

  readonly flowSwitcherOptions = computed<readonly PillOption[]>(() =>
    this.catalogFamilies().all.map((g) => ({
      value: g.key,
      label: g.displayTitle,
      hint: `${g.activeStageCount}/8 stages · ${g.schemaBadge}`,
    })),
  );

  readonly selectedFamilyVersions = computed<readonly QAFlowVersionItem[]>(
    () => {
      const det = this.selectedDetail();
      if (!det) return [];
      const grp = this.groupedVersions().find((g) => g.key === det.key);
      return grp?.versions ?? [det];
    },
  );

  readonly versionSwitcherOptions = computed<readonly PillOption[]>(() => {
    const vers = this.selectedFamilyVersions();
    return vers.map((v) => ({
      value: v.hash,
      label: v.retiredAt
        ? `@v${v.version} (retired)`
        : v.builtIn && vers.some((x) => !x.builtIn && x.version === v.version)
          ? `@v${v.version} (built-in)`
          : `@v${v.version}`,
      hint: v.summary ? v.summary.slice(0, 60) : undefined,
    }));
  });

  readonly nextVersionNum = computed(() => {
    const vers = this.selectedFamilyVersions();
    if (vers.length === 0) return 2;
    return (vers[0]?.version ?? 1) + 1;
  });

  readonly diffFiles = computed(() => {
    const detail = this.selectedDetail();
    let oldT = detail ? this.readonlySkillText(detail) : "";
    let newT =
      this.studio()?.codingSkillText() ||
      this.draftDeclaration().skill?.text ||
      "";
    if (!this.isEditing() && detail) {
      const parentRef =
        detail.parentHash ||
        detail.declarationV4?.extends ||
        detail.declaration?.extends ||
        detail.lineage?.[0]?.hash ||
        "";
      const parentVer = parentRef
        ? this.versions().find(
            (v) =>
              v.hash === parentRef ||
              `${v.key}@${v.version}` === parentRef ||
              v.key === parentRef,
          )
        : undefined;
      oldT = parentVer ? this.readonlySkillText(parentVer) : "";
      newT = this.readonlySkillText(detail);
    }
    if (oldT === newT) return [];

    const lines: DiffPreviewLine[] = [];
    const oldLines = oldT ? oldT.split("\n") : [];
    const newLines = newT ? newT.split("\n") : [];

    for (const l of oldLines) {
      lines.push({ kind: "del", text: l });
    }
    for (const l of newLines) {
      lines.push({ kind: "add", text: l });
    }

    return [
      {
        path: "skill.text",
        status: "modified",
        additions: newLines.length,
        deletions: oldLines.length,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            lines,
          },
        ],
      } as DiffPreviewFile,
    ];
  });

  constructor() {
    const snapQm = this.route.snapshot?.queryParamMap;
    const initParam = snapQm?.get("flow") || snapQm?.get("from") || "";
    if (initParam) {
      this.flowQueryParam.set(initParam);
    }

    void this.loadVersions();

    const qpObs = (
      this.route as unknown as {
        queryParamMap?: {
          subscribe?: (
            fn: (m: { get: (k: string) => string | null }) => void,
          ) => Subscription;
        };
      }
    ).queryParamMap;
    if (qpObs && typeof qpObs.subscribe === "function") {
      this.querySub = qpObs.subscribe((m) => {
        const flowParam = m.get("flow") || m.get("from") || "";
        this.flowQueryParam.set(flowParam);
        if (this.versions().length === 0) return;
        if (flowParam) {
          const h = this.resolveVersionParam(flowParam);
          if (h && h !== this.selectedHash()) {
            void this.doSelectVersion(h);
          }
        } else if (this.activeFlowId()) {
          const active = this.versions().find(
            (v) => v.key === this.activeFlowId() && !v.retiredAt,
          );
          if (active && active.hash !== this.selectedHash()) {
            void this.doSelectVersion(active.hash);
          }
        }
      });
    }
  }

  ngOnDestroy(): void {
    this.querySub?.unsubscribe();
  }

  protected onDocumentClick(ev: Event): void {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    const insideAnchor = Array.from(
      this.hostEl.nativeElement.querySelectorAll(".qa-menu-anchor"),
    ).some((el) => el.contains(target));
    if (!insideAnchor) {
      this.closeMenus();
    }
  }

  protected toggleTestMenu(ev: Event): void {
    ev.stopPropagation();
    const next = !this.testMenuOpen();
    this.moreMenuOpen.set(false);
    this.testMenuOpen.set(next);
  }

  protected toggleMoreMenu(ev: Event): void {
    ev.stopPropagation();
    const next = !this.moreMenuOpen();
    this.testMenuOpen.set(false);
    this.moreMenuOpen.set(next);
  }

  protected closeMenus(): void {
    this.testMenuOpen.set(false);
    this.moreMenuOpen.set(false);
  }

  protected openGuide(): void {
    this.studio()?.openGuide();
  }

  protected openYamlTab(): void {
    this.studio()?.inspectorTab.set("yaml");
  }

  protected onStudioStepSelected(): void {
    if (typeof window !== "undefined" && window.innerWidth < 600) {
      this.mobileInspectorOpen.set(true);
    }
  }

  protected enterDraftFromStudio(): void {
    if (!this.isEditing() && this.canAdmin()) {
      this.newVersion();
    }
  }

  protected onFlowAdopted(hash: string): void {
    void this.loadVersions().then(() => {
      if (hash) {
        void this.doSelectVersion(hash);
      }
    });
  }

  private resolveVersionParam(raw: string): string {
    if (raw.includes("@")) {
      const [key, ver] = raw.split("@");
      const verNum = Number((ver || "").replace(/^v/i, ""));
      const candidates = this.versions()
        .filter((item) => item.key === key && item.version === verNum)
        .sort(compareFlowVersionsDesc);
      const v = candidates.find((item) => !item.retiredAt) ?? candidates[0];
      if (v) return v.hash;
    }
    const matching = this.versions()
      .filter((item) => item.key === raw)
      .sort(compareFlowVersionsDesc);
    const preferred = matching.find((item) => !item.retiredAt) ?? matching[0];
    if (preferred) return preferred.hash;
    return raw;
  }

  protected selectFlowFamily(flowKey: string): void {
    const fam = this.catalogFamilies().all.find((g) => g.key === flowKey);
    if (fam) {
      void this.selectVersion(fam.latestActiveHash, true);
      return;
    }
    const hash = this.resolveVersionParam(flowKey);
    if (hash) {
      void this.selectVersion(hash, true);
    }
  }

  protected onStudioSkillChange(ev: {
    mode: "inherit" | "append" | "replace";
    text: string;
  }): void {
    this.draftDeclaration.update((prev) => ({
      ...prev,
      skill: {
        ...prev.skill,
        mode: ev.mode,
        text: ev.mode === "inherit" ? "" : ev.text,
      },
      verifier: { ...prev.verifier, tiers: [...prev.verifier.tiers] },
    }));
  }

  schemaShortBadge(detail: QAFlowVersionDetail): string {
    if (
      this.isEditing() &&
      this.draftDeclaration().schema === "grain.dev/qa-flow/v4"
    ) {
      return "v4";
    }
    return schemaShortLabel(detail);
  }

  protected rolloutStatusTone(flowKey: string): string {
    if (this.activeFlowId() === flowKey) {
      if (this.qaEnabled() && this.activeRolloutPct() > 0) {
        return "healthy";
      }
      return "warn";
    }
    return "neutral";
  }

  protected rolloutStatusLabel(flowKey: string): string {
    if (this.activeFlowId() === flowKey) {
      if (this.qaEnabled() && this.activeRolloutPct() > 0) {
        return `Active (${this.activeRolloutPct()}%)`;
      }
      return "Default · Paused (0%)";
    }
    return "Available";
  }

  protected rolloutStatusTip(flowKey: string): string {
    if (this.activeFlowId() === flowKey) {
      if (this.qaEnabled() && this.activeRolloutPct() > 0) {
        return `Active default workflow for ${this.activeRolloutPct()}% of eligible new tasks.`;
      }
      return "Selected as default in Settings → Tasks, but rollout is currently paused at 0%.";
    }
    return "Available to pin on schedules, suites, A/B experiments, or set as the global default.";
  }

  protected canShowSetDefault(detail: QAFlowVersionDetail): boolean {
    if (!this.canWriteSettings() || detail.retiredAt) return false;
    const alreadyActive =
      this.qaEnabled() &&
      this.activeFlowId() === detail.key &&
      this.activeRolloutPct() > 0;
    return !alreadyActive;
  }

  confirmSetAsDefault(): void {
    const detail = this.selectedDetail();
    if (!detail) return;
    const prev = {
      qaEnabled: this.qaEnabled(),
      qaFlowId: this.activeFlowId() || "golden-v1-minimal",
      qaRolloutPct: this.activeRolloutPct(),
      qaShadowOnControl: this.qaShadowOnControl(),
    };
    const nextPct = prev.qaRolloutPct > 0 ? prev.qaRolloutPct : 100;
    const friendly = humanizeWorkflowKey(detail.key, detail.label);

    this.confirmRequest.set({
      title: `Set ${detail.label || friendly} as default`,
      message: `Activate "${detail.label || friendly}" (${detail.key}) for ${nextPct}% of eligible new tasks with shadow evaluation on control?`,
      accept: "Set as default",
      destructive: false,
      run: async () => {
        try {
          await this.api.put("PUT /api/settings", undefined, {
            qaEnabled: true,
            qaFlowId: detail.key,
            qaRolloutPct: nextPct,
            qaShadowOnControl: true,
          });
          this.qaEnabled.set(true);
          this.activeFlowId.set(detail.key);
          this.activeRolloutPct.set(nextPct);
          this.qaShadowOnControl.set(true);
          this.snackbar.show(
            `Default workflow set to ${detail.label || friendly} (${nextPct}%)`,
            {
              label: "Undo",
              run: async () => {
                await this.api.put("PUT /api/settings", undefined, prev);
                this.qaEnabled.set(prev.qaEnabled);
                this.activeFlowId.set(prev.qaFlowId);
                this.activeRolloutPct.set(prev.qaRolloutPct);
                this.qaShadowOnControl.set(prev.qaShadowOnControl);
              },
            },
          );
        } catch {
          this.snackbar.show("Failed to update default workflow");
        }
      },
    });
  }

  byteCount(text: string): number {
    return utf8ByteCount(text);
  }

  readonlySkillText(detail: QAFlowVersionDetail): string {
    return (
      detail.declaration?.skill?.text ||
      detail.sourceYaml ||
      detail.summary ||
      ""
    );
  }

  readonlySkillBytes(detail: QAFlowVersionDetail): number {
    if (detail.resolved?.injectSkill === false) return 0;
    if (detail.declaration?.skill?.text) {
      return this.byteCount(detail.declaration.skill.text);
    }
    return detail.resolved?.skillBytes ?? this.byteCount(detail.summary || "");
  }

  isFloorCheck(checkId: string): boolean {
    return isLockedFloorRule(checkId);
  }

  toggleParentDiff(): void {
    this.showParentDiff.update((v) => !v);
  }

  openProbe(): void {
    this.studio()?.showProbe.set(true);
  }

  openAdopt(): void {
    this.studio()?.showAdopt.set(true);
  }

  async loadVersions(): Promise<void> {
    if (this.access.can("GET /api/settings")) {
      try {
        const settings = (await this.api.get("GET /api/settings")) as {
          qaEnabled?: boolean;
          qaFlowId?: string;
          qaRolloutPct?: number;
          qaShadowOnControl?: boolean;
        } | null;
        if (settings) {
          this.qaEnabled.set(Boolean(settings.qaEnabled));
          this.activeFlowId.set(settings.qaFlowId ?? "");
          this.activeRolloutPct.set(settings.qaRolloutPct ?? 0);
          this.qaShadowOnControl.set(settings.qaShadowOnControl ?? true);
        }
      } catch {
        // Optional settings read when operator holds narrower scope.
      }
    }

    let loaded: QAFlowVersionItem[] = [];
    try {
      const res = (await this.api.get<QAFlowVersionsResponse>(
        "GET /api/qa/flow-versions",
        undefined,
        "limit=50",
      )) as QAFlowVersionsResponse | null;
      loaded = Array.isArray(res?.versions) ? res.versions : [];
    } catch {
      loaded = [];
    }

    if (
      loaded.length === 0 ||
      loaded.some((v) => v.key === "golden-v1-minimal" && v.builtIn)
    ) {
      let fallback: QAFlowsResponse | null = null;
      try {
        fallback = (await this.api.get<QAFlowsResponse>(
          "GET /api/qa/flows",
        )) as QAFlowsResponse | null;
      } catch {
        fallback = null;
      }
      for (const f of fallback?.flows ?? []) {
        const existingIdx = loaded.findIndex((x) => x.key === f.id);
        if (existingIdx >= 0) {
          if (
            f.label &&
            loaded[existingIdx].label === loaded[existingIdx].key
          ) {
            loaded[existingIdx] = {
              ...loaded[existingIdx],
              label: f.label,
            };
          }
          continue;
        }
        loaded.push({
          hash: f.id,
          key: f.id,
          version: 1,
          label: f.label,
          summary: f.summary,
          qaEngineRev: 1,
          builtIn: true,
          resolved: f,
        });
      }
    }

    this.versions.set(loaded);
    if (!this.selectedHash() && loaded.length > 0) {
      const qm = this.route.snapshot?.queryParamMap;
      const fromParam = qm?.get("from") || qm?.get("flow");
      if (fromParam) {
        this.flowQueryParam.set(fromParam);
        const resolved = this.resolveVersionParam(fromParam);
        if (resolved) {
          await this.doSelectVersion(resolved);
          return;
        }
      }
      const activeMatch = this.activeFlowId()
        ? loaded
            .filter((v) => v.key === this.activeFlowId() && !v.retiredAt)
            .sort(compareFlowVersionsDesc)[0]
        : undefined;
      const primaryFirst =
        groupWorkflowFamilies(loaded).primary[0]?.latestActiveHash;
      const firstHash = activeMatch?.hash ?? primaryFirst ?? loaded[0].hash;
      await this.doSelectVersion(firstHash);
    }
  }

  async selectVersion(hash: string, fromUserClick = false): Promise<void> {
    if (this.isEditing()) {
      this.confirmRequest.set({
        title: "Unsaved changes",
        message: "You have unsaved draft changes. Discard them?",
        accept: "Discard",
        destructive: true,
        run: async () => {
          await this.doSelectVersion(hash, fromUserClick);
        },
      });
    } else {
      await this.doSelectVersion(hash, fromUserClick);
    }
  }

  async doSelectVersion(hash: string, fromUserClick = false): Promise<void> {
    this.selectedHash.set(hash);
    this.isEditing.set(false);
    this.dryRunResult.set(null);
    this.closeMenus();
    if (fromUserClick) {
      this.mobileInspectorOpen.set(true);
    }
    const local = this.versions().find((x) => x.hash === hash);
    if (fromUserClick && local && this.router) {
      const qpObs = (this.route as unknown as { queryParamMap?: unknown })
        .queryParamMap;
      if (qpObs) {
        const grp = this.groupedVersions().find((g) => g.key === local.key);
        const latestActive =
          grp?.versions.find((v) => !v.retiredAt) ?? grp?.versions[0];
        const flowQueryVal =
          local.hash === latestActive?.hash
            ? local.key
            : local.version !== (latestActive?.version ?? local.version)
              ? `${local.key}@${local.version}`
              : local.hash;
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { flow: flowQueryVal },
          queryParamsHandling: "merge",
        });
      }
    }
    try {
      const detail = (await this.api.get<QAFlowVersionDetail>(
        "GET /api/qa/flow-versions/{hash}",
        { hash },
      )) as QAFlowVersionDetail | null;
      if (this.selectedHash() !== hash) return;
      if (detail && detail.hash) {
        this.selectedDetail.set({
          ...local,
          ...detail,
          label:
            local?.label && detail.label === detail.key
              ? local.label
              : detail.label,
          resolved:
            detail.resolved ??
            (detail as unknown as { spec?: QAFlowVersionDetail["resolved"] })
              .spec ??
            local?.resolved,
        });
        return;
      }
    } catch {
      // Fall back to cached list item below.
    }
    if (this.selectedHash() !== hash) return;
    if (local) {
      this.selectedDetail.set(local);
    }
  }

  newVersion(): void {
    this.isEditing.set(true);
    this.isFork.set(false);
    this.initDraft();
  }

  forkFlow(): void {
    this.isEditing.set(true);
    this.isFork.set(true);
    this.initDraft();
    this.studio()?.openGuide();
  }

  initDraft(): void {
    const detail = this.selectedDetail();
    if (!detail) return;
    const inheritsParentSkill = Boolean(
      !detail.declaration?.skill &&
      !detail.declarationV4?.skill &&
      (detail.parentHash ||
        detail.declarationV4?.extends ||
        detail.declarationV3?.extends ||
        detail.declaration?.extends),
    );
    const base: FlowDeclarationV2 = detail.declaration ?? {
      schema: "grain.dev/qa-flow/v2",
      key: detail.key,
      extends: detail.hash,
      label: detail.label,
      summary: detail.summary,
      skill: {
        mode: inheritsParentSkill ? "inherit" : "replace",
        text: inheritsParentSkill ? "" : detail.summary || "",
        maxBytes: 1800,
      },
      stopNudge: detail.resolved?.stopNudge || false,
      stagingIsolation: detail.resolved?.stagingIsolation || false,
      checks: {},
      verifier: {
        enabled: detail.resolved?.enableS4 || false,
        tiers: ["T1", "T2", "T3"],
        maxRepairRounds: detail.resolved?.maxS4RepairRounds || 1,
        maxSeconds: 60,
        maxTokens: 50000,
        checklist: "escape-classes-v1",
      },
    };

    const draft = structuredClone(base);
    if (
      detail.schemaVer === "grain.dev/qa-flow/v4" ||
      detail.schema === "grain.dev/qa-flow/v4" ||
      detail.declarationV4 ||
      detail.key.includes("v4")
    ) {
      draft.schema = "grain.dev/qa-flow/v4";
      draft.declarationV4 = detail.declarationV4;
    } else if (
      detail.schemaVer === "grain.dev/qa-flow/v3" ||
      detail.schema === "grain.dev/qa-flow/v3" ||
      detail.declarationV3 ||
      detail.key.startsWith("golden-v3")
    ) {
      draft.schema = "grain.dev/qa-flow/v3";
      draft.declarationV3 = detail.declarationV3;
    }
    draft.key = this.isFork() ? `${detail.key}-fork` : detail.key;
    draft.extends = detail.hash;

    const checks: Record<string, { enabled: boolean; severity: string }> = {};
    const params: Record<string, Record<string, unknown>> = {};
    for (const c of this.builtInCheckKeys) {
      if (this.isFloorCheck(c)) {
        checks[c] = { enabled: true, severity: "blocking" };
      } else {
        const resolvedRule = detail.resolved?.rules?.find((r) => r.id === c);
        checks[c] = {
          enabled: draft.checks?.[c]?.enabled ?? resolvedRule?.enabled ?? false,
          severity:
            draft.checks?.[c]?.severity || resolvedRule?.severity || "blocking",
        };
        params[c] = { ...(draft.checks?.[c]?.params || {}) };
      }
    }
    this.draftChecks.set(checks);
    this.draftCheckParams.set(params);
    this.draftDeclaration.set(draft);
  }

  cancelEdit(): void {
    this.confirmRequest.set({
      title: "Discard draft",
      message: "Discard your unpublished draft changes?",
      accept: "Discard draft",
      destructive: true,
      run: async () => {
        this.isEditing.set(false);
        this.isFork.set(false);
      },
    });
  }

  setDraftField(
    field: "key" | "extends" | "label" | "summary" | "skill.text",
    val: string,
  ): void {
    this.draftDeclaration.update((prev) => {
      const next: FlowDeclarationV2 = {
        ...prev,
        skill: { ...prev.skill },
        verifier: { ...prev.verifier, tiers: [...prev.verifier.tiers] },
      };
      if (field === "key") next.key = val;
      if (field === "extends") next.extends = val;
      if (field === "label") next.label = val;
      if (field === "summary") next.summary = val;
      if (field === "skill.text") next.skill.text = val;
      return next;
    });
  }

  updateDraft(field: string, event: Event): void {
    const val = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (
      field === "key" ||
      field === "extends" ||
      field === "label" ||
      field === "summary" ||
      field === "skill.text"
    ) {
      this.setDraftField(field, val);
    }
  }

  protected setBuiltinCheckEnabled(check: string, enabled: boolean): void {
    this.draftChecks.update((prev) => {
      const cur = prev[check] || { enabled: false, severity: "blocking" };
      return {
        ...prev,
        [check]: { ...cur, enabled },
      };
    });
  }

  toggleCheckEnabled(check: string): void {
    const cur = this.draftChecks()[check]?.enabled ?? false;
    this.setBuiltinCheckEnabled(check, !cur);
  }

  updateCheckSeverity(check: string, sev: string): void {
    this.draftChecks.update((prev) => {
      const cur = prev[check] || { enabled: true, severity: "blocking" };
      return {
        ...prev,
        [check]: { ...cur, severity: sev },
      };
    });
  }

  prepareDraft(): FlowDeclarationV2 & Partial<FlowDeclarationV4> {
    const draft = structuredClone(
      this.draftDeclaration(),
    ) as FlowDeclarationV2 & Partial<FlowDeclarationV4>;
    delete draft.declarationV3;
    delete draft.declarationV4;

    const checks = this.draftChecks();
    const params = this.draftCheckParams();
    draft.checks = {};
    for (const c of this.builtInCheckKeys) {
      if (this.isFloorCheck(c)) continue;
      if (checks[c]?.enabled) {
        draft.checks[c] = {
          enabled: true,
          severity: (checks[c].severity || "blocking") as
            "blocking" | "warn" | "shadow",
        };
        if (params[c] && Object.keys(params[c]).length > 0) {
          draft.checks[c].params = { ...params[c] };
        }
      } else {
        draft.checks[c] = { enabled: false };
      }
    }

    const st = this.studio();
    if (st) {
      const mode = st.codingSkillMode() || "replace";
      draft.skill = {
        mode,
        text: mode === "inherit" ? "" : st.codingSkillText(),
        maxBytes: draft.skill?.maxBytes || 4096,
      };
      draft.stopNudge = st.stopNudge();
      draft.verifier = {
        ...draft.verifier,
        enabled: Boolean(st.verifierEnabled()),
      };

      if (
        draft.schema === "grain.dev/qa-flow/v4" ||
        draft.schema === "grain.dev/qa-flow/v3" ||
        st.hasV4Customizations()
      ) {
        const v4 = st.exportDeclarationV4({
          key: draft.key,
          extends: draft.extends,
          label: draft.label,
          summary: draft.summary,
          maxSkillBytes: draft.skill.maxBytes,
        });
        draft.schema = "grain.dev/qa-flow/v4";
        if (v4.skill) {
          draft.skill = v4.skill;
        }
        draft.stages = v4.stages;
        draft.decompose = v4.decompose;
        draft.context = v4.context;
        draft.readabilityPacks = v4.readabilityPacks;
        draft.skillSteps = v4.skillSteps;
        draft.prContract = v4.prContract;
        draft.stopNudge = v4.stopNudge ?? draft.stopNudge;
        if (v4.verifier) {
          draft.verifier = {
            ...draft.verifier,
            enabled: Boolean(v4.verifier.enabled),
          };
        }
        if (v4.customChecks?.length) {
          draft.customChecks = v4.customChecks;
        } else {
          delete draft.customChecks;
          delete draft["custom-checks"];
        }
      }
    }

    return draft;
  }

  async runDryRun(): Promise<void> {
    if (this.isEditing()) {
      await this.dryRunDraft();
      return;
    }
    await this.dryRun();
  }

  async dryRunDraft(): Promise<void> {
    try {
      const decl = this.prepareDraft();
      const res = await this.api.post<QADryRunResponse>(
        "POST /api/qa/flow-versions",
        undefined,
        { declaration: decl },
        "dryRun=1&limit=20",
      );
      this.dryRunResult.set(res);
      this.snackbar.show("Dry run complete");
    } catch {
      this.snackbar.show("Dry run failed");
    }
  }

  async dryRun(): Promise<void> {
    const detail = this.selectedDetail();
    if (!detail) return;
    try {
      const res = await this.api.post<QADryRunResponse>(
        "POST /api/qa/flow-versions",
        undefined,
        { hash: detail.hash },
        "dryRun=1&limit=20",
      );
      this.dryRunResult.set(res);
      this.snackbar.show("Dry run complete");
    } catch {
      this.snackbar.show("Dry run failed");
    }
  }

  confirmPublish(): void {
    const decl = this.prepareDraft();
    const activeBlocking =
      Object.values(decl.checks || {}).filter((c) => c.severity === "blocking")
        .length +
      (decl.customChecks?.filter((c) => c.severity === "blocking").length ??
        0) +
      2;
    const skillBytes = this.byteCount(decl.skill.text);
    const targetVer = this.isFork() ? 1 : this.nextVersionNum();
    this.confirmRequest.set({
      title: `Publish v${targetVer}`,
      message: `Publish ${decl.key}@v${targetVer} (extends ${decl.extends || "none"})?\nPrompt size: ${skillBytes} bytes · Blocking checks: ${activeBlocking}.`,
      accept: `Publish v${targetVer}`,
      destructive: false,
      run: async () => {
        try {
          const pubRes = (await this.api.post<
            QAFlowPublishResponse & { hash?: string }
          >("POST /api/qa/flow-versions", undefined, {
            declaration: decl,
          })) as (QAFlowPublishResponse & { hash?: string }) | null;
          this.snackbar.show("Version published");
          this.isEditing.set(false);
          this.isFork.set(false);
          await this.loadVersions();
          const newHash = pubRes?.version?.hash ?? pubRes?.hash;
          if (newHash) {
            await this.doSelectVersion(newHash);
          }
        } catch {
          this.snackbar.show("Publish failed");
        }
      },
    });
  }

  retireFlow(): void {
    const detail = this.selectedDetail();
    if (!detail) return;
    this.confirmRequest.set({
      title: "Retire flow",
      message: `Retire version ${detail.key}@${detail.version} (${detail.hash})?`,
      accept: "Retire",
      destructive: true,
      run: async () => {
        try {
          await this.api.post("POST /api/qa/flow-versions", undefined, {
            action: "retire",
            hash: detail.hash,
          });
          this.snackbar.show("Flow retired");
          await this.loadVersions();
          if (this.selectedHash() === detail.hash) {
            const nextActive = this.versions()
              .filter((v) => v.key === detail.key && !v.retiredAt)
              .sort(compareFlowVersionsDesc)[0];
            await this.doSelectVersion(nextActive?.hash ?? detail.hash);
          }
        } catch {
          this.snackbar.show("Retire failed");
        }
      },
    });
  }

  onConfirmDone(accepted: boolean): void {
    const req = this.confirmRequest();
    this.confirmRequest.set(null);
    if (accepted && req) {
      void req.run();
    }
  }
}
