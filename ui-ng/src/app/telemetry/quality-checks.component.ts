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
  input,
  output,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import {
  armLabel,
  armVerdicts,
  checkPrecision,
  costMeasured,
  cupedTip,
  durWords,
  experimentPeriodLabel,
  experimentScope,
  matchedRecall,
  rateDiffWords,
  relDiffWords,
  stageWords,
  timeDiffWords,
  timeTip,
  tokenWords,
} from "./quality-verdict";
import {
  type QACheckRuleSummary,
  type QASummary,
  formatCheckDurationMs,
  formatPct,
} from "./telemetry.models";

interface MetricRow {
  id: string;
  label: string;
  tip: string;
  treatment: string;
  control: string;
  diff: string;
}

/**
 * Telemetry → Quality checks tab: read-only rollout results and per-check
 * health from GET /api/qa/summary. The parent page owns fetching, the
 * window/repository controls and the tablist.
 */
@Component({
  selector: "g-telemetry-quality",
  imports: [RouterLink, TipDirective, StatusIconComponent],
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./quality-checks.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (deniedReason(); as why) {
      <p class="empty-state" data-testid="qa-denied">{{ why }}</p>
    } @else if (!summary()) {
      @if (error(); as err) {
        <div
          class="banner banner-error tq-error"
          role="alert"
          data-testid="qa-error"
        >
          <span>Could not load quality results: {{ err }}</span>
          <button
            type="button"
            class="btn-text"
            data-testid="qa-retry"
            (click)="retry.emit()"
          >
            Try again
          </button>
        </div>
      } @else {
        <article
          class="ops-card tq-card"
          aria-busy="true"
          data-testid="qa-loading"
        >
          <h2 class="ops-card-title">Loading quality results…</h2>
          <div class="tq-skel" aria-hidden="true"><i></i><i></i><i></i></div>
        </article>
      }
    } @else {
      @let qa = summary()!;
      @if (isOff()) {
        <article class="ops-card tq-card tq-off" data-testid="card-qa-rollout">
          <div class="ops-card-head tq-head">
            <div class="tq-head-text">
              <h2 class="ops-card-title">Quality checks</h2>
              <p class="ops-card-sub">
                Compare pull requests made with and without pre-PR quality
                checks.
              </p>
            </div>
            <span class="status-pill neutral" data-testid="qa-rollout-pill">
              <g-status-icon tone="neutral" kind="idle" />
              Off
            </span>
          </div>
          <p class="tq-lead" data-testid="qa-rollout-empty">
            Quality control is off on this deployment. Turn on a rollout in
            Settings → Tasks: each new work tree is then assigned either to run
            with the checks or without them, and this tab compares the two.
          </p>
          <div class="tq-links">
            <a
              class="btn-tonal"
              routerLink="/settings/tasks"
              data-testid="qa-configure-link"
            >
              Settings → Tasks
            </a>
            <a
              class="btn-text"
              routerLink="/processes/quality"
              data-testid="qa-rules-link"
            >
              See the checks
            </a>
          </div>
        </article>
      } @else {
        <article
          class="ops-card tq-card"
          data-testid="card-qa-rollout"
          aria-labelledby="tq-results-title"
        >
          <div class="ops-card-head tq-head">
            <div class="tq-head-text">
              <h2 class="ops-card-title" id="tq-results-title">
                Rollout results
              </h2>
              <p class="ops-card-sub">
                A work tree is a root task and every child task filed under it.
                Each runs entirely in one arm: with quality checks ({{ arm() }})
                or without them (control).
              </p>
            </div>
            <div class="headline-actions">
              <span
                [class]="'status-pill tabular ' + rollout().tone"
                data-testid="qa-rollout-pill"
                [gTip]="rollout().tip"
                tabindex="0"
              >
                <g-status-icon
                  [tone]="rollout().tone"
                  [kind]="rollout().kind"
                />
                {{ rollout().label }}
              </span>
              <a
                class="btn-tonal"
                routerLink="/settings/tasks"
                data-testid="qa-configure-link"
              >
                Configure
              </a>
            </div>
          </div>

          @if (period(); as p) {
            <p class="tq-scope" data-testid="qa-scope">
              <span class="status-pill neutral" data-testid="qa-period-chip">
                <g-status-icon tone="neutral" kind="progress" />
                {{ p }}
              </span>
            </p>
          } @else {
            <p class="tq-scope" data-testid="qa-scope">
              Covers work trees assigned in the last {{ windowWords()
              }}{{ repoWords() }}
              ·
              <span
                class="tq-term"
                tabindex="0"
                [gTip]="
                  'Epoch ' +
                  qa.epoch +
                  ' started when the rollout last changed; regime ' +
                  qa.regimeId +
                  ' is the current rollout percentage step. Changing the window above changes these results.'
                "
                >epoch {{ qa.epoch }}</span
              >
            </p>
          }

          @if ((qa.circuitBreaker.reasons?.length ?? 0) > 0) {
            <p
              class="banner banner-error tq-banner"
              role="status"
              data-testid="qa-circuit-breaker-banner"
            >
              <g-status-icon tone="error" kind="blocked" />
              <span>
                Safety guardrail tripped:
                {{ (qa.circuitBreaker.reasons ?? []).join(" · ") }}. New
                work trees run without enforcement until the rollout is reset.
              </span>
            </p>
          }

          @if (noAssignments()) {
            <p class="tq-lead" data-testid="qa-rollout-empty">
              Waiting for the first work trees under epoch {{ qa.epoch }}.
              Results appear once both arms have work.
            </p>
          } @else {
            <ul class="tq-verdicts" aria-label="Verdict by arm">
              @for (v of verdicts(); track v.arm) {
                <li
                  class="tq-verdict"
                  data-testid="qa-verdict"
                  [attr.data-state]="v.state"
                >
                  <span
                    [class]="'status-pill ' + v.tone"
                    data-testid="qa-verdict-pill"
                    tabindex="0"
                    [gTip]="v.tip || null"
                  >
                    <g-status-icon [tone]="v.tone" [kind]="v.kind" />
                    {{ v.arm }} · {{ v.label }}
                  </span>
                  <p class="tq-sentence" data-testid="qa-verdict-sentence">
                    {{ v.sentence }}
                  </p>
                  @if (v.need) {
                    <p class="tq-need" data-testid="qa-verdict-need">
                      {{ v.need }}
                    </p>
                  }
                </li>
              }
            </ul>

            <div
              class="tq-table"
              role="table"
              aria-label="Rollout measures by arm"
              data-testid="chart-qa-rollout"
            >
              <div class="tq-row tq-row-head" role="row">
                <span role="columnheader">Measure</span>
                <span role="columnheader" class="tabular"
                  >{{ arm() }} ·
                  {{ qa.treatment.assignedOrigins }} work trees</span
                >
                <span role="columnheader" class="tabular"
                  >Control · {{ qa.control.assignedOrigins }} work trees</span
                >
                <span role="columnheader">Difference</span>
              </div>
              @for (m of metrics(); track m.id) {
                <div
                  class="tq-row"
                  role="row"
                  [attr.data-testid]="'qa-metric-' + m.id"
                >
                  <span role="rowheader">
                    <span class="tq-term" tabindex="0" [gTip]="m.tip">{{
                      m.label
                    }}</span>
                  </span>
                  <span role="cell" class="tabular" [attr.data-arm]="arm()">{{
                    m.treatment
                  }}</span>
                  <span role="cell" class="tabular" data-arm="Control">{{
                    m.control
                  }}</span>
                  <span
                    role="cell"
                    class="tabular tq-diff"
                    data-arm="Difference"
                    >{{ m.diff }}</span
                  >
                </div>
              }
            </div>
            <p class="tq-foot muted">
              {{ qa.treatment.prsOpened }} vs {{ qa.control.prsOpened }} pull
              requests opened · {{ qa.treatment.heldByQaGate }} held by the
              quality gate.
              @if (!costShown()) {
                Dollar cost was not measured for these runs, so usage is shown
                in tokens.
              }
            </p>
          }
        </article>

        <article
          class="ops-card tq-card"
          data-testid="card-qa-checks"
          aria-labelledby="tq-checks-title"
        >
          <div class="ops-card-head tq-head">
            <div class="tq-head-text">
              <h2 class="ops-card-title" id="tq-checks-title">Check health</h2>
              <p class="ops-card-sub">
                On {{ arm() }} pull requests a failing check blocks the PR. On
                control pull requests checks run in shadow: they never block and
                only record what would have happened.
              </p>
            </div>
            <a
              class="btn-tonal"
              routerLink="/processes/quality"
              data-testid="qa-rules-link"
            >
              Manage checks
            </a>
          </div>

          @if (qa.shadowRecall.controlTasksChecked > 0) {
            <p class="tq-lead tabular" data-testid="qa-shadow-summary">
              On control, shadow checks would have blocked
              {{ qa.shadowRecall.shadowWouldBlock }} of
              {{ qa.shadowRecall.controlTasksChecked }} tasks ({{
                pct(qa.shadowRecall.shadowCatchRate)
              }}).
              @if (matched(); as mr) {
                <span
                  class="tq-term"
                  tabindex="0"
                  gTip="Escapes whose file, line and problem class match a shadow finding, divided by all escapes on control."
                  >They matched
                  @if (mr.matched !== null) {
                    {{ mr.matched }} of
                    {{ qa.shadowRecall.controlBlindEscapes }}
                  }
                  escapes found later ({{ pct(mr.rate) }}).</span
                >
              } @else if (qa.shadowRecall.controlBlindEscapes > 0) {
                <span
                  class="tq-term"
                  tabindex="0"
                  gTip="Counts control tasks where a shadow check flagged something and an escape was also found. It is PR co-occurrence overlap, not matched findings."
                  >PR co-occurrence (not matched file:line findings):
                  {{ pct(qa.shadowRecall.pairedRecall) }}
                  of escapes.</span
                >
              }
            </p>
          }

          @if (qa.checks.length === 0) {
            <p class="tq-lead muted" data-testid="qa-checks-empty">
              No pre-PR quality check runs recorded in this window.
            </p>
          } @else {
            <ul
              class="tq-checks"
              aria-label="Health of each quality check"
              data-testid="qa-checks-table"
            >
              @for (c of qa.checks; track c.stage + ":" + c.ruleId) {
                <li class="tq-check" [attr.data-rule]="c.ruleId">
                  <div class="tq-check-top">
                    <strong class="tq-check-name">{{ c.ruleId }}</strong>
                    <span
                      class="muted tq-term"
                      tabindex="0"
                      [gTip]="'Stage ' + c.stage"
                      >{{ stage(c.stage) }}</span
                    >
                    @if (c.errorCount > 0) {
                      <span
                        class="status-pill error tabular"
                        data-testid="qa-check-errors"
                      >
                        <g-status-icon tone="error" kind="error" />
                        {{ c.errorCount }}
                        {{ c.errorCount === 1 ? "error" : "errors" }}
                      </span>
                    }
                  </div>
                  <dl class="tq-check-stats tabular">
                    <div>
                      <dt>Runs</dt>
                      <dd>
                        {{ c.enforcedRuns }} blocking ·
                        {{ c.shadowRuns }} shadow
                      </dd>
                    </div>
                    <div>
                      <dt>Flagged</dt>
                      <dd>
                        {{ c.failCount }} of
                        {{ c.enforcedRuns + c.shadowRuns }} ({{
                          pct(c.catchRate)
                        }})
                      </dd>
                    </div>
                    <div>
                      <dt>Findings</dt>
                      <dd>{{ c.findingsCount }}</dd>
                    </div>
                    <div>
                      <dt>
                        <span
                          class="tq-term"
                          tabindex="0"
                          [gTip]="precisionTip(c)"
                          >Precision</span
                        >
                      </dt>
                      <dd data-testid="qa-check-precision">
                        {{ precisionText(c) }}
                      </dd>
                    </div>
                    @if (c.helpfulVotes + c.notHelpfulVotes > 0) {
                      <div>
                        <dt>
                          <span
                            class="tq-term"
                            tabindex="0"
                            [gTip]="
                              'Operator votes on findings. Not-helpful share ' +
                              pct(c.notHelpfulRate) +
                              ', Wilson lower bound ' +
                              pct(c.notHelpfulWilsonLb) +
                              '.'
                            "
                            >Votes</span
                          >
                        </dt>
                        <dd>
                          {{ c.helpfulVotes }} helpful ·
                          {{ c.notHelpfulVotes }} not helpful
                        </dd>
                      </div>
                    }
                    <div>
                      <dt>
                        <span
                          class="tq-term"
                          tabindex="0"
                          gTip="Median / 95th percentile run time"
                          >Time</span
                        >
                      </dt>
                      <dd>
                        {{ ms(c.p50DurationMs) }} / {{ ms(c.p95DurationMs) }}
                      </dd>
                    </div>
                  </dl>
                </li>
              }
            </ul>
          }
        </article>
      }
    }
  `,
})
export class TelemetryQualityComponent {
  readonly summary = input<QASummary | null>(null);
  readonly error = input<string | null>(null);
  readonly deniedReason = input<string | null>(null);
  readonly windowId = input<string>("7d");
  readonly repo = input<string>("");
  readonly retry = output<void>();

  protected readonly pct = formatPct;
  protected readonly ms = formatCheckDurationMs;
  protected readonly stage = stageWords;

  protected readonly arm = computed(() => {
    const qa = this.summary();
    return qa ? armLabel(qa) : "Treatment";
  });

  protected readonly noAssignments = computed(() => {
    const qa = this.summary();
    return (
      !qa ||
      (qa.treatment?.assignedOrigins ?? 0) +
        (qa.control?.assignedOrigins ?? 0) ===
        0
    );
  });

  /** Off and nothing to read: one designed empty state. */
  protected readonly isOff = computed(() => {
    const qa = this.summary();
    return (
      !!qa && !qa.enabled && this.noAssignments() && qa.checks.length === 0
    );
  });

  protected readonly verdicts = computed(() => {
    const qa = this.summary();
    return qa ? armVerdicts(qa) : [];
  });

  protected readonly period = computed(() => {
    const e = experimentScope(this.summary());
    return e ? experimentPeriodLabel(e) : null;
  });

  protected readonly matched = computed(() => {
    const qa = this.summary();
    return qa ? matchedRecall(qa) : null;
  });

  protected readonly costShown = computed(() => {
    const qa = this.summary();
    return !!qa && costMeasured(qa);
  });

  protected readonly windowWords = computed(() => {
    switch (this.windowId()) {
      case "24h":
        return "24 hours";
      case "30d":
        return "30 days";
      default:
        return "7 days";
    }
  });

  protected readonly repoWords = computed(() =>
    this.repo() ? ` in ${this.repo()}` : " across all repositories",
  );

  protected readonly rollout = computed(() => {
    const qa = this.summary();
    if (!qa) return { tone: "neutral", kind: "idle", label: "Off", tip: "" };
    const tip = `Rollout: ${qa.rolloutPct}% of new work trees run with ${qa.flowId}${qa.shadowOnControl ? "; control runs the checks in shadow" : ""}.`;
    if (
      qa.circuitBreaker.shouldAutoDowngrade ||
      (qa.enabled && qa.rolloutPct === 0 && qa.regimeId > 1)
    ) {
      return {
        tone: "blast",
        kind: "warning",
        label: `0% shadow-only · ${qa.flowId}`,
        tip,
      };
    }
    if (qa.enabled) {
      return {
        tone: "healthy",
        kind: "running",
        label: `${qa.rolloutPct}% · ${qa.flowId}`,
        tip,
      };
    }
    return {
      tone: "neutral",
      kind: "idle",
      label: "Off",
      tip: "Rollout is off; results below are from work trees assigned before it was turned off.",
    };
  });

  protected readonly metrics = computed<MetricRow[]>(() => {
    const qa = this.summary();
    if (!qa) return [];
    const t = qa.treatment;
    const c = qa.control;
    const of = (n: number, d: number) =>
      `${formatPct(d ? n / d : Number.NaN)} (${n} of ${d})`;
    const rows: MetricRow[] = [
      {
        id: "escapes",
        label: "Work trees with an escape",
        tip: `An escape is a problem found after the PR opened, by blind review or a failed first-push CI run. Wilson 95% intervals: ${formatPct(t.blindEscapeCiLow)}–${formatPct(t.blindEscapeCiHigh)} vs ${formatPct(c.blindEscapeCiLow)}–${formatPct(c.blindEscapeCiHigh)}.`,
        treatment: of(t.blindEscapes, t.assignedOrigins),
        control: of(c.blindEscapes, c.assignedOrigins),
        diff: rateDiffWords(t.blindEscapeRate, c.blindEscapeRate),
      },
      {
        id: "first-push-ci",
        label: "First CI run green",
        tip: "Share of pull requests whose first CI run passed.",
        treatment: of(t.firstPushCiGreen, t.firstPushCiEvaluated),
        control: of(c.firstPushCiGreen, c.firstPushCiEvaluated),
        diff: rateDiffWords(t.firstPushCiGreenRate, c.firstPushCiGreenRate),
      },
      {
        id: "churn",
        label: "Fixed again within 7 days of merge",
        tip: "Merged pull requests that needed a follow-up repair within 7 days (post-merge churn).",
        treatment: of(t.postMergeChurn7d, t.prsMerged),
        control: of(c.postMergeChurn7d, c.prsMerged),
        diff: rateDiffWords(t.postMergeChurn7dRate, c.postMergeChurn7dRate),
      },
    ];
    const isCostZero = (qa as QASummary & { costMeasured?: boolean }).costMeasured === false;
    rows.push(
      this.timeRow(
        "time-to-pr",
        "Time to PR (median)",
        "Time to PR, per task",
        qa.overallTimeToPrSeconds,
      ),
      this.timeRow(
        "fast-lane",
        "Time to PR, small tasks",
        "Time to PR for low-risk tasks (guardrail)",
        qa.fastLaneTimeToPrSeconds,
      ),
      this.timeRow(
        "time-to-land",
        "Time to land a work tree",
        "Time from a work tree's first task to its last merge",
        qa.originTimeToLandSeconds,
      ),
      {
        id: "tokens",
        label: "Tokens per work tree",
        tip: cupedTip("Tokens per work tree", qa.tokensCuped, tokenWords) + (isCostZero ? " Token usage (provider does not report dollar billing)." : ""),
        treatment: qa.tokensCuped.treatN
          ? tokenWords(qa.tokensCuped.adjTreatMean)
          : "—",
        control: qa.tokensCuped.ctrlN
          ? tokenWords(qa.tokensCuped.adjCtrlMean)
          : "—",
        diff: relDiffWords(qa.tokensCuped, "more tokens", "fewer tokens"),
      },
    );
    if (costMeasured(qa)) {
      const usd = (v: number) => `$${v.toFixed(2)}`;
      rows.push({
        id: "cost",
        label: "Cost per work tree",
        tip: cupedTip("Measured cost per work tree", qa.costCuped, usd),
        treatment: qa.costCuped.treatN ? usd(qa.costCuped.adjTreatMean) : "—",
        control: qa.costCuped.ctrlN ? usd(qa.costCuped.adjCtrlMean) : "—",
        diff: relDiffWords(qa.costCuped, "higher cost", "lower cost"),
      });
    }
    rows.push(
      {
        id: "prompt",
        label: "Prompt added by quality guidance",
        tip: `Share of prompt bytes taken by the injected quality guidance, over ${t.promptsMeasured} measured prompts. Measured in bytes, not tokens.`,
        treatment: `${formatPct(t.qaSkillPromptByteShare)} of prompt bytes`,
        control: `${formatPct(c.qaSkillPromptByteShare)} of prompt bytes`,
        diff: rateDiffWords(t.qaSkillPromptByteShare, c.qaSkillPromptByteShare),
      },
      {
        id: "thread-cuts",
        label: "Conversations trimmed for length",
        tip: "Share of agent runs whose context was cut to fit the model window.",
        treatment: `${formatPct(t.threadCutShare)} (${t.threadCuts})`,
        control: `${formatPct(c.threadCutShare)} (${c.threadCuts})`,
        diff: rateDiffWords(t.threadCutShare, c.threadCutShare),
      },
    );
    return rows;
  });

  private timeRow(
    id: string,
    label: string,
    tipLabel: string,
    hl: QASummary["overallTimeToPrSeconds"],
  ): MetricRow {
    return {
      id,
      label,
      tip: timeTip(tipLabel, hl),
      treatment: hl?.treatN ? durWords(hl.treatMedian) : "—",
      control: hl?.ctrlN ? durWords(hl.ctrlMedian) : "—",
      diff: timeDiffWords(hl),
    };
  }

  protected precisionText(c: QACheckRuleSummary): string {
    const p = checkPrecision(c);
    if (p === null) return "not measured";
    const tp = (c as QACheckRuleSummary & { confirmedTruePositives?: number })
      .confirmedTruePositives;
    return typeof tp === "number"
      ? `${formatPct(p)} (${tp} confirmed)`
      : formatPct(p);
  }

  protected precisionTip(c: QACheckRuleSummary): string {
    return checkPrecision(c) === null
      ? "Share of flags confirmed as real problems. Not reported for this check yet, so a high flag count does not mean real problems were caught."
      : "Share of flags confirmed as real problems (by an operator vote or a substantive fix).";
  }
}
