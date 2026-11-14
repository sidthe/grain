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
  signal,
} from "@angular/core";
import { GrainApi } from "../api/grain-api.service";
import { SnackbarService } from "../services/snackbar.service";
import { errorText } from "../sessions/session-helpers";
import { DialogTrapDirective } from "../shared/dialog-trap.directive";
import { PillSelectComponent } from "../shared/pill-select.component";
import type {
  CustomCheckDeclarationV3,
  FlowDeclarationV3,
  QAAdoptResponse,
  QADryRunResponse,
  QAProbeResponse,
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

interface EditableCustomCheck {
  readonly uid: number;
  readonly engine: CustomCheckEngine;
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
  styleUrl: "./qa-v3-studio.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="qa-v3-studio editor-scroll-area" data-testid="qa-v3-studio">
      <div class="editor-section">
        <h3>V3 Pipeline stages</h3>
        <label for="s0Intent">
          <input
            id="s0Intent"
            type="checkbox"
            [checked]="s0Intent()"
            (change)="s0Intent.set(checkedValue($event))"
          />
          S0 Intent
        </label>
        <label for="s2PlanCritic">
          <input
            id="s2PlanCritic"
            type="checkbox"
            [checked]="s2PlanCritic()"
            (change)="s2PlanCritic.set(checkedValue($event))"
          />
          S2 Plan Critic
        </label>
        <button
          type="button"
          class="btn-text"
          data-testid="qa-v3-add-stage"
          (click)="addCustomStage()"
        >
          + Custom stage
        </button>
        @for (stage of customStages(); track stage.uid) {
          <div
            class="check-row"
            data-testid="qa-v3-custom-stage-row"
            style="margin-top: 16px;"
          >
            <div class="check-name">
              <strong>Custom Stage</strong>
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

        <div style="margin-top: 16px;">
          <label for="s5Triage">S5 Merge Triage</label>
          <g-pill-select
            id="s5Triage"
            ariaLabel="S5 Merge Triage"
            [(value)]="s5Triage"
            [options]="s5Options"
          />
        </div>
      </div>

      <div class="editor-section">
        <h3>Custom checks</h3>
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
            style="margin-top: 16px;"
          >
            <div class="check-name">
              <strong>Engine:</strong> {{ check.engine }}
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
                Pass fixture (JSON array)
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
                Fail fixture (JSON array)
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
        <button
          type="button"
          class="btn-tonal"
          style="margin-top: 16px;"
          data-testid="qa-v3-verify-dry-run"
          (click)="verifyDryRun()"
          [disabled]="verifying()"
        >
          Verify fixtures &amp; dry-run
        </button>

        @if (dryRunResult(); as r) {
          <div class="dry-run-results" style="margin-top: 16px;">
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

      <div class="editor-section section-divider">
        <h3>Adopt from repo commit</h3>
        <button
          type="button"
          class="btn-outlined"
          data-testid="qa-v3-open-adopt"
          (click)="showAdopt.set(true)"
        >
          Adopt Flow
        </button>
      </div>

      <div class="editor-section section-divider">
        <h3>What-if probe</h3>
        <button
          type="button"
          class="btn-outlined"
          data-testid="qa-v3-open-probe"
          (click)="showProbe.set(true)"
        >
          Test Probe
        </button>
      </div>
    </div>

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
            <div class="section-divider" data-testid="qa-v3-probe-result">
              <span class="status-pill info"
                >Complexity: {{ pr.complexity.tier }}</span
              >
              <p>Score: {{ pr.risk.score }}/100</p>
              <p>Blast Tier: {{ pr.risk.tier }}</p>
              <p>S5 Triage: {{ pr.triage.decision }} ({{ pr.triage.mode }})</p>
              <p>Stages Fired: {{ probeStagesText() }}</p>
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class QaV3StudioComponent {
  private readonly api = inject(GrainApi);
  private readonly snackbar = inject(SnackbarService);
  private nextUid = 1;

  readonly decl = input<FlowDeclarationV3>();

  readonly s0Intent = signal(false);
  readonly s2PlanCritic = signal(false);
  readonly s5Triage = signal<"off" | "shadow" | "enforced">("off");
  readonly customStages = signal<readonly EditableCustomStage[]>([]);

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

  readonly customChecks = signal<readonly EditableCustomCheck[]>([]);

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
        list.map((cc) => ({
          uid: this.nextUid++,
          engine: cc.kind ?? cc.engine ?? "pattern",
          passJson: JSON.stringify(cc.fixtures?.pass ?? []),
          failJson: JSON.stringify(cc.fixtures?.fail ?? []),
        })),
      );
    });
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
    this.customChecks.update((c) => [
      ...c,
      { uid, engine, passJson: "[]", failJson: "[]" },
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
        customChecksYaml += `  - id: custom:check-${i}\n    kind: ${c.engine}\n    severity: blocking\n    message: "Failed"\n    fixtures:\n      pass: ${c.passJson.replace(/\n/g, "")}\n      fail: ${c.failJson.replace(/\n/g, "")}\n`;
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
