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
  input,
  signal,
  inject,
} from "@angular/core";
import { GrainApi } from "../api/grain-api.service";
import { SnackbarService } from "../services/snackbar.service";
import { AccessService } from "../services/access.service";
import type {
  FlowDeclarationV3,
  QADryRunResponse,
  QAProbeResponse,
  QAAdoptResponse,
} from "./qa-flows.models";
import { PillSelectComponent } from "../shared/pill-select.component";
import { DialogTrapDirective } from "../shared/dialog-trap.directive";
import { errorText } from "../sessions/session-helpers";

@Component({
  selector: "g-qa-v3-studio",
  imports: [PillSelectComponent, DialogTrapDirective],
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./qa-v3-studio.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="qa-v3-studio editor-scroll-area">
      <div class="editor-section">
        <h3>V3 Pipeline stages</h3>
        <label for="s0Intent"
          ><input
            id="s0Intent"
            type="checkbox"
            [checked]="s0Intent()"
            (change)="s0Intent.set($any($event.target).checked)"
          />
          S0 Intent</label
        >
        <label for="s2PlanCritic"
          ><input
            id="s2PlanCritic"
            type="checkbox"
            [checked]="s2PlanCritic()"
            (change)="s2PlanCritic.set($any($event.target).checked)"
          />
          S2 Plan Critic</label
        >
        <button class="btn-text" (click)="addCustomStage()">
          + Custom stage
        </button>
        @for (s of customStages(); track $index) {
          <div class="check-row" style="margin-top: 16px;">
            <div class="check-name">
              <strong>Custom Stage</strong>
              <button
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
                (input)="s.id = $any($event.target).value"
              />

              <label [attr.for]="'stg-lbl-' + $index">Label</label>
              <input
                [id]="'stg-lbl-' + $index"
                type="text"
                [value]="s.label"
                (input)="s.label = $any($event.target).value"
              />

              <label [attr.for]="'stg-after-' + $index">Insert After</label>
              <g-pill-select
                ariaLabel="Insert after"
                [value]="s.insertAfter"
                (valueChange)="s.insertAfter = $any($event)"
                [options]="[
                  { value: 's2', label: 's2' },
                  { value: 's3', label: 's3' },
                  { value: 's4', label: 's4' },
                ]"
              />

              <label [attr.for]="'stg-to-' + $index">Timeout (s)</label>
              <input
                [id]="'stg-to-' + $index"
                type="number"
                [value]="s.timeoutSeconds"
                (input)="
                  s.timeoutSeconds = $any($event.target).valueAsNumber || 0
                "
              />
            </div>
          </div>
        }

        <div style="margin-top: 16px;">
          <label for="s5Triage">S5 Merge Triage</label>
          <g-pill-select
            id="s5Triage"
            [(value)]="s5Triage"
            [options]="s5Options"
          />
        </div>
      </div>

      <div class="editor-section">
        <h3>Custom checks</h3>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn-outlined" (click)="addCheck('pattern')">
            pattern
          </button>
          <button class="btn-outlined" (click)="addCheck('diff-budget')">
            diff-budget
          </button>
          <button class="btn-outlined" (click)="addCheck('companion')">
            companion
          </button>
          <button class="btn-outlined" (click)="addCheck('jsonschema')">
            jsonschema
          </button>
        </div>

        @for (c of customChecks(); track $index) {
          <div class="check-row" style="margin-top: 16px;">
            <div class="check-name">
              <strong>Engine:</strong> {{ c.engine }}
              <button class="btn-text danger" (click)="removeCheck($index)">
                Remove
              </button>
            </div>
            <div
              class="check-params"
              style="flex-direction: column; align-items: stretch; width: 100%;"
            >
              <label [attr.for]="'pass-' + $index"
                >Pass fixture (JSON array)</label
              >
              <textarea
                [id]="'pass-' + $index"
                [value]="c.passJson"
                (input)="updateFixture($index, 'pass', $any($event.target).value)"
                rows="2"
              ></textarea>
              <label [attr.for]="'fail-' + $index"
                >Fail fixture (JSON array)</label
              >
              <textarea
                [id]="'fail-' + $index"
                [value]="c.failJson"
                (input)="updateFixture($index, 'fail', $any($event.target).value)"
                rows="2"
              ></textarea>
            </div>
          </div>
        }
        <button
          class="btn-tonal"
          style="margin-top: 16px;"
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

      <div
        class="editor-section"
        style="margin-top: 32px; border-top: 1px solid var(--grain-border); padding-top: 24px;"
      >
        <h3>Adopt from repo commit</h3>
        <button class="btn-outlined" (click)="showAdopt.set(true)">
          Adopt Flow
        </button>
      </div>

      <div
        class="editor-section"
        style="margin-top: 32px; border-top: 1px solid var(--grain-border); padding-top: 24px;"
      >
        <h3>What-if probe</h3>
        <button class="btn-outlined" (click)="showProbe.set(true)">
          Test Probe
        </button>
      </div>
    </div>

    @if (showAdopt()) {
      <!-- eslint-disable @angular-eslint/template/click-events-have-key-events,@angular-eslint/template/interactive-supports-focus -->
      <div
        gDialogTrap
        class="modal-backdrop"
        (click)="showAdopt.set(false)"
        class="modal-backdrop-full"
      >
        <div
          class="modal-content"
          (click)="$event.stopPropagation()"
          style="background:var(--grain-surface);margin:10% auto;padding:24px;border-radius:12px;max-width:500px;"
          (keydown.escape)="showAdopt.set(false)"
        >
          <h3>Adopt Flow from Commit</h3>
          <label for="adoptRepo">Repo</label>
          <input
            id="adoptRepo"
            type="text"
            [value]="adoptRepo()"
            (input)="adoptRepo.set($any($event.target).value)"
          />
          <label for="adoptPath">Path</label>
          <input
            id="adoptPath"
            type="text"
            [value]="adoptPath()"
            (input)="adoptPath.set($any($event.target).value)"
          />
          <label for="adoptCommit">Commit (40-char SHA)</label>
          <input
            id="adoptCommit"
            type="text"
            [value]="adoptCommit()"
            (input)="adoptCommit.set($any($event.target).value)"
          />

          <div style="margin-top:24px;display:flex;gap:12px;">
            <button
              class="btn-primary"
              (click)="doAdopt()"
              [disabled]="
                !adoptRepo() || !adoptPath() || !adoptCommit() || adopting()
              "
            >
              Adopt
            </button>
            <button class="btn-outlined" (click)="showAdopt.set(false)">
              Cancel
            </button>
          </div>
        </div>
      </div>
    }

    @if (showProbe()) {
      <!-- eslint-disable @angular-eslint/template/click-events-have-key-events,@angular-eslint/template/interactive-supports-focus -->
      <div
        gDialogTrap
        class="modal-backdrop"
        (click)="showProbe.set(false)"
        class="modal-backdrop-right"
      >
        <div
          class="probe-drawer"
          (click)="$event.stopPropagation()"
          style="background:var(--grain-surface);height:100%;width:400px;padding:24px;overflow-y:auto;"
          (keydown.escape)="showProbe.set(false)"
        >
          <h3>What-if Probe</h3>
          <label for="probeTitle">Title</label>
          <input
            id="probeTitle"
            type="text"
            [value]="probeTitle()"
            (input)="probeTitle.set($any($event.target).value)"
          />
          <label for="probeBody">Body</label>
          <textarea
            id="probeBody"
            [value]="probeBody()"
            (input)="probeBody.set($any($event.target).value)"
            rows="3"
          ></textarea>
          <label for="probeFiles">Files (comma or newline separated)</label>
          <textarea
            id="probeFiles"
            [value]="probeFiles()"
            (input)="probeFiles.set($any($event.target).value)"
            rows="3"
          ></textarea>
          <label for="probeNonTest">Non Test Added</label>
          <input
            id="probeNonTest"
            type="number"
            [value]="probeNonTest()"
            (input)="probeNonTest.set($any($event.target).valueAsNumber || 0)"
          />

          <button
            class="btn-primary"
            style="margin-top:16px;width:100%;"
            (click)="doProbe()"
            [disabled]="probing()"
          >
            Run Probe
          </button>

          @if (probeResult(); as pr) {
            <div
              style="margin-top: 24px; border-top: 1px solid var(--grain-border); padding-top: 16px;"
            >
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
  private api = inject(GrainApi);
  private snackbar = inject(SnackbarService);
  private access = inject(AccessService);

  decl = input<FlowDeclarationV3>();

  s0Intent = signal(false);
  s2PlanCritic = signal(false);
  s5Triage = signal<"off" | "shadow" | "enforced">("off");
  customStages = signal<
    Array<{
      id: string;
      label: string;
      insertAfter: "s2" | "s3" | "s4";
      timeoutSeconds: number;
    }>
  >([]);

  s5Options = [
    { value: "off", label: "off" },
    { value: "shadow", label: "shadow" },
    { value: "enforced", label: "enforced" },
  ];

  customChecks = signal<
    Array<{
      engine: "pattern" | "diff-budget" | "companion" | "jsonschema";
      passJson: string;
      failJson: string;
    }>
  >([]);

  verifying = signal(false);
  dryRunResult = signal<QADryRunResponse | null>(null);

  showAdopt = signal(false);
  adoptRepo = signal("");
  adoptPath = signal(".grain/qa/flow.yml");
  adoptCommit = signal("");
  adopting = signal(false);

  showProbe = signal(false);
  probeTitle = signal("");
  probeBody = signal("");
  probeFiles = signal("");
  probeNonTest = signal(0);
  probing = signal(false);
  probeResult = signal<QAProbeResponse | null>(null);

  addCustomStage() {
    this.customStages.update((s) => [
      ...s,
      { id: "custom-" + s.length,
        label: "Custom " + s.length,
        insertAfter: "s2",
        timeoutSeconds: 300,
      },
    ]);
  }

  removeCustomStage(idx: number) {
    this.customStages.update((s) => {
      const ns = [...s];
      ns.splice(idx, 1);
      return ns;
    });
  }

  addCheck(engine: "pattern" | "diff-budget" | "companion" | "jsonschema") {
    this.customChecks.update((c) => [
      ...c,
      { engine, passJson: "[]", failJson: "[]" },
    ]);
  }

  removeCheck(idx: number) {
    this.customChecks.update((c) => {
      const nc = [...c];
      nc.splice(idx, 1);
      return nc;
    });
  }

  updateFixture(idx: number, type: "pass" | "fail", val: string) {
    this.customChecks.update((c) => {
      const nc = [...c];
      if (type === "pass") nc[idx].passJson = val;
      else nc[idx].failJson = val;
      return nc;
    });
  }

  async verifyDryRun() {
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
        customChecksYaml += `  - id: check-${i}\n    kind: ${c.engine}\n    severity: blocking\n    message: "Failed"\n    fixtures:\n      pass: ${c.passJson.replace(/\n/g, "")}\n      fail: ${c.failJson.replace(/\n/g, "")}\n`;
      }
      let customStagesYaml = "";
      for (const s of this.customStages()) {
        customStagesYaml += `    - id: ${s.id}\n      label: ${s.label}\n      insertAfter: ${s.insertAfter}\n      timeoutSeconds: ${s.timeoutSeconds}\n`;
      }

      const yml = `schema: "grain.dev/qa-flow/v3"\nkey: draft-v3-preview\nextends: golden-v2@1\nstages:\n  s0-intent:\n    enabled: ${this.s0Intent()}\n  s2-plan-critic:\n    enabled: ${this.s2PlanCritic()}\n  s5-merge-triage:\n    mode: ${this.s5Triage()}\n  custom:\n${customStagesYaml}\ncustom-checks:\n${customChecksYaml}`;
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

  async doAdopt() {
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

  async doProbe() {
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
