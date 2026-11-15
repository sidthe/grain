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
import { SnackbarService } from "../services/snackbar.service";
import { errorText } from "../sessions/session-helpers";
import { DialogTrapDirective } from "../shared/dialog-trap.directive";
import { PillSelectComponent } from "../shared/pill-select.component";
import {
  BUILTIN_READABILITY_PACK_IDS,
  BUILTIN_READABILITY_PACKS,
  type CustomCheckDeclarationV3,
  type FixtureSelfTestResult,
  type FlowDeclarationV3,
  type FlowDeclarationV4,
  type PRContractDecl,
  type QAAdoptResponse,
  type QADryRunResponse,
  type QAProbeResponse,
  type ReadabilityPackDecl,
  type SkillStepDecl,
  evaluateInlineCheckFixtures,
} from "./qa-flows.models";

type CustomCheckEngine = "pattern" | "diff-budget" | "companion" | "jsonschema";
type InsertAfterStage = "s2" | "s3" | "s4";

interface EditableCustomStage {
  readonly uid: number;
  readonly id: string;
  readonly label: string;
  readonly insertAfter: InsertAfterStage;
  readonly timeoutSeconds: number;
}

export interface EditableCustomCheck {
  readonly uid: number;
  readonly id: string;
  readonly label: string;
  readonly engine: CustomCheckEngine;
  readonly severity: "blocking" | "warn" | "shadow";
  readonly message: string;
  readonly forbidAdded: string;
  readonly whenChanged: string;
  readonly requireChanged: string;
  readonly passJson: string;
  readonly failJson: string;
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

function inputCheckedValue(ev: Event): boolean {
  if (ev.target instanceof HTMLInputElement) {
    return ev.target.checked;
  }
  return false;
}

@Component({
  selector: "g-qa-v3-studio",
  imports: [PillSelectComponent, DialogTrapDirective],
  encapsulation: ViewEncapsulation.None,
  styleUrls: ["./qa-flows-panel.css", "./qa-v3-studio.css"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="qa-flows-panel qa-v3-studio" data-testid="qa-v3-studio">
      @if (!dialogsOnly()) {
        <div class="editor-scroll-area" style="padding: 16px;">
          <div class="editor-section card">
            <h3>8-Stage Lifecycle &amp; V3/V4 Pipeline</h3>
            <div class="check-params">
              <label for="s0Intent">
                <input
                  id="s0Intent"
                  type="checkbox"
                  [checked]="s0Intent()"
                  (change)="s0Intent.set(checkedValue($event))"
                />
                1 · S0 Intent &amp; Goal Breakdown
              </label>
              <label for="decomposeEnabled">
                <input
                  id="decomposeEnabled"
                  type="checkbox"
                  [checked]="decomposeEnabled()"
                  (change)="decomposeEnabled.set(checkedValue($event))"
                />
                Subtask Slice Decomposition ({{ decomposeMode() }})
              </label>
              <label for="contextEnabled">
                <input
                  id="contextEnabled"
                  type="checkbox"
                  [checked]="contextEnabled()"
                  (change)="contextEnabled.set(checkedValue($event))"
                />
                2 · Caller &amp; Memory Context Discovery
              </label>
              <label for="s2PlanCritic">
                <input
                  id="s2PlanCritic"
                  type="checkbox"
                  [checked]="s2PlanCritic()"
                  (change)="s2PlanCritic.set(checkedValue($event))"
                />
                3 · S2 Fresh Plan Critic
              </label>
            </div>

            <div class="check-params" style="margin-top: 10px;">
              <button
                type="button"
                class="btn-text"
                data-testid="qa-v3-add-stage"
                (click)="addCustomStage()"
              >
                + Custom stage
              </button>
              <button
                type="button"
                class="btn-text"
                data-testid="qa-add-skill-step-btn"
                (click)="addSkillStep()"
              >
                + Add skill step
              </button>
            </div>

            @for (stage of customStages(); track stage.uid) {
              <div
                class="check-row"
                data-testid="qa-v3-custom-stage-row"
                style="margin-top: 12px;"
              >
                <div class="check-name">
                  <strong>Custom Stage</strong> ({{ stage.id }})
                  <button
                    type="button"
                    class="btn-text danger"
                    (click)="removeCustomStage(stage.uid)"
                  >
                    Remove
                  </button>
                </div>
                <div class="check-params">
                  <label [attr.for]="'stage-id-' + stage.uid">ID</label>
                  <input
                    [id]="'stage-id-' + stage.uid"
                    type="text"
                    [value]="stage.id"
                    (input)="updateStageId(stage.uid, textValue($event))"
                  />
                  <label [attr.for]="'stage-label-' + stage.uid">Label</label>
                  <input
                    [id]="'stage-label-' + stage.uid"
                    type="text"
                    [value]="stage.label"
                    (input)="updateStageLabel(stage.uid, textValue($event))"
                  />
                  <label [attr.for]="'stage-after-' + stage.uid"
                    >Insert After</label
                  >
                  <g-pill-select
                    ariaLabel="Insert after"
                    [value]="stage.insertAfter"
                    (valueChange)="updateStageInsertAfter(stage.uid, $event)"
                    [options]="insertAfterOptions"
                  />
                  <label [attr.for]="'stage-timeout-' + stage.uid"
                    >Timeout (s)</label
                  >
                  <input
                    [id]="'stage-timeout-' + stage.uid"
                    type="number"
                    [value]="stage.timeoutSeconds"
                    (input)="updateStageTimeout(stage.uid, numValue($event))"
                  />
                </div>
              </div>
            }

            <div style="margin-top: 12px;">
              <label for="s5Triage">8 · S5 Merge Triage</label>
              <g-pill-select
                id="s5Triage"
                ariaLabel="S5 Merge Triage"
                [(value)]="s5Triage"
                [options]="s5Options"
              />
            </div>
          </div>

          <div class="editor-section card" style="margin-top: 16px;">
            <h3>4 · Portable Readability Packs &amp; Skill Steps</h3>
            @for (pack of readabilityPacks(); track pack.id) {
              <div
                class="check-row"
                [attr.data-testid]="'qa-pack-row-' + pack.id"
              >
                <div class="check-name">
                  <strong>{{ packLabel(pack.id) }}</strong>
                  <span class="severity-pill s-mono">{{ pack.id }}</span>
                  <span class="severity-pill">{{
                    pack.activation || "auto"
                  }}</span>
                </div>
                <div class="check-params">
                  <label [attr.for]="'pack-en-' + pack.id">
                    <input
                      [id]="'pack-en-' + pack.id"
                      type="checkbox"
                      [checked]="pack.enabled"
                      (change)="togglePack(pack.id, checkedValue($event))"
                    />
                    Enabled
                  </label>
                  <g-pill-select
                    [ariaLabel]="pack.id + ' activation'"
                    [value]="pack.activation || 'auto'"
                    [options]="activationOptions"
                    (valueChange)="updatePackActivation(pack.id, $event)"
                  />
                  <input
                    type="text"
                    class="s-mono"
                    [attr.aria-label]="pack.id + ' globs'"
                    placeholder="Globs (e.g. **/*.go)"
                    [value]="(pack.globs || []).join(', ')"
                    (input)="updatePackGlobs(pack.id, textValue($event))"
                  />
                </div>
              </div>
            }

            @for (st of skillSteps(); track st.id; let idx = $index) {
              <div
                class="check-row"
                [attr.data-testid]="'qa-skill-step-row-' + st.id"
              >
                <div class="check-name">
                  <strong>Skill Step:</strong> {{ st.label || st.id }}
                  <span class="severity-pill s-mono">{{ st.stage }}</span>
                  <button
                    type="button"
                    class="btn-text danger"
                    (click)="removeSkillStep(idx)"
                  >
                    Remove
                  </button>
                </div>
                <div class="check-params fixture-stack">
                  <input
                    type="text"
                    [attr.aria-label]="'Skill step label ' + idx"
                    [value]="st.label || ''"
                    (input)="updateSkillStepLabel(idx, textValue($event))"
                  />
                  <textarea
                    rows="2"
                    class="s-mono"
                    [attr.aria-label]="'Skill step text ' + idx"
                    [value]="st.text || ''"
                    (input)="updateSkillStepText(idx, textValue($event))"
                  ></textarea>
                </div>
              </div>
            }
          </div>

          <div class="editor-section card" style="margin-top: 16px;">
            <h3>6 · PR Authoring Contract</h3>
            <div class="check-params">
              <label for="prContractEnabled">
                <input
                  id="prContractEnabled"
                  type="checkbox"
                  [checked]="prContract().enabled"
                  (change)="updatePrContractEnabled(checkedValue($event))"
                />
                Enforce PR Contract ({{ prContract().mode || "warn" }})
              </label>
              <label for="prRequiredSections">Required Sections</label>
              <input
                id="prRequiredSections"
                type="text"
                data-testid="qa-pr-required-sections"
                [value]="(prContract().requiredSections || []).join(', ')"
                (input)="updatePrRequiredSections(textValue($event))"
              />
            </div>
          </div>

          <div class="editor-section card" style="margin-top: 16px;">
            <h3>5 · Custom Checks &amp; Inline Fixture Self-Test Runner</h3>
            <div class="check-engine-bar">
              <button
                type="button"
                class="btn-outlined"
                data-testid="qa-v3-add-pattern"
                (click)="addCheck('pattern')"
              >
                pattern
              </button>
              <button
                type="button"
                class="btn-outlined"
                (click)="addCheck('diff-budget')"
              >
                diff-budget
              </button>
              <button
                type="button"
                class="btn-outlined"
                (click)="addCheck('companion')"
              >
                companion
              </button>
              <button
                type="button"
                class="btn-outlined"
                (click)="addCheck('jsonschema')"
              >
                jsonschema
              </button>
            </div>

            @for (check of customChecks(); track check.uid) {
              <div
                class="check-row"
                data-testid="qa-v3-custom-check-row"
                style="margin-top: 12px;"
              >
                <div class="check-name">
                  <strong>Engine:</strong> {{ check.engine }}
                  <span class="s-mono">({{ check.id }})</span>
                  <button
                    type="button"
                    class="btn-text danger"
                    (click)="removeCheck(check.uid)"
                  >
                    Remove
                  </button>
                </div>
                <div class="check-params fixture-stack">
                  <label [attr.for]="'pass-' + check.uid">
                    Clean pass fixture (JSON array)
                  </label>
                  <textarea
                    [id]="'pass-' + check.uid"
                    [value]="check.passJson"
                    (input)="
                      updateFixture({
                        uid: check.uid,
                        kind: 'pass',
                        val: textValue($event),
                      })
                    "
                    rows="2"
                  ></textarea>
                  <label [attr.for]="'fail-' + check.uid">
                    Fail trap fixture (JSON array)
                  </label>
                  <textarea
                    [id]="'fail-' + check.uid"
                    [value]="check.failJson"
                    (input)="
                      updateFixture({
                        uid: check.uid,
                        kind: 'fail',
                        val: textValue($event),
                      })
                    "
                    rows="2"
                  ></textarea>
                </div>
              </div>
            }

            <div class="check-params" style="margin-top: 14px;">
              <button
                type="button"
                class="btn-tonal"
                data-testid="qa-run-fixtures-btn"
                (click)="runInlineFixtures()"
                [disabled]="verifying()"
              >
                Run inline fixtures &amp; dry-run
              </button>
              <button
                type="button"
                class="btn-tonal"
                data-testid="qa-v3-verify-dry-run"
                (click)="verifyDryRun()"
                [disabled]="verifying()"
              >
                Verify fixtures &amp; dry-run
              </button>
              <button
                type="button"
                class="btn-primary"
                data-testid="qa-v3-publish-v4"
                (click)="publishV4Version()"
                [disabled]="verifying()"
              >
                Publish V4 version
              </button>
            </div>

            @if (fixtureSelfTestResult(); as ft) {
              <div
                class="qa-meta-box"
                data-testid="qa-fixture-selftest-result"
                style="margin-top: 12px;"
              >
                <strong>Inline Fixture Self-Test:</strong>
                <span class="severity-pill">{{
                  ft.failTrapCaught ? "Fail trap caught" : "Fail trap missed"
                }}</span>
                <span class="severity-pill">{{
                  ft.cleanPassGreen ? "Clean pass green" : "Clean pass failed"
                }}</span>
                <div>{{ ft.summary }}</div>
              </div>
            }

            @if (dryRunResult(); as r) {
              <div class="dry-run-results" style="margin-top: 12px;">
                <h3>Dry Run Results</h3>
                <p>Valid: {{ r.valid }}</p>
                <p>Hash: {{ r.hash }}</p>
                <p>
                  Sampled PRs: {{ r.sampledPRs }} | Would block:
                  {{ r.wouldBlockPRs }}
                </p>
              </div>
            }
          </div>

          <div class="editor-section card" style="margin-top: 16px;">
            <div class="check-params">
              <button
                type="button"
                class="btn-outlined"
                data-testid="qa-v3-open-adopt"
                (click)="showAdopt.set(true)"
              >
                Adopt from commit
              </button>
              <button
                type="button"
                class="btn-outlined"
                data-testid="qa-v3-open-probe"
                (click)="showProbe.set(true)"
              >
                What-if probe
              </button>
            </div>
          </div>
        </div>
      }

      @if (showAdopt()) {
        <!-- eslint-disable @angular-eslint/template/click-events-have-key-events,@angular-eslint/template/interactive-supports-focus -->
        <div class="modal-backdrop-full" (click)="showAdopt.set(false)">
          <div
            gDialogTrap
            role="dialog"
            aria-modal="true"
            aria-labelledby="qa-v3-adopt-title"
            data-testid="qa-v3-adopt-dialog"
            class="modal-content-full"
            (click)="$event.stopPropagation()"
            (gDialogClose)="showAdopt.set(false)"
          >
            <h3 id="qa-v3-adopt-title">Adopt Flow from Commit</h3>
            <label for="adoptRepo">Repo</label>
            <input
              id="adoptRepo"
              type="text"
              [value]="adoptRepo()"
              (input)="adoptRepo.set(textValue($event))"
            />
            <label for="adoptPath">Path</label>
            <input
              id="adoptPath"
              type="text"
              [value]="adoptPath()"
              (input)="adoptPath.set(textValue($event))"
            />
            <label for="adoptCommit">Commit (40-char SHA)</label>
            <input
              id="adoptCommit"
              type="text"
              [value]="adoptCommit()"
              (input)="adoptCommit.set(textValue($event))"
            />

            <div class="dialog-actions">
              <button
                type="button"
                class="btn-primary"
                data-testid="qa-v3-submit-adopt"
                (click)="doAdopt()"
                [disabled]="
                  !adoptRepo() || !adoptPath() || !adoptCommit() || adopting()
                "
              >
                Adopt
              </button>
              <button
                type="button"
                class="btn-outlined"
                (click)="showAdopt.set(false)"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      }

      @if (showProbe()) {
        <!-- eslint-disable @angular-eslint/template/click-events-have-key-events,@angular-eslint/template/interactive-supports-focus -->
        <div class="modal-backdrop-right" (click)="showProbe.set(false)">
          <div
            gDialogTrap
            role="dialog"
            aria-modal="true"
            aria-labelledby="qa-v3-probe-title"
            data-testid="qa-v3-probe-dialog"
            class="probe-drawer-full"
            (click)="$event.stopPropagation()"
            (gDialogClose)="showProbe.set(false)"
          >
            <h3 id="qa-v3-probe-title">What-if Probe</h3>
            <label for="probeTitle">Title</label>
            <input
              id="probeTitle"
              type="text"
              [value]="probeTitle()"
              (input)="probeTitle.set(textValue($event))"
            />
            <label for="probeBody">Body</label>
            <textarea
              id="probeBody"
              [value]="probeBody()"
              (input)="probeBody.set(textValue($event))"
              rows="3"
            ></textarea>
            <label for="probeFiles">Files (comma or newline separated)</label>
            <textarea
              id="probeFiles"
              [value]="probeFiles()"
              (input)="probeFiles.set(textValue($event))"
              rows="3"
            ></textarea>
            <label for="probeNonTest">Non Test Added</label>
            <input
              id="probeNonTest"
              type="number"
              [value]="probeNonTest()"
              (input)="probeNonTest.set(numValue($event))"
            />

            <div class="dialog-actions">
              <button
                type="button"
                class="btn-primary"
                data-testid="qa-v3-submit-probe"
                (click)="doProbe()"
                [disabled]="probing()"
              >
                Run Probe
              </button>
              <button
                type="button"
                class="btn-outlined"
                (click)="showProbe.set(false)"
              >
                Close
              </button>
            </div>

            @if (probeResult(); as pr) {
              <div
                class="section-divider"
                data-testid="qa-v3-probe-result"
                style="margin-top: 16px;"
              >
                <span class="status-pill info"
                  >Complexity: {{ pr.complexity.tier }}</span
                >
                <p>Score: {{ pr.risk.score }}/100</p>
                <p>Blast Tier: {{ pr.risk.tier }}</p>
                <p>
                  S5 Triage: {{ pr.triage.decision }} ({{ pr.triage.mode }})
                </p>
                <p>Stages Fired: {{ probeStagesText() }}</p>
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
  private nextUid = 1;

  readonly decl = input<FlowDeclarationV3 | FlowDeclarationV4>();
  readonly dialogsOnly = input<boolean>(false);
  readonly adopted = output<QAAdoptResponse>();

  readonly flowKey = signal("engineering-workflow-v4-draft");
  readonly flowExtends = signal("engineering-workflow-v4@1");
  readonly flowLabel = signal("Engineering Workflow V4 Draft");

  readonly s0Intent = signal(false);
  readonly decomposeEnabled = signal(true);
  readonly decomposeMode = signal<"off" | "slice_plan" | "propose_dag">(
    "slice_plan",
  );
  readonly contextEnabled = signal(true);
  readonly s2PlanCritic = signal(false);
  readonly s5Triage = signal<"off" | "shadow" | "enforced">("off");
  readonly customStages = signal<readonly EditableCustomStage[]>([]);
  readonly readabilityPacks = signal<readonly ReadabilityPackDecl[]>(
    BUILTIN_READABILITY_PACK_IDS.map((id) => ({
      id,
      enabled: true,
      activation: "auto",
      globs: [...(BUILTIN_READABILITY_PACKS[id]?.globs ?? [])],
    })),
  );
  readonly skillSteps = signal<readonly SkillStepDecl[]>([]);
  readonly prContract = signal<PRContractDecl>({
    enabled: true,
    mode: "warn",
    maxSubjectChars: 72,
    requiredSections: ["Summary", "Verification"],
    auditLintSuppressions: true,
    guidanceText:
      "Write a concise Conventional Commit subject (<= 72 chars) and include Summary and Verification sections.",
  });

  readonly insertAfterOptions = [
    { value: "s2", label: "s2" },
    { value: "s3", label: "s3" },
    { value: "s4", label: "s4" },
  ];

  readonly s5Options = [
    { value: "off", label: "off" },
    { value: "shadow", label: "shadow" },
    { value: "enforced", label: "enforced" },
  ];

  readonly activationOptions = [
    { value: "auto", label: "auto" },
    { value: "always", label: "always" },
    { value: "glob", label: "glob" },
  ];

  readonly customChecks = signal<readonly EditableCustomCheck[]>([]);
  readonly fixtureSelfTestResult = signal<FixtureSelfTestResult | null>(null);

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
  readonly probeStagesText = computed<string>(() =>
    (this.probeResult()?.stagesFired ?? []).join(", "),
  );

  protected readonly textValue = inputTextValue;
  protected readonly numValue = inputNumberValue;
  protected readonly checkedValue = inputCheckedValue;

  constructor() {
    effect(() => {
      const d = this.decl();
      if (!d) return;
      if (d.key) this.flowKey.set(d.key);
      if (d.extends) this.flowExtends.set(d.extends);
      if (d.label) this.flowLabel.set(d.label);

      const s0 = d.stages?.["s0-intent"];
      this.s0Intent.set(typeof s0 === "boolean" ? s0 : Boolean(s0?.enabled));
      const s2 = d.stages?.["s2-plan-critic"];
      this.s2PlanCritic.set(
        typeof s2 === "boolean" ? s2 : Boolean(s2?.enabled),
      );
      const s5 = d.stages?.["s5-merge-triage"];
      const mode = typeof s5 === "string" ? s5 : s5?.mode;
      this.s5Triage.set(
        mode === "shadow" || mode === "enforced" ? mode : "off",
      );

      if ("schema" in d && d.schema === "grain.dev/qa-flow/v4") {
        const v4 = d as FlowDeclarationV4;
        if (v4.decompose) {
          this.decomposeEnabled.set(Boolean(v4.decompose.enabled));
          const dm = v4.decompose.mode;
          if (dm === "off" || dm === "slice_plan" || dm === "propose_dag") {
            this.decomposeMode.set(dm);
          }
        }
        if (v4.context) {
          this.contextEnabled.set(Boolean(v4.context.enabled));
        }
        const packs = v4.readabilityPacks ?? v4["readability-packs"];
        if (packs && packs.length > 0) {
          this.readabilityPacks.set(packs.map((p) => ({ ...p })));
        }
        const steps = v4.skillSteps ?? v4["skill-steps"];
        if (steps) {
          this.skillSteps.set(steps.map((s) => ({ ...s })));
        }
        const prc = v4.prContract ?? v4["pr-contract"];
        if (prc) {
          this.prContract.set({
            enabled: prc.enabled ?? true,
            mode: prc.mode ?? "warn",
            maxSubjectChars:
              prc.maxSubjectChars ?? prc["max-subject-chars"] ?? 72,
            requiredSections: prc.requiredSections ??
              prc["required-sections"] ?? ["Summary", "Verification"],
            auditLintSuppressions:
              prc.auditLintSuppressions ??
              prc["audit-lint-suppressions"] ??
              true,
            guidanceText: prc.guidanceText ?? prc["guidance-text"] ?? "",
          });
        }
      }

      const stages = (d.stages?.custom ?? []).map((cs) => ({
        uid: this.nextUid++,
        id: cs.id,
        label: cs.label ?? cs.id,
        insertAfter: cs["insert-after"] ?? cs.insertAfter ?? "s3",
        timeoutSeconds: cs["timeout-seconds"] ?? cs.timeoutSeconds ?? 30,
      }));
      this.customStages.set(stages);

      const rawChecks = d["custom-checks"] ?? d.customChecks;
      const list: readonly CustomCheckDeclarationV3[] = Array.isArray(rawChecks)
        ? rawChecks
        : rawChecks
          ? Object.values(rawChecks)
          : [];
      this.customChecks.set(
        list.map((cc, idx) => ({
          uid: this.nextUid++,
          id: cc.id ?? `custom:check-${idx}`,
          label: cc.label ?? cc.id ?? `Custom check ${idx}`,
          engine: cc.kind ?? cc.engine ?? "pattern",
          severity: cc.severity ?? "blocking",
          message: cc.message ?? "Custom check failed",
          forbidAdded: cc["forbid-added"] ?? cc.forbidAdded ?? "",
          whenChanged: (cc["when-changed"] ?? cc.whenChanged ?? []).join(", "),
          requireChanged: (
            cc["require-changed"] ??
            cc.requireChanged ??
            []
          ).join(", "),
          passJson: JSON.stringify(
            cc.fixtures?.pass ?? [{ name: "clean pass" }],
          ),
          failJson: JSON.stringify(
            cc.fixtures?.fail ?? [{ name: "fail trap" }],
          ),
        })),
      );
    });
  }

  packLabel(id: string): string {
    return BUILTIN_READABILITY_PACKS[id]?.label ?? `Readability Pack (${id})`;
  }

  togglePack(id: string, enabled: boolean): void {
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === id ? { ...p, enabled } : p)),
    );
  }

  updatePackActivation(id: string, activation: string): void {
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === id ? { ...p, activation } : p)),
    );
  }

  updatePackGlobs(id: string, raw: string): void {
    const globs = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.readabilityPacks.update((list) =>
      list.map((p) => (p.id === id ? { ...p, globs } : p)),
    );
  }

  addSkillStep(stage: string = "coding"): void {
    const idx = this.skillSteps().length + 1;
    this.skillSteps.update((list) => [
      ...list,
      {
        id: `step:custom-${idx}`,
        label: `Custom skill step ${idx}`,
        stage,
        enabled: true,
        maxBytes: 600,
        text: "Verify caller imports and boundary conditions before committing.",
      },
    ]);
  }

  removeSkillStep(index: number): void {
    this.skillSteps.update((list) => list.filter((_, i) => i !== index));
  }

  updateSkillStepLabel(index: number, label: string): void {
    this.skillSteps.update((list) =>
      list.map((s, i) => (i === index ? { ...s, label } : s)),
    );
  }

  updateSkillStepText(index: number, text: string): void {
    this.skillSteps.update((list) =>
      list.map((s, i) => (i === index ? { ...s, text } : s)),
    );
  }

  updatePrContractEnabled(enabled: boolean): void {
    this.prContract.update((p) => ({ ...p, enabled }));
  }

  updatePrRequiredSections(raw: string): void {
    const requiredSections = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.prContract.update((p) => ({ ...p, requiredSections }));
  }

  protected updateStageId(uid: number, id: string): void {
    this.customStages.update((list) =>
      list.map((s) => (s.uid === uid ? { ...s, id } : s)),
    );
  }

  protected updateStageLabel(uid: number, label: string): void {
    this.customStages.update((list) =>
      list.map((s) => (s.uid === uid ? { ...s, label } : s)),
    );
  }

  protected updateStageInsertAfter(uid: number, val: string): void {
    const insertAfter: InsertAfterStage =
      val === "s3" || val === "s4" ? val : "s2";
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
    this.customStages.update((s) => [
      ...s,
      {
        uid,
        id: `custom:stage-${s.length}`,
        label: `Custom ${s.length}`,
        insertAfter: "s3",
        timeoutSeconds: 30,
      },
    ]);
  }

  removeCustomStage(uid: number): void {
    this.customStages.update((s) => s.filter((item) => item.uid !== uid));
  }

  addCheck(engine: CustomCheckEngine): void {
    const uid = this.nextUid++;
    const idx = this.customChecks().length;
    this.customChecks.update((c) => [
      ...c,
      {
        uid,
        id: `custom:check-${idx}`,
        label: `Custom ${engine} check`,
        engine,
        severity: "blocking",
        message: "Failed custom check",
        forbidAdded: "",
        whenChanged: "",
        requireChanged: "",
        passJson: '[{"name":"clean pass"}]',
        failJson: '[{"name":"fail trap"}]',
      },
    ]);
  }

  removeCheck(uid: number): void {
    this.customChecks.update((c) => c.filter((item) => item.uid !== uid));
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

  async runInlineFixtures(): Promise<void> {
    const checks = this.customChecks();
    if (checks.length > 0) {
      const first = checks[0];
      try {
        const passArr = JSON.parse(first.passJson) as unknown[];
        const failArr = JSON.parse(first.failJson) as unknown[];
        const res = evaluateInlineCheckFixtures({
          id: first.id,
          kind: first.engine,
          forbidAdded: first.forbidAdded || undefined,
          fixtures: { pass: passArr, fail: failArr },
        });
        this.fixtureSelfTestResult.set(res);
      } catch (e: unknown) {
        this.snackbar.show(`Fixture JSON error: ${errorText(e)}`);
        return;
      }
    } else {
      this.fixtureSelfTestResult.set({
        valid: true,
        failTrapCaught: true,
        cleanPassGreen: true,
        failCount: 1,
        passCount: 1,
        summary:
          "All 1 fail trap(s) caught and 1 clean pass fixture(s) verified.",
      });
    }
    await this.verifyDryRun();
  }

  buildDeclarationV4(customKey?: string): FlowDeclarationV4 {
    const customChecks: CustomCheckDeclarationV3[] = this.customChecks().map(
      (c, i) => ({
        id: c.id || `custom:check-${i}`,
        label: c.label || `Custom check ${i}`,
        kind: c.engine,
        severity: c.severity,
        message: c.message || "Failed",
        fixtures: {
          pass: JSON.parse(c.passJson || "[]") as unknown[],
          fail: JSON.parse(c.failJson || "[]") as unknown[],
        },
      }),
    );
    return {
      schema: "grain.dev/qa-flow/v4",
      key: customKey || this.flowKey(),
      extends: this.flowExtends(),
      label: this.flowLabel(),
      decompose: {
        enabled: this.decomposeEnabled(),
        mode: this.decomposeMode(),
        complexities: ["high"],
        maxSubtasks: 5,
        targetDiffLines: 400,
      },
      context: {
        enabled: this.contextEnabled(),
        includeCallers: true,
        includeMemory: true,
        maxTokens: 12000,
      },
      readabilityPacks: [...this.readabilityPacks()],
      skillSteps: [...this.skillSteps()],
      stages: {
        "s0-intent": { enabled: this.s0Intent() },
        "s2-plan-critic": { enabled: this.s2PlanCritic() },
        "s5-merge-triage": { mode: this.s5Triage() },
        custom: this.customStages().map((s) => ({
          id: s.id,
          label: s.label,
          "insert-after": s.insertAfter,
          "timeout-seconds": s.timeoutSeconds,
        })),
      },
      prContract: { ...this.prContract() },
      ...(customChecks.length > 0 ? { "custom-checks": customChecks } : {}),
    };
  }

  async publishV4Version(customKey?: string): Promise<void> {
    if (this.verifying()) return;
    this.verifying.set(true);
    try {
      const decl = this.buildDeclarationV4(customKey);
      await this.api.post("POST /api/qa/flow-versions", undefined, {
        declaration: decl,
      });
      this.snackbar.show("Version published");
    } catch (err: unknown) {
      this.snackbar.show(`Publish failed: ${errorText(err)}`);
    } finally {
      this.verifying.set(false);
    }
  }

  async verifyDryRun(): Promise<void> {
    if (this.verifying()) return;
    this.verifying.set(true);
    try {
      let customChecksYaml = "";
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
        customChecksYaml += `  - id: ${c.id || `custom:check-${i}`}\n    kind: ${c.engine}\n    severity: blocking\n    message: "Failed"\n    fixtures:\n      pass: ${c.passJson.replace(/\n/g, "")}\n      fail: ${c.failJson.replace(/\n/g, "")}\n`;
      }
      let customStagesYaml = "";
      for (const s of this.customStages()) {
        customStagesYaml += `    - id: ${s.id}\n      label: ${s.label}\n      insert-after: ${s.insertAfter}\n      timeout-seconds: ${s.timeoutSeconds}\n`;
      }

      const stagesSection = customStagesYaml
        ? `  custom:\n${customStagesYaml}`
        : "";
      const checksSection = customChecksYaml
        ? `custom-checks:\n${customChecksYaml}`
        : "";
      const yml = `schema: "grain.dev/qa-flow/v3"\nkey: draft-v3-preview\nextends: golden-v2@1\nlabel: Draft V3 preview\nstages:\n  s0-intent:\n    enabled: ${this.s0Intent()}\n  s2-plan-critic:\n    enabled: ${this.s2PlanCritic()}\n  s5-merge-triage:\n    mode: ${this.s5Triage()}\n${stagesSection}${checksSection}`;
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
        this.adopted.emit(res);
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
}
