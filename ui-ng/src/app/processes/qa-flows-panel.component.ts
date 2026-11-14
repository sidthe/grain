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
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
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
import { QaV3StudioComponent } from "./qa-v3-studio.component";
import { DiffViewerComponent } from "../shared/diff-viewer.component";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import {
  type FlowDeclarationV2,
  type QADryRunResponse,
  type QAFlowVersionDetail,
  type QAFlowVersionItem,
  type QAFlowVersionsResponse,
} from "./qa-flows.models";

@Component({
  selector: "g-qa-flows-panel",
  imports: [
    QaV3StudioComponent,
    DiffViewerComponent,
    PillSelectComponent,
    ConfirmDialogComponent,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ["./qa-flows-panel.css"],
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="qa-flows-layout" data-testid="qa-flows-panel">
      <div
        class="qa-flows-list"
        role="navigation"
        aria-label="Quality flow versions"
      >
        @for (group of groupedVersions(); track group.key) {
          <div class="flow-group">
            <div class="flow-group-title s-mono">{{ group.key }}</div>
            @for (v of group.versions; track v.hash) {
              <button
                type="button"
                class="flow-item"
                [attr.data-testid]="
                  v.hash === group.latestActiveHash
                    ? 'qa-flow-row-' + group.key
                    : null
                "
                [class.selected]="v.hash === selectedHash()"
                [attr.aria-current]="v.hash === selectedHash() ? 'true' : null"
                (click)="selectVersion(v.hash)"
              >
                <div class="flow-item-header">
                  <span class="s-mono">&#64;{{ v.version }}</span>
                  @if (
                    qaEnabled() &&
                    activeFlowId() === v.key &&
                    v.hash === group.latestActiveHash
                  ) {
                    <span class="badge active-badge"
                      >Active ({{ activeRolloutPct() }}%)</span
                    >
                  } @else if (v.hash === group.latestActiveHash) {
                    <span class="badge active-badge">Available</span>
                  }
                  @if (v.builtIn) {
                    <span class="badge builtin-badge">Built-in</span>
                  } @else {
                    <span class="badge custom-badge">Custom</span>
                  }
                  @if (v.retiredAt) {
                    <span class="badge retired-badge">Retired</span>
                  }
                </div>
                <div class="flow-item-rev">rev {{ v.qaEngineRev }}</div>
                <div class="flow-item-summary">{{ v.summary }}</div>
              </button>
            }
          </div>
        }
      </div>

      <div class="qa-flows-detail">
        @if (selectedDetail(); as detail) {
          @if (isEditing()) {
            <div class="editor-header">
              <h2>{{ isFork() ? "Fork flow" : "New version" }}</h2>
              <div class="editor-actions">
                <button type="button" class="btn-text" (click)="cancelEdit()">
                  Cancel
                </button>
                <button type="button" class="btn-tonal" (click)="dryRunDraft()">
                  Dry run draft
                </button>
                <button
                  type="button"
                  class="btn-primary"
                  [disabled]="skillByteOverflow()"
                  (click)="confirmPublish()"
                >
                  Publish version
                </button>
              </div>
            </div>

            @if (dryRunResult(); as dr) {
              <div class="dry-run-results">
                <h3>Dry Run Results</h3>
                <div>
                  Sampled PRs: <span class="s-num">{{ dr.sampledPRs }}</span> |
                  Would block PRs:
                  <span class="s-num">{{ dr.wouldBlockPRs }}</span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Would Block</th>
                      <th>Warn Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of dr.byCheck; track c.ruleId) {
                      <tr>
                        <td class="s-mono">{{ c.ruleId }}</td>
                        <td class="s-num">{{ c.wouldBlock }}</td>
                        <td class="s-num">{{ c.warnCount }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }

            <div class="jump-select">
              <span class="s-label">Jump to section</span>
              <g-pill-select
                ariaLabel="Jump to section"
                [options]="jumpOptions"
                [value]="jumpSection()"
                (valueChange)="scrollToSection($event)"
              />
            </div>

            <div class="editor-scroll-area">
              @if (draftDeclaration().schema === "grain.dev/qa-flow/v3") {
                <g-qa-v3-studio [decl]="draftDeclaration().declarationV3" />
              } @else {
                <div id="section-basics" class="editor-section">
                  <h3>Basics</h3>
                  <label for="qa-flow-key-input">Key</label>
                  <input
                    id="qa-flow-key-input"
                    type="text"
                    class="s-mono"
                    [value]="draftDeclaration().key"
                    (input)="updateDraft('key', $event)"
                    [disabled]="!isFork()"
                  />
                  <label for="qa-flow-ext-input">Extends</label>
                  <input
                    id="qa-flow-ext-input"
                    type="text"
                    class="s-mono"
                    [value]="draftDeclaration().extends || ''"
                    (input)="updateDraft('extends', $event)"
                    disabled
                  />
                  <label for="qa-flow-lbl-input">Label</label>
                  <input
                    id="qa-flow-lbl-input"
                    type="text"
                    [value]="draftDeclaration().label"
                    (input)="updateDraft('label', $event)"
                  />
                  <label for="qa-flow-sum-input">Summary</label>
                  <input
                    id="qa-flow-sum-input"
                    type="text"
                    [value]="draftDeclaration().summary || ''"
                    (input)="updateDraft('summary', $event)"
                  />
                </div>

                <div id="section-skill" class="editor-section">
                  <h3>Coding skill</h3>
                  <div class="skill-header">
                    <g-pill-select
                      ariaLabel="Coding skill mode"
                      [options]="skillOptions"
                      [value]="draftDeclaration().skill.mode"
                      (valueChange)="updateSkillMode($event)"
                    />
                    <div
                      class="byte-counter"
                      [class.error]="skillByteOverflow()"
                    >
                      <span class="s-num">{{ draftSkillBytes() }}</span>
                      /
                      <span class="s-num">{{
                        draftDeclaration().skill.maxBytes
                      }}</span>
                      bytes
                    </div>
                    <div class="compare-toggle">
                      <button
                        type="button"
                        class="g-switch"
                        role="switch"
                        aria-label="Compare with parent"
                        [attr.aria-checked]="showParentDiff()"
                        (click)="toggleParentDiff()"
                      ></button>
                      <span>Compare with parent</span>
                    </div>
                  </div>
                  @if (showParentDiff()) {
                    <g-diff-viewer [files]="diffFiles()" />
                  } @else {
                    <label for="qa-flow-skill-textarea"
                      >Skill instructions</label
                    >
                    <textarea
                      id="qa-flow-skill-textarea"
                      class="s-mono"
                      rows="8"
                      [value]="draftDeclaration().skill.text"
                      (input)="updateDraft('skill.text', $event)"
                    ></textarea>
                  }
                </div>

                <div id="section-checks" class="editor-section">
                  <h3>Built-in checks</h3>
                  @for (check of builtInCheckKeys; track check) {
                    <div class="check-row">
                      <div class="check-name s-mono">{{ check }}</div>
                      @if (isFloorCheck(check)) {
                        <button
                          type="button"
                          class="g-switch"
                          role="switch"
                          [attr.aria-label]="'Enable ' + check"
                          aria-checked="true"
                          disabled
                          title="Floors are always on and blocking"
                        ></button>
                        <g-pill-select
                          [ariaLabel]="check + ' severity'"
                          [options]="floorOptions"
                          value="blocking"
                          [disabled]="true"
                          title="Floors are always on and blocking"
                        />
                      } @else {
                        <button
                          type="button"
                          class="g-switch"
                          role="switch"
                          [attr.aria-label]="'Enable ' + check"
                          [attr.aria-checked]="draftChecks()[check].enabled"
                          (click)="toggleCheckEnabled(check)"
                        ></button>
                        <g-pill-select
                          [ariaLabel]="check + ' severity'"
                          [options]="severityOptions"
                          [value]="draftChecks()[check].severity || 'blocking'"
                          (valueChange)="updateCheckSeverity(check, $event)"
                          [disabled]="!draftChecks()[check].enabled"
                        />
                        @if (
                          check === "golden:mutation-hardening" ||
                          check === "golden:boundary-fuzz"
                        ) {
                          <div class="check-params">
                            @if (check === "golden:mutation-hardening") {
                              <label [attr.for]="check + '-mutants'"
                                >mutants
                                <input
                                  [id]="check + '-mutants'"
                                  type="number"
                                  class="s-num"
                                  [value]="
                                    draftCheckParams()[check]['mutants'] ?? 25
                                  "
                                  (input)="
                                    updateCheckParam(check, 'mutants', $event)
                                  "
                                  [disabled]="!draftChecks()[check].enabled"
                              /></label>
                            }
                            <label [attr.for]="check + '-max-seconds'"
                              >max-seconds
                              <input
                                [id]="check + '-max-seconds'"
                                type="number"
                                class="s-num"
                                [value]="
                                  draftCheckParams()[check]['max-seconds'] ??
                                  (check === 'golden:mutation-hardening'
                                    ? 60
                                    : 15)
                                "
                                (input)="
                                  updateCheckParam(check, 'max-seconds', $event)
                                "
                                [disabled]="!draftChecks()[check].enabled"
                            /></label>
                          </div>
                        }
                      }
                    </div>
                  }
                </div>

                <div id="section-verifier" class="editor-section">
                  <h3>Verifier</h3>
                  <div class="compare-toggle">
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      aria-label="Enable semantic verifier"
                      [attr.aria-checked]="draftDeclaration().verifier.enabled"
                      (click)="toggleVerifierEnabled()"
                    ></button>
                    <span>Enabled</span>
                  </div>
                  <div
                    class="tier-toggles"
                    role="group"
                    aria-label="Blast tiers"
                  >
                    @for (tier of verifierTiers; track tier) {
                      <button
                        type="button"
                        [attr.aria-pressed]="
                          draftDeclaration().verifier.tiers.includes(tier)
                        "
                        [disabled]="!draftDeclaration().verifier.enabled"
                        (click)="toggleTier(tier)"
                      >
                        {{ tier }}
                      </button>
                    }
                  </div>
                  <label for="qa-chk-select">Checklist</label>
                  <g-pill-select
                    id="qa-chk-select"
                    ariaLabel="Checklist"
                    [options]="checklistOptions"
                    [value]="draftDeclaration().verifier.checklist"
                    [disabled]="!draftDeclaration().verifier.enabled"
                    (valueChange)="updateVerifierChecklist($event)"
                  />
                  <label for="qa-ms-input">Max seconds</label>
                  <input
                    id="qa-ms-input"
                    type="number"
                    class="s-num"
                    [value]="draftDeclaration().verifier.maxSeconds"
                    [disabled]="!draftDeclaration().verifier.enabled"
                    (input)="updateDraft('verifier.maxSeconds', $event)"
                    [max]="600"
                  />
                  <label for="qa-mt-input">Max tokens</label>
                  <input
                    id="qa-mt-input"
                    type="number"
                    class="s-num"
                    [value]="draftDeclaration().verifier.maxTokens"
                    [disabled]="!draftDeclaration().verifier.enabled"
                    (input)="updateDraft('verifier.maxTokens', $event)"
                    [max]="200000"
                  />
                </div>
              }
            </div>
          } @else {
            <div class="detail-header">
              <h2 data-testid="qa-flow-insp-title">
                {{ detail.label || detail.key }}
                <span class="s-mono">&#64;{{ detail.version }}</span>
                @if (detail.schemaVer === "grain.dev/qa-flow/v3") {
                  <span class="severity-pill">v3</span>
                }
                @if (detail.sourceKind === "adopt" && detail.sourceRepo) {
                  <span class="s-mono severity-pill"
                    >{{ detail.sourceRepo }}&#64;{{
                      (detail.sourceCommit || "").slice(0, 7)
                    }}</span
                  >
                }
              </h2>
              <div class="detail-actions">
                <a
                  class="btn-text"
                  routerLink="/settings/tasks"
                  data-testid="qa-configure-rollout-link"
                  >Settings → Tasks</a
                >
                @if (canAdmin()) {
                  @if (!detail.builtIn) {
                    <button
                      type="button"
                      class="btn-tonal"
                      (click)="newVersion()"
                    >
                      New version
                    </button>
                  }
                  <button type="button" class="btn-tonal" (click)="forkFlow()">
                    Fork flow
                  </button>
                  <button type="button" class="btn-tonal" (click)="dryRun()">
                    Dry run
                  </button>
                  <a
                    class="btn-tonal"
                    [routerLink]="['/telemetry']"
                    [queryParams]="{
                      tab: 'quality',
                      createExp: '1',
                      flow: detail.hash,
                    }"
                    >Test in an experiment</a
                  >
                  @if (!detail.builtIn && !detail.retiredAt) {
                    <button
                      type="button"
                      class="btn-text btn-retire"
                      (click)="retireFlow()"
                    >
                      Retire
                    </button>
                  }
                }
              </div>
            </div>

            @if (dryRunResult(); as dr) {
              <div class="dry-run-results">
                <h3>Dry Run Results</h3>
                <div>
                  Sampled PRs: <span class="s-num">{{ dr.sampledPRs }}</span> |
                  Would block PRs:
                  <span class="s-num">{{ dr.wouldBlockPRs }}</span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Would Block</th>
                      <th>Warn Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of dr.byCheck; track c.ruleId) {
                      <tr>
                        <td class="s-mono">{{ c.ruleId }}</td>
                        <td class="s-num">{{ c.wouldBlock }}</td>
                        <td class="s-num">{{ c.warnCount }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }

            <div class="cards-layout" data-testid="qa-flow-detail-card">
              <div class="card">
                <h3>Coding skill</h3>
                <div
                  class="s-mono skill-text-readonly"
                  tabindex="0"
                  role="region"
                  aria-label="Coding skill markdown"
                >
                  {{ readonlySkillText(detail) }}
                </div>
                <div class="byte-count s-num">
                  {{ readonlySkillBytes(detail) }} bytes
                </div>
              </div>
              <div class="card">
                <h3>Built-in checks</h3>
                <table>
                  <tbody>
                    @for (rule of detail.resolved?.rules || []; track rule.id) {
                      <tr [attr.data-testid]="'qa-rule-card-' + rule.id">
                        <td class="s-mono">{{ rule.id }}</td>
                        <td>
                          <span class="severity-pill">{{ rule.severity }}</span>
                        </td>
                        <td>{{ rule.summary }}</td>
                        @if (isFloorCheck(rule.id)) {
                          <td><span class="badge floor-badge">Floor</span></td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <div class="card">
                <h3>Verifier</h3>
                <div>
                  @if (
                    detail.declaration
                      ? detail.declaration.verifier.enabled
                      : detail.resolved?.enableS4
                  ) {
                    Status:
                    <span class="s-mono">{{
                      detail.declaration?.verifier?.tiers?.length
                        ? (detail.declaration?.verifier?.tiers?.join("/") ??
                            "") +
                          " diffs (max " +
                          (detail.declaration?.verifier?.maxRepairRounds ?? 1) +
                          " round)"
                        : "T2/T3 diffs (max " +
                          (detail.resolved?.maxS4RepairRounds ?? 1) +
                          " round)"
                    }}</span
                    ><br />
                  } @else {
                    Status: <span class="s-mono">disabled</span><br />
                  }
                  Tiers:
                  <span class="s-mono">{{
                    (detail.declaration?.verifier?.tiers || []).join(", ") ||
                      "—"
                  }}</span
                  ><br />
                  Checklist:
                  <span class="s-mono">{{
                    detail.declaration?.verifier?.checklist ||
                      "escape-classes-v1"
                  }}</span
                  ><br />
                  Max seconds:
                  <span class="s-num">{{
                    detail.declaration?.verifier?.maxSeconds ??
                      (detail.resolved?.maxS4RepairRounds ?? 0) * 60
                  }}</span
                  ><br />
                </div>
              </div>
              @if (detail.lineage && detail.lineage.length > 0) {
                <div class="card">
                  <h3>Lineage</h3>
                  <ul>
                    @for (lin of detail.lineage; track lin.hash) {
                      <li class="s-mono">{{ lin.hash }}</li>
                    }
                  </ul>
                </div>
              }
            </div>
          }
        } @else {
          <div class="empty-detail">Select a flow version from the list.</div>
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
export class QaFlowsPanelComponent {
  private api = inject(GrainApi);
  private access = inject(AccessService);
  private snackbar = inject(SnackbarService);
  private route = inject(ActivatedRoute);

  versions = signal<QAFlowVersionItem[]>([]);
  selectedHash = signal<string | null>(null);
  selectedDetail = signal<QAFlowVersionDetail | null>(null);
  qaEnabled = signal(false);
  activeFlowId = signal("");
  activeRolloutPct = signal(0);

  isEditing = signal(false);
  isFork = signal(false);
  showParentDiff = signal(false);
  jumpSection = signal("basics");

  dryRunResult = signal<QADryRunResponse | null>(null);
  confirmRequest = signal<ConfirmRequest | null>(null);

  draftDeclaration = signal<FlowDeclarationV2>({
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
  draftChecks = signal<
    Record<
      string,
      { enabled: boolean; severity: string; params?: Record<string, unknown> }
    >
  >({});
  draftCheckParams = signal<Record<string, Record<string, unknown>>>({});

  readonly verifierTiers = ["T1", "T2", "T3"];

  readonly jumpOptions: PillOption[] = [
    { value: "basics", label: "Basics" },
    { value: "skill", label: "Coding skill" },
    { value: "checks", label: "Built-in checks" },
    { value: "verifier", label: "Verifier" },
  ];
  readonly skillOptions: PillOption[] = [
    { value: "replace", label: "Replace" },
    { value: "append", label: "Append" },
    { value: "inherit", label: "Inherit" },
  ];
  readonly floorOptions: PillOption[] = [
    { value: "blocking", label: "blocking" },
  ];
  readonly severityOptions: PillOption[] = [
    { value: "blocking", label: "blocking" },
    { value: "warn", label: "warn" },
    { value: "shadow", label: "shadow" },
  ];
  readonly checklistOptions: PillOption[] = [
    { value: "escape-classes-v1", label: "escape-classes-v1" },
  ];

  readonly builtInCheckKeys = [
    "golden:test-integrity-guard",
    "golden:strict-config-decoder",
    "golden:sibling-export-hazard",
    "golden:ui-budget-and-spec-floor",
    "golden:exported-surface-delta",
    "golden:test-hygiene",
    "golden:mutation-hardening",
    "golden:boundary-fuzz",
  ];

  canAdmin = computed(() => this.access.can("POST /api/qa/flow-versions"));

  draftSkillBytes = computed(() =>
    this.byteCount(this.draftDeclaration().skill?.text || ""),
  );

  skillByteOverflow = computed(
    () =>
      this.draftSkillBytes() > (this.draftDeclaration().skill?.maxBytes || 0),
  );

  groupedVersions = computed(() => {
    const list = this.versions();
    const groups = new Map<string, QAFlowVersionItem[]>();
    for (const v of list) {
      if (!groups.has(v.key)) groups.set(v.key, []);
      groups.get(v.key)!.push(v);
    }
    return Array.from(groups.entries())
      .map(([key, vers]) => {
        const sorted = [...vers].sort((a, b) => b.version - a.version);
        const latestActive = sorted.find((v) => !v.retiredAt);
        return {
          key,
          versions: sorted,
          latestActiveHash: latestActive?.hash,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  });

  diffFiles = computed(() => {
    const detail = this.selectedDetail();
    const oldT = detail ? this.readonlySkillText(detail) : "";
    const newT = this.draftDeclaration().skill?.text || "";
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
    void this.loadVersions();

    effect(
      () => {
        const from = this.route.snapshot.queryParamMap.get("from");
        if (from && this.versions().length > 0 && !this.selectedHash()) {
          let target = from;
          if (from.includes("@")) {
            const [key, ver] = from.split("@");
            const v = this.versions().find(
              (item) => item.key === key && item.version === Number(ver),
            );
            if (v) target = v.hash;
          }
          void this.selectVersion(target);
        }
      },
      { allowSignalWrites: true },
    );
  }

  byteCount(text: string): number {
    return new TextEncoder().encode(text || "").length;
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
    if (detail.declaration?.skill?.text) {
      return this.byteCount(detail.declaration.skill.text);
    }
    return detail.resolved?.skillBytes ?? this.byteCount(detail.summary || "");
  }

  isFloorCheck(checkId: string): boolean {
    return (
      checkId === "golden:test-integrity-guard" ||
      checkId === "golden:strict-config-decoder"
    );
  }

  toggleParentDiff(): void {
    this.showParentDiff.update((v) => !v);
  }

  async loadVersions(): Promise<void> {
    if (this.access.can("GET /api/settings")) {
      try {
        const settings = (await this.api.get("GET /api/settings")) as {
          qaEnabled?: boolean;
          qaFlowId?: string;
          qaRolloutPct?: number;
        } | null;
        if (settings) {
          this.qaEnabled.set(Boolean(settings.qaEnabled));
          this.activeFlowId.set(settings.qaFlowId ?? "");
          this.activeRolloutPct.set(settings.qaRolloutPct ?? 0);
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

    if (loaded.length === 0) {
      let fallback: QAFlowsResponse | null = null;
      try {
        fallback = (await this.api.get<QAFlowsResponse>(
          "GET /api/qa/flows",
        )) as QAFlowsResponse | null;
      } catch {
        fallback = null;
      }
      loaded = (fallback?.flows ?? []).map((f) => ({
        hash: f.id,
        key: f.id,
        version: 1,
        label: f.label,
        summary: f.summary,
        qaEngineRev: 1,
        builtIn: true,
        resolved: f,
      }));
    }

    this.versions.set(loaded);
    if (!this.selectedHash() && loaded.length > 0) {
      const activeMatch = this.activeFlowId()
        ? loaded.find((v) => v.key === this.activeFlowId() && !v.retiredAt)
        : undefined;
      const firstHash = activeMatch?.hash ?? loaded[0].hash;
      await this.doSelectVersion(firstHash);
    }
  }

  async selectVersion(hash: string): Promise<void> {
    if (this.isEditing()) {
      this.confirmRequest.set({
        title: "Unsaved changes",
        message: "You have unsaved changes. Discard them?",
        accept: "Discard",
        destructive: true,
        run: async () => {
          await this.doSelectVersion(hash);
        },
      });
    } else {
      await this.doSelectVersion(hash);
    }
  }

  async doSelectVersion(hash: string): Promise<void> {
    this.selectedHash.set(hash);
    this.isEditing.set(false);
    this.dryRunResult.set(null);
    const local = this.versions().find((x) => x.hash === hash);
    try {
      const detail = (await this.api.get<QAFlowVersionDetail>(
        "GET /api/qa/flow-versions/{hash}",
        { hash },
      )) as QAFlowVersionDetail | null;
      if (detail && detail.hash) {
        this.selectedDetail.set({
          ...local,
          ...detail,
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
  }

  initDraft(): void {
    const detail = this.selectedDetail();
    if (!detail) return;
    const base: FlowDeclarationV2 = detail.declaration ?? {
      schema: "grain.dev/qa-flow/v2",
      key: detail.key,
      extends: detail.hash,
      label: detail.label,
      summary: detail.summary,
      skill: {
        mode: "replace",
        text: detail.summary || "",
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

    const draft = JSON.parse(JSON.stringify(base)) as FlowDeclarationV2;
    if (
      detail.schemaVer === "grain.dev/qa-flow/v3" ||
      detail.declarationV3 ||
      detail.key.startsWith("golden-v3")
    ) {
      draft.schema = "grain.dev/qa-flow/v3";
      draft.declarationV3 = detail.declarationV3;
    }
    if (this.isFork()) {
      draft.key = detail.key + "-fork";
    }
    draft.extends = `${detail.key}@${detail.version}`;
    if (!draft.skill) {
      draft.skill = { mode: "replace", text: "", maxBytes: 1800 };
    }
    if (!draft.checks) draft.checks = {};

    const checks: Record<
      string,
      { enabled: boolean; severity: string; params?: Record<string, unknown> }
    > = {};
    const params: Record<string, Record<string, unknown>> = {};
    for (const c of this.builtInCheckKeys) {
      if (this.isFloorCheck(c)) {
        checks[c] = { enabled: true, severity: "blocking" };
      } else {
        checks[c] = {
          enabled: draft.checks[c]?.enabled ?? false,
          severity: draft.checks[c]?.severity || "blocking",
        };
        params[c] = { ...(draft.checks[c]?.params || {}) };
      }
    }
    this.draftChecks.set(checks);
    this.draftCheckParams.set(params);
    this.draftDeclaration.set(draft);
  }

  cancelEdit(): void {
    this.confirmRequest.set({
      title: "Unsaved changes",
      message: "You have unsaved changes. Discard them?",
      accept: "Discard",
      destructive: true,
      run: async () => {
        this.isEditing.set(false);
      },
    });
  }

  updateDraft(field: string, event: Event): void {
    const val = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
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
      if (field === "verifier.maxSeconds") {
        next.verifier.maxSeconds = Number(val);
      }
      if (field === "verifier.maxTokens") {
        next.verifier.maxTokens = Number(val);
      }
      return next;
    });
  }

  updateCheckParam(check: string, param: string, event: Event): void {
    const val = Number((event.target as HTMLInputElement).value);
    this.draftCheckParams.update((prev) => ({
      ...prev,
      [check]: { ...(prev[check] || {}), [param]: val },
    }));
  }

  toggleCheckEnabled(check: string): void {
    this.draftChecks.update((prev) => {
      const cur = prev[check] || { enabled: false, severity: "blocking" };
      return {
        ...prev,
        [check]: { ...cur, enabled: !cur.enabled },
      };
    });
  }

  toggleVerifierEnabled(): void {
    this.draftDeclaration.update((prev) => ({
      ...prev,
      verifier: { ...prev.verifier, enabled: !prev.verifier.enabled },
    }));
  }

  updateSkillMode(mode: string): void {
    this.draftDeclaration.update((prev) => ({
      ...prev,
      skill: {
        ...prev.skill,
        mode: mode as "replace" | "inherit" | "append",
      },
    }));
  }

  updateCheckSeverity(check: string, sev: string): void {
    this.draftChecks.update((prev) => {
      const cur = prev[check] || { enabled: false, severity: "blocking" };
      return {
        ...prev,
        [check]: { ...cur, severity: sev },
      };
    });
  }

  updateVerifierChecklist(val: string): void {
    this.draftDeclaration.update((prev) => ({
      ...prev,
      verifier: { ...prev.verifier, checklist: val },
    }));
  }

  toggleTier(tier: string): void {
    this.draftDeclaration.update((prev) => {
      const tiers = prev.verifier.tiers.includes(tier)
        ? prev.verifier.tiers.filter((t) => t !== tier)
        : [...prev.verifier.tiers, tier];
      return {
        ...prev,
        verifier: { ...prev.verifier, tiers },
      };
    });
  }

  scrollToSection(section: string): void {
    this.jumpSection.set(section);
    const el = document.getElementById("section-" + section);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }

  prepareDraft(): FlowDeclarationV2 {
    const draft = JSON.parse(
      JSON.stringify(this.draftDeclaration()),
    ) as FlowDeclarationV2;
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
      }
    }
    return draft;
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
      const body = detail.declaration
        ? { declaration: detail.declaration }
        : { yaml: detail.sourceYaml || "" };
      const res = await this.api.post<QADryRunResponse>(
        "POST /api/qa/flow-versions",
        undefined,
        body,
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
        .length + 2;
    const skillBytes = this.byteCount(decl.skill.text);
    this.confirmRequest.set({
      title: "Publish version",
      message: `Publish ${decl.key} (extends ${decl.extends || "none"})?\nSkill size: ${skillBytes} bytes.\nActive blocking checks: ${activeBlocking}.`,
      accept: "Publish",
      destructive: false,
      run: async () => {
        try {
          await this.api.post("POST /api/qa/flow-versions", undefined, {
            declaration: decl,
          });
          this.snackbar.show("Version published");
          this.isEditing.set(false);
          await this.loadVersions();
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
