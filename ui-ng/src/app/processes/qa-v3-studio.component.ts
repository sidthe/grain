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
  input,
  output,
  signal,
} from "@angular/core";
import { GrainApi } from "../api/grain-api.service";
import type { DiffPreviewFile } from "../api/models";
import { SnackbarService } from "../services/snackbar.service";
import { errorText } from "../sessions/session-helpers";
import { DialogTrapDirective } from "../shared/dialog-trap.directive";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import {
  ALL_WORKFLOW_STAGE_IDS,
  BUILT_IN_READABILITY_PACK_IDS,
  type CustomCheckDeclarationV3,
  type CustomStageDeclarationV3,
  type FixtureSelfTestReport,
  type FlowDeclarationV3,
  type FlowDeclarationV4,
  MAX_PROMPT_BUDGET_BYTES,
  type QAAdoptResponse,
  type QADryRunResponse,
  type QAFlowVersionDetail,
  type QAProbeResponse,
  type ReadabilityPackDecl,
  type SkillStepDecl,
  type WorkflowStageView,
  type WorkflowStepView,
  buildClientWorkflowStagesView,
  computeActivePromptBytes,
  evaluateFixturesClientSide,
  extractPatternExampleLines,
  formatStageModeLabel,
  formatStepModeLabel,
  serializePatternFixtures,
  stageModePillClass,
  stageModeTip,
  stepModePillClass,
  synthesizeCompanionFixtures,
  synthesizeDiffBudgetFixtures,
  utf8ByteCount,
} from "./qa-flows.models";
import {
  type CustomCheckEngine,
  type EditableCustomCheck,
  type EditableCustomStage,
  type InsertAfterStage,
  QaStepDrawerComponent,
  type StudioInspectorTab,
} from "./qa-step-drawer.component";

export type {
  CustomCheckEngine,
  EditableCustomCheck,
  EditableCustomStage,
  InsertAfterStage,
  StudioInspectorTab,
};
export type StepKindFilter = "all" | "skills" | "checks" | "agents";

function createAllCollapsedMap(): Readonly<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const id of ALL_WORKFLOW_STAGE_IDS) {
    out[id] = true;
  }
  return out;
}

function inputTextValue(ev: Event): string {
  if (
    ev.target instanceof HTMLInputElement ||
    ev.target instanceof HTMLTextAreaElement
  ) {
    return ev.target.value;
  }
  return "";
}

