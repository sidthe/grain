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
        @for (s of customStages(); track $index) {
          <div class="check-row" style="margin-top: 16px;">
            <div class="check-name">
              <strong>Custom Stage</strong>
              <button
                type="button"
                class="btn-text danger"
                (click)="removeCustomStage($index)"
              >
                Remove
              </button>
            </div>
            <div class="check-params">
              <label [attr.for]="'stg-id-' + $index">ID</label>
              <input
                [id]="'stg-id-' + $index"
                type="text"
                [value]="s.id"
                (input)="updateStageId($index, textValue($event))"
              />

              <label [attr.for]="'stg-lbl-' + $index">Label</label>
              <input
                [id]="'stg-lbl-' + $index"
                type="text"
                [value]="s.label"
                (input)="updateStageLabel($index, textValue($event))"
              />

              <label [attr.for]="'stg-after-' + $index">Insert After</label>
              <g-pill-select
                ariaLabel="Insert after"
                [value]="s.insertAfter"
                (valueChange)="updateStageInsertAfter($index, $event)"
                [options]="insertAfterOptions"
              />

              <label [attr.for]="'stg-to-' + $index">Timeout (s)</label>
              <input
                [id]="'stg-to-' + $index"
                type="number"
                [value]="s.timeoutSeconds"
                (input)="updateStageTimeout($index, numValue($event))"
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

        @for (c of customChecks(); track $index) {
          <div class="check-row" style="margin-top: 16px;">
            <div class="check-name">
              <strong>Engine:</strong> {{ c.engine }}
              <button
                type="button"
                class="btn-text danger"
                (click)="removeCheck($index)"
              >
                Remove
              </button>
            </div>
            <div class="check-params fixture-stack">
              <label [attr.for]="'pass-' + $index">
                Pass fixture (JSON array)
              </label>
              <textarea
                [id]="'pass-' + $index"
                [value]="c.passJson"
                (input)="updateFixture($index, 'pass', textValue($event))"
                rows="2"
              ></textarea>
              <label [attr.for]="'fail-' + $index">
                Fail fixture (JSON array)
              </label>
              <textarea
                [id]="'fail-' + $index"
                [value]="c.failJson"
                (input)="updateFixture($index, 'fail', textValue($event))"
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
          class="modal-content-full"
          (click)="$event.stopPropagation()"
          (keydown.escape)="showAdopt.set(false)"
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
          class="probe-drawer-full"
          (click)="$event.stopPropagation()"
          (keydown.escape)="showProbe.set(false)"
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
              <p>Stages Fired: {{ pr.stagesFired.join(", ") }}</p>
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

  readonly decl = input<FlowDeclarationV3>();

  readonly s0Intent = signal(false);
  readonly s2PlanCritic = signal(false);
  readonly s5Triage = signal<"off" | "shadow" | "enforced">("off");
  readonly customStages = signal<
    Array<{
      id: string;
      label: string;
      insertAfter: InsertAfterStage;
      timeoutSeconds: number;
    }>
  >([]);

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

  readonly customChecks = signal<
    Array<{
      engine: CustomCheckEngine;
      passJson: string;
      failJson: string;
    }>
  >([]);

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
        id: cs.id,
        label: cs.label ?? cs.id,
        insertAfter: cs["insert-after"] ?? cs.insertAfter ?? "s3",
        timeoutSeconds: cs["timeout-seconds"] ?? cs.timeoutSeconds ?? 30,
      }));
      this.customStages.set(stages);

      const rawChecks = d["custom-checks"] ?? d.customChecks;
      const list: CustomCheckDeclarationV3[] = Array.isArray(rawChecks)
        ? rawChecks
        : rawChecks
          ? Object.values(rawChecks)
          : [];
      this.customChecks.set(
        list.map((cc) => ({
          engine: cc.kind ?? cc.engine ?? "pattern",
          passJson: JSON.stringify(cc.fixtures?.pass ?? []),
          failJson: JSON.stringify(cc.fixtures?.fail ?? []),
        })),
      );
    });
  }

  protected textValue(ev: Event): string {
    return (ev.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected numValue(ev: Event): number {
    return (ev.target as HTMLInputElement).valueAsNumber || 0;
  }

  protected checkedValue(ev: Event): boolean {
    return (ev.target as HTMLInputElement).checked;
  }

  protected updateStageId(idx: number, id: string): void {
    this.customStages.update((list) =>
      list.map((s, i) => (i === idx ? { ...s, id } : s)),
    );
  }

  protected updateStageLabel(idx: number, label: string): void {
    this.customStages.update((list) =>
      list.map((s, i) => (i === idx ? { ...s, label } : s)),
    );
  }

  protected updateStageInsertAfter(idx: number, val: string): void {
    const insertAfter: InsertAfterStage =
      val === "s3" || val === "s4" ? val : "s2";
    this.customStages.update((list) =>
      list.map((s, i) => (i === idx ? { ...s, insertAfter } : s)),
    );
  }

  protected updateStageTimeout(idx: number, timeoutSeconds: number): void {
    this.customStages.update((list) =>
      list.map((s, i) => (i === idx ? { ...s, timeoutSeconds } : s)),
    );
  }

  addCustomStage(): void {
    this.customStages.update((s) => [
      ...s,
      {
        id: `custom:stage-${s.length}`,
        label: `Custom ${s.length}`,
        insertAfter: "s3",
        timeoutSeconds: 30,
      },
    ]);
  }

  removeCustomStage(idx: number): void {
    this.customStages.update((s) => s.filter((_, i) => i !== idx));
  }

  addCheck(engine: CustomCheckEngine): void {
    this.customChecks.update((c) => [
      ...c,
      { engine, passJson: "[]", failJson: "[]" },
    ]);
  }

  removeCheck(idx: number): void {
    this.customChecks.update((c) => c.filter((_, i) => i !== idx));
  }

  updateFixture(idx: number, kind: "pass" | "fail", val: string): void {
    this.customChecks.update((c) =>
      c.map((item, i) =>
        i === idx
          ? kind === "pass"
            ? { ...item, passJson: val }
            : { ...item, failJson: val }
          : item,
      ),
    );
  }

  async verifyDryRun(): Promise<void> {
    this.verifying.set(true);
    try {
      let customChecksYaml = "";
      for (let i = 0; i < this.customChecks().length; i++) {
        const c = this.customChecks()[i];
        try {
          JSON.parse(c.passJson);
          JSON.parse(c.failJson);
        } catch (e) {
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
    } catch (err) {
      this.snackbar.show(`Dry run failed: ${errorText(err)}`);
    } finally {
      this.verifying.set(false);
    }
  }

  async doAdopt(): Promise<void> {
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
    } catch (err) {
      this.snackbar.show(`Adopt failed: ${errorText(err)}`);
    } finally {
      this.adopting.set(false);
    }
  }

  async doProbe(): Promise<void> {
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
    } catch (err) {
      this.snackbar.show(`Probe failed: ${errorText(err)}`);
    } finally {
      this.probing.set(false);
    }
  }
}
