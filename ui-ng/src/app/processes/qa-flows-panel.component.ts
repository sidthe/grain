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
  DestroyRef,
  ViewChild,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
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
import { DiffViewerComponent } from "../shared/diff-viewer.component";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import {
  BUILTIN_READABILITY_PACK_IDS,
  BUILTIN_READABILITY_PACKS,
  MAX_ACTIVE_PROMPT_BUDGET_BYTES,
  buildFallbackStagesView,
  evaluateInlineCheckFixtures,
  type ContextDiscoveryDecl,
  type CustomCheckDeclarationV3,
  type DecomposeDecl,
  type FixtureSelfTestResult,
  type FlowDeclarationV2,
  type FlowDeclarationV3,
  type FlowDeclarationV4,
  type PRContractDecl,
  type QADryRunResponse,
  type QAFlowVersionDetail,
  type QAFlowVersionItem,
  type QAFlowVersionsResponse,
  type ReadabilityPackDecl,
  type SkillStepDecl,
  type WorkflowStageView,
  type WorkflowStepView,
} from "./qa-flows.models";
import { QaV3StudioComponent } from "./qa-v3-studio.component";

export type StepKindFilter = "all" | "skills" | "gates" | "subagents";
export type InspectorTab = "definition" | "stats" | "yaml";

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
  styleUrls: ["./qa-flows-panel.css", "./qa-v3-studio.css"],
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="qa-flows-panel qa-v3-studio" data-testid="qa-flows-panel">
      <!-- Top Sub-Header Toolbar -->
      <header class="qa-studio-toolbar" data-testid="qa-studio-toolbar">
        <div class="qa-toolbar-left">
          <g-pill-select
            ariaLabel="Switch QA flow package"
            [options]="flowPackageOptions()"
            [value]="selectedHash() || ''"
            (valueChange)="selectVersion($event)"
          />
          @if (selectedDetail(); as detail) {
            <h2 class="qa-toolbar-title" data-testid="qa-flow-insp-title">
              {{ detail.label || detail.key }}
              <span class="s-mono">&#64;{{ detail.version }}</span>
            </h2>
            <span class="severity-pill">{{ schemaLabel(detail) }}</span>
            @if (qaEnabled() && activeFlowId() === detail.key) {
              <span class="badge active-badge"
                >Active ({{ activeRolloutPct() }}%)</span
              >
            } @else {
              <span class="badge active-badge">Available</span>
            }
            @if (detail.builtIn) {
              <span class="badge builtin-badge">Built-in</span>
            } @else {
              <span class="badge custom-badge">Custom</span>
            }
            @if (detail.sourceKind === "adopt" && detail.sourceRepo) {
              <span class="s-mono severity-pill"
                >{{ detail.sourceRepo }}&#64;{{
                  (detail.sourceCommit || "").slice(0, 7)
                }}</span
              >
            }
            @if (detail.retiredAt) {
              <span class="badge retired-badge">Retired</span>
            }
          }
        </div>

        <div class="qa-toolbar-right">
          <div
            class="qa-prompt-budget"
            data-testid="qa-prompt-budget"
            title="Active coding skill + readability packs + skill steps + PR contract vs 8.0 kB prompt cap"
          >
            <span class="s-label">Prompt budget</span>
            <div class="qa-budget-track" aria-hidden="true">
              <div
                class="qa-budget-fill"
                [class.warn]="promptBudgetPct() >= 80 && !skillByteOverflow()"
                [class.over]="skillByteOverflow()"
                [style.width.%]="promptBudgetPct()"
              ></div>
            </div>
            <span class="s-mono s-num">
              {{ formatBytesKb(activePromptBytes()) }} / 8.0 kB
            </span>
            <span
              class="byte-counter s-mono s-num"
              [class.error]="skillByteOverflow()"
              >({{ draftSkillBytes() }} B)</span
            >
          </div>

          <button
            type="button"
            class="btn-tonal"
            data-testid="qa-v3-open-probe"
            (click)="openProbeDrawer()"
          >
            What-if probe
          </button>
          <button
            type="button"
            class="btn-tonal"
            data-testid="qa-toolbar-dry-run"
            (click)="isEditing() ? dryRunDraft() : dryRun()"
          >
            Dry run
          </button>
          <button
            type="button"
            class="btn-tonal"
            data-testid="qa-v3-open-adopt"
            (click)="openAdoptModal()"
          >
            Adopt from commit
          </button>
          @if (canAdmin() && selectedDetail(); as detail) {
            <button
              type="button"
              class="btn-tonal"
              data-testid="qa-fork-flow-btn"
              (click)="forkFlow()"
            >
              Fork flow
            </button>
            <button
              type="button"
              class="btn-tonal"
              data-testid="qa-new-version-btn"
              (click)="newVersion()"
            >
              New version
            </button>
            <a
              class="btn-tonal"
              [routerLink]="['/telemetry']"
              [queryParams]="{
                tab: 'quality',
                createExp: '1',
                flow: detail.hash,
              }"
              >Test in experiment</a
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
          <a
            class="btn-text"
            routerLink="/settings/tasks"
            data-testid="qa-configure-rollout-link"
            >Settings → Tasks</a
          >
        </div>
      </header>

      <!-- Package Selector Pill Strip (preserves quality-flows-list & qa-flow-row-* testids) -->
      <div
        class="qa-pkg-strip"
        data-testid="quality-flows-list"
        role="navigation"
        aria-label="Quality flow versions"
      >
        @for (group of groupedVersions(); track group.key) {
          @for (v of group.versions; track v.hash) {
            <button
              type="button"
              class="qa-pkg-btn"
              [attr.data-testid]="
                v.hash === group.latestActiveHash
                  ? 'qa-flow-row-' + group.key
                  : null
              "
              [class.selected]="v.hash === selectedHash()"
              [attr.aria-current]="v.hash === selectedHash() ? 'true' : null"
              (click)="onSelectVersionFromList(v)"
            >
              <span class="s-mono">{{ v.key }}&#64;{{ v.version }}</span>
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
            </button>
          }
        }
      </div>

      <!-- Dirty Authoring Bar (Draft Edit Mode) -->
      @if (isEditing()) {
        <div class="qa-dirty-bar" data-testid="qa-dirty-bar">
          <div>
            <strong>{{
              isFork() ? "Drafting forked flow:" : "Drafting new version:"
            }}</strong>
            <span class="s-mono"> {{ draftDeclaration().key }}</span>
            <span class="severity-pill">{{ draftDeclaration().schema }}</span>
          </div>
          <div class="qa-dirty-actions">
            <button
              type="button"
              class="btn-text"
              data-testid="qa-compare-parent-btn"
              (click)="toggleParentDiff()"
            >
              {{
                showParentDiff() ? "Hide parent diff" : "Compare with parent"
              }}
            </button>
            <button
              type="button"
              class="btn-text"
              data-testid="qa-cancel-edit-btn"
              (click)="cancelEdit()"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn-tonal"
              data-testid="qa-verify-dry-run-btn"
              (click)="dryRunDraft()"
            >
              Verify &amp; dry-run
            </button>
            <button
              type="button"
              class="btn-primary"
              data-testid="qa-publish-version-btn"
              [disabled]="skillByteOverflow()"
              (click)="confirmPublish()"
            >
              Publish version
            </button>
          </div>
        </div>
      }

      <!-- Cohesive 30/70 Studio Workbench -->
      <div
        class="qa-studio-workbench"
        [class.mobile-inspector-open]="mobileInspectorOpen()"
      >
        <!-- Left 30% Stage & Step Tree -->
        <aside
          class="qa-stage-tree"
          data-testid="qa-stage-tree"
          aria-label="8-Stage Software Lifecycle Tree"
        >
          <div class="qa-tree-controls">
            <form
              class="qa-search-form"
              role="search"
              autocomplete="off"
              (submit)="$event.preventDefault()"
            >
              <input
                type="search"
                data-testid="qa-step-search"
                placeholder="Filter stages, skills, packs, or checks…"
                aria-label="Filter stages, skills, packs, or checks"
                [value]="searchQuery()"
                (input)="onSearchInput($event)"
              />
            </form>
            <div
              class="qa-kind-chips"
              role="group"
              aria-label="Filter by step kind"
            >
              @for (chip of kindChips; track chip.id) {
                <button
                  type="button"
                  class="qa-kind-chip"
                  [class.active]="kindFilter() === chip.id"
                  [attr.data-testid]="'qa-kind-chip-' + chip.id"
                  (click)="kindFilter.set(chip.id)"
                >
                  {{ chip.label }}
                </button>
              }
            </div>
          </div>

          <div class="qa-tree-scroll">
            @for (stage of filteredStages(); track stage.id) {
              <div
                class="qa-stage-group"
                [attr.data-testid]="'qa-stage-group-' + stage.id"
              >
                <button
                  type="button"
                  class="qa-stage-btn"
                  [class.selected]="
                    selectedNodeKind() === 'stage' &&
                    selectedStageId() === stage.id
                  "
                  [attr.data-testid]="'qa-stage-header-' + stage.id"
                  [attr.aria-expanded]="!isStageCollapsed(stage.id)"
                  (click)="selectStage(stage.id)"
                >
                  <span class="qa-stage-title">
                    {{ isStageCollapsed(stage.id) ? "▸" : "▾" }}
                    {{ stage.label }}
                  </span>
                  <span class="qa-step-pills">
                    <span class="severity-pill">{{ stage.mode }}</span>
                    <span class="s-mono s-num">{{ stage.steps.length }}</span>
                  </span>
                </button>

                @if (!isStageCollapsed(stage.id)) {
                  <div class="qa-stage-children">
                    @for (step of stage.steps; track step.id) {
                      <button
                        type="button"
                        class="qa-step-node"
                        [class.selected]="
                          selectedNodeKind() === 'step' &&
                          selectedStepId() === step.id
                        "
                        [attr.data-testid]="'qa-tree-step-' + step.id"
                        (click)="selectStep(stage.id, step)"
                      >
                        <div class="qa-step-main">
                          <span class="qa-step-name">{{ step.label }}</span>
                          <span class="qa-step-sub s-mono">{{ step.id }}</span>
                        </div>
                        <div class="qa-step-pills">
                          @if (step.lockedFloor) {
                            <span class="badge floor-badge">floor</span>
                          }
                          @if (step.mode) {
                            <span class="severity-pill">{{ step.mode }}</span>
                          }
                          @if (!step.enabled) {
                            <span class="severity-pill">off</span>
                          }
                        </div>
                      </button>
                    }
                    @if (isEditing()) {
                      <button
                        type="button"
                        class="btn-text s-mono"
                        [attr.data-testid]="'qa-stage-add-step-' + stage.id"
                        (click)="addStepToStage(stage.id)"
                      >
                        + Add step
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </div>
        </aside>

        <!-- Right 70% Full-Width Stage / Step Inspector & Live Editor -->
        <section
          class="qa-step-inspector"
          data-testid="qa-step-inspector"
          aria-label="Stage and Step Inspector"
        >
          <button
            type="button"
            class="btn-text qa-mobile-back"
            data-testid="qa-mobile-back"
            (click)="closeMobileInspector()"
          >
            ← Back to stages &amp; flows
          </button>

          @if (selectedDetail(); as detail) {
            <div data-testid="qa-flow-detail-card">
              @if (showParentDiff()) {
                <div class="qa-insp-card">
                  <div class="qa-insp-header">
                    <h3>Parent Flow Skill Diff</h3>
                    <button
                      type="button"
                      class="btn-text"
                      (click)="toggleParentDiff()"
                    >
                      Close diff
                    </button>
                  </div>
                  <g-diff-viewer [files]="diffFiles()" />
                </div>
              }

              @if (dryRunResult(); as dr) {
                <div class="dry-run-results" data-testid="qa-dry-run-banner">
                  <h3>Dry Run Results</h3>
                  <div>
                    Sampled PRs: <span class="s-num">{{ dr.sampledPRs }}</span>
                    | Would block PRs:
                    <span class="s-num">{{ dr.wouldBlockPRs }}</span>
                    | Hash: <span class="s-mono">{{ dr.hash }}</span>
                  </div>
                  @if (dr.byCheck && dr.byCheck.length > 0) {
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
                  }
                </div>
              }

              <!-- STAGE CONTRACT INSPECTOR -->
              @if (selectedNodeKind() === "stage" && activeStage(); as stage) {
                <div class="qa-insp-card" data-testid="qa-stage-contract-card">
                  <div class="qa-insp-header">
                    <div>
                      <span class="s-label"
                        >Stage {{ stage.index }} of 8 ·
                        {{ stage.boundary }}</span
                      >
                      <h3>{{ stage.label }}</h3>
                      <p>{{ stage.summary }}</p>
                    </div>
                    <div class="qa-step-pills">
                      <span class="s-mono severity-pill">{{ stage.id }}</span>
                      <span class="severity-pill">{{ stage.mode }}</span>
                      <span class="badge active-badge">{{
                        stage.enabled ? "Enabled" : "Disabled"
                      }}</span>
                    </div>
                  </div>

                  <div class="qa-meta-grid">
                    <div class="qa-meta-cell">
                      <span class="s-label">Execution Boundary</span>
                      <strong>{{ stage.boundary }}</strong>
                    </div>
                    <div class="qa-meta-cell">
                      <span class="s-label">Complexity &amp; Blast Tiers</span>
                      <strong class="s-mono">{{
                        stageTriggerSummary(stage)
                      }}</strong>
                    </div>
                    <div class="qa-meta-cell">
                      <span class="s-label">Timeout &amp; Token Budget</span>
                      <strong class="s-mono s-num">{{
                        stageBudgetSummary(stage)
                      }}</strong>
                    </div>
                    <div class="qa-meta-cell">
                      <span class="s-label">Orthogonal Verifier (S4)</span>
                      <strong class="s-mono">{{
                        verifierSummaryText(detail)
                      }}</strong>
                    </div>
                  </div>

                  @if (isEditing()) {
                    <div class="editor-section" data-testid="qa-stage-editor">
                      <h3>Draft Flow &amp; Stage Controls</h3>
                      <div class="qa-form-grid">
                        <label>
                          Flow Key
                          <input
                            id="qa-flow-key-input"
                            type="text"
                            class="s-mono"
                            [value]="draftDeclaration().key"
                            [disabled]="!isFork()"
                            (input)="updateDraft('key', $event)"
                          />
                        </label>
                        <label>
                          Extends
                          <input
                            id="qa-flow-ext-input"
                            type="text"
                            class="s-mono"
                            [value]="draftDeclaration().extends || ''"
                            (input)="updateDraft('extends', $event)"
                          />
                        </label>
                        <label>
                          Label
                          <input
                            id="qa-flow-lbl-input"
                            type="text"
                            [value]="draftDeclaration().label"
                            (input)="updateDraft('label', $event)"
                          />
                        </label>
                        <label>
                          Schema Version
                          <select
                            data-testid="qa-draft-schema-select"
                            [value]="draftDeclaration().schema"
                            (change)="
                              updateDraftSchema($any($event.target).value)
                            "
                          >
                            <option value="grain.dev/qa-flow/v4">
                              grain.dev/qa-flow/v4 (8-Stage Studio)
                            </option>
                            <option value="grain.dev/qa-flow/v3">
                              grain.dev/qa-flow/v3
                            </option>
                            <option value="grain.dev/qa-flow/v2">
                              grain.dev/qa-flow/v2
                            </option>
                          </select>
                        </label>
                      </div>

                      <div class="qa-form-grid">
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            [checked]="draftV4().decompose?.enabled ?? false"
                            (change)="
                              toggleDraftDecompose($any($event.target).checked)
                            "
                          />
                          Stage 1 Subtask Decomposition ({{
                            draftV4().decompose?.mode || "slice_plan"
                          }})
                        </label>
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            [checked]="draftV4().context?.enabled ?? false"
                            (change)="
                              toggleDraftContext($any($event.target).checked)
                            "
                          />
                          Stage 2 Caller &amp; Memory Context Discovery
                        </label>
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            [checked]="draftDeclaration().stopNudge"
                            (change)="toggleDraftBool('stopNudge')"
                          />
                          Stage 6 Pre-PR Stop Nudge
                        </label>
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            [checked]="draftDeclaration().stagingIsolation"
                            (change)="toggleDraftBool('stagingIsolation')"
                          />
                          Stage 5 Staging Ref Isolation
                        </label>
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            [checked]="draftDeclaration().verifier.enabled"
                            (change)="toggleVerifierEnabled()"
                          />
                          Stage 7 Orthogonal S4 Verifier
                        </label>
                      </div>

                      <div class="qa-insp-header">
                        <h4>Stage 4 Coding Contract &amp; Skill Steps</h4>
                        <div class="qa-step-pills">
                          <button
                            type="button"
                            class="btn-tonal"
                            data-testid="qa-add-skill-step-btn"
                            (click)="addSkillStep('coding')"
                          >
                            + Add skill step
                          </button>
                          <button
                            type="button"
                            class="btn-tonal"
                            data-testid="qa-add-custom-check-btn"
                            (click)="addCustomCheck()"
                          >
                            + Add custom check
                          </button>
                        </div>
                      </div>
                      <textarea
                        rows="5"
                        class="s-mono"
                        aria-label="Coding skill text"
                        [value]="draftDeclaration().skill.text"
                        (input)="updateDraft('skill.text', $event)"
                      ></textarea>
                    </div>
                  }

                  <div class="qa-insp-header">
                    <h4>Ordered Steps in {{ stage.label }}</h4>
                    <span class="s-mono s-num"
                      >{{ stage.steps.length }} step(s)</span
                    >
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Step</th>
                        <th>Kind</th>
                        <th>Mode / Severity</th>
                        <th>Scope / Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (st of stage.steps; track st.id) {
                        <tr
                          [attr.data-testid]="'qa-stage-step-row-' + st.id"
                          (click)="selectStep(stage.id, st)"
                          style="cursor: pointer"
                        >
                          <td>
                            <strong>{{ st.label }}</strong
                            ><br />
                            <span class="s-mono">{{ st.id }}</span>
                          </td>
                          <td class="s-mono">{{ st.kind }}</td>
                          <td>
                            <span class="severity-pill">{{
                              st.mode || (st.enabled ? "active" : "off")
                            }}</span>
                            @if (st.lockedFloor) {
                              <span class="badge floor-badge">Floor</span>
                            }
                          </td>
                          <td>{{ st.summary || st.scope || "—" }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>

                  <div class="qa-insp-header">
                    <h4>Resolved Flow Gates &amp; Checks</h4>
                  </div>
                  <table>
                    <tbody>
                      @for (
                        rule of detail.resolved?.rules || [];
                        track rule.id
                      ) {
                        <tr
                          [attr.data-testid]="'qa-rule-card-' + rule.id"
                          (click)="selectRuleFromTable(rule.id)"
                          style="cursor: pointer"
                        >
                          <td class="s-mono">{{ rule.id }}</td>
                          <td>
                            <span class="severity-pill">{{
                              rule.severity
                            }}</span>
                          </td>
                          <td>{{ rule.summary }}</td>
                          @if (isFloorCheck(rule.id)) {
                            <td>
                              <span class="badge floor-badge">Floor</span>
                            </td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }

              <!-- STEP / PACK / CONTRACT / CHECK INSPECTOR -->
              @if (selectedNodeKind() === "step" && activeStep(); as step) {
                <div class="qa-insp-card" data-testid="qa-step-detail-card">
                  <div class="qa-insp-header">
                    <div>
                      <button
                        type="button"
                        class="btn-text s-mono"
                        (click)="selectStage(step.stageId)"
                      >
                        ← Back to stage ({{ step.stageId }})
                      </button>
                      <h3>{{ step.label }}</h3>
                      <span class="s-mono">{{ step.id }}</span>
                    </div>
                    <div class="qa-step-pills">
                      <span class="s-mono severity-pill">{{ step.kind }}</span>
                      @if (step.mode) {
                        <span class="severity-pill">{{ step.mode }}</span>
                      }
                      @if (step.lockedFloor) {
                        <span class="badge floor-badge">Floor (Locked)</span>
                      }
                      @if (step.bytes) {
                        <span class="s-mono s-num">{{ step.bytes }} B</span>
                      }
                    </div>
                  </div>

                  <!-- Inspector Tabs -->
                  <div
                    class="qa-insp-tabs"
                    role="tablist"
                    aria-label="Step inspector tabs"
                  >
                    <button
                      type="button"
                      role="tab"
                      class="qa-insp-tab"
                      data-testid="qa-tab-definition"
                      [class.active]="inspectorTab() === 'definition'"
                      [attr.aria-selected]="inspectorTab() === 'definition'"
                      (click)="inspectorTab.set('definition')"
                    >
                      Definition &amp; fixtures
                    </button>
                    <button
                      type="button"
                      role="tab"
                      class="qa-insp-tab"
                      data-testid="qa-tab-stats"
                      [class.active]="inspectorTab() === 'stats'"
                      [attr.aria-selected]="inspectorTab() === 'stats'"
                      (click)="inspectorTab.set('stats')"
                    >
                      Empirical stats &amp; dry-run
                    </button>
                    <button
                      type="button"
                      role="tab"
                      class="qa-insp-tab"
                      data-testid="qa-tab-yaml"
                      [class.active]="inspectorTab() === 'yaml'"
                      [attr.aria-selected]="inspectorTab() === 'yaml'"
                      (click)="inspectorTab.set('yaml')"
                    >
                      Lineage &amp; YAML
                    </button>
                  </div>

                  @if (inspectorTab() === "definition") {
                    <p>{{ step.summary }}</p>

                    <!-- READABILITY PACK INSPECTOR / EDITOR -->
                    @if (step.kind === "readability_pack") {
                      <div
                        class="editor-section"
                        data-testid="qa-readability-pack-inspector"
                      >
                        <div class="qa-meta-grid">
                          <div class="qa-meta-cell">
                            <span class="s-label">Language Pack</span>
                            <strong class="s-mono">{{
                              packIdFromStep(step)
                            }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Activation</span>
                            <strong class="s-mono">{{
                              step.mode || "auto"
                            }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Path Globs</span>
                            <strong class="s-mono">{{
                              step.scope || "auto-detected by extension"
                            }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Guidance Size</span>
                            <strong class="s-mono s-num"
                              >{{
                                step.bytes || byteCount(step.text || "")
                              }}
                              bytes</strong
                            >
                          </div>
                        </div>

                        @if (isEditing()) {
                          <div class="qa-form-grid">
                            <label class="checkbox-label">
                              <input
                                type="checkbox"
                                [attr.data-testid]="
                                  'qa-pack-enabled-' + packIdFromStep(step)
                                "
                                [checked]="
                                  getDraftPack(packIdFromStep(step)).enabled
                                "
                                (change)="
                                  updateDraftPackEnabled(
                                    packIdFromStep(step),
                                    $any($event.target).checked
                                  )
                                "
                              />
                              Enable {{ step.label }}
                            </label>
                            <label>
                              Activation Mode
                              <select
                                [attr.data-testid]="
                                  'qa-pack-activation-' + packIdFromStep(step)
                                "
                                [value]="
                                  getDraftPack(packIdFromStep(step))
                                    .activation || 'auto'
                                "
                                (change)="
                                  updateDraftPackActivation(
                                    packIdFromStep(step),
                                    $any($event.target).value
                                  )
                                "
                              >
                                <option value="auto">
                                  auto (match language extensions)
                                </option>
                                <option value="always">always</option>
                                <option value="glob">glob</option>
                              </select>
                            </label>
                            <label>
                              Path Globs (comma-separated)
                              <input
                                type="text"
                                class="s-mono"
                                [attr.data-testid]="
                                  'qa-pack-globs-' + packIdFromStep(step)
                                "
                                [value]="
                                  (
                                    getDraftPack(packIdFromStep(step)).globs ||
                                    []
                                  ).join(', ')
                                "
                                (input)="
                                  updateDraftPackGlobs(
                                    packIdFromStep(step),
                                    $any($event.target).value
                                  )
                                "
                              />
                            </label>
                          </div>
                          <label>
                            Custom Pack Rules Override / Appendix
                            <textarea
                              rows="4"
                              class="s-mono"
                              [attr.data-testid]="
                                'qa-pack-custom-text-' + packIdFromStep(step)
                              "
                              [value]="
                                getDraftPack(packIdFromStep(step)).customText ||
                                ''
                              "
                              (input)="
                                updateDraftPackCustomText(
                                  packIdFromStep(step),
                                  $any($event.target).value
                                )
                              "
                            ></textarea>
                          </label>
                        }

                        <h4>Readability Rules Markdown</h4>
                        <div
                          class="qa-markdown-well s-mono"
                          data-testid="qa-pack-markdown"
                        >
                          {{ step.text }}
                        </div>
                      </div>
                    }

                    <!-- PR CONTRACT INSPECTOR / EDITOR -->
                    @if (step.kind === "pr_contract") {
                      <div
                        class="editor-section"
                        data-testid="qa-pr-contract-inspector"
                      >
                        <div class="qa-meta-grid">
                          <div class="qa-meta-cell">
                            <span class="s-label">Enforcement Mode</span>
                            <strong class="s-mono">{{
                              step.mode || "warn"
                            }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Required PR Sections</span>
                            <strong class="s-mono">{{
                              step.scope || "Summary, Verification"
                            }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Max Subject Length</span>
                            <strong class="s-mono s-num"
                              >{{
                                draftV4().prContract?.maxSubjectChars || 72
                              }}
                              chars</strong
                            >
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Lint Suppression Audit</span>
                            <strong class="s-mono">{{
                              (draftV4().prContract?.auditLintSuppressions ??
                              true)
                                ? "enforced"
                                : "off"
                            }}</strong>
                          </div>
                        </div>

                        @if (isEditing()) {
                          <div class="qa-form-grid">
                            <label>
                              Required Sections (comma-separated)
                              <input
                                type="text"
                                class="s-mono"
                                data-testid="qa-pr-required-sections"
                                [value]="
                                  (
                                    draftV4().prContract?.requiredSections || [
                                      'Summary',
                                      'Verification',
                                    ]
                                  ).join(', ')
                                "
                                (input)="
                                  updatePRRequiredSections(
                                    $any($event.target).value
                                  )
                                "
                              />
                            </label>
                            <label>
                              Contract Mode
                              <select
                                [value]="draftV4().prContract?.mode || 'warn'"
                                (change)="
                                  updatePRContractMode(
                                    $any($event.target).value
                                  )
                                "
                              >
                                <option value="warn">warn</option>
                                <option value="blocking">blocking</option>
                                <option value="off">off</option>
                              </select>
                            </label>
                          </div>
                        }

                        @if (step.text) {
                          <h4>PR Authoring Guidance</h4>
                          <div class="qa-markdown-well s-mono">
                            {{ step.text }}
                          </div>
                        }
                      </div>
                    }

                    <!-- SKILL / SKILL STEP INSPECTOR -->
                    @if (step.kind === "skill" || step.kind === "skill_step") {
                      <div class="editor-section">
                        @if (isEditing()) {
                          <div class="qa-insp-header">
                            <h4>Edit Skill Markdown</h4>
                            <button
                              type="button"
                              class="btn-tonal"
                              data-testid="qa-add-skill-step-btn"
                              (click)="addSkillStep('coding')"
                            >
                              + Add skill step
                            </button>
                          </div>
                          @if (step.id === "coding:base-skill") {
                            <textarea
                              rows="8"
                              class="s-mono"
                              [value]="draftDeclaration().skill.text"
                              (input)="updateDraft('skill.text', $event)"
                            ></textarea>
                          } @else {
                            <textarea
                              rows="6"
                              class="s-mono"
                              [value]="step.text || ''"
                              (input)="
                                updateSkillStepText(
                                  step.id,
                                  $any($event.target).value
                                )
                              "
                            ></textarea>
                          }
                        } @else {
                          <div
                            class="qa-markdown-well s-mono"
                            role="region"
                            aria-label="Coding skill markdown"
                          >
                            {{ step.text || readonlySkillText(detail) }}
                          </div>
                        }
                      </div>
                    }

                    <!-- GATE / CHECK INSPECTOR + INLINE FIXTURE SELF-TEST RUNNER -->
                    @if (
                      step.kind === "deterministic_check" ||
                      step.kind.startsWith("custom_check")
                    ) {
                      <div
                        class="editor-section"
                        data-testid="qa-check-inspector"
                      >
                        <div class="qa-meta-grid">
                          <div class="qa-meta-cell">
                            <span class="s-label">Rule ID</span>
                            <strong class="s-mono">{{ step.id }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Engine Kind</span>
                            <strong class="s-mono">{{ step.kind }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Severity</span>
                            <strong class="s-mono">{{
                              step.mode || "blocking"
                            }}</strong>
                          </div>
                          <div class="qa-meta-cell">
                            <span class="s-label">Target Scope</span>
                            <strong class="s-mono">{{
                              step.scope || "**/*"
                            }}</strong>
                          </div>
                        </div>

                        @if (isEditing() && !step.lockedFloor) {
                          <div class="qa-form-grid">
                            <label class="checkbox-label">
                              <input
                                type="checkbox"
                                [checked]="isDraftCheckEnabled(step)"
                                (change)="toggleCheckEnabled(step.id)"
                              />
                              Enabled
                            </label>
                            <label>
                              Severity
                              <select
                                [value]="draftCheckSeverity(step)"
                                (change)="
                                  updateCheckSeverity(
                                    step.id,
                                    $any($event.target).value
                                  )
                                "
                              >
                                <option value="blocking">blocking</option>
                                <option value="warn">warn</option>
                                <option value="shadow">shadow</option>
                              </select>
                            </label>
                          </div>
                        }

                        <!-- 1-Click Inline Fixture Self-Test Runner -->
                        <div
                          class="qa-insp-card"
                          data-testid="qa-fixture-runner-card"
                        >
                          <div class="qa-insp-header">
                            <div>
                              <h4>Inline Fixture Self-Test Runner</h4>
                              <p>
                                Verifies that the Fail trap fixture triggers a
                                finding and the Clean pass fixture exits green.
                              </p>
                            </div>
                            <button
                              type="button"
                              class="btn-primary"
                              data-testid="qa-run-fixtures-btn"
                              (click)="runInlineFixturesForStep(step)"
                            >
                              Run inline fixture self-test
                            </button>
                          </div>

                          @if (activeStepFixtures(step); as checkWithFixtures) {
                            <div class="qa-meta-grid">
                              <div
                                class="qa-meta-cell"
                                data-testid="qa-fail-trap-box"
                              >
                                <span class="s-label">Fail trap fixture</span>
                                <strong class="s-mono">{{
                                  formatFixturePreview(
                                    checkWithFixtures,
                                    "fail"
                                  )
                                }}</strong>
                              </div>
                              <div
                                class="qa-meta-cell"
                                data-testid="qa-clean-pass-box"
                              >
                                <span class="s-label">Clean pass fixture</span>
                                <strong class="s-mono">{{
                                  formatFixturePreview(
                                    checkWithFixtures,
                                    "pass"
                                  )
                                }}</strong>
                              </div>
                            </div>
                          }

                          @if (fixtureResultForStep(step.id); as res) {
                            <div
                              class="dry-run-results"
                              data-testid="qa-fixture-test-result"
                            >
                              <strong class="s-mono">
                                {{
                                  res.valid
                                    ? "PASS · Fail trap caught & Clean pass green"
                                    : "FAIL · Fixture mismatch"
                                }}
                              </strong>
                              <p>{{ res.summary }}</p>
                            </div>
                          }
                        </div>
                      </div>
                    }
                  }

                  @if (inspectorTab() === "stats") {
                    <div class="editor-section" data-testid="qa-stats-panel">
                      <div class="qa-meta-grid">
                        <div class="qa-meta-cell">
                          <span class="s-label">Sampled PRs</span>
                          <strong class="s-mono s-num">{{
                            dryRunResult()?.sampledPRs ?? 20
                          }}</strong>
                        </div>
                        <div class="qa-meta-cell">
                          <span class="s-label">Would Block</span>
                          <strong class="s-mono s-num">{{
                            stepWouldBlockCount(step.id)
                          }}</strong>
                        </div>
                        <div class="qa-meta-cell">
                          <span class="s-label">Warn Count</span>
                          <strong class="s-mono s-num">{{
                            stepWarnCount(step.id)
                          }}</strong>
                        </div>
                      </div>
                      <button
                        type="button"
                        class="btn-tonal"
                        (click)="isEditing() ? dryRunDraft() : dryRun()"
                      >
                        Run historical dry-run (20 PRs)
                      </button>
                    </div>
                  }

                  @if (inspectorTab() === "yaml") {
                    <div class="editor-section" data-testid="qa-yaml-panel">
                      <div class="qa-insp-header">
                        <h4>Flow Lineage &amp; Source YAML</h4>
                        <button
                          type="button"
                          class="btn-tonal"
                          data-testid="qa-yaml-compare-btn"
                          (click)="toggleParentDiff()"
                        >
                          Compare with parent
                        </button>
                      </div>
                      @if (detail.lineage && detail.lineage.length > 0) {
                        <ul>
                          @for (lin of detail.lineage; track lin.hash) {
                            <li class="s-mono">
                              {{ lin.key }}&#64;{{ lin.version }} ({{
                                lin.hash
                              }})
                            </li>
                          }
                        </ul>
                      }
                      <div
                        class="qa-markdown-well s-mono"
                        data-testid="qa-yaml-preview"
                      >
                        {{ detail.sourceYaml || formatDeclarationYaml(detail) }}
                      </div>
                    </div>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="qa-insp-card">
              Select a flow version from the toolbar to inspect its 8-stage
              lifecycle.
            </div>
          }
        </section>
      </div>
    </div>

    <!-- Shared V3/V4 Probe Drawer & Adopt Modal -->
    <g-qa-v3-studio
      #v3Studio
      [dialogsOnly]="true"
      [decl]="activeStudioDecl()"
      (adopted)="loadVersions()"
    />

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
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  @ViewChild("v3Studio") v3Studio?: QaV3StudioComponent;

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
  mobileInspectorOpen = signal(false);

  // 30/70 Tree & Inspector state
  searchQuery = signal("");
  kindFilter = signal<StepKindFilter>("all");
  collapsedStages = signal<ReadonlySet<string>>(new Set());
  selectedNodeKind = signal<"stage" | "step">("stage");
  selectedStageId = signal<string>("s0-decompose");
  selectedStepId = signal<string | null>(null);
  inspectorTab = signal<InspectorTab>("definition");
  fixtureResults = signal<Readonly<Record<string, FixtureSelfTestResult>>>({});

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

  draftV4 = signal<FlowDeclarationV4>({
    schema: "grain.dev/qa-flow/v4",
    key: "engineering-workflow-v4",
    extends: "golden-v3@1",
    label: "engineering workflow v4",
    decompose: {
      enabled: true,
      mode: "slice_plan",
      complexities: ["high"],
      maxSubtasks: 5,
      targetDiffLines: 400,
    },
    context: {
      enabled: true,
      includeCallers: true,
      includeMemory: true,
      maxTokens: 12000,
      extraPaths: ["pkg/**", "ui-ng/src/**"],
    },
    readabilityPacks: BUILTIN_READABILITY_PACK_IDS.map((id) => ({
      id,
      enabled: true,
      activation: "auto",
      globs: BUILTIN_READABILITY_PACKS[id]?.globs ?? [],
    })),
    skillSteps: [],
    prContract: {
      enabled: true,
      mode: "warn",
      maxSubjectChars: 72,
      requiredSections: ["Summary", "Verification"],
      auditLintSuppressions: true,
    },
    stages: {
      "s0-intent": { enabled: true },
      "s2-plan-critic": { enabled: true },
      "s5-merge-triage": { mode: "shadow" },
      custom: [],
    },
    "custom-checks": [],
  });

  draftChecks = signal<
    Record<
      string,
      { enabled: boolean; severity: string; params?: Record<string, unknown> }
    >
  >({});
  draftCheckParams = signal<Record<string, Record<string, unknown>>>({});

  readonly kindChips: ReadonlyArray<{
    readonly id: StepKindFilter;
    readonly label: string;
  }> = [
    { id: "all", label: "All" },
    { id: "skills", label: "Skills & Packs" },
    { id: "gates", label: "Gates & Checks" },
    { id: "subagents", label: "Sub-agents" },
  ];

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

  draftSkillBytes = computed(() => {
    if (this.isEditing()) {
      return this.byteCount(this.draftDeclaration().skill?.text || "");
    }
    const detail = this.selectedDetail();
    return detail ? this.readonlySkillBytes(detail) : 0;
  });

  activePromptBytes = computed(() => {
    const stages = this.activeStagesView();
    let total = 0;
    for (const stg of stages) {
      for (const st of stg.steps) {
        if (!st.enabled) continue;
        if (
          st.kind === "skill" ||
          st.kind === "readability_pack" ||
          st.kind === "skill_step" ||
          st.kind === "pr_contract"
        ) {
          total += st.bytes ?? this.byteCount(st.text || "");
        }
      }
    }
    return total || this.draftSkillBytes();
  });

  promptBudgetPct = computed(() =>
    Math.min(
      100,
      Math.round(
        (this.activePromptBytes() / MAX_ACTIVE_PROMPT_BUDGET_BYTES) * 100,
      ),
    ),
  );

  skillByteOverflow = computed(() => {
    if (this.isEditing()) {
      const cap = this.draftDeclaration().skill?.maxBytes || 1800;
      if (this.draftSkillBytes() > cap) return true;
    }
    return this.activePromptBytes() > MAX_ACTIVE_PROMPT_BUDGET_BYTES;
  });

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

  flowPackageOptions = computed<PillOption[]>(() => {
    const list = this.versions();
    return list.map((v) => ({
      value: v.hash,
      label: `${v.key}@${v.version}`,
    }));
  });

  activeStagesView = computed<WorkflowStageView[]>(() => {
    const detail = this.selectedDetail();
    if (this.isEditing()) {
      return buildFallbackStagesView({
        ...(detail ?? {
          hash: "draft",
          key: this.draftDeclaration().key || "draft",
          version: 1,
          label: this.draftDeclaration().label || "Draft",
          summary: this.draftDeclaration().summary || "",
          qaEngineRev: 4,
        }),
        schemaVer: this.draftDeclaration().schema,
        declaration: this.draftDeclaration(),
        declarationV4: this.draftV4(),
        stagesView: undefined,
      });
    }
    return buildFallbackStagesView(detail);
  });

  filteredStages = computed<WorkflowStageView[]>(() => {
    const raw = this.activeStagesView();
    const q = this.searchQuery().trim().toLowerCase();
    const kf = this.kindFilter();
    return raw
      .map((stage) => {
        const stageMatches =
          !q ||
          stage.label.toLowerCase().includes(q) ||
          stage.id.toLowerCase().includes(q);
        const steps = stage.steps.filter((st) => {
          if (!this.matchesKindFilter(st, kf)) return false;
          if (!q || stageMatches) return true;
          return (
            st.label.toLowerCase().includes(q) ||
            st.id.toLowerCase().includes(q) ||
            st.kind.toLowerCase().includes(q) ||
            (st.summary || "").toLowerCase().includes(q) ||
            (st.scope || "").toLowerCase().includes(q)
          );
        });
        return { ...stage, steps };
      })
      .filter(
        (stage) =>
          (q === "" && kf === "all") ||
          stage.steps.length > 0 ||
          (kf === "all" && stage.label.toLowerCase().includes(q)),
      );
  });

  activeStage = computed<WorkflowStageView | null>(() => {
    const stages = this.activeStagesView();
    return (
      stages.find((s) => s.id === this.selectedStageId()) ?? stages[0] ?? null
    );
  });

  activeStep = computed<WorkflowStepView | null>(() => {
    const stepId = this.selectedStepId();
    if (!stepId) return null;
    for (const stg of this.activeStagesView()) {
      const found = stg.steps.find((s) => s.id === stepId);
      if (found) return found;
    }
    return null;
  });

  activeStudioDecl = computed<
    FlowDeclarationV3 | FlowDeclarationV4 | undefined
  >(() => {
    if (this.isEditing()) return this.draftV4();
    const d = this.selectedDetail();
    return d?.declarationV4 ?? d?.declarationV3 ?? undefined;
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

    if (this.route.queryParamMap) {
      this.route.queryParamMap
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((params) => {
          const ref = params.get("flow") ?? params.get("from");
          if (ref && this.versions().length > 0) {
            this.selectByParamRef(ref);
          } else if (
            !ref &&
            this.versions().length > 0 &&
            this.selectedHash()
          ) {
            const defHash = this.defaultVersionHash(this.versions());
            if (defHash && defHash !== this.selectedHash()) {
              void this.selectVersion(defHash);
            }
          }
        });
    }

    effect(() => {
      const qp = this.route.snapshot?.queryParamMap;
      const ref = qp?.get("from") ?? qp?.get("flow");
      if (ref && this.versions().length > 0 && !this.selectedHash()) {
        this.selectByParamRef(ref);
      }
    });
  }

  private selectByParamRef(ref: string): void {
    let target = ref;
    if (ref.includes("@")) {
      const [key, ver] = ref.split("@");
      const v = this.versions().find(
        (item) => item.key === key && item.version === Number(ver),
      );
      if (v) target = v.hash;
    } else {
      const byKey = this.versions().find(
        (item) => item.key === ref || item.hash === ref,
      );
      if (byKey) target = byKey.hash;
    }
    if (target && target !== this.selectedHash()) {
      void this.selectVersion(target);
    }
  }

  private matchesKindFilter(
    step: WorkflowStepView,
    filter: StepKindFilter,
  ): boolean {
    if (filter === "all") return true;
    if (filter === "skills") {
      return (
        step.kind === "skill" ||
        step.kind === "readability_pack" ||
        step.kind === "skill_step" ||
        step.kind === "context_discovery" ||
        step.kind === "decomposition"
      );
    }
    if (filter === "gates") {
      return (
        step.kind === "deterministic_check" ||
        step.kind.startsWith("custom_check") ||
        step.kind === "pr_contract" ||
        step.kind === "classifier" ||
        step.kind === "risk_override" ||
        step.kind === "nudge"
      );
    }
    if (filter === "subagents") {
      return (
        step.kind === "llm_gate" ||
        step.kind === "llm_critic" ||
        step.kind === "llm_verifier" ||
        step.kind === "merge_triage" ||
        step.kind === "custom_stage"
      );
    }
    return true;
  }

  schemaLabel(detail: QAFlowVersionDetail): string {
    if (
      detail.schemaVer === "grain.dev/qa-flow/v4" ||
      detail.declarationV4 ||
      detail.key.includes("v4")
    ) {
      return "v4";
    }
    if (
      detail.schemaVer === "grain.dev/qa-flow/v3" ||
      detail.declarationV3 ||
      detail.key.includes("v3")
    ) {
      return "v3";
    }
    return "v2";
  }

  formatBytesKb(bytes: number): string {
    return (bytes / 1024).toFixed(1);
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

  verifierSummaryText(detail: QAFlowVersionDetail): string {
    const enabled = detail.declaration
      ? detail.declaration.verifier.enabled
      : detail.resolved?.enableS4;
    if (!enabled) return "disabled";
    const tiers = detail.declaration?.verifier?.tiers;
    const rounds =
      detail.declaration?.verifier?.maxRepairRounds ??
      detail.resolved?.maxS4RepairRounds ??
      1;
    if (tiers && tiers.length > 0) {
      return `${tiers.join("/")} diffs (max ${rounds} round)`;
    }
    return `T2/T3 diffs (max ${rounds} round)`;
  }

  stageTriggerSummary(stage: WorkflowStageView): string {
    if (stage.id === "s0-decompose") return "medium, high complexity";
    if (stage.id === "s1-context") return "all diffs (0..100 blast score)";
    if (stage.id === "s2-plan") return "medium, high · T2/T3";
    if (stage.id === "s4-verify") return "T2/T3 blast tiers";
    if (stage.id === "s5-triage") return "auto T0/T1 · human T2/T3";
    return "always (every task run)";
  }

  stageBudgetSummary(stage: WorkflowStageView): string {
    if (stage.id === "s0-decompose") return "30s · 15,000 tok";
    if (stage.id === "s1-context") return "12,000 tok context cap";
    if (stage.id === "s2-plan") return "45s · 25,000 tok";
    if (stage.id === "s2-coding") return "8.0 kB active guidance cap";
    if (stage.id === "s4-verify") return "60s · 50,000 tok";
    return "< 1s deterministic";
  }

  isFloorCheck(checkId: string): boolean {
    return (
      checkId === "golden:test-integrity-guard" ||
      checkId === "golden:strict-config-decoder"
    );
  }

  onSearchInput(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  isStageCollapsed(stageId: string): boolean {
    return this.collapsedStages().has(stageId);
  }

  selectStage(stageId: string): void {
    if (
      this.selectedNodeKind() === "stage" &&
      this.selectedStageId() === stageId
    ) {
      this.collapsedStages.update((set) => {
        const next = new Set(set);
        if (next.has(stageId)) next.delete(stageId);
        else next.add(stageId);
        return next;
      });
    } else if (this.isStageCollapsed(stageId)) {
      this.collapsedStages.update((set) => {
        const next = new Set(set);
        next.delete(stageId);
        return next;
      });
    }
    this.selectedNodeKind.set("stage");
    this.selectedStageId.set(stageId);
    this.selectedStepId.set(null);
    this.mobileInspectorOpen.set(true);
  }

  selectStep(stageId: string, step: WorkflowStepView): void {
    this.selectedStageId.set(stageId);
    this.selectedNodeKind.set("step");
    this.selectedStepId.set(step.id);
    this.inspectorTab.set("definition");
    this.mobileInspectorOpen.set(true);
  }

  selectRuleFromTable(ruleId: string): void {
    for (const stg of this.activeStagesView()) {
      const found = stg.steps.find((s) => s.id === ruleId);
      if (found) {
        this.selectStep(stg.id, found);
        return;
      }
    }
  }

  closeMobileInspector(): void {
    this.mobileInspectorOpen.set(false);
  }

  openProbeDrawer(): void {
    this.v3Studio?.showProbe.set(true);
  }

  openAdoptModal(): void {
    this.v3Studio?.showAdopt.set(true);
  }

  isDraftCheckEnabled(step: WorkflowStepView): boolean {
    const entry = this.draftChecks()[step.id] as
      { enabled: boolean; severity: string } | undefined;
    return entry ? entry.enabled : step.enabled;
  }

  draftCheckSeverity(step: WorkflowStepView): string {
    const entry = this.draftChecks()[step.id] as
      { enabled: boolean; severity: string } | undefined;
    return entry?.severity || step.mode || "blocking";
  }

  packIdFromStep(step: WorkflowStepView): string {
    return step.id.replace(/^readability:/, "");
  }

  getDraftPack(packId: string): ReadabilityPackDecl {
    const packs = this.draftV4().readabilityPacks ?? [];
    return (
      packs.find((p) => p.id === packId) ?? {
        id: packId,
        enabled: true,
        activation: "auto",
        globs: BUILTIN_READABILITY_PACKS[packId]?.globs ?? [],
      }
    );
  }

  updateDraftPackEnabled(packId: string, enabled: boolean): void {
    this.upsertDraftPack(packId, { enabled });
  }

  updateDraftPackActivation(packId: string, activation: string): void {
    this.upsertDraftPack(packId, { activation });
  }

  updateDraftPackGlobs(packId: string, raw: string): void {
    const globs = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.upsertDraftPack(packId, { globs });
  }

  updateDraftPackCustomText(packId: string, customText: string): void {
    this.upsertDraftPack(packId, { customText });
  }

  private upsertDraftPack(
    packId: string,
    patch: Partial<ReadabilityPackDecl>,
  ): void {
    this.draftV4.update((prev) => {
      const list = [...(prev.readabilityPacks ?? [])];
      const idx = list.findIndex((p) => p.id === packId);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...patch };
      } else {
        list.push({
          id: packId,
          enabled: true,
          activation: "auto",
          globs: BUILTIN_READABILITY_PACKS[packId]?.globs ?? [],
          ...patch,
        });
      }
      return { ...prev, readabilityPacks: list };
    });
  }

  updatePRRequiredSections(raw: string): void {
    const requiredSections = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.draftV4.update((prev) => ({
      ...prev,
      prContract: {
        ...(prev.prContract ?? { enabled: true, mode: "warn" }),
        enabled: true,
        requiredSections,
      },
    }));
  }

  updatePRContractMode(mode: string): void {
    this.draftV4.update((prev) => ({
      ...prev,
      prContract: {
        ...(prev.prContract ?? { enabled: true }),
        enabled: mode !== "off",
        mode,
      },
    }));
  }

  addSkillStep(stage: "s0" | "s2" | "coding" | "pr" | "s4" = "coding"): void {
    const nextIdx = (this.draftV4().skillSteps ?? []).length + 1;
    const newStep: SkillStepDecl = {
      id: `step:custom-${nextIdx}`,
      label: `Custom Skill Step ${nextIdx}`,
      stage,
      enabled: true,
      maxBytes: 600,
      text: "Verify caller imports and add regression tests before opening PR.",
    };
    this.draftV4.update((prev) => ({
      ...prev,
      skillSteps: [...(prev.skillSteps ?? []), newStep],
    }));
    const stageId =
      stage === "s0"
        ? "s0-decompose"
        : stage === "s2"
          ? "s2-plan"
          : stage === "pr"
            ? "s3-pr"
            : stage === "s4"
              ? "s4-verify"
              : "s2-coding";
    this.selectedStageId.set(stageId);
    this.selectedNodeKind.set("step");
    this.selectedStepId.set(newStep.id);
  }

  updateSkillStepText(stepId: string, text: string): void {
    this.draftV4.update((prev) => ({
      ...prev,
      skillSteps: (prev.skillSteps ?? []).map((s) =>
        s.id === stepId ? { ...s, text } : s,
      ),
    }));
  }

  addCustomCheck(): void {
    const raw = this.draftV4()["custom-checks"];
    const list: CustomCheckDeclarationV3[] = Array.isArray(raw) ? [...raw] : [];
    const idx = list.length + 1;
    const id = `custom:pattern-${idx}`;
    list.push({
      id,
      label: `Custom Pattern Gate ${idx}`,
      kind: "pattern",
      severity: "warn",
      paths: ["pkg/**/*.go"],
      exclude: ["**/*_test.go"],
      "forbid-added": "\\bfmt\\.Println\\(",
      message: "Avoid debug fmt.Println in production packages.",
      fixtures: {
        fail: [
          {
            name: "fail trap with fmt.Println",
            file: "pkg/server.go",
            "added-lines": ['fmt.Println("debug")'],
          },
        ],
        pass: [
          {
            name: "clean pass structured log",
            file: "pkg/server.go",
            "added-lines": ['slog.Info("ready")'],
          },
        ],
      },
    });
    this.draftV4.update((prev) => ({ ...prev, "custom-checks": list }));
    this.selectedStageId.set("s3-checks");
    this.selectedNodeKind.set("step");
    this.selectedStepId.set(id);
  }

  addStepToStage(stageId: string): void {
    if (stageId === "s3-checks") {
      this.addCustomCheck();
    } else if (stageId === "s0-decompose") {
      this.addSkillStep("s0");
    } else if (stageId === "s2-plan") {
      this.addSkillStep("s2");
    } else if (stageId === "s3-pr") {
      this.addSkillStep("pr");
    } else if (stageId === "s4-verify") {
      this.addSkillStep("s4");
    } else {
      this.addSkillStep("coding");
    }
  }

  activeStepFixtures(step: WorkflowStepView): CustomCheckDeclarationV3 {
    const detail = this.selectedDetail();
    const v4 = this.isEditing()
      ? this.draftV4()
      : (detail?.declarationV4 ?? detail?.declarationV3);
    const raw = v4?.["custom-checks"] ?? v4?.customChecks;
    const list: readonly CustomCheckDeclarationV3[] = Array.isArray(raw)
      ? raw
      : raw
        ? Object.values(raw)
        : [];
    const found = list.find((c) => c.id === step.id);
    if (found) return found;

    return {
      id: step.id,
      label: step.label,
      kind: "pattern",
      severity: (step.mode as "blocking" | "warn" | "shadow") || "blocking",
      "forbid-added": "t\\.Skip\\(",
      fixtures: {
        fail: [
          {
            name: `${step.id} fail trap`,
            file: "pkg/service_test.go",
            "added-lines": ['t.Skip("skipping broken test")'],
          },
        ],
        pass: [
          {
            name: `${step.id} clean pass`,
            file: "pkg/service_test.go",
            "added-lines": ["if got != want { t.Fatalf(...) }"],
          },
        ],
      },
    };
  }

  formatFixturePreview(
    check: CustomCheckDeclarationV3,
    which: "fail" | "pass",
  ): string {
    const arr = which === "fail" ? check.fixtures?.fail : check.fixtures?.pass;
    const list = Array.isArray(arr) ? arr : [];
    if (list.length === 0) return "none";
    const first = list[0];
    const lines =
      first["added-lines"] ??
      first.addedLines ??
      first["changed-files"] ??
      first.changedFiles ??
      [];
    return `${first.name || which}: ${lines.join(", ") || first.file || "configured"}`;
  }

  fixtureResultForStep(stepId: string): FixtureSelfTestResult | null {
    return this.fixtureResults()[stepId] ?? null;
  }

  async runInlineFixturesForStep(step: WorkflowStepView): Promise<void> {
    const check = this.activeStepFixtures(step);
    const localResult = evaluateInlineCheckFixtures(check);
    this.fixtureResults.update((prev) => ({
      ...prev,
      [step.id]: localResult,
    }));

    try {
      const detail = this.selectedDetail();
      const body = this.isEditing()
        ? { declaration: this.prepareActiveDeclarationForApi() }
        : detail?.declaration
          ? { declaration: this.cleanV2Declaration(detail.declaration) }
          : { yaml: detail?.sourceYaml || "" };
      await this.api.post<QADryRunResponse>(
        "POST /api/qa/flow-versions",
        undefined,
        body,
        "dryRun=1",
      );
      this.snackbar.show(
        localResult.valid
          ? "Inline fixtures verified (Fail trap caught, Clean pass green)"
          : "Fixture self-test completed with warnings",
      );
    } catch {
      this.snackbar.show(localResult.summary);
    }
  }

  stepWouldBlockCount(stepId: string): number {
    const dr = this.dryRunResult();
    return dr?.byCheck?.find((c) => c.ruleId === stepId)?.wouldBlock ?? 0;
  }

  stepWarnCount(stepId: string): number {
    const dr = this.dryRunResult();
    return dr?.byCheck?.find((c) => c.ruleId === stepId)?.warnCount ?? 0;
  }

  formatDeclarationYaml(detail: QAFlowVersionDetail): string {
    const target =
      detail.declarationV4 ?? detail.declarationV3 ?? detail.declaration;
    return target ? JSON.stringify(target, null, 2) : detail.summary || "";
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
      loaded = Array.isArray(res?.versions) ? [...res.versions] : [];
    } catch {
      loaded = [];
    }

    if (loaded.length === 0 || loaded.some((v) => v.builtIn)) {
      let fallback: QAFlowsResponse | null = null;
      try {
        fallback = (await this.api.get<QAFlowsResponse>(
          "GET /api/qa/flows",
        )) as QAFlowsResponse | null;
      } catch {
        fallback = null;
      }
      const existingKeys = new Set(loaded.map((v) => v.key));
      for (const f of fallback?.flows ?? []) {
        if (!existingKeys.has(f.id)) {
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
          existingKeys.add(f.id);
        }
      }
    }

    this.versions.set(loaded);
    if (!this.selectedHash() && loaded.length > 0) {
      const qp = this.route.snapshot?.queryParamMap;
      const fromRef = qp?.get("from") ?? qp?.get("flow");
      if (fromRef) {
        this.selectByParamRef(fromRef);
        if (this.selectedHash()) return;
      }
      const firstHash = this.defaultVersionHash(loaded);
      if (firstHash) {
        await this.doSelectVersion(firstHash);
      }
    }
  }

  private defaultVersionHash(loaded: QAFlowVersionItem[]): string | undefined {
    const activeMatch = this.activeFlowId()
      ? loaded.find((v) => v.key === this.activeFlowId() && !v.retiredAt)
      : undefined;
    const v4Match = loaded.find(
      (v) =>
        v.key === "engineering-workflow-v4" ||
        v.schemaVer === "grain.dev/qa-flow/v4",
    );
    return activeMatch?.hash ?? v4Match?.hash ?? loaded[0]?.hash;
  }

  onSelectVersionFromList(v: QAFlowVersionItem): void {
    this.mobileInspectorOpen.set(true);
    void this.selectVersion(v.hash);
    if (this.router.url.startsWith("/processes")) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { flow: v.key },
        queryParamsHandling: "merge",
      });
    }
  }

  async selectVersion(hash: string): Promise<void> {
    if (!hash) return;
    if (this.isEditing()) {
      this.confirmRequest.set({
        title: "Unsaved changes",
        message: "You have unsaved changes. Discard them?",
        accept: "Discard",
        destructive: true,
        run: async () => {
          this.isEditing.set(false);
          await this.doSelectVersion(hash);
        },
      });
      return;
    }
    await this.doSelectVersion(hash);
  }

  private async doSelectVersion(hash: string): Promise<void> {
    this.selectedHash.set(hash);
    this.dryRunResult.set(null);
    this.showParentDiff.set(false);
    const local = this.versions().find((v) => v.hash === hash);
    try {
      const detail = (await this.api.get<QAFlowVersionDetail>(
        "GET /api/qa/flow-versions/{hash}",
        { hash },
      )) as QAFlowVersionDetail | null;
      if (detail && detail.key) {
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
    const isV4 =
      detail.schemaVer === "grain.dev/qa-flow/v4" ||
      Boolean(detail.declarationV4) ||
      detail.key.includes("v4");
    const isV3 =
      detail.schemaVer === "grain.dev/qa-flow/v3" ||
      Boolean(detail.declarationV3) ||
      detail.key.startsWith("golden-v3");

    if (isV4) {
      draft.schema = "grain.dev/qa-flow/v4";
      draft.declarationV4 = detail.declarationV4;
    } else if (isV3) {
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

    const v4Source = detail.declarationV4;
    const v3Source = detail.declarationV3 ?? v4Source;
    this.draftV4.set({
      schema: "grain.dev/qa-flow/v4",
      key: draft.key,
      extends: draft.extends,
      label: draft.label || detail.label || draft.key,
      summary: draft.summary || detail.summary,
      stopNudge: draft.stopNudge,
      stagingIsolation: draft.stagingIsolation,
      decompose: v4Source?.decompose ?? {
        enabled: true,
        mode: "slice_plan",
        complexities: ["high"],
        maxSubtasks: 5,
        targetDiffLines: 400,
      },
      context: v4Source?.context ?? {
        enabled: true,
        includeCallers: true,
        includeMemory: true,
        maxTokens: 12000,
        extraPaths: ["pkg/**", "ui-ng/src/**"],
      },
      readabilityPacks:
        v4Source?.readabilityPacks ??
        v4Source?.["readability-packs"] ??
        BUILTIN_READABILITY_PACK_IDS.map((id) => ({
          id,
          enabled: true,
          activation: "auto",
          globs: BUILTIN_READABILITY_PACKS[id]?.globs ?? [],
        })),
      skillSteps: [
        ...(v4Source?.skillSteps ?? v4Source?.["skill-steps"] ?? []),
      ],
      prContract: v4Source?.prContract ??
        v4Source?.["pr-contract"] ?? {
          enabled: true,
          mode: "warn",
          maxSubjectChars: 72,
          requiredSections: ["Summary", "Verification"],
          auditLintSuppressions: true,
        },
      stages: v3Source?.stages ?? {
        "s0-intent": { enabled: true },
        "s2-plan-critic": { enabled: true },
        "s5-merge-triage": { mode: "shadow" },
        custom: [],
      },
      "custom-checks":
        v3Source?.["custom-checks"] ?? v3Source?.customChecks ?? [],
    });
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

  updateDraftSchema(
    schema:
      "grain.dev/qa-flow/v2" | "grain.dev/qa-flow/v3" | "grain.dev/qa-flow/v4",
  ): void {
    this.draftDeclaration.update((prev) => ({ ...prev, schema }));
  }

  toggleDraftDecompose(enabled: boolean): void {
    this.draftV4.update((prev) => ({
      ...prev,
      decompose: {
        ...(prev.decompose ?? { mode: "slice_plan", maxSubtasks: 5 }),
        enabled,
      },
    }));
  }

  toggleDraftContext(enabled: boolean): void {
    this.draftV4.update((prev) => ({
      ...prev,
      context: {
        ...(prev.context ?? {
          includeCallers: true,
          includeMemory: true,
          maxTokens: 12000,
        }),
        enabled,
      },
    }));
  }

  toggleDraftBool(field: "stopNudge" | "stagingIsolation"): void {
    this.draftDeclaration.update((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
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

  private cleanV2Declaration(decl: FlowDeclarationV2): FlowDeclarationV2 {
    const copy = JSON.parse(JSON.stringify(decl)) as FlowDeclarationV2;
    delete copy.declarationV3;
    delete copy.declarationV4;
    return copy;
  }

  prepareDraft(): FlowDeclarationV2 {
    const draft = this.cleanV2Declaration(this.draftDeclaration());
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

  prepareDraftV4(): FlowDeclarationV4 {
    const base = this.prepareDraft();
    const v4 = this.draftV4();
    const decomp: DecomposeDecl | undefined = v4.decompose
      ? {
          enabled: v4.decompose.enabled,
          mode: v4.decompose.mode || "slice_plan",
          complexities: v4.decompose.complexities ?? ["high"],
          maxSubtasks:
            v4.decompose.maxSubtasks ?? v4.decompose["max-subtasks"] ?? 5,
          targetDiffLines:
            v4.decompose.targetDiffLines ??
            v4.decompose["target-diff-lines"] ??
            400,
        }
      : undefined;
    const ctx: ContextDiscoveryDecl | undefined = v4.context
      ? {
          enabled: v4.context.enabled,
          includeCallers:
            v4.context.includeCallers ?? v4.context["include-callers"] ?? true,
          includeMemory:
            v4.context.includeMemory ?? v4.context["include-memory"] ?? true,
          maxTokens: v4.context.maxTokens ?? v4.context["max-tokens"] ?? 12000,
          extraPaths: v4.context.extraPaths ?? v4.context["extra-paths"],
        }
      : undefined;
    const pr: PRContractDecl | undefined = v4.prContract
      ? {
          enabled: v4.prContract.enabled,
          mode: v4.prContract.mode || "warn",
          maxSubjectChars:
            v4.prContract.maxSubjectChars ??
            v4.prContract["max-subject-chars"] ??
            72,
          requiredSections: v4.prContract.requiredSections ??
            v4.prContract["required-sections"] ?? ["Summary", "Verification"],
          auditLintSuppressions:
            v4.prContract.auditLintSuppressions ??
            v4.prContract["audit-lint-suppressions"] ??
            true,
          guidanceText:
            v4.prContract.guidanceText ?? v4.prContract["guidance-text"],
        }
      : undefined;

    return {
      schema: "grain.dev/qa-flow/v4",
      key: base.key || v4.key || "custom-workflow-v4",
      extends: base.extends || v4.extends || "engineering-workflow-v4@1",
      label: base.label || v4.label,
      summary: base.summary || v4.summary,
      stopNudge: base.stopNudge,
      stagingIsolation: base.stagingIsolation,
      decompose: decomp,
      context: ctx,
      skills: {
        ...(v4.skills ?? {}),
        coding: base.skill,
      },
      readabilityPacks: (v4.readabilityPacks ?? []).map((p) => ({
        id: p.id,
        enabled: p.enabled,
        activation: p.activation || "auto",
        globs: p.globs,
        customText: p.customText ?? p["custom-text"],
      })),
      skillSteps: (v4.skillSteps ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        stage: s.stage,
        enabled: s.enabled,
        globs: s.globs,
        maxBytes: s.maxBytes ?? s["max-bytes"] ?? 600,
        text: s.text,
      })),
      stages: v4.stages,
      prContract: pr,
      checks: base.checks,
      "custom-checks": v4["custom-checks"] ?? v4.customChecks,
      verifier: base.verifier,
    };
  }

  prepareActiveDeclarationForApi():
    FlowDeclarationV2 | FlowDeclarationV3 | FlowDeclarationV4 {
    const schema = this.draftDeclaration().schema;
    if (schema === "grain.dev/qa-flow/v4") {
      return this.prepareDraftV4();
    }
    return this.prepareDraft();
  }

  async dryRunDraft(): Promise<void> {
    try {
      const decl = this.prepareActiveDeclarationForApi();
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
      const body = detail.declarationV4
        ? { declaration: detail.declarationV4 }
        : detail.declaration
          ? { declaration: this.cleanV2Declaration(detail.declaration) }
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
    const base = this.prepareDraft();
    const payload = this.prepareActiveDeclarationForApi();
    const activeBlocking =
      Object.values(base.checks || {}).filter((c) => c.severity === "blocking")
        .length + 2;
    const skillBytes = this.activePromptBytes();
    this.confirmRequest.set({
      title: "Publish version",
      message: `Publish ${base.key} (extends ${base.extends || "none"})?\nActive prompt size: ${skillBytes} bytes.\nActive blocking checks: ${activeBlocking}.`,
      accept: "Publish",
      destructive: false,
      run: async () => {
        try {
          await this.api.post("POST /api/qa/flow-versions", undefined, {
            declaration: payload,
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
