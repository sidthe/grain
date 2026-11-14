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
} from "@angular/core";
import type { QAExperimentResults } from "./qa-experiments.models";

@Component({
  selector: "g-quality-v3-cards",
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./quality-v3-cards.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="quality-v3-cards">
      @if (results()?.declarationDiff; as diff) {
        <div class="diff-strip">
          <strong
            >Changed vs. {{ results()?.referenceArmId || "control" }}:</strong
          >
          @for (s of diff.addedStages || []; track $index) {
            <span class="status-pill success">+{{ s }}</span>
          }
          @for (s of diff.removedStages || []; track $index) {
            <span class="status-pill error">-{{ s }}</span>
          }
          @if ((diff.addedCustomChecks || []).length) {
            <span class="status-pill success"
              >+{{ (diff.addedCustomChecks || []).length }} custom checks</span
            >
          }
          @if ((diff.removedCustomChecks || []).length) {
            <span class="status-pill error"
              >-{{ (diff.removedCustomChecks || []).length }} custom
              checks</span
            >
          }
          @if ((diff.changedChecks || []).length) {
            <span class="status-pill warning"
              >{{ (diff.changedChecks || []).length }} changed checks</span
            >
          }
          @if (diff.changedVerifier) {
            <span class="status-pill warning">Verifier changed</span>
          }
          @if (diff.changedTriage) {
            <span class="status-pill warning">Triage changed</span>
          }
        </div>
      }

      @if ((results()?.stageFunnel || [])?.length) {
        <div class="ops-card">
          <h3>Stage Funnel &amp; Cost Attribution</h3>
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Arm</th>
                <th>Runs / Applies</th>
                <th>Findings</th>
                <th>Repaired next SHA</th>
                <th>p95 latency</th>
                <th>Median tokens</th>
              </tr>
            </thead>
            <tbody>
              @for (
                row of results()?.stageFunnel || [];
                track row.armId + "-" + row.stage
              ) {
                <tr>
                  <td>{{ row.stage }}</td>
                  <td class="mono">{{ row.armId }}</td>
                  <td>
                    {{ row.runs }}
                    <span class="muted">({{ row.applicablePct }}%)</span>
                  </td>
                  <td>{{ row.findingsCount }}</td>
                  <td>{{ row.repairedInNextShaPct }}%</td>
                  <td>{{ row.durationP95Ms }} ms</td>
                  <td>{{ row.tokensMedian }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      @if ((results()?.triageMetrics || [])?.length) {
        <div class="ops-card">
          <h3>Human-Review Triage (S5)</h3>
          <table>
            <thead>
              <tr>
                <th>Arm</th>
                <th>Mode</th>
                <th>Reviews saved</th>
                <th>Human-routed</th>
                <th>Auto-merged escape rate</th>
                <th>Human-routed precision</th>
              </tr>
            </thead>
            <tbody>
              @for (row of results()?.triageMetrics || []; track row.armId) {
                <tr>
                  <td class="mono">{{ row.armId }}</td>
                  <td>
                    <span class="status-pill">{{ row.mode }}</span>
                  </td>
                  <td>{{ row.autoMergeEligiblePct }}%</td>
                  <td>{{ row.humanRoutedPct }}%</td>
                  <td>{{ row.autoMergedEscapeRate }}%</td>
                  <td>{{ row.humanRoutedTruePositiveRate }}%</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class QualityV3CardsComponent {
  results = input<QAExperimentResults>();
}