function inputNumberValue(ev: Event): number {
  if (ev.target instanceof HTMLInputElement) {
    const parsed = ev.target.valueAsNumber;
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizeStringList(
  raw: string | readonly string[] | undefined,
): readonly string[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return [raw.trim()];
  }
  return [];
}

function defaultFixturesForEngine(engine: CustomCheckEngine): {
  forbidAdded: string;
  whenChanged: string;
  requireChanged: string;
  maxChangedLines: number;
  failLine: string;
  passLine: string;
  failJson: string;
  passJson: string;
} {
  switch (engine) {
    case "companion": {
      const whenChanged = "pkg/model/schema.go";
      const requireChanged = "pkg/model/migrations.go";
      const syn = synthesizeCompanionFixtures(whenChanged, requireChanged);
      return {
        forbidAdded: "",
        whenChanged,
        requireChanged,
        maxChangedLines: 0,
        failLine: "",
        passLine: "",
        failJson: syn.failJson,
        passJson: syn.passJson,
      };
    }
    case "diff-budget": {
      const maxChangedLines = 250;
      const syn = synthesizeDiffBudgetFixtures(maxChangedLines, "pkg/**/*.go");
      return {
        forbidAdded: "",
        whenChanged: "",
        requireChanged: "",
        maxChangedLines,
        failLine: "",
        passLine: "",
        failJson: syn.failJson,
        passJson: syn.passJson,
      };
    }
    case "jsonschema":
      return {
        forbidAdded: "",
        whenChanged: "",
        requireChanged: "",
        maxChangedLines: 0,
        failLine: "",
        passLine: "",
        failJson: JSON.stringify([
          { name: "invalid-schema", content: '{"bad":true}' },
        ]),
        passJson: JSON.stringify([
          { name: "valid-schema", content: '{"schema":"v4"}' },
        ]),
      };
    case "pattern":
    default: {
      const failLine = 'console.log("debug")';
      const passLine = "const ready = true;";
      const ser = serializePatternFixtures(failLine, passLine);
      return {
        forbidAdded: "console\\.log\\(",
        whenChanged: "",
        requireChanged: "",
        maxChangedLines: 0,
        failLine,
        passLine,
        failJson: ser.failJson,
        passJson: ser.passJson,
      };
    }
  }
}

@Component({
  selector: "g-qa-v3-studio",
  imports: [
    DialogTrapDirective,
    StatusIconComponent,
    TipDirective,
    QaStepDrawerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./qa-v3-studio.css",
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="qa-v3-studio" data-testid="qa-v3-studio">
      <div class="qa-workbench-split">
        <!-- CENTER COLUMN: HEADER + LIFECYCLE STAGE SPINE -->
        <div class="qa-spine-col">
          <ng-content select="[qaCenterHeader]" />

          <section
            class="qa-stage-tree"
            aria-label="Software workflow lifecycle stages"
            data-testid="qa-stage-tree"
          >
            <div class="qa-tree-controls">
              <form
                class="qa-spine-search-form"
                role="search"
                autocomplete="off"
                (submit)="$event.preventDefault()"
              >
                <input
                  type="search"
                  data-testid="qa-step-search"
                  placeholder="Filter stages or substeps…"
                  aria-label="Filter stages or substeps"
                  [value]="stepSearch()"
                  (input)="stepSearch.set(textValue($event))"
                />
                <button
                  type="button"
                  class="btn-tonal qa-expand-all-btn"
                  data-testid="qa-expand-all-stages"
                  [gTip]="
                    allVisibleStagesExpanded()
                      ? 'Collapse all lifecycle stage cards'
                      : 'Expand all visible lifecycle stage cards'
                  "
                  (click)="toggleExpandAllStages()"
                >
                  {{
                    allVisibleStagesExpanded() ? "Collapse all" : "Expand all"
                  }}
                </button>
              </form>

              <div
                class="qa-kind-chips"
                role="group"
                aria-label="Filter substep type"
              >
                @for (opt of kindFilterOptions; track opt.id) {
                  <button
                    type="button"
                    class="qa-kind-chip"
                    [attr.aria-pressed]="kindFilter() === opt.id"
                    [attr.data-testid]="'qa-kind-filter-' + opt.id"
                    (click)="kindFilter.set(opt.id)"
                  >
                    {{ opt.label }}
                  </button>
                }
              </div>
            </div>

            <div class="qa-stage-tree-list" data-testid="qa-stage-spine-scroll">
              @for (stage of visibleStages(); track stage.id) {
                @let isSkipped = !(stage.enabled && stage.mode !== "off");
                @let collapsed = effectiveStageCollapsed(stage.id);
                <section
                  class="qa-stage-group"
                  [class.is-skipped]="isSkipped"
                  [attr.data-testid]="'qa-stage-' + stage.id"
                >
                  <button
                    type="button"
                    class="qa-stage-header-btn"
                    [attr.aria-expanded]="!collapsed"
                    [attr.data-testid]="'qa-stage-toggle-' + stage.id"
                    (click)="toggleStageCollapse(stage.id)"
                  >
                    <span class="qa-stage-title-wrap">
                      <span class="qa-stage-chevron" aria-hidden="true">{{
                        collapsed ? "▸" : "▾"
                      }}</span>
                      <span class="qa-stage-title">{{ stage.label }}</span>
                    </span>
                    <span class="qa-stage-meta">
                      <span class="qa-step-count">
                        {{ activeStepsInStage(stage) }}/{{ stage.steps.length }}
                      </span>
                      <span
                        [class]="'status-pill ' + stagePillClass(stage)"
                        [gTip]="stageTip(stage)"
                      >
                        <g-status-icon [tone]="stagePillClass(stage)" />
                        {{ stagePillLabel(stage) }}
                      </span>
                    </span>
                  </button>

                  <ul class="qa-step-list" [hidden]="collapsed">
                    @for (step of stage.steps; track step.id) {
                      <li [attr.data-testid]="'qa-rule-card-' + step.id">
                        <button
                          type="button"
                          class="qa-step-node"
                          [class.is-selected]="
                            selectedStepId() === step.id && !addingForStageId()
                          "
                          [attr.data-testid]="'qa-step-row-' + step.id"
                          (click)="selectStep(stage.id, step.id)"
                        >
                          <div class="qa-step-node-main">
                            <span class="qa-step-label">{{ step.label }}</span>
                            <span
                              [class]="'status-pill ' + stepPillClass(step)"
                            >
                              <g-status-icon [tone]="stepPillClass(step)" />
                              {{ stepPillLabel(step) }}
                            </span>
                          </div>
                          <div class="qa-step-node-sub">
                            <span class="s-mono">{{
                              step.scope || "**/*"
                            }}</span>
                            @if (step.bytes && step.bytes > 0) {
                              <span class="s-num">{{ step.bytes }} B</span>
                            }
                          </div>
                        </button>
                      </li>
                    }

                    @if (canEdit()) {
                      <li>
                        <button
                          type="button"
                          class="btn-text qa-add-step-btn"
                          data-testid="qa-add-step-btn"
                          [attr.data-stage-id]="stage.id"
                          [gTip]="
                            'Add a skill, deterministic check, or critic substep to stage ' +
                            stage.index +
                            '.'
                          "
                          (click)="requestAddSubstep(stage.id)"
                        >
                          + Add substep to Stage {{ stage.index }}…
                        </button>
                      </li>
                    }
                  </ul>
                </section>
              }

              @if (
                isPartialReadonlyFilterActive() && skippedStagesCount() > 0
              ) {
                <button
                  type="button"
                  class="qa-skipped-stages-bar"
                  data-testid="qa-toggle-skipped-stages"
                  [attr.aria-expanded]="showSkippedStages()"
                  gTip="Show or hide stages skipped in this partial workflow."
                  (click)="showSkippedStages.set(!showSkippedStages())"
                >
                  @if (showSkippedStages()) {
                    Hide {{ skippedStagesCount() }} skipped
                    {{ skippedStagesCount() === 1 ? "stage" : "stages" }}
                  } @else {
                    + {{ skippedStagesCount() }}
                    {{ skippedStagesCount() === 1 ? "stage" : "stages" }}
                    skipped in this workflow — Show all 8
                  }
                </button>
              }
            </div>
          </section>
        </div>

        <!-- RIGHT COLUMN: FOCUSED SUBSTEP / GUIDE DRAWER -->
        <g-qa-step-drawer
          [detail]="detail()"
          [stages]="workflowStages()"
          [selectedStage]="activeStage()"
          [selectedStep]="selectedStepView()"
          [addingForStage]="addingStageView()"
          [inspectorTab]="inspectorTab()"
          [editing]="editing()"
          [canEdit]="canEdit()"
          [isFork]="isFork()"
          [draftKey]="draftKey()"
          [draftLabel]="draftLabel()"
          [draftSummary]="draftSummary()"
          [qaEnabled]="qaEnabled()"
          [activeFlowId]="activeFlowId()"
          [activeRolloutPct]="activeRolloutPct()"
          [activePromptBytes]="activePromptBytes()"
          [verifierSummaryText]="verifierSummaryText()"
          [showParentDiff]="showParentDiff()"
          [diffFiles]="diffFiles()"
          [dryRunResult]="effectiveDryRun()"
          [fixtureReport]="fixtureReport()"
          [verifying]="verifying()"
          [yamlPreview]="buildYaml()"
          [s0Intent]="s0Intent()"
          [decomposeEnabled]="decomposeEnabled()"
          [decomposeMode]="decomposeMode()"
          [decomposeMaxSubtasks]="decomposeMaxSubtasks()"
          [decomposeTargetDiffLines]="decomposeTargetDiffLines()"
          [contextEnabled]="contextEnabled()"
          [contextIncludeCallers]="contextIncludeCallers()"
          [contextIncludeMemory]="contextIncludeMemory()"
          [contextMaxTokens]="contextMaxTokens()"
          [s2PlanCritic]="s2PlanCritic()"
          [codingSkillMode]="codingSkillMode()"
          [codingSkillText]="codingSkillText()"
          [readabilityPacks]="readabilityPacks()"
          [skillSteps]="skillSteps()"
          [customChecks]="customChecks()"
          [customStages]="customStages()"
          [prEnabled]="prEnabled()"
          [prMode]="prMode()"
          [prMaxSubjectChars]="prMaxSubjectChars()"
          [prRequiredSections]="prRequiredSections()"
          [prAuditLint]="prAuditLint()"
          [prGuidanceText]="prGuidanceText()"
          [stopNudge]="stopNudge()"
          [verifierEnabled]="verifierEnabled()"
          [s5Triage]="s5Triage()"
          (tabChange)="inspectorTab.set($event)"
          (closeStep)="openGuide()"
          (enterDraftReq)="enterDraftReq.emit()"
          (toggleParentDiffReq)="toggleParentDiffReq.emit()"
          (openProbeReq)="showProbe.set(true)"
          (verifyDryRunReq)="verifyDryRun()"
          (runFixtureSelfTestReq)="runFixtureSelfTest()"
          (selectStepFromInsight)="selectStepFromGuide($event)"
          (draftKeyChange)="draftKeyChange.emit($event)"
          (draftLabelChange)="draftLabelChange.emit($event)"
          (draftSummaryChange)="draftSummaryChange.emit($event)"
          (addSkillStepReq)="addSkillStepForStage($event)"
          (addCheckReq)="addCheck($event)"
          (addCustomStageReq)="addCustomStage()"
          (s0IntentChange)="s0Intent.set($event)"
          (decomposeEnabledChange)="decomposeEnabled.set($event)"
          (decomposeModeChange)="updateDecomposeMode($event)"
          (decomposeMaxSubtasksChange)="decomposeMaxSubtasks.set($event)"
          (decomposeTargetLinesChange)="decomposeTargetDiffLines.set($event)"
          (contextEnabledChange)="contextEnabled.set($event)"
          (contextCallersChange)="contextIncludeCallers.set($event)"
          (contextMemoryChange)="contextIncludeMemory.set($event)"
          (contextMaxTokensChange)="contextMaxTokens.set($event)"
          (s2PlanCriticChange)="s2PlanCritic.set($event)"
          (codingSkillModeChange)="updateCodingSkillMode($event)"
          (codingSkillTextChange)="codingSkillText.set($event)"
          (packEnabledChange)="updatePackEnabled($event.id, $event.enabled)"
          (packActivationChange)="
            updatePackActivation($event.id, $event.activation)
          "
          (packGlobsChange)="updatePackGlobs($event.id, $event.globs)"
          (packCustomTextChange)="updatePackCustomText($event.id, $event.text)"
          (skillStepEnabledChange)="
            updateSkillStepEnabled($event.id, $event.enabled)
          "
          (skillStepLabelChange)="updateSkillStepLabel($event.id, $event.label)"
          (skillStepGlobsChange)="updateSkillStepGlobs($event.id, $event.globs)"
          (skillStepTextChange)="updateSkillStepText($event.id, $event.text)"
          (removeSkillStepReq)="removeSkillStep($event)"
          (customCheckMetaChange)="
            updateCheckMeta($event.uid, $event.field, $event.val)
          "
          (customCheckSeverityChange)="
            updateCheckSeverity($event.uid, $event.severity)
          "
          (customCheckFieldChange)="
            updateCheckField($event.uid, $event.field, $event.val)
          "
          (customCheckMaxLinesChange)="
            updateCheckMaxLines($event.uid, $event.maxChangedLines)
          "
          (patternExampleChange)="
            updatePatternExample($event.uid, $event.kind, $event.line)
          "
          (removeCustomCheckReq)="removeCheck($event)"
          (customStageLabelChange)="updateStageLabel($event.uid, $event.label)"
          (customStageAfterChange)="
            updateStageInsertAfter($event.uid, $event.insertAfter)
          "
          (customStageTimeoutChange)="
            updateStageTimeout($event.uid, $event.timeoutSeconds)
          "
          (removeCustomStageReq)="removeCustomStage($event)"
          (builtinCheckToggleReq)="builtinCheckToggle.emit($event)"
          (builtinCheckSeverityReq)="builtinCheckSeverity.emit($event)"
          (prEnabledChange)="prEnabled.set($event)"
          (prModeChange)="updatePrMode($event)"
          (prMaxSubjectCharsChange)="prMaxSubjectChars.set($event)"
          (prRequiredSectionsChange)="prRequiredSections.set($event)"
          (prAuditLintChange)="prAuditLint.set($event)"
          (prGuidanceTextChange)="prGuidanceText.set($event)"
          (stopNudgeChange)="stopNudge.set($event)"
          (verifierEnabledChange)="verifierEnabled.set($event)"
          (s5TriageChange)="updateS5Triage($event)"
        />
      </div>

      <!-- ADOPT FLOW MODAL -->
      @if (showAdopt()) {
        <div
          class="modal-backdrop-full"
          (click)="showAdopt.set(false)"
          role="presentation"
        >
          <div
            class="modal-content-full"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qa-v3-adopt-title"
            data-testid="qa-v3-adopt-dialog"
            gDialogTrap
            (gDialogClose)="showAdopt.set(false)"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <h3 id="qa-v3-adopt-title">Import workflow from git commit</h3>
            <div class="modal-fields">
              <label for="adoptRepo">Repository (owner/name)</label>
              <input
                id="adoptRepo"
                type="text"
                [value]="adoptRepo()"
                (input)="adoptRepo.set(textValue($event))"
                placeholder="owner/repo"
              />
              <label for="adoptPath">Declaration file path</label>
              <input
                id="adoptPath"
                type="text"
                [value]="adoptPath()"
                (input)="adoptPath.set(textValue($event))"
              />
              <label for="adoptCommit">40-character commit SHA</label>
              <input
                id="adoptCommit"
                type="text"
                [value]="adoptCommit()"
                (input)="adoptCommit.set(textValue($event))"
                placeholder="0123456789abcdef0123456789abcdef01234567"
              />
            </div>
            <div class="dialog-actions">
              <button
                type="button"
                class="btn-text"
                (click)="showAdopt.set(false)"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn-primary"
                data-testid="qa-v3-submit-adopt"
                (click)="doAdopt()"
                [disabled]="adopting()"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      }

      <!-- WHAT-IF PROBE DRAWER -->
      @if (showProbe()) {
        <div
          class="modal-backdrop-right"
          (click)="showProbe.set(false)"
          role="presentation"
        >
          <div
            class="probe-drawer-full"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qa-v3-probe-title"
            data-testid="qa-v3-probe-dialog"
            gDialogTrap
            (gDialogClose)="showProbe.set(false)"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <h3 id="qa-v3-probe-title">Simulate file paths &amp; blast tier</h3>
            <div class="modal-fields">
              <label for="probeTitle">Sample task title</label>
              <input
                id="probeTitle"
                type="text"
                [value]="probeTitle()"
                (input)="probeTitle.set(textValue($event))"
              />
              <label for="probeBody">Sample task description</label>
              <textarea
                id="probeBody"
                rows="3"
                [value]="probeBody()"
                (input)="probeBody.set(textValue($event))"
              ></textarea>
              <label for="probeFiles"
                >Touched files (comma or newline separated)</label
              >
              <textarea
                id="probeFiles"
                rows="3"
                class="s-mono"
                [value]="probeFiles()"
                (input)="probeFiles.set(textValue($event))"
              ></textarea>
              <label for="probeNonTest">Non-test added lines</label>
              <input
                id="probeNonTest"
                type="number"
                [value]="probeNonTest()"
                (input)="probeNonTest.set(numValue($event))"
              />
            </div>
            <div class="dialog-actions">
              <button
                type="button"
                class="btn-text"
                (click)="showProbe.set(false)"
              >
                Close
              </button>
              <button
                type="button"
                class="btn-primary"
                data-testid="qa-v3-submit-probe"
                (click)="doProbe()"
                [disabled]="probing()"
              >
                Run simulation
              </button>
            </div>
            @if (probeResult(); as pr) {
              <div class="qa-drawer-card" data-testid="qa-v3-probe-result">
                <p>
                  <strong>Complexity:</strong> {{ pr.complexity.tier }} (score
                  {{ pr.complexity.score }})
                </p>
                <p>
                  <strong>Blast radius:</strong> {{ pr.risk.tier }} (score
                  {{ pr.risk.score }}/100)
                </p>
                <p><strong>Stages fired:</strong> {{ probeStagesText() }}</p>
                <p>
                  <strong>Merge triage:</strong> {{ pr.triage.decision }} ({{
                    pr.triage.mode
                  }})
                </p>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class QaV3StudioComponent {
  private readonly api = inject(GrainApi);
  private readonly snackbar = inject(SnackbarService);

  readonly decl = input<FlowDeclarationV3 | undefined>(undefined);
  readonly declV4 = input<FlowDeclarationV4 | undefined>(undefined);
  readonly detail = input<QAFlowVersionDetail | null>(null);
  readonly editing = input<boolean>(true);
  readonly canEdit = input<boolean>(true);
  readonly embedded = input<boolean>(false);
  readonly isFork = input<boolean>(false);
  readonly draftKey = input<string>("");
  readonly draftLabel = input<string>("");
  readonly draftSummary = input<string>("");
  readonly builtinCheckOverrides = input<
    Readonly<Record<string, { enabled?: boolean; severity?: string }>>
  >({});

  readonly qaEnabled = input<boolean>(false);
  readonly activeFlowId = input<string>("");
  readonly activeRolloutPct = input<number>(0);

  readonly showParentDiff = input<boolean>(false);
  readonly diffFiles = input<readonly DiffPreviewFile[]>([]);
  readonly externalDryRun = input<QADryRunResponse | null>(null);

  readonly adopted = output<string>();
  readonly toggleParentDiffReq = output<void>();
  readonly enterDraftReq = output<void>();
  readonly stepSelected = output<string>();
  readonly draftKeyChange = output<string>();
  readonly draftLabelChange = output<string>();
  readonly draftSummaryChange = output<string>();
  readonly builtinCheckToggle = output<{ id: string; enabled: boolean }>();
  readonly builtinCheckSeverity = output<{ id: string; severity: string }>();

  private nextUid = 1;
  private lastHydratedIdentity = "__uninitialized__";
  private wasEditing = false;

  readonly maxPromptBudgetBytes = MAX_PROMPT_BUDGET_BYTES;

  readonly stepSearch = signal("");
  readonly kindFilter = signal<StepKindFilter>("all");
  readonly collapsedStages = signal<Readonly<Record<string, boolean>>>(
    createAllCollapsedMap(),
  );
  readonly showSkippedStages = signal(false);
  readonly selectedStageId = signal<string>("s0-decompose");
  readonly selectedStepId = signal<string | null>(null);
  readonly addingForStageId = signal<string | null>(null);
  readonly inspectorTab = signal<StudioInspectorTab>("definition");

  readonly s0Intent = signal(false);
  readonly decomposeEnabled = signal(false);
  readonly decomposeMode = signal<"off" | "slice_plan" | "propose_dag">(
    "slice_plan",
  );
  readonly decomposeMaxSubtasks = signal(4);
  readonly decomposeTargetDiffLines = signal(400);

  readonly contextEnabled = signal(false);
  readonly contextIncludeCallers = signal(true);
  readonly contextIncludeMemory = signal(true);
  readonly contextMaxTokens = signal(12000);

  readonly s2PlanCritic = signal(false);

  readonly codingSkillMode = signal<"replace" | "append" | "inherit">(
    "replace",
  );
  readonly codingSkillText = signal("");

  readonly readabilityPacks = signal<readonly ReadabilityPackDecl[]>(
    BUILT_IN_READABILITY_PACK_IDS.map((id) => ({
      id,
      enabled: false,
      activation: "auto",
      globs: [],
      customText: "",
    })),
  );

  readonly skillSteps = signal<readonly SkillStepDecl[]>([]);

  readonly prEnabled = signal(false);
  readonly prMode = signal<"off" | "warn" | "blocking">("warn");
  readonly prMaxSubjectChars = signal(72);
  readonly prRequiredSections = signal("Summary, Verification");
  readonly prAuditLint = signal(true);
  readonly prGuidanceText = signal(
    "Explain root cause, verification commands, and any intentional trade-offs.",
  );
  readonly stopNudge = signal(true);
  readonly verifierEnabled = signal(false);

  readonly s5Triage = signal<"off" | "shadow" | "enforced">("off");
  readonly customStages = signal<readonly EditableCustomStage[]>([]);
  readonly customChecks = signal<readonly EditableCustomCheck[]>([]);

  readonly fixtureReport = signal<FixtureSelfTestReport | null>(null);
  readonly verifying = signal(false);
  readonly dryRunResult = signal<QADryRunResponse | null>(null);

  readonly showAdopt = signal(false);
  readonly adoptRepo = signal("");
  readonly adoptPath = signal(".grain/qa/flow.yml");
  readonly adoptCommit = signal("");
  readonly adopting = signal(false);

  readonly showProbe = signal(false);
  readonly probeTitle = signal("");
  readonly probeBody = signal("");
  readonly probeFiles = signal("");
  readonly probeNonTest = signal(0);
  readonly probing = signal(false);
  readonly probeResult = signal<QAProbeResponse | null>(null);

  readonly kindFilterOptions: readonly {
    id: StepKindFilter;
    label: string;
  }[] = [
    { id: "all", label: "All" },
    { id: "skills", label: "Skills" },
    { id: "checks", label: "Checks" },
    { id: "agents", label: "Critics" },
  ];

  readonly workflowStages = computed<readonly WorkflowStageView[]>(() => {
    const det = this.detail();
    const exportedChecks = this.exportCustomChecks();
    const exportedStages = this.exportCustomStages();
    const prSections = this.prRequiredSections()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return buildClientWorkflowStagesView(det, {
      preferLiveDraft: true,
      s0Intent: this.s0Intent(),
      s2PlanCritic: this.s2PlanCritic(),
      s5Triage: this.s5Triage(),
      decompose: {
        enabled: this.decomposeEnabled(),
        mode: this.decomposeMode(),
        complexities: ["medium", "high"],
        maxSubtasks: this.decomposeMaxSubtasks(),
        targetDiffLines: this.decomposeTargetDiffLines(),
      },
      context: {
        enabled: this.contextEnabled(),
        includeCallers: this.contextIncludeCallers(),
        includeMemory: this.contextIncludeMemory(),
        maxTokens: this.contextMaxTokens(),
      },
      readabilityPacks: this.readabilityPacks(),
      skillSteps: this.skillSteps(),
      prContract: {
        enabled: this.prEnabled(),
        mode: this.prMode(),
        maxSubjectChars: this.prMaxSubjectChars(),
        requiredSections: prSections,
        auditLintSuppressions: this.prAuditLint(),
        guidanceText: this.prGuidanceText(),
      },
      stopNudge: this.stopNudge(),
      codingSkillText: this.codingSkillText(),
      codingSkillMode: this.codingSkillMode(),
      checks: this.editing() ? this.builtinCheckOverrides() : undefined,
      verifier: {
        enabled: this.verifierEnabled(),
      },
      customChecks: exportedChecks,
      customStages: exportedStages,
    });
  });

  readonly filteredStages = computed<readonly WorkflowStageView[]>(() => {
    const q = this.stepSearch().trim().toLowerCase();
    const kf = this.kindFilter();
    const stages = this.workflowStages();
    if (!q && kf === "all") return stages;
    return stages
      .map((st) => {
        const stageMatch = q !== "" && st.label.toLowerCase().includes(q);
        const steps = st.steps.filter((step) => {
          if (!this.matchesKindFilter(step, kf)) return false;
          if (!q || stageMatch) return true;
          return (
            step.label.toLowerCase().includes(q) ||
            step.id.toLowerCase().includes(q) ||
            (step.scope || "").toLowerCase().includes(q) ||
            (step.summary || "").toLowerCase().includes(q)
          );
        });
        return { ...st, steps };
      })
      .filter((st) => st.steps.length > 0);
  });

  readonly isPartialReadonlyFilterActive = computed(
    () =>
      !this.editing() &&
      this.stepSearch().trim() === "" &&
      this.kindFilter() === "all",
  );

  readonly skippedStagesCount = computed(
    () =>
      this.filteredStages().filter((s) => !(s.enabled && s.mode !== "off"))
        .length,
  );

  readonly visibleStages = computed<readonly WorkflowStageView[]>(() => {
    const all = this.filteredStages();
    if (this.isPartialReadonlyFilterActive() && !this.showSkippedStages()) {
      return all.filter((s) => s.enabled && s.mode !== "off");
    }
    return all;
  });

  readonly allVisibleStagesExpanded = computed(() => {
    const vis = this.visibleStages();
    return (
      vis.length > 0 && vis.every((s) => !this.effectiveStageCollapsed(s.id))
    );
  });

  readonly activeStage = computed<WorkflowStageView>(() => {
    const id = this.selectedStageId();
    const stages = this.workflowStages();
    return stages.find((s) => s.id === id) ?? stages[0];
  });

  readonly addingStageView = computed<WorkflowStageView | null>(() => {
    const id = this.addingForStageId();
    if (!id) return null;
    return this.workflowStages().find((s) => s.id === id) ?? null;
  });

  readonly selectedStepView = computed<WorkflowStepView | null>(() => {
    const id = this.selectedStepId();
    if (!id) return null;
    for (const st of this.workflowStages()) {
      const found = st.steps.find((s) => s.id === id);
      if (found) return found;
    }
    return null;
  });

  readonly codingSkillBytes = computed(() =>
    utf8ByteCount(this.codingSkillText()),
  );

  readonly activePromptBytes = computed(() =>
    computeActivePromptBytes(this.workflowStages(), this.codingSkillBytes()),
  );

  readonly effectiveDryRun = computed(
    () => this.dryRunResult() ?? this.externalDryRun(),
  );

  readonly verifierSummaryText = computed(() => {
    if (!this.verifierEnabled()) return "disabled";
    const det = this.detail();
    const rounds =
      det?.declarationV4?.verifier?.maxRepairRounds ??
      det?.declaration?.verifier?.maxRepairRounds ??
      det?.resolved?.maxS4RepairRounds ??
      1;
    return `T2/T3 diffs (max ${rounds} round${rounds === 1 ? "" : "s"})`;
  });

  readonly probeStagesText = computed(() => {
    const pr = this.probeResult();
    if (!pr || pr.stagesFired.length === 0) return "none";
    return pr.stagesFired.join(", ");
  });

  constructor() {
    effect(() => {
      const d3 = this.decl();
      const d4 = this.declV4();
      const det = this.detail();
      const isEd = this.editing();
      const identity = [
        det?.hash ?? "",
        det?.key ?? "",
        d4?.key ?? "",
        d3?.key ?? "",
        d4 ? "v4" : "",
        d3 ? "v3" : "",
      ].join("|");
      const discardedEdit = this.wasEditing && !isEd;
      this.wasEditing = isEd;

      if (identity !== this.lastHydratedIdentity || discardedEdit) {
        const changedFlow = identity !== this.lastHydratedIdentity;
        this.lastHydratedIdentity = identity;
        this.hydrateFromDeclarations(d3, d4, det);
        if (changedFlow) {
          this.collapsedStages.set(createAllCollapsedMap());
          this.showSkippedStages.set(false);
          this.selectedStepId.set(null);
          this.addingForStageId.set(null);
          this.fixtureReport.set(null);
          this.dryRunResult.set(null);
        }
      }
    });
  }

  private hydrateFromDeclarations(
    d3: FlowDeclarationV3 | undefined,
    d4: FlowDeclarationV4 | undefined,
    det: QAFlowVersionDetail | null,
  ): void {
    const effectiveV4 =
      d4 ?? det?.declarationV4 ?? det?.declaration?.declarationV4;
    const effectiveV3 =
      d3 ?? det?.declarationV3 ?? det?.declaration?.declarationV3;
    const isV4 = Boolean(
      effectiveV4 ||
      det?.schemaVer === "grain.dev/qa-flow/v4" ||
      det?.schema === "grain.dev/qa-flow/v4",
    );
    const isV3 = Boolean(
      effectiveV3 ||
      det?.schemaVer === "grain.dev/qa-flow/v3" ||
      det?.schema === "grain.dev/qa-flow/v3",
    );
    const stages = effectiveV4?.stages ?? effectiveV3?.stages;

    const s0 = stages?.["s0-intent"];
    if (typeof s0 === "boolean") {
      this.s0Intent.set(s0);
    } else if (s0 && typeof s0 === "object") {
      this.s0Intent.set(Boolean(s0.enabled));
    } else {
      this.s0Intent.set(Boolean(det?.resolved?.s0Intent ?? (isV4 || isV3)));
    }

    const s2 = stages?.["s2-plan-critic"];
    if (typeof s2 === "boolean") {
      this.s2PlanCritic.set(s2);
    } else if (s2 && typeof s2 === "object") {
      this.s2PlanCritic.set(Boolean(s2.enabled));
    } else {
      this.s2PlanCritic.set(
        Boolean(det?.resolved?.s2PlanCritic ?? (isV4 || isV3)),
      );
    }

    const s5 = stages?.["s5-merge-triage"];
    if (typeof s5 === "string") {
      this.s5Triage.set(s5);
    } else if (s5 && typeof s5 === "object") {
      this.s5Triage.set(s5.mode ?? "off");
    } else {
      const resolvedTriage = det?.resolved?.s5MergeTriage;
      if (resolvedTriage === "enforced" || resolvedTriage === "shadow") {
        this.s5Triage.set(resolvedTriage);
      } else {
        this.s5Triage.set(isV4 || isV3 ? "shadow" : "off");
      }
    }

    if (effectiveV4?.decompose) {
      this.decomposeEnabled.set(effectiveV4.decompose.enabled ?? true);
      const dm = effectiveV4.decompose.mode;
      this.decomposeMode.set(
        dm === "off" || dm === "propose_dag" ? dm : "slice_plan",
      );
      this.decomposeMaxSubtasks.set(
        effectiveV4.decompose.maxSubtasks ??
          effectiveV4.decompose["max-subtasks"] ??
          4,
      );
      this.decomposeTargetDiffLines.set(
        effectiveV4.decompose.targetDiffLines ??
          effectiveV4.decompose["target-diff-lines"] ??
          400,
      );
    } else {
      this.decomposeEnabled.set(isV4);
      this.decomposeMode.set("slice_plan");
      this.decomposeMaxSubtasks.set(4);
      this.decomposeTargetDiffLines.set(400);
    }

    if (effectiveV4?.context) {
      this.contextEnabled.set(effectiveV4.context.enabled ?? true);
      this.contextIncludeCallers.set(
        effectiveV4.context.includeCallers ??
          effectiveV4.context["include-callers"] ??
          true,
      );
      this.contextIncludeMemory.set(
        effectiveV4.context.includeMemory ??
          effectiveV4.context["include-memory"] ??
          true,
      );
      this.contextMaxTokens.set(
        effectiveV4.context.maxTokens ??
          effectiveV4.context["max-tokens"] ??
          12000,
      );
    } else {
      this.contextEnabled.set(isV4);
      this.contextIncludeCallers.set(true);
      this.contextIncludeMemory.set(true);
      this.contextMaxTokens.set(12000);
    }

    const sk = effectiveV4?.skill ?? det?.declaration?.skill;
    if (sk) {
      this.codingSkillMode.set(sk.mode || "replace");
      this.codingSkillText.set(sk.text || "");
    } else if (det?.resolved?.injectSkill === false) {
      this.codingSkillMode.set("replace");
      this.codingSkillText.set("");
    } else if (det) {
      this.codingSkillMode.set("replace");
      this.codingSkillText.set(det.sourceYaml || det.summary || "");
    } else {
      this.codingSkillText.set("");
    }

    const rawPacks =
      effectiveV4?.readabilityPacks ?? effectiveV4?.["readability-packs"];
    if (rawPacks && rawPacks.length > 0) {
      const byId = new Map(rawPacks.map((p) => [p.id, p]));
      this.readabilityPacks.set(
        BUILT_IN_READABILITY_PACK_IDS.map((id) => {
          const found = byId.get(id);
          const fallbackText =
            (found as { text?: string } | undefined)?.text ?? "";
          return {
            id,
            enabled: found ? Boolean(found.enabled) : false,
            activation: found?.activation || "auto",
            globs: found?.globs ? [...found.globs] : [],
            customText:
              found?.customText ?? found?.["custom-text"] ?? fallbackText,
          };
        }),
      );
    } else {
      this.readabilityPacks.set(
        BUILT_IN_READABILITY_PACK_IDS.map((id) => ({
          id,
          enabled: isV4,
          activation: "auto",
          globs: [],
          customText: "",
        })),
      );
    }

    const rawSteps = effectiveV4?.skillSteps ?? effectiveV4?.["skill-steps"];
    if (rawSteps) {
      this.skillSteps.set(
        rawSteps.map((s) => ({
          id: s.id,
          label: s.label || s.id,
          stage: s.stage || "coding",
          enabled: s.enabled,
          globs: s.globs ? [...s.globs] : [],
          maxBytes: s.maxBytes ?? s["max-bytes"] ?? 600,
          text: s.text || "",
        })),
      );
    } else {
      this.skillSteps.set([]);
    }

    const pr = effectiveV4?.prContract ?? effectiveV4?.["pr-contract"];
    if (pr) {
      this.prEnabled.set(Boolean(pr.enabled));
      const pm = pr.mode;
      this.prMode.set(pm === "off" || pm === "blocking" ? pm : "warn");
      this.prMaxSubjectChars.set(
        pr.maxSubjectChars ?? pr["max-subject-chars"] ?? 72,
      );
      const secs = pr.requiredSections ?? pr["required-sections"];
      this.prRequiredSections.set(
        secs?.length ? secs.join(", ") : "Summary, Verification",
      );
      this.prAuditLint.set(
        pr.auditLintSuppressions ?? pr["audit-lint-suppressions"] ?? true,
      );
      if (pr.guidanceText ?? pr["guidance-text"]) {
        this.prGuidanceText.set(pr.guidanceText ?? pr["guidance-text"] ?? "");
      }
    } else {
      this.prEnabled.set(isV4);
      this.prMode.set("warn");
      this.prMaxSubjectChars.set(72);
      this.prRequiredSections.set("Summary, Verification");
      this.prAuditLint.set(true);
    }

    this.stopNudge.set(
      effectiveV4?.stopNudge ??
        det?.declaration?.stopNudge ??
        det?.resolved?.stopNudge ??
        isV4,
    );

    this.verifierEnabled.set(
      Boolean(
        effectiveV4?.verifier?.enabled ??
        effectiveV3?.verifier?.enabled ??
        det?.declaration?.verifier?.enabled ??
        det?.resolved?.enableS4 ??
        isV4,
      ),
    );

    const cStages = (stages?.custom ?? []).map((cs) => ({
      uid: this.nextUid++,
      id: cs.id,
      label: cs.label ?? cs.id,
      insertAfter: (cs["insert-after"] ??
        cs.insertAfter ??
        "s3") as InsertAfterStage,
      timeoutSeconds: cs["timeout-seconds"] ?? cs.timeoutSeconds ?? 30,
    }));
    this.customStages.set(cStages);

    const rawChecks =
      effectiveV4?.customChecks ??
      effectiveV4?.["custom-checks"] ??
      effectiveV3?.["custom-checks"] ??
      effectiveV3?.customChecks;
    const list: readonly CustomCheckDeclarationV3[] = Array.isArray(rawChecks)
      ? rawChecks
      : rawChecks
        ? Object.values(rawChecks)
        : [];
    this.customChecks.set(
      list.map((cc, idx) => {
        const engine = cc.kind ?? cc.engine ?? "pattern";
        const def = defaultFixturesForEngine(engine);
        const forbidAdded =
          cc["forbid-added"] ?? cc.forbidAdded ?? cc.forbid ?? def.forbidAdded;
        const whenList = normalizeStringList(
          cc["when-changed"] ?? cc.whenChanged,
        );
        const whenChanged = (
          whenList.length > 0
            ? whenList
            : def.whenChanged
              ? [def.whenChanged]
              : []
        ).join(", ");
        const reqList = normalizeStringList(
          cc["require-changed"] ?? cc.requireChanged,
        );
        const requireChanged = (
          reqList.length > 0
            ? reqList
            : def.requireChanged
              ? [def.requireChanged]
              : []
        ).join(", ");
        const maxChangedLines =
          cc["max-changed-lines"] ?? cc.maxChangedLines ?? def.maxChangedLines;
        const paths = normalizeStringList(cc.paths).join(", ");

        let failJson = cc.fixtures?.fail
          ? JSON.stringify(cc.fixtures.fail)
          : def.failJson;
        let passJson = cc.fixtures?.pass
          ? JSON.stringify(cc.fixtures.pass)
          : def.passJson;
        if (!cc.fixtures?.fail && engine === "companion") {
          const syn = synthesizeCompanionFixtures(whenChanged, requireChanged);
          failJson = syn.failJson;
          passJson = syn.passJson;
        } else if (!cc.fixtures?.fail && engine === "diff-budget") {
          const syn = synthesizeDiffBudgetFixtures(maxChangedLines, paths);
          failJson = syn.failJson;
          passJson = syn.passJson;
        }

        const patternLines =
          engine === "pattern"
            ? extractPatternExampleLines(failJson, passJson, forbidAdded)
            : { failLine: "", passLine: "" };

        return {
          uid: this.nextUid++,
          id: cc.id ?? `custom:check-${idx}`,
          label: cc.label ?? cc.id ?? `Custom check ${idx}`,
          engine,
          severity: cc.severity ?? "blocking",
          message: cc.message ?? "Custom check failed.",
          paths,
          forbidAdded,
          whenChanged,
          requireChanged,
          maxChangedLines,
          failLine: patternLines.failLine,
          passLine: patternLines.passLine,
          passJson,
          failJson,
        };
      }),
    );
  }

  private matchesKindFilter(
    step: WorkflowStepView,
    filter: StepKindFilter,
  ): boolean {
    if (filter === "all") return true;
    const k = step.kind;
    if (filter === "skills") {
      return (
        k === "skill" ||
        k === "readability_pack" ||
        k === "skill_step" ||
        k === "pr_contract" ||
        k === "stop_nudge" ||
        k === "context_discovery"
      );
    }
    if (filter === "checks") {
      return (
        k === "builtin_check" ||
        k.startsWith("custom_check:") ||
        k.startsWith("custom_stage:") ||
        k === "classifier" ||
        k === "merge_triage"
      );
    }
    return k === "llm_critic" || k === "decomposition" || k === "llm_verifier";
  }

  effectiveStageCollapsed(stageId: string): boolean {
    if (this.stepSearch().trim() !== "" || this.kindFilter() !== "all") {
      return false;
    }
    return Boolean(this.collapsedStages()[stageId]);
  }

  toggleStageCollapse(stageId: string): void {
    const currentlyCollapsed = this.effectiveStageCollapsed(stageId);
    this.collapsedStages.update((prev) => ({
      ...prev,
      [stageId]: !currentlyCollapsed,
    }));
    this.selectedStageId.set(stageId);
  }

  toggleExpandAllStages(): void {
    const collapseAll = this.allVisibleStagesExpanded();
    const next: Record<string, boolean> = {};
    for (const id of ALL_WORKFLOW_STAGE_IDS) {
      next[id] = collapseAll;
    }
    this.collapsedStages.set(next);
  }

  openGuide(): void {
    this.selectedStepId.set(null);
    this.addingForStageId.set(null);
    this.inspectorTab.set("definition");
  }

  selectStep(stageId: string, stepId: string): void {
    this.addingForStageId.set(null);
    this.selectedStageId.set(stageId);
    this.selectedStepId.set(stepId);
    this.inspectorTab.set("definition");
    this.stepSelected.emit(stepId);
  }

  selectStepFromGuide(target: { stageId: string; stepId: string }): void {
    this.showSkippedStages.set(true);
    this.collapsedStages.update((prev) => ({
      ...prev,
      [target.stageId]: false,
    }));
    this.selectStep(target.stageId, target.stepId);
  }

  requestAddSubstep(stageId: string): void {
    this.collapsedStages.update((prev) => ({ ...prev, [stageId]: false }));
    this.selectedStageId.set(stageId);
    this.selectedStepId.set(null);
    this.addingForStageId.set(stageId);
    this.inspectorTab.set("definition");
    if (!this.editing()) {
      this.enterDraftReq.emit();
    }
    this.stepSelected.emit(`add:${stageId}`);
  }

  protected activeStepsInStage(stage: WorkflowStageView): number {
    return stage.steps.filter((s) => s.enabled).length;
  }

  protected stagePillLabel(stage: WorkflowStageView): string {
    return formatStageModeLabel(stage);
  }

  protected stagePillClass(stage: WorkflowStageView): string {
    return stageModePillClass(stage);
  }

  protected stageTip(stage: WorkflowStageView): string {
    return stageModeTip(stage);
  }

  protected stepPillLabel(step: WorkflowStepView): string {
    return formatStepModeLabel(step);
  }

  protected stepPillClass(step: WorkflowStepView): string {
    return stepModePillClass(step);
  }

  protected updateDecomposeMode(val: string): void {
    this.decomposeMode.set(
      val === "off" || val === "propose_dag" ? val : "slice_plan",
    );
  }

  protected updateCodingSkillMode(val: string): void {
    this.codingSkillMode.set(
      val === "append" || val === "inherit" ? val : "replace",
    );
  }

  protected updateS5Triage(val: string): void {
    this.s5Triage.set(val === "enforced" || val === "shadow" ? val : "off");
  }

  updatePackEnabled(packId: string, enabled: boolean): void {
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === packId ? { ...p, enabled } : p)),
    );
  }

  updatePackActivation(packId: string, activation: string): void {
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === packId ? { ...p, activation } : p)),
    );
  }

  updatePackGlobs(packId: string, raw: string): void {
    const globs = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === packId ? { ...p, globs } : p)),
    );
  }

  updatePackCustomText(packId: string, customText: string): void {
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === packId ? { ...p, customText } : p)),
    );
  }

  updatePrMode(val: string): void {
    this.prMode.set(val === "off" || val === "blocking" ? val : "warn");
  }

  addSkillStepForStage(stageId: string): void {
    const stageMap: Readonly<Record<string, string>> = {
      "s0-decompose": "s0",
      "s2-plan": "s2",
      "s2-coding": "coding",
      "s3-pr": "pr",
      "s4-verify": "s4",
    };
    const stg = stageMap[stageId] ?? "coding";
    const targetStageViewId =
      stageId === "s1-context" ||
      stageId === "s3-checks" ||
      stageId === "s5-triage"
        ? "s2-coding"
        : stageId;
    const idx = this.skillSteps().length + 1;
    const id = `step:custom-${stg}-${idx}`;
    const newStep: SkillStepDecl = {
      id,
      label: `Custom ${stg} skill ${idx}`,
      stage: stg,
      enabled: true,
      globs: ["**/*"],
      maxBytes: 600,
      text: `Verify ${stg} invariants before proceeding.`,
    };
    this.skillSteps.update((prev) => [...prev, newStep]);
    this.addingForStageId.set(null);
    this.collapsedStages.update((prev) => ({
      ...prev,
      [targetStageViewId]: false,
    }));
    this.selectedStageId.set(targetStageViewId);
    this.selectedStepId.set(id);
  }

  updateSkillStepLabel(stepId: string, label: string): void {
    this.skillSteps.update((list) =>
      list.map((s) => (s.id === stepId ? { ...s, label } : s)),
    );
  }

  updateSkillStepGlobs(stepId: string, raw: string): void {
    const globs = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.skillSteps.update((list) =>
      list.map((s) => (s.id === stepId ? { ...s, globs } : s)),
    );
  }

  updateSkillStepText(stepId: string, text: string): void {
    this.skillSteps.update((list) =>
      list.map((s) => (s.id === stepId ? { ...s, text } : s)),
    );
  }

  updateSkillStepEnabled(stepId: string, enabled: boolean): void {
    this.skillSteps.update((list) =>
      list.map((s) => (s.id === stepId ? { ...s, enabled } : s)),
    );
  }

  removeSkillStep(stepId: string): void {
    this.skillSteps.update((list) => list.filter((s) => s.id !== stepId));
    if (this.selectedStepId() === stepId) {
      this.selectedStepId.set(null);
    }
  }

  protected updateStageLabel(uid: number, label: string): void {
    this.customStages.update((list) =>
      list.map((s) => (s.uid === uid ? { ...s, label } : s)),
    );
  }

  protected updateStageInsertAfter(uid: number, val: string): void {
    const insertAfter: InsertAfterStage =
      val === "s2" || val === "s4" ? val : "s3";
    this.customStages.update((list) =>
      list.map((s) => (s.uid === uid ? { ...s, insertAfter } : s)),
    );
  }

  protected updateStageTimeout(uid: number, timeoutSeconds: number): void {
    this.customStages.update((list) =>
      list.map((s) => (s.uid === uid ? { ...s, timeoutSeconds } : s)),
    );
  }

  addCustomStage(): void {
    const uid = this.nextUid++;
    const idx = this.customStages().length;
    const id = `custom:stage-${idx}`;
    this.customStages.update((s) => [
      ...s,
      {
        uid,
        id,
        label: `Custom critic stage ${idx + 1}`,
        insertAfter: "s3",
        timeoutSeconds: 30,
      },
    ]);
    this.addingForStageId.set(null);
    this.collapsedStages.update((prev) => ({ ...prev, "s3-checks": false }));
    this.selectedStageId.set("s3-checks");
    this.selectedStepId.set(id);
  }

  removeCustomStage(uid: number): void {
    const target = this.customStages().find((s) => s.uid === uid);
    this.customStages.update((s) => s.filter((item) => item.uid !== uid));
    if (target && this.selectedStepId() === target.id) {
      this.selectedStepId.set(null);
    }
  }

  addCheck(engine: CustomCheckEngine): void {
    const uid = this.nextUid++;
    const idx = this.customChecks().length;
    const id = `custom:check-${idx}`;
    const def = defaultFixturesForEngine(engine);
    this.customChecks.update((c) => [
      ...c,
      {
        uid,
        id,
        label: `Custom ${engine} check ${idx + 1}`,
        engine,
        severity: "blocking",
        message: "Custom check failed.",
        paths: "pkg/**/*.go",
        forbidAdded: def.forbidAdded,
        whenChanged: def.whenChanged,
        requireChanged: def.requireChanged,
        maxChangedLines: def.maxChangedLines,
        failLine: def.failLine,
        passLine: def.passLine,
        passJson: def.passJson,
        failJson: def.failJson,
      },
    ]);
    this.addingForStageId.set(null);
    this.collapsedStages.update((prev) => ({ ...prev, "s3-checks": false }));
    this.selectedStageId.set("s3-checks");
    this.selectedStepId.set(id);
  }

  removeCheck(uid: number): void {
    const target = this.customChecks().find((c) => c.uid === uid);
    this.customChecks.update((c) => c.filter((item) => item.uid !== uid));
    if (target && this.selectedStepId() === target.id) {
      this.selectedStepId.set(null);
    }
  }

  updateCheckMeta(
    uid: number,
    field: "id" | "label" | "message",
    val: string,
  ): void {
    const prev = this.customChecks().find((c) => c.uid === uid);
    this.customChecks.update((list) =>
      list.map((c) => (c.uid === uid ? { ...c, [field]: val } : c)),
    );
    if (field === "id" && prev && this.selectedStepId() === prev.id) {
      this.selectedStepId.set(val);
    }
  }

  updateCheckSeverity(uid: number, val: string): void {
    const severity: "blocking" | "warn" | "shadow" =
      val === "warn" || val === "shadow" ? val : "blocking";
    this.customChecks.update((list) =>
      list.map((c) => (c.uid === uid ? { ...c, severity } : c)),
    );
  }

  updateCheckField(
    uid: number,
    field: "paths" | "forbidAdded" | "whenChanged" | "requireChanged",
    val: string,
  ): void {
    this.customChecks.update((list) =>
      list.map((c) => {
        if (c.uid !== uid) return c;
        const next = { ...c, [field]: val };
        if (next.engine === "companion") {
          const syn = synthesizeCompanionFixtures(
            next.whenChanged,
            next.requireChanged,
          );
          return { ...next, failJson: syn.failJson, passJson: syn.passJson };
        }
        if (next.engine === "diff-budget" && field === "paths") {
          const syn = synthesizeDiffBudgetFixtures(
            next.maxChangedLines,
            next.paths,
          );
          return { ...next, failJson: syn.failJson, passJson: syn.passJson };
        }
        return next;
      }),
    );
  }

  updateCheckMaxLines(uid: number, maxChangedLines: number): void {
    this.customChecks.update((list) =>
      list.map((c) => {
        if (c.uid !== uid) return c;
        const syn = synthesizeDiffBudgetFixtures(maxChangedLines, c.paths);
        return {
          ...c,
          maxChangedLines,
          failJson: syn.failJson,
          passJson: syn.passJson,
        };
      }),
    );
  }

  updatePatternExample(uid: number, kind: "fail" | "pass", line: string): void {
    this.customChecks.update((list) =>
      list.map((c) => {
        if (c.uid !== uid) return c;
        const failLine = kind === "fail" ? line : c.failLine;
        const passLine = kind === "pass" ? line : c.passLine;
        const ser = serializePatternFixtures(failLine, passLine);
        return {
          ...c,
          failLine,
          passLine,
          failJson: ser.failJson,
          passJson: ser.passJson,
        };
      }),
    );
  }

  updateFixture(options: {
    uid: number;
    kind: "pass" | "fail";
    val: string;
  }): void {
    this.customChecks.update((c) =>
      c.map((item) =>
        item.uid === options.uid
          ? options.kind === "pass"
            ? { ...item, passJson: options.val }
            : { ...item, failJson: options.val }
          : item,
      ),
    );
  }

  exportCustomStages(): CustomStageDeclarationV3[] {
    return this.customStages().map((s) => ({
      id: s.id,
      label: s.label,
      "insert-after": s.insertAfter,
      "timeout-seconds": s.timeoutSeconds,
    }));
  }

  exportCustomChecks(): CustomCheckDeclarationV3[] {
    return this.customChecks().map((c) => {
      let passArr: unknown[] = [];
      let failArr: unknown[] = [];
      try {
        passArr = JSON.parse(c.passJson) as unknown[];
      } catch {
        passArr = [];
      }
      try {
        failArr = JSON.parse(c.failJson) as unknown[];
      } catch {
        failArr = [];
      }
      const paths = c.paths
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const whenChanged = c.whenChanged
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const requireChanged = c.requireChanged
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        id: c.id,
        label: c.label || c.id,
        kind: c.engine,
        severity: c.severity,
        message: c.message || "Failed",
        ...(paths.length > 0 ? { paths } : {}),
        ...(c.forbidAdded ? { "forbid-added": c.forbidAdded } : {}),
        ...(whenChanged.length > 0 ? { "when-changed": whenChanged } : {}),
        ...(requireChanged.length > 0
          ? { "require-changed": requireChanged }
          : {}),
        ...(c.maxChangedLines > 0
          ? { "max-changed-lines": c.maxChangedLines }
          : {}),
        fixtures: {
          fail: failArr,
          pass: passArr,
        },
      };
    });
  }

  exportDeclarationV4(meta?: {
    key?: string;
    extends?: string;
    label?: string;
    summary?: string;
  }): FlowDeclarationV4 {
    const det = this.detail();
    const customStages = this.exportCustomStages();
    const customChecks = this.exportCustomChecks();
    const skillText = this.codingSkillText().trim();
    return {
      schema: "grain.dev/qa-flow/v4",
      key: meta?.key || det?.key || "engineering-workflow-v4",
      extends:
        meta?.extends ||
        det?.declarationV4?.extends ||
        det?.declaration?.extends ||
        "engineering-workflow-v4@1",
      label: meta?.label || det?.label || "Engineering workflow v4",
      summary: meta?.summary || det?.summary || "",
      ...(skillText
        ? {
            skill: {
              mode: this.codingSkillMode() || "replace",
              text: skillText,
              maxBytes: 4096,
            },
          }
        : {}),
      stages: {
        "s0-intent": { enabled: this.s0Intent() },
        "s2-plan-critic": { enabled: this.s2PlanCritic() },
        "s5-merge-triage": { mode: this.s5Triage() },
        ...(customStages.length > 0 ? { custom: customStages } : {}),
      },
      decompose: {
        enabled: this.decomposeEnabled(),
        mode: this.decomposeMode(),
        complexities: ["medium", "high"],
        maxSubtasks: this.decomposeMaxSubtasks(),
        targetDiffLines: this.decomposeTargetDiffLines(),
      },
      context: {
        enabled: this.contextEnabled(),
        includeCallers: this.contextIncludeCallers(),
        includeMemory: this.contextIncludeMemory(),
        maxTokens: this.contextMaxTokens(),
        extraPaths: ["design/design/**", "docs/**"],
      },
      readabilityPacks: this.readabilityPacks().map((p) => ({
        id: p.id,
        enabled: p.enabled,
        activation: p.activation || "auto",
        ...(p.globs?.length ? { globs: p.globs } : {}),
        ...(p.customText ? { customText: p.customText } : {}),
      })),
      skillSteps: this.skillSteps().map((s) => ({
        id: s.id,
        label: s.label || s.id,
        stage: s.stage || "coding",
        enabled: s.enabled,
        ...(s.globs?.length ? { globs: s.globs } : {}),
        maxBytes: s.maxBytes || 600,
        text: s.text || "",
      })),
      prContract: {
        enabled: this.prEnabled(),
        mode: this.prMode(),
        maxSubjectChars: this.prMaxSubjectChars(),
        requiredSections: this.prRequiredSections()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        auditLintSuppressions: this.prAuditLint(),
        guidanceText: this.prGuidanceText(),
      },
      stopNudge: this.stopNudge(),
      verifier: {
        enabled: this.verifierEnabled(),
        tiers: ["T2", "T3"],
        maxRepairRounds: 1,
        maxSeconds: 60,
        maxTokens: 50000,
        checklist: "escape-classes-v1",
      },
      ...(customChecks.length > 0 ? { customChecks } : {}),
    };
  }

  buildYaml(): string {
    const checks = this.customChecks();
    let customChecksYaml = "";
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      const paths = c.paths
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const whenChanged = c.whenChanged
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const requireChanged = c.requireChanged
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      customChecksYaml += `  - id: ${JSON.stringify(c.id || `custom:check-${i}`)}\n`;
      customChecksYaml += `    label: ${JSON.stringify(c.label || c.id || `Custom check ${i}`)}\n`;
      customChecksYaml += `    kind: ${c.engine}\n`;
      customChecksYaml += `    severity: ${c.severity}\n`;
      customChecksYaml += `    message: ${JSON.stringify(c.message || "Failed")}\n`;
      if (paths.length > 0) {
        customChecksYaml += `    paths: ${JSON.stringify(paths)}\n`;
      }
      if (c.forbidAdded) {
        customChecksYaml += `    forbid-added: ${JSON.stringify(c.forbidAdded)}\n`;
      }
      if (whenChanged.length > 0) {
        customChecksYaml += `    when-changed: ${JSON.stringify(whenChanged)}\n`;
      }
      if (requireChanged.length > 0) {
        customChecksYaml += `    require-changed: ${JSON.stringify(requireChanged)}\n`;
      }
      if (c.maxChangedLines > 0) {
        customChecksYaml += `    max-changed-lines: ${c.maxChangedLines}\n`;
      }
      customChecksYaml += `    fixtures:\n      pass: ${c.passJson.replace(/\n/g, "")}\n      fail: ${c.failJson.replace(/\n/g, "")}\n`;
    }
    let customStagesYaml = "";
    for (const s of this.customStages()) {
      customStagesYaml += `    - id: ${s.id}\n      label: ${s.label}\n      insert-after: ${s.insertAfter}\n      timeout-seconds: ${s.timeoutSeconds}\n`;
    }
    let packsYaml = "";
    for (const p of this.readabilityPacks()) {
      packsYaml += `  - id: ${p.id}\n    enabled: ${p.enabled}\n    activation: ${p.activation || "auto"}\n`;
      if (p.globs && p.globs.length > 0) {
        packsYaml += `    globs: ${JSON.stringify(p.globs)}\n`;
      }
      if (p.customText) {
        packsYaml += `    custom-text: ${JSON.stringify(p.customText)}\n`;
      }
    }
    let stepsYaml = "";
    for (const s of this.skillSteps()) {
      stepsYaml += `  - id: ${JSON.stringify(s.id)}\n    label: ${JSON.stringify(s.label || s.id)}\n    stage: ${s.stage || "coding"}\n    enabled: ${s.enabled}\n    max-bytes: ${s.maxBytes || 600}\n`;
      if (s.globs && s.globs.length > 0) {
        stepsYaml += `    globs: ${JSON.stringify(s.globs)}\n`;
      }
      stepsYaml += `    text: ${JSON.stringify(s.text || "")}\n`;
    }
    const prSections = this.prRequiredSections()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const stagesSection = customStagesYaml
      ? `  custom:\n${customStagesYaml}`
      : "";
    const checksSection = customChecksYaml
      ? `custom-checks:\n${customChecksYaml}`
      : "";
    const packsSection = packsYaml ? `readability-packs:\n${packsYaml}` : "";
    const stepsSection = stepsYaml ? `skill-steps:\n${stepsYaml}` : "";
    return `schema: "grain.dev/qa-flow/v4"\nkey: ${this.detail()?.key || "draft-v4-preview"}\nextends: golden-v3@1\nlabel: Draft V4 preview\ndecompose:\n  enabled: ${this.decomposeEnabled()}\n  mode: ${this.decomposeMode()}\n  max-subtasks: ${this.decomposeMaxSubtasks()}\n  target-diff-lines: ${this.decomposeTargetDiffLines()}\ncontext:\n  enabled: ${this.contextEnabled()}\n  include-callers: ${this.contextIncludeCallers()}\n  include-memory: ${this.contextIncludeMemory()}\n  max-tokens: ${this.contextMaxTokens()}\n${packsSection}${stepsSection}pr-contract:\n  enabled: ${this.prEnabled()}\n  mode: ${this.prMode()}\n  max-subject-chars: ${this.prMaxSubjectChars()}\n  required-sections: ${JSON.stringify(prSections)}\n  audit-lint-suppressions: ${this.prAuditLint()}\nstages:\n  s0-intent:\n    enabled: ${this.s0Intent()}\n  s2-plan-critic:\n    enabled: ${this.s2PlanCritic()}\n  s5-merge-triage:\n    mode: ${this.s5Triage()}\n${stagesSection}${checksSection}`;
  }

  async runFixtureSelfTest(): Promise<void> {
    const checks = this.customChecks();
    if (checks.length > 0) {
      const activeId = this.selectedStepId();
      const target =
        checks.find((c) => c.id === activeId) ?? checks[checks.length - 1];
      const report = evaluateFixturesClientSide({
        id: target.id,
        engine: target.engine,
        paths: target.paths
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        forbidAdded: target.forbidAdded,
        whenChanged: target.whenChanged
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        requireChanged: target.requireChanged
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        maxChangedLines: target.maxChangedLines,
        failJson: target.failJson,
        passJson: target.passJson,
      });
      this.fixtureReport.set(report);
    } else {
      const def = defaultFixturesForEngine("pattern");
      this.fixtureReport.set(
        evaluateFixturesClientSide({
          id: this.selectedStepId() || "golden:test-integrity-guard",
          engine: "pattern",
          forbidAdded: def.forbidAdded,
          failJson: def.failJson,
          passJson: def.passJson,
        }),
      );
    }
    await this.verifyDryRun();
  }

  async verifyDryRun(): Promise<void> {
    if (this.verifying()) return;
    this.verifying.set(true);
    try {
      const checks = this.customChecks();
      for (let i = 0; i < checks.length; i++) {
        const c = checks[i];
        try {
          JSON.parse(c.passJson);
          JSON.parse(c.failJson);
        } catch (e: unknown) {
          this.snackbar.show(`JSON parse error in check-${i}: ${errorText(e)}`);
          return;
        }
      }
      const yml = this.buildYaml();
      const res = await this.api.post<QADryRunResponse>(
        "POST /api/qa/flow-versions",
        undefined,
        { yaml: yml },
        "dryRun=1",
      );
      if (res) this.dryRunResult.set(res);
    } catch (err: unknown) {
      this.snackbar.show(`Dry run failed: ${errorText(err)}`);
    } finally {
      this.verifying.set(false);
    }
  }

  async doAdopt(): Promise<void> {
    if (this.adopting()) return;
    this.adopting.set(true);
    try {
      const res = await this.api.post<QAAdoptResponse>(
        "POST /api/qa/flow-versions/adopt",
        undefined,
        {
          repo: this.adoptRepo(),
          path: this.adoptPath(),
          commit: this.adoptCommit(),
        },
      );
      if (res) {
        this.snackbar.show(`Adopted flow ${res.hash}`);
        this.showAdopt.set(false);
        this.adopted.emit(res.hash);
      }
    } catch (err: unknown) {
      this.snackbar.show(`Adopt failed: ${errorText(err)}`);
    } finally {
      this.adopting.set(false);
    }
  }

  async doProbe(): Promise<void> {
    if (this.probing()) return;
    this.probing.set(true);
    try {
      const files = this.probeFiles()
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await this.api.post<QAProbeResponse>(
        "POST /api/qa/probe",
        undefined,
        {
          title: this.probeTitle(),
          body: this.probeBody(),
          files,
          nonTestAdded: this.probeNonTest(),
        },
      );
      if (res) this.probeResult.set(res);
    } catch (err: unknown) {
      this.snackbar.show(`Probe failed: ${errorText(err)}`);
    } finally {
      this.probing.set(false);
    }
  }

  protected textValue(ev: Event): string {
    return inputTextValue(ev);
  }

  protected numValue(ev: Event): number {
    return inputNumberValue(ev);
  }
}
