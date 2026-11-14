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

import { DOCUMENT } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnDestroy,
  type OnInit,
  ViewEncapsulation,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { type RouteKey } from "../api/generated-routes";
import { GrainApi, routeScope } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { ViewFilter } from "../services/view-filter.service";
import { errorText, renderMarkdown } from "../sessions/session-view";
import { ActorChipComponent } from "../shared/actor-chip.component";
import {
  ConfirmDialogComponent,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import { configuredInstanceRepos } from "../shared/instance-repos";
import { SplitController } from "../shared/split-controller";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";
import {
  type ContextTab,
  type EditorMode,
  type FsEntry,
  type FsGrepHit,
  type FsListResponse,
  type FsScheme,
  MAX_MEMORY_DOCUMENT_LENGTH,
  MAX_MEMORY_DOCUMENT_NAME_LENGTH,
  MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH,
  MAX_MEMORY_LENGTH,
  MEMORY_DOC_SLUG_RE,
  type Memory,
  type MemoryDocument,
  buildMemoryScopes,
  buildGrepTruncationNotice,
  documentSize,
  estimateTokens,
  highlightSyntaxHtml,
  isStaleMemory,
  memoryAge,
  parseGrepResult,
  repoFromMemoryFsPath,
  scopeKey,
  scopeLabel,
  utf8ByteLength,
  validateDocumentSlug,
} from "./context.models";

const TABS: readonly { id: ContextTab; label: string }[] = [
  { id: "instructions", label: "Standing Instructions" },
  { id: "documents", label: "Memory Documents (Packs)" },
  { id: "namespace", label: "Namespace Browser" },
];

type ReachableReposPayload =
  | {
      configured?: boolean;
      available?: boolean;
      repos?: Array<string | { repo?: string; push?: boolean }>;
    }
  | Array<string | { repo?: string; push?: boolean }>;

@Component({
  selector: "g-context-page",
  imports: [
    TipDirective,
    StatusIconComponent,
    ActorChipComponent,
    ConfirmDialogComponent,
  ],
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    "../shared/work-surface.css",
    "../shared/ops-surface.css",
    "./context-page.component.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(document:click)": "onDocClick($event)",
    "(document:keydown.escape)": "onEscape($event)",
  },
  template: `
    <section
      class="view-panel is-active"
      aria-labelledby="context-headline"
      [attr.inert]="confirmReq() ? '' : null"
      data-testid="context-page"
    >
      <div class="stage-header">
        <div class="view-headline-row">
          <div class="headline-cluster">
            <h1
              class="view-headline"
              id="context-headline"
              tabindex="-1"
              data-testid="context-headline"
            >
              Context &amp; Standing Memory
            </h1>
            <span class="status-pill neutral">
              <g-status-icon tone="neutral" kind="progress" />
              {{ scopeLabel(selectedRepo()) }}
            </span>
          </div>

          <div class="headline-actions">
            <div
              class="ctx-split-controls"
              role="group"
              aria-label="Pane split"
            >
              <button
                type="button"
                class="btn-text"
                data-testid="context-toggle-list"
                [attr.aria-pressed]="sp.collapsed()"
                (click)="sp.toggleCollapsed()"
              >
                {{ sp.collapsed() ? "Show list" : "Hide list" }}
              </button>
              <button
                type="button"
                class="btn-text tabular"
                [attr.aria-pressed]="!sp.collapsed() && sp.ratioPct() === 30"
                (click)="sp.setPreset(0.3)"
              >
                30 / 70
              </button>
              <button
                type="button"
                class="btn-text tabular"
                [attr.aria-pressed]="!sp.collapsed() && sp.ratioPct() === 42"
                (click)="sp.setPreset(0.42)"
              >
                42 / 58
              </button>
            </div>
            <button
              type="button"
              class="btn-tonal"
              data-testid="context-refresh"
              [disabled]="loading()"
              (click)="refreshAll()"
            >
              Refresh
            </button>
          </div>
        </div>

        <p class="view-subtitle">
          Standing memory carried in every dispatched prompt, on-demand memory
          document packs (200-byte index summary), and the live
          <code>/api/fs/memory/</code> namespace.
        </p>

        <!-- Scope Switcher + Tabs -->
        <div class="ops-toolbar" role="toolbar" aria-label="Context scope">
          <button
            type="button"
            class="filter-chip"
            data-testid="context-scope-deployment"
            [disabled]="!canReadDeploymentScope()"
            [gTip]="
              canReadDeploymentScope()
                ? 'Switch to deployment-wide memory'
                : deniedReadReason('')
            "
            [attr.aria-pressed]="selectedRepo() === ''"
            (click)="selectScope('')"
          >
            This deployment
          </button>

          <div class="pop-wrap">
            <button
              #repoTrigger
              type="button"
              class="pop-trigger"
              [class.is-active]="selectedRepo() !== ''"
              data-testid="context-repo-trigger"
              aria-haspopup="listbox"
              [attr.aria-expanded]="repoMenuOpen()"
              aria-controls="context-repo-menu"
              (click)="toggleRepoMenu($event)"
              (keydown)="onRepoTriggerKeydown($event)"
            >
              <span>{{
                selectedRepo()
                  ? "Repo: " + selectedRepo()
                  : "Select repository…"
              }}</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M7 10l5 5 5-5z" fill="currentColor" />
              </svg>
            </button>
            @if (repoMenuOpen()) {
              <ul
                #repoListbox
                class="pop-menu"
                id="context-repo-menu"
                role="listbox"
                tabindex="-1"
                aria-label="Repository scope"
                data-testid="context-repo-menu"
                (keydown)="onListboxKeydown($event)"
              >
                <li role="none">
                  <button
                    type="button"
                    class="pop-item"
                    role="option"
                    [disabled]="!canReadDeploymentScope()"
                    [attr.aria-selected]="selectedRepo() === ''"
                    (click)="selectScope('')"
                  >
                    <span>This deployment (global)</span>
                    @if (selectedRepo() === "") {
                      <span aria-hidden="true">✓</span>
                    }
                  </button>
                </li>
                @for (r of allKnownRepos(); track r) {
                  <li role="none">
                    <button
                      type="button"
                      class="pop-item"
                      role="option"
                      [attr.aria-selected]="
                        scopeKey(selectedRepo()) === scopeKey(r)
                      "
                      [attr.data-testid]="'context-repo-opt-' + r"
                      (click)="selectScope(r)"
                    >
                      <span class="tabular">{{ r }}</span>
                      @if (scopeKey(selectedRepo()) === scopeKey(r)) {
                        <span aria-hidden="true">✓</span>
                      }
                    </button>
                  </li>
                }
              </ul>
            }
          </div>

          @if (canAddRepoScope()) {
            <div class="ops-toolbar-end">
              @if (addingRepo()) {
                <input
                  type="text"
                  class="ops-input tabular"
                  placeholder="owner/name"
                  aria-label="Add repository scope"
                  data-testid="context-add-repo-input"
                  [value]="newRepoDraft()"
                  (input)="newRepoDraft.set($any($event.target).value)"
                  (keydown.enter)="commitAddRepo()"
                />
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="context-add-repo-confirm"
                  (click)="commitAddRepo()"
                >
                  Select
                </button>
                <button
                  type="button"
                  class="btn-text"
                  (click)="addingRepo.set(false)"
                >
                  Cancel
                </button>
              } @else {
                <button
                  type="button"
                  class="btn-text"
                  data-testid="context-add-repo-btn"
                  (click)="openAddRepo()"
                >
                  + Add repository scope
                </button>
              }
            </div>
          }
        </div>

        <div
          class="tab-strip"
          role="tablist"
          aria-label="Context sections"
          data-testid="context-tabs"
        >
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              class="tab-link ctx-tab-btn"
              [id]="'context-tab-btn-' + t.id"
              [attr.aria-selected]="tab() === t.id"
              [attr.aria-controls]="'context-panel-' + t.id"
              [attr.tabindex]="tab() === t.id ? 0 : -1"
              [attr.data-testid]="'context-tab-' + t.id"
              (click)="pickTab(t.id)"
              (keydown)="onTabKeydown($event, t.id)"
            >
              <span>{{ t.label }}</span>
              @if (t.id === "instructions") {
                <span class="tab-count tabular">{{ scopes().length }}</span>
              } @else if (t.id === "documents") {
                <span class="tab-count tabular">{{
                  scopedDocuments().length
                }}</span>
              }
            </button>
          }
        </div>
      </div>

      @if (loadError(); as err) {
        <p class="banner banner-error" role="alert" data-testid="context-error">
          {{ err }}
        </p>
      }

      @if (!canReadMemory()) {
        <p
          class="empty-state"
          role="tabpanel"
          [id]="'context-panel-' + tab()"
          [attr.aria-labelledby]="'context-tab-btn-' + tab()"
          data-testid="context-denied"
        >
          {{ deniedReadReason(selectedRepo()) }}
        </p>
      } @else {
        <!-- Context-scoped 30 / 70 Resizable Split Workspace -->
        <div
          class="ctx-split"
          #splitEl
          role="tabpanel"
          [id]="'context-panel-' + tab()"
          [attr.aria-labelledby]="'context-tab-btn-' + tab()"
          [class.is-collapsed]="sp.collapsed()"
          [class.is-dragging]="sp.dragging()"
          [style.--queue-w.%]="sp.ratioExact()"
          data-testid="context-split"
        >
          <!-- LEFT PANE (30%) -->
          <section
            class="ctx-list-pane"
            aria-label="Context index"
            data-testid="context-left-pane"
          >
            <!-- Left Pane: Standing Instructions Scopes -->
            @if (tab() === "instructions") {
              <div class="ctx-pane-head">
                <div class="ctx-pane-head-row">
                  <strong>Memory Scopes</strong>
                  <span class="muted tabular">{{
                    filteredScopes().length
                  }}</span>
                </div>
              </div>
              <ul class="ctx-list">
                @for (sc of filteredScopes(); track sc.key) {
                  <li
                    class="ctx-row"
                    [class.is-selected]="scopeKey(selectedRepo()) === sc.key"
                    [attr.data-testid]="
                      'scope-row-' + (sc.repo || 'deployment')
                    "
                  >
                    <button
                      type="button"
                      class="ctx-row-btn"
                      (click)="selectScope(sc.repo)"
                    >
                      <span class="ctx-row-line1">
                        <span
                          [class]="
                            isStale(sc.updatedAt)
                              ? 'status-pill blast'
                              : sc.text
                                ? 'status-pill healthy'
                                : 'status-pill neutral'
                          "
                        >
                          <g-status-icon
                            [tone]="
                              isStale(sc.updatedAt)
                                ? 'blast'
                                : sc.text
                                  ? 'healthy'
                                  : 'neutral'
                            "
                            [kind]="
                              isStale(sc.updatedAt)
                                ? 'warning'
                                : sc.text
                                  ? 'healthy'
                                  : 'neutral'
                            "
                          />
                          {{
                            isStale(sc.updatedAt)
                              ? "Stale"
                              : sc.text
                                ? "Active"
                                : "Empty"
                          }}
                        </span>
                        <span class="row-title">{{ sc.label }}</span>
                      </span>
                      <span class="ctx-row-line2 muted tabular">
                        <span>{{ utf8Len(sc.text) }} bytes</span>
                        <span>· {{ sc.documents.length }} packs</span>
                        @if (ageOf(sc.updatedAt); as age) {
                          <span>· {{ age }}</span>
                        }
                      </span>
                      @if (sc.updatedBy) {
                        <span class="ctx-row-line3">
                          <g-actor-chip
                            [label]="sc.updatedBy"
                            [kind]="sc.updatedByKind || 'human'"
                          />
                        </span>
                      }
                    </button>
                  </li>
                }
              </ul>
            }

            <!-- Left Pane: Memory Documents (Packs) -->
            @if (tab() === "documents") {
              <div class="ctx-pane-head">
                <div class="ctx-pane-head-row">
                  <strong>Memory Packs</strong>
                  @if (canCreateDoc()) {
                    <button
                      type="button"
                      class="btn-primary"
                      style="min-height: 32px; padding: 0 12px"
                      data-testid="doc-new-btn"
                      [gTip]="
                        'Create a new memory document in ' +
                        scopeLabel(selectedRepo())
                      "
                      (click)="startNewDocument()"
                    >
                      + New pack
                    </button>
                  }
                </div>
                <form
                  role="search"
                  autocomplete="off"
                  style="display: contents"
                  (submit)="$event.preventDefault()"
                >
                  <input
                    type="search"
                    name="grain-docs-search"
                    autocomplete="off"
                    spellcheck="false"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    class="ops-input"
                    placeholder="Search documents by name or summary…"
                    aria-label="Search memory documents"
                    data-testid="docs-search-input"
                    [value]="docSearch()"
                    (input)="docSearch.set($any($event.target).value)"
                  />
                </form>
              </div>

              @if (filteredDocuments().length === 0) {
                <p class="empty-state" data-testid="docs-empty">
                  No memory documents filed under
                  {{ scopeLabel(selectedRepo()) }}.
                </p>
              } @else {
                <ul class="ctx-list" data-testid="docs-list">
                  @for (
                    d of filteredDocuments();
                    track (d.repo || "") + ":" + d.name
                  ) {
                    <li
                      class="ctx-row"
                      [class.is-selected]="
                        !creatingDoc() &&
                        selectedDocName() === d.name &&
                        scopeKey(selectedDocRepo()) === scopeKey(d.repo)
                      "
                      [attr.data-testid]="'doc-row-' + d.name"
                    >
                      <button
                        type="button"
                        class="ctx-row-btn"
                        (click)="openDocument(d)"
                      >
                        <span class="ctx-row-line1">
                          <span class="status-pill neutral tabular">
                            <g-status-icon tone="neutral" kind="progress" />
                            {{ fmtDocSize(d.length) }}
                          </span>
                          <span class="row-title tabular">{{ d.name }}</span>
                        </span>
                        <span class="ctx-row-summary" [title]="d.summary">
                          {{ d.summary }}
                        </span>
                        <span class="ctx-row-line3 muted">
                          @if (d.updatedBy) {
                            <g-actor-chip
                              [label]="d.updatedBy"
                              [kind]="d.updatedByKind || 'human'"
                            />
                          }
                          @if (ageOf(d.updatedAt); as age) {
                            <span>{{ age }}</span>
                          }
                        </span>
                      </button>
                    </li>
                  }
                </ul>
              }
            }

            <!-- Left Pane: Namespace File Browser -->
            @if (tab() === "namespace") {
              <div class="ctx-pane-head">
                <div class="ctx-pane-head-row">
                  <div class="segmented" role="group" aria-label="FS scheme">
                    <button
                      type="button"
                      [attr.aria-pressed]="fsScheme() === 'memory'"
                      data-testid="fs-scheme-memory"
                      (click)="pickFsScheme('memory')"
                    >
                      memory://
                    </button>
                    @if (canReadConfigFs()) {
                      <button
                        type="button"
                        [attr.aria-pressed]="fsScheme() === 'config'"
                        data-testid="fs-scheme-config"
                        (click)="pickFsScheme('config')"
                      >
                        config://
                      </button>
                    }
                  </div>
                  @if (fsDir()) {
                    <button
                      type="button"
                      class="btn-text"
                      data-testid="fs-up-btn"
                      (click)="navigateFsUp()"
                    >
                      ↑ Up
                    </button>
                  }
                </div>

                <div class="ctx-fs-crumbs" data-testid="fs-breadcrumbs">
                  <button
                    type="button"
                    class="btn-text"
                    style="padding: 0 6px; height: 24px"
                    (click)="openFsDir('')"
                  >
                    {{ fsScheme() }}://
                  </button>
                  @for (seg of fsBreadcrumbs(); track seg.path) {
                    <span class="muted">/</span>
                    <button
                      type="button"
                      class="btn-text"
                      style="padding: 0 6px; height: 24px"
                      (click)="openFsDir(seg.path)"
                    >
                      {{ seg.name }}
                    </button>
                  }
                </div>

                <form
                  role="search"
                  autocomplete="off"
                  style="display: flex; gap: 6px; min-width: 0; margin: 0"
                  (submit)="$event.preventDefault(); runFsGrep()"
                >
                  <input
                    type="search"
                    name="grain-fs-grep"
                    autocomplete="off"
                    spellcheck="false"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    class="ops-input"
                    style="flex: 1; min-width: 0"
                    placeholder="Grep pattern in subtree…"
                    aria-label="Grep namespace files"
                    data-testid="fs-grep-input"
                    [value]="fsGrepQuery()"
                    (input)="fsGrepQuery.set($any($event.target).value)"
                  />
                  <button
                    type="submit"
                    class="btn-tonal"
                    style="min-height: 36px; padding: 0 12px"
                    data-testid="fs-grep-btn"
                  >
                    Grep
                  </button>
                </form>
              </div>

              @if (fsGrepHits() !== null) {
                <div class="ctx-pane-head-row" style="padding: 8px 16px">
                  <span class="muted tabular"
                    >{{ fsGrepHits()?.length ?? 0 }} matches</span
                  >
                  <button
                    type="button"
                    class="btn-text"
                    (click)="clearFsGrep()"
                  >
                    Clear search
                  </button>
                </div>
                <ul class="ctx-list" data-testid="fs-grep-results">
                  @for (hit of fsGrepHits() ?? []; track $index) {
                    <li>
                      <button
                        type="button"
                        class="ctx-fs-row"
                        (click)="openFsFile(hit.file)"
                      >
                        <span class="tabular" style="min-width: 0">
                          <strong>{{ hit.file }}</strong>
                          @if (hit.line) {
                            <span class="muted">:{{ hit.line }}</span>
                          }
                          <div
                            class="muted"
                            style="
                              overflow: hidden;
                              text-overflow: ellipsis;
                              white-space: nowrap;
                            "
                          >
                            {{ hit.text }}
                          </div>
                        </span>
                      </button>
                    </li>
                  }
                </ul>
                @if (fsGrepTruncated()) {
                  <div
                    class="ctx-fs-grep-footer"
                    role="status"
                    data-testid="fs-grep-truncated"
                  >
                    <g-status-icon tone="blast" kind="warning" />
                    <div class="ctx-fs-grep-footer-body">
                      @for (notice of fsGrepNotices(); track $index) {
                        <p class="ctx-fs-grep-footer-line tabular">
                          {{ notice }}
                        </p>
                      }
                    </div>
                  </div>
                }
              } @else if (fsEntries().length === 0) {
                <p class="empty-state" data-testid="fs-empty">
                  No files in {{ fsScheme() }}://{{ fsDir() }}.
                </p>
              } @else {
                <ul class="ctx-list" data-testid="fs-entries-list">
                  @for (entry of fsEntries(); track entry.name) {
                    <li>
                      <button
                        type="button"
                        class="ctx-fs-row"
                        [class.is-selected]="
                          fsSelectedFile() === joinPath(fsDir(), entry.name)
                        "
                        [attr.data-testid]="'fs-entry-' + entry.name"
                        (click)="onFsEntryClick(entry)"
                      >
                        <span class="tabular">
                          {{ entry.type === "dir" ? "📁 " : "📄 "
                          }}{{ entry.name
                          }}{{ entry.type === "dir" ? "/" : "" }}
                        </span>
                        @if (entry.type !== "dir" && entry.size !== undefined) {
                          <span class="muted tabular">{{
                            fmtDocSize(entry.size)
                          }}</span>
                        }
                      </button>
                    </li>
                  }
                </ul>
              }
            }
          </section>

          <!-- RESIZABLE DIVIDER -->
          <div
            class="ctx-resizer"
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            aria-label="Resize context list and editor"
            [attr.aria-valuenow]="sp.ratioPct()"
            [attr.aria-valuemin]="sp.minPct()"
            [attr.aria-valuemax]="sp.maxPct()"
            data-testid="context-resizer"
            (pointerdown)="sp.onResizeStart($event)"
            (pointermove)="sp.onResizeMove($event)"
            (pointerup)="sp.onResizeEnd($event)"
            (pointercancel)="sp.onResizeEnd($event)"
            (dblclick)="sp.reset()"
            (keydown)="sp.onKey($event)"
          >
            <span class="ctx-resizer-pill" aria-hidden="true"></span>
            @if (sp.dragging()) {
              <span class="ctx-resizer-badge tabular" aria-hidden="true"
                >{{ sp.ratioPct() }}%</span
              >
            }
          </div>

          <!-- RIGHT PANE (70%) -->
          <section
            class="ctx-detail-pane"
            aria-label="Context editor and preview"
            data-testid="context-right-pane"
          >
            <!-- Right Pane 1: Standing Instructions Editor & Live Preview -->
            @if (tab() === "instructions") {
              @let cur = currentScopeRow();
              <div class="ops-card-head">
                <div>
                  <h2 class="ops-card-title" data-testid="memory-scope-title">
                    {{ cur.label }} — Standing Instructions (memory.md)
                  </h2>
                  <p class="ops-card-sub">
                    Injected verbatim into the system prompt of every dispatched
                    run targeting {{ cur.repo || "this deployment" }}.
                  </p>
                </div>

                @if (canWriteMemory()) {
                  <div class="headline-actions">
                    @if (memoryDirty()) {
                      <span
                        class="status-pill blast"
                        data-testid="memory-dirty-pill"
                      >
                        <g-status-icon tone="blast" kind="warning" />
                        Unsaved changes
                      </span>
                    }
                    <div
                      class="segmented"
                      role="group"
                      aria-label="Standing instructions editor mode"
                    >
                      @for (m of ["edit", "split", "preview"]; track m) {
                        <button
                          type="button"
                          [attr.aria-pressed]="editorMode() === m"
                          [attr.data-testid]="'memory-mode-' + m"
                          (click)="setEditorMode(m)"
                        >
                          {{ m }}
                        </button>
                      }
                    </div>
                  </div>
                }
              </div>

              @if (isStale(cur.updatedAt)) {
                <div class="banner banner-info" style="margin: 0">
                  <strong
                    >Stale standing note ({{ ageOf(cur.updatedAt) }}):</strong
                  >
                  still injected into every prompt — verify it still holds.
                </div>
              }

              <div class="tel-legend tabular">
                <span
                  class="ctx-counter"
                  [class.is-over]="memoryByteLen() > maxMemoryLen"
                  data-testid="memory-char-count"
                >
                  {{ memoryByteLen() }} / {{ maxMemoryLen }} bytes
                </span>
                <span data-testid="memory-token-count"
                  >≈{{ estTokens(memoryDraft()) }} tokens</span
                >
                @if (cur.updatedBy) {
                  <g-actor-chip
                    [label]="cur.updatedBy"
                    [kind]="cur.updatedByKind || 'human'"
                  />
                }
              </div>

              <div
                class="ctx-editor-grid"
                [class.is-split]="canWriteMemory() && editorMode() === 'split'"
              >
                @if (canWriteMemory() && editorMode() !== "preview") {
                  <textarea
                    class="ctx-textarea"
                    aria-label="Standing memory markdown"
                    data-testid="memory-textarea"
                    placeholder="Write standing patterns, build gotchas, or architectural invariants for runs in this scope…"
                    [value]="memoryDraft()"
                    (input)="onMemoryInput($any($event.target).value)"
                  ></textarea>
                }
                @if (!canWriteMemory() || editorMode() !== "edit") {
                  <div
                    class="ctx-md-preview"
                    tabindex="0"
                    data-testid="memory-preview"
                    [innerHTML]="memoryPreviewHtml()"
                  ></div>
                }
              </div>

              @if (canWriteMemory()) {
                <div class="headline-actions" style="justify-content: flex-end">
                  <button
                    type="button"
                    class="btn-text"
                    data-testid="memory-revert-btn"
                    [disabled]="!memoryDirty() || savingMemory()"
                    (click)="revertMemory()"
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    data-testid="memory-save-btn"
                    [disabled]="
                      !memoryDirty() ||
                      savingMemory() ||
                      memoryByteLen() > maxMemoryLen
                    "
                    (click)="saveMemory()"
                  >
                    {{ savingMemory() ? "Saving…" : "Save instructions" }}
                  </button>
                </div>
              } @else {
                <p
                  class="ctx-counter"
                  style="margin: 0"
                  data-testid="memory-write-denied"
                >
                  {{ deniedWriteReason("PUT /api/memory", selectedRepo()) }}
                </p>
              }
            }

            <!-- Right Pane 2: Memory Documents (Packs) Viewer & Editor -->
            @if (tab() === "documents") {
              @if (!(canCreateDoc() && creatingDoc()) && !selectedDocName()) {
                <div class="empty-state" data-testid="doc-placeholder">
                  @if (canCreateDoc()) {
                    Select a memory document pack on the left to read or edit
                    its contents, or create a new pack.
                  } @else {
                    Select a memory document pack on the left to inspect its
                    contents.
                  }
                </div>
              } @else {
                <div class="ops-card-head">
                  <div>
                    <h2 class="ops-card-title" data-testid="doc-editor-title">
                      {{
                        canCreateDoc() && creatingDoc()
                          ? "New Memory Document (" +
                            scopeLabel(selectedRepo()) +
                            ")"
                          : selectedDocName()
                      }}
                    </h2>
                    <p class="ops-card-sub">
                      Every prompt carries the 200-byte summary index line;
                      agents fetch full text on demand.
                    </p>
                  </div>
                  @if (canWriteDoc()) {
                    <div class="headline-actions">
                      @if (docDirty()) {
                        <span
                          class="status-pill blast"
                          data-testid="doc-dirty-pill"
                        >
                          <g-status-icon tone="blast" kind="warning" />
                          Unsaved
                        </span>
                      }
                      <div
                        class="segmented"
                        role="group"
                        aria-label="Document editor mode"
                      >
                        @for (m of ["edit", "split", "preview"]; track m) {
                          <button
                            type="button"
                            [attr.aria-pressed]="editorMode() === m"
                            [attr.data-testid]="'doc-mode-' + m"
                            (click)="setEditorMode(m)"
                          >
                            {{ m }}
                          </button>
                        }
                      </div>
                    </div>
                  }
                </div>

                @if (canCreateDoc() && creatingDoc()) {
                  <label class="ctx-summary-box">
                    <div class="ctx-pane-head-row">
                      <span class="ops-kpi-label">Document name (slug)</span>
                      <span
                        class="ctx-counter tabular"
                        [class.is-over]="!!docNameValidationError()"
                      >
                        {{ newDocNameDraft().trim().length }} /
                        {{ maxDocNameLen }} chars
                      </span>
                    </div>
                    <input
                      type="text"
                      class="ops-input tabular"
                      placeholder="e.g. database-migrations or auth-invariants"
                      aria-label="Memory document name"
                      aria-describedby="doc-name-hint"
                      data-testid="doc-name-input"
                      [value]="newDocNameDraft()"
                      (input)="onNewDocNameInput($any($event.target).value)"
                    />
                    <span
                      id="doc-name-hint"
                      class="ctx-counter"
                      data-testid="doc-name-hint"
                    >
                      Lowercase letters, digits, and single hyphens (max 64
                      chars).
                    </span>
                    @if (docNameValidationError(); as nerr) {
                      <span
                        class="ctx-counter is-over"
                        role="alert"
                        data-testid="doc-name-error"
                        >{{ nerr }}</span
                      >
                    }
                  </label>
                }

                @if (canWriteDoc()) {
                  <label class="ctx-summary-box">
                    <div class="ctx-pane-head-row">
                      <span class="ops-kpi-label"
                        >Prompt index summary (injected into every run)</span
                      >
                      <span
                        class="ctx-counter tabular"
                        [class.is-over]="summaryOverLimit()"
                        data-testid="doc-summary-counter"
                      >
                        {{ summaryByteLen() }} / {{ maxSummaryLen }} bytes
                      </span>
                    </div>
                    <input
                      type="text"
                      class="ops-input"
                      aria-label="Document prompt index summary"
                      data-testid="doc-summary-input"
                      placeholder="One crisp line explaining when an agent should open this document (max 200 bytes)…"
                      [value]="docSummaryDraft()"
                      (input)="onDocSummaryInput($any($event.target).value)"
                    />
                    @if (summaryValidationError(); as serr) {
                      <span
                        class="ctx-counter is-over"
                        role="alert"
                        data-testid="doc-summary-error"
                        >{{ serr }}</span
                      >
                    }
                  </label>
                } @else {
                  <div class="ctx-summary-box">
                    <div class="ctx-pane-head-row">
                      <span class="ops-kpi-label"
                        >Prompt index summary (injected into every run)</span
                      >
                      <span
                        class="ctx-counter tabular"
                        data-testid="doc-summary-counter"
                      >
                        {{ summaryByteLen() }} / {{ maxSummaryLen }} bytes
                      </span>
                    </div>
                    <p
                      class="ctx-md-preview ctx-readonly-summary"
                      data-testid="doc-summary-readonly"
                    >
                      {{
                        docSummaryDraft().trim() ||
                          "No prompt index summary configured."
                      }}
                    </p>
                  </div>
                }

                <div class="tel-legend tabular">
                  <span
                    class="ctx-counter"
                    [class.is-over]="docBodyByteLen() > maxDocLen"
                    data-testid="doc-body-counter"
                  >
                    {{ docBodyByteLen() }} / {{ maxDocLen }} bytes
                  </span>
                  <span>≈{{ estTokens(docTextDraft()) }} tokens</span>
                </div>

                <div
                  class="ctx-editor-grid"
                  [class.is-split]="canWriteDoc() && editorMode() === 'split'"
                >
                  @if (canWriteDoc() && editorMode() !== "preview") {
                    <textarea
                      class="ctx-textarea"
                      aria-label="Memory document markdown body"
                      data-testid="doc-text-input"
                      placeholder="Detailed domain reference, architecture notes, or troubleshooting playbook…"
                      [value]="docTextDraft()"
                      (input)="onDocTextInput($any($event.target).value)"
                    ></textarea>
                  }
                  @if (!canWriteDoc() || editorMode() !== "edit") {
                    <div
                      class="ctx-md-preview"
                      tabindex="0"
                      data-testid="doc-preview"
                      [innerHTML]="docPreviewHtml()"
                    ></div>
                  }
                </div>

                @if (canWriteDoc()) {
                  <div
                    class="headline-actions"
                    style="justify-content: space-between"
                  >
                    <div>
                      @if (!creatingDoc() && selectedDocName()) {
                        <button
                          type="button"
                          class="btn-text danger"
                          data-testid="doc-delete-btn"
                          [disabled]="savingDoc()"
                          (click)="confirmDeleteDocument()"
                        >
                          Delete document
                        </button>
                      }
                    </div>
                    <div class="headline-actions">
                      <button
                        type="button"
                        class="btn-text"
                        data-testid="doc-revert-btn"
                        [disabled]="!docDirty() || savingDoc()"
                        (click)="revertDocument()"
                      >
                        {{ creatingDoc() ? "Cancel" : "Revert" }}
                      </button>
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="doc-save-btn"
                        [disabled]="!canSubmitDocument() || savingDoc()"
                        (click)="saveDocument()"
                      >
                        {{ savingDoc() ? "Saving…" : "Save document" }}
                      </button>
                    </div>
                  </div>
                } @else {
                  <p
                    class="ctx-counter"
                    style="margin: 0"
                    data-testid="doc-write-denied"
                  >
                    {{
                      deniedWriteReason(
                        "PUT /api/memory/documents",
                        selectedDocName() ? selectedDocRepo() : selectedRepo()
                      )
                    }}
                  </p>
                }
              }
            }

            <!-- Right Pane 3: Namespace File Preview -->
            @if (tab() === "namespace") {
              @if (!fsSelectedFile()) {
                <div class="empty-state" data-testid="fs-placeholder">
                  Choose a file in <code>{{ fsScheme() }}://</code> on the left
                  (or search with Grep) to inspect its redacted contents.
                </div>
              } @else {
                <div class="ops-card-head">
                  <div>
                    <h2
                      class="ops-card-title tabular"
                      data-testid="fs-file-title"
                    >
                      {{ fsScheme() }}://{{ fsSelectedFile() }}
                    </h2>
                    <p class="ops-card-sub tabular">
                      {{ utf8Len(fsFileContent()) }} bytes · ≈{{
                        estTokens(fsFileContent())
                      }}
                      tokens · Read-only namespace projection
                    </p>
                  </div>
                  <div class="headline-actions">
                    @if (fsSelectedFile().endsWith(".md")) {
                      <div
                        class="segmented"
                        role="group"
                        aria-label="Namespace file render mode"
                      >
                        <button
                          type="button"
                          [attr.aria-pressed]="!fsRenderMd()"
                          (click)="fsRenderMd.set(false)"
                        >
                          Syntax
                        </button>
                        <button
                          type="button"
                          [attr.aria-pressed]="fsRenderMd()"
                          (click)="fsRenderMd.set(true)"
                        >
                          Markdown
                        </button>
                      </div>
                    }
                    <button
                      type="button"
                      class="btn-tonal"
                      (click)="copyFsContent()"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                @if (fsSelectedFile().endsWith(".md") && fsRenderMd()) {
                  <div
                    class="ctx-md-preview"
                    tabindex="0"
                    data-testid="fs-md-preview"
                    [innerHTML]="fsMarkdownHtml()"
                  ></div>
                } @else {
                  <pre
                    class="dark-well"
                    tabindex="0"
                    data-testid="fs-code-preview"
                    [innerHTML]="fsHighlightedHtml()"
                  ></pre>
                }
              }
            }
          </section>
        </div>
      }
    </section>

    @if (confirmReq(); as req) {
      <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
    }
  `,
})
export class ContextPageComponent implements OnInit, OnDestroy {
  protected readonly api = inject(GrainApi);
  protected readonly access = inject(AccessService);
  protected readonly viewFilter = inject(ViewFilter);
  private readonly snackbar = inject(SnackbarService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);

  protected readonly tabs = TABS;
  protected readonly maxMemoryLen = MAX_MEMORY_LENGTH;
  protected readonly maxDocLen = MAX_MEMORY_DOCUMENT_LENGTH;
  protected readonly maxSummaryLen = MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH;
  protected readonly maxDocNameLen = MAX_MEMORY_DOCUMENT_NAME_LENGTH;
  protected readonly scopeLabel = scopeLabel;
  protected readonly scopeKey = scopeKey;
  protected readonly ageOf = memoryAge;
  protected readonly isStale = isStaleMemory;
  protected readonly fmtDocSize = documentSize;
  protected readonly estTokens = estimateTokens;
  protected readonly utf8Len = utf8ByteLength;

  private readonly splitEl = viewChild<ElementRef<HTMLElement>>("splitEl");
  private readonly repoTrigger =
    viewChild<ElementRef<HTMLButtonElement>>("repoTrigger");
  private readonly repoListbox =
    viewChild<ElementRef<HTMLElement>>("repoListbox");

  protected readonly sp = new SplitController({
    ratioKey: "grain.context.splitRatio",
    collapsedKey: "grain.context.splitCollapsed",
    defaultRatio: 0.3,
    element: () => this.splitEl()?.nativeElement,
  });

  protected readonly tab = signal<ContextTab>("instructions");
  protected readonly editorMode = signal<EditorMode>("split");
  protected readonly selectedRepo = signal<string>("");
  protected readonly repoMenuOpen = signal(false);
  protected readonly addingRepo = signal(false);
  protected readonly newRepoDraft = signal<string>("");
  protected readonly extraRepos = signal<string[]>([]);
  protected readonly configRepos = signal<string[]>([]);

  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly confirmReq = signal<ConfirmRequest | null>(null);

  protected readonly memories = signal<Memory[]>([]);
  protected readonly documents = signal<MemoryDocument[]>([]);

  // Standing instructions editor state per scope key
  protected readonly memoryDrafts = signal<Record<string, string>>({});
  protected readonly savingMemory = signal(false);

  // Memory documents state
  protected readonly docSearch = signal<string>("");
  protected readonly creatingDoc = signal(false);
  protected readonly newDocNameDraft = signal<string>("");
  protected readonly selectedDocRepo = signal<string>("");
  protected readonly selectedDocName = signal<string>("");
  protected readonly loadedDocSummary = signal<string>("");
  protected readonly loadedDocText = signal<string>("");
  protected readonly docSummaryDraft = signal<string>("");
  protected readonly docTextDraft = signal<string>("");
  protected readonly savingDoc = signal(false);

  // Namespace browser state
  protected readonly fsScheme = signal<FsScheme>("memory");
  protected readonly fsDir = signal<string>("");
  protected readonly fsEntries = signal<FsEntry[]>([]);
  protected readonly fsSelectedFile = signal<string>("");
  protected readonly fsFileContent = signal<string>("");
  protected readonly fsRenderMd = signal(false);
  protected readonly fsGrepQuery = signal<string>("");
  protected readonly fsGrepHits = signal<FsGrepHit[] | null>(null);
  protected readonly fsGrepTruncated = signal<boolean>(false);
  protected readonly fsGrepNotices = signal<string[]>([]);
  private fsGrepSeq = 0;
  private docLoadSeq = 0;
  private hasLoadedMemory = false;
  private pendingDiscardResolve: ((accepted: boolean) => void) | null = null;
  private readonly onBeforeUnload = (ev: BeforeUnloadEvent): void => {
    if (!this.hasUnsavedChanges()) return;
    ev.preventDefault();
    ev.returnValue = "";
  };

  constructor() {
    afterNextRender(() => this.sp.attach());
  }

  private scopeRepoLimits(route: RouteKey): string[] {
    if (this.access.isFullAccess()) return [];
    const scope = routeScope(route);
    return scope ? (this.access.repoLimits()[scope] ?? []) : [];
  }

  private canGlobalRoute(route: RouteKey): boolean {
    return this.access.canGlobalScope(routeScope(route));
  }

  private canRouteForScope(route: RouteKey, repo: string): boolean {
    const clean = repo.trim();
    if (!clean) return this.canGlobalRoute(route);
    return this.access.can(route, clean);
  }

  private canWriteRoute(
    route: "PUT /api/memory" | "PUT /api/memory/documents",
    repo: string,
  ): boolean {
    // Fail closed until /api/config resolves so viewers never see transient write UI.
    return this.access.configLoaded() && this.canRouteForScope(route, repo);
  }

  protected readonly memoryReadLimits = computed<string[]>(() =>
    this.scopeRepoLimits("GET /api/memory"),
  );
  protected readonly memoryWriteLimits = computed<string[]>(() =>
    this.scopeRepoLimits("PUT /api/memory"),
  );
  protected readonly settingsReadLimits = computed<string[]>(() =>
    this.scopeRepoLimits("GET /api/fs/config/{path...}"),
  );
  protected readonly isMemoryReadRepoLimited = computed(
    () => this.memoryReadLimits().length > 0,
  );
  protected readonly isMemoryWriteRepoLimited = computed(
    () => this.memoryWriteLimits().length > 0,
  );

  protected readonly canReadDeploymentScope = computed(
    () =>
      this.canGlobalRoute("GET /api/memory") &&
      this.canGlobalRoute("GET /api/memory/documents"),
  );

  protected readonly canReadMemory = computed(() =>
    this.canRouteForScope("GET /api/memory", this.selectedRepo()),
  );

  protected readonly canAddRepoScope = computed(
    () =>
      this.access.configLoaded() &&
      (this.canGlobalRoute("PUT /api/memory") ||
        this.canGlobalRoute("PUT /api/memory/documents")),
  );

  protected readonly canWriteMemory = computed(() =>
    this.canWriteRoute("PUT /api/memory", this.selectedRepo()),
  );

  protected readonly canCreateDoc = computed(() =>
    this.canWriteRoute("PUT /api/memory/documents", this.selectedRepo()),
  );

  protected readonly canWriteDoc = computed(() => {
    const repo =
      this.creatingDoc() || !this.selectedDocName()
        ? this.selectedRepo()
        : this.selectedDocRepo();
    return this.canWriteRoute("PUT /api/memory/documents", repo);
  });

  // config:// exposes deployment-wide memory (memory/deployment.md, tables/memory.json),
  // so both settings:read and memory:read must be granted globally without repoLimits.
  protected readonly canReadConfigFs = computed(
    () =>
      this.canGlobalRoute("GET /api/fs/config/{path...}") &&
      this.canGlobalRoute("GET /api/memory"),
  );

  protected deniedReadReason(repo: string): string {
    const clean = repo.trim();
    if (!clean && this.isMemoryReadRepoLimited()) {
      return `Your role ${this.access.roleLabel() || "limited"} holds memory:read only on ${this.memoryReadLimits().join(", ")} and cannot read deployment-wide memory.`;
    }
    return this.access.deniedReason("GET /api/memory", clean || undefined);
  }

  protected deniedWriteReason(
    route: "PUT /api/memory" | "PUT /api/memory/documents",
    repo: string,
  ): string {
    const clean = repo.trim();
    const limits = this.scopeRepoLimits(route);
    if (!clean && limits.length > 0) {
      const scope = routeScope(route) ?? "memory:write";
      return `Your role ${this.access.roleLabel() || "limited"} holds ${scope} only on ${limits.join(", ")} and cannot modify deployment-wide memory.`;
    }
    return this.access.deniedReason(route, clean || undefined);
  }

  protected readonly scopes = computed(() => {
    const all = buildMemoryScopes(
      this.memories(),
      this.documents(),
      [
        ...this.configRepos(),
        ...this.memoryReadLimits(),
        ...this.memoryWriteLimits(),
        ...this.extraRepos(),
      ],
      this.canReadDeploymentScope(),
    );
    if (!this.isMemoryReadRepoLimited()) return all;
    return all.filter(
      (s) => s.repo && this.access.can("GET /api/memory", s.repo),
    );
  });

  protected readonly allKnownRepos = computed<string[]>(() =>
    this.scopes()
      .map((s) => s.repo)
      .filter((r) => r !== ""),
  );

  protected readonly filteredScopes = computed(() => {
    const q = this.viewFilter.query().trim().toLowerCase();
    const list = this.scopes();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.label.toLowerCase().includes(q) || s.text.toLowerCase().includes(q),
    );
  });

  protected readonly currentScopeRow = computed(() => {
    const k = scopeKey(this.selectedRepo());
    return (
      this.scopes().find((s) => s.key === k) ?? {
        key: k,
        repo: this.selectedRepo(),
        label: scopeLabel(this.selectedRepo()),
        text: "",
        documents: [],
      }
    );
  });

  protected readonly memoryDraft = computed<string>(() => {
    const cur = this.currentScopeRow();
    const map = this.memoryDrafts();
    return cur.key in map ? map[cur.key] : cur.text;
  });

  protected readonly memoryByteLen = computed<number>(() =>
    utf8ByteLength(this.memoryDraft()),
  );

  protected readonly memoryDirty = computed<boolean>(
    () => this.memoryDraft() !== this.currentScopeRow().text,
  );

  protected readonly memoryPreviewHtml = computed<string>(() => {
    const src = this.memoryDraft().trim();
    if (!src) {
      return '<p class="muted">Nothing remembered in this scope yet.</p>';
    }
    return renderMarkdown(src);
  });

  protected readonly scopedDocuments = computed<MemoryDocument[]>(() => {
    const k = scopeKey(this.selectedRepo());
    return this.documents().filter((d) => scopeKey(d.repo) === k);
  });

  protected readonly filteredDocuments = computed<MemoryDocument[]>(() => {
    const q = (this.docSearch() || this.viewFilter.query())
      .trim()
      .toLowerCase();
    const list = this.scopedDocuments();
    if (!q) return list;
    return list.filter(
      (d) =>
        d.name.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q),
    );
  });

  protected readonly docNameValidationError = computed<string | null>(() => {
    if (!this.creatingDoc()) return null;
    return validateDocumentSlug(this.newDocNameDraft());
  });

  protected readonly summaryByteLen = computed<number>(() =>
    utf8ByteLength(this.docSummaryDraft().trim()),
  );

  protected readonly docBodyByteLen = computed<number>(() =>
    utf8ByteLength(this.docTextDraft()),
  );

  protected readonly summaryOverLimit = computed<boolean>(
    () => this.summaryByteLen() > MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH,
  );

  protected readonly summaryValidationError = computed<string | null>(() => {
    const bytes = this.summaryByteLen();
    if (bytes > MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH) {
      return `Summary exceeds ${MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH} bytes (${bytes}/${MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH}). Keep it to a single index line.`;
    }
    if (
      (this.creatingDoc() || this.selectedDocName()) &&
      this.docTextDraft().trim().length > 0 &&
      bytes === 0
    ) {
      return "A summary is required so runs know when to read this document.";
    }
    return null;
  });

  protected readonly docDirty = computed<boolean>(() => {
    if (this.creatingDoc()) {
      if (!this.canCreateDoc()) return false;
      return (
        this.newDocNameDraft().trim().length > 0 ||
        this.docSummaryDraft().trim().length > 0 ||
        this.docTextDraft().trim().length > 0
      );
    }
    if (!this.selectedDocName()) return false;
    return (
      this.docSummaryDraft() !== this.loadedDocSummary() ||
      this.docTextDraft() !== this.loadedDocText()
    );
  });

  protected readonly hasUnsavedChanges = computed<boolean>(() => {
    if (this.docDirty()) return true;
    const drafts = this.memoryDrafts();
    const rows = this.scopes();
    for (const key of Object.keys(drafts)) {
      const saved = rows.find((s) => s.key === key)?.text ?? "";
      if (drafts[key] !== saved) return true;
    }
    return false;
  });

  protected readonly canSubmitDocument = computed<boolean>(() => {
    if (!this.canWriteDoc()) return false;
    if (this.creatingDoc() && !this.canCreateDoc()) return false;
    const name = this.creatingDoc()
      ? this.newDocNameDraft().trim()
      : this.selectedDocName().trim();
    const summary = this.docSummaryDraft().trim();
    const text = this.docTextDraft().trim();
    if (!name || !summary || !text) return false;
    if (
      name.length > MAX_MEMORY_DOCUMENT_NAME_LENGTH ||
      !MEMORY_DOC_SLUG_RE.test(name)
    ) {
      return false;
    }
    if (utf8ByteLength(summary) > MAX_MEMORY_DOCUMENT_SUMMARY_LENGTH) {
      return false;
    }
    if (utf8ByteLength(text) > MAX_MEMORY_DOCUMENT_LENGTH) {
      return false;
    }
    return this.docDirty();
  });

  protected readonly docPreviewHtml = computed<string>(() => {
    const src = this.docTextDraft().trim();
    if (!src) return '<p class="muted">Document body preview appears here.</p>';
    return renderMarkdown(src);
  });

  protected readonly fsBreadcrumbs = computed(() => {
    const dir = this.fsDir();
    if (!dir) return [];
    const parts = dir.split("/").filter(Boolean);
    return parts.map((name, idx) => ({
      name,
      path: parts.slice(0, idx + 1).join("/"),
    }));
  });

  protected readonly fsHighlightedHtml = computed(() =>
    highlightSyntaxHtml(this.fsFileContent(), this.fsSelectedFile()),
  );

  protected readonly fsMarkdownHtml = computed(() =>
    renderMarkdown(this.fsFileContent() || ""),
  );

  ngOnInit(): void {
    this.doc.defaultView?.addEventListener("beforeunload", this.onBeforeUnload);
    const qp = this.route.snapshot.queryParamMap;
    const t = qp.get("tab");
    if (t === "instructions" || t === "documents" || t === "namespace") {
      this.tab.set(t);
    }
    const r = qp.get("repo")?.trim() ?? "";
    if (r) {
      this.selectedRepo.set(r);
      this.extraRepos.set([r]);
    }
    this.ensurePermittedRepoSelected();
    void this.bootstrap();
  }

  ngOnDestroy(): void {
    this.doc.defaultView?.removeEventListener(
      "beforeunload",
      this.onBeforeUnload,
    );
    if (this.pendingDiscardResolve) {
      this.pendingDiscardResolve(false);
      this.pendingDiscardResolve = null;
    }
    this.sp.detach();
  }

  canDeactivate(): Promise<boolean> {
    return this.confirmDiscardIfDirty();
  }

  private ensurePermittedRepoSelected(): void {
    if (this.selectedRepo().trim() || this.canReadDeploymentScope()) return;
    const firstPermitted = this.memoryReadLimits().find((r) =>
      this.access.can("GET /api/memory", r),
    );
    if (firstPermitted) {
      this.selectedRepo.set(firstPermitted);
      this.syncUrl();
    }
  }

  private async bootstrap(): Promise<void> {
    await this.loadBootstrapRepos();
    if (!this.canAddRepoScope()) {
      this.addingRepo.set(false);
      this.newRepoDraft.set("");
    }
    if (!this.canCreateDoc() && this.creatingDoc()) {
      this.creatingDoc.set(false);
      this.newDocNameDraft.set("");
      this.docSummaryDraft.set("");
      this.docTextDraft.set("");
    }
    this.ensurePermittedRepoSelected();
    await this.refreshAll();
  }

  private async loadBootstrapRepos(): Promise<void> {
    const found = new Set<string>();
    let restricted = false;
    if (this.access.can("GET /api/config")) {
      try {
        const cfg = await this.api.config();
        if (cfg) {
          this.access.setConfig(cfg);
          const summary = configuredInstanceRepos(cfg);
          restricted = summary.hasTargetAllowlist;
          for (const r of summary.repos) {
            found.add(r);
          }
        }
      } catch {
        // Non-fatal.
      }
    }
    // Only fall back to GitHub-wide reachable-repos discovery when this
    // deployment has no configured repositories attached yet; otherwise a
    // user's GitHub token floods the scope rail with hundreds/thousands of
    // unrelated repositories.
    if (
      !restricted &&
      found.size === 0 &&
      this.access.can("GET /api/deployment/reachable-repos")
    ) {
      try {
        const rr = await this.api.get<ReachableReposPayload>(
          "GET /api/deployment/reachable-repos",
        );
        const list = Array.isArray(rr) ? rr : (rr?.repos ?? []);
        for (const r of list) {
          const name = typeof r === "string" ? r : r?.repo;
          if (typeof name === "string" && name.trim()) {
            found.add(name.trim());
          }
        }
      } catch {
        // Optional when repos:read is not held.
      }
    }
    if (found.size > 0) this.configRepos.set([...found]);
  }

  async refreshAll(): Promise<void> {
    if (!this.canReadMemory()) return;
    this.loading.set(true);
    this.loadError.set(null);
    try {
      if (this.isMemoryReadRepoLimited()) {
        const repos = [
          ...new Set(
            [...this.memoryReadLimits(), this.selectedRepo()]
              .map((r) => r.trim())
              .filter(
                (r) => r !== "" && this.canRouteForScope("GET /api/memory", r),
              ),
          ),
        ];
        const [memLists, docLists] = await Promise.all([
          Promise.all(
            repos.map((r) =>
              this.api.get<
                Memory[] | { items?: Memory[]; memories?: Memory[] }
              >(
                "GET /api/memory",
                undefined,
                new URLSearchParams({ repo: r }).toString(),
              ),
            ),
          ),
          Promise.all(
            repos.map((r) =>
              this.api.get<
                | MemoryDocument[]
                | { items?: MemoryDocument[]; documents?: MemoryDocument[] }
              >(
                "GET /api/memory/documents",
                undefined,
                new URLSearchParams({ repo: r }).toString(),
              ),
            ),
          ),
        ]);
        this.memories.set(
          memLists
            .flatMap((res) =>
              Array.isArray(res) ? res : (res?.items ?? res?.memories ?? []),
            )
            .filter((m) =>
              this.canRouteForScope("GET /api/memory", m?.repo || ""),
            ),
        );
        this.documents.set(
          docLists
            .flatMap((res) =>
              Array.isArray(res) ? res : (res?.items ?? res?.documents ?? []),
            )
            .filter((d) =>
              this.canRouteForScope("GET /api/memory/documents", d?.repo || ""),
            ),
        );
      } else {
        const [memRes, docRes] = await Promise.all([
          this.api.get<Memory[] | { items?: Memory[]; memories?: Memory[] }>(
            "GET /api/memory",
          ),
          this.api.get<
            | MemoryDocument[]
            | { items?: MemoryDocument[]; documents?: MemoryDocument[] }
          >("GET /api/memory/documents"),
        ]);
        this.memories.set(
          Array.isArray(memRes)
            ? memRes
            : (memRes?.items ?? memRes?.memories ?? []),
        );
        this.documents.set(
          Array.isArray(docRes)
            ? docRes
            : (docRes?.items ?? docRes?.documents ?? []),
        );
      }
      this.hasLoadedMemory = true;
      if (this.fsScheme() === "config" && !this.canReadConfigFs()) {
        this.fsScheme.set("memory");
        this.fsDir.set("");
        this.fsEntries.set([]);
        this.fsSelectedFile.set("");
        this.fsFileContent.set("");
        this.clearFsGrep();
      }
      if (this.tab() === "namespace") {
        await this.loadFsDir(this.fsDir());
      }
    } catch (err) {
      this.loadError.set(errorText(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async pickTab(t: ContextTab): Promise<boolean> {
    if (this.tab() === t) return false;
    if (this.savingDoc() || this.savingMemory()) return false;
    if (!(await this.confirmDiscardIfDirty())) return false;
    this.tab.set(t);
    this.syncUrl();
    if (t === "namespace" && this.fsEntries().length === 0) {
      void this.loadFsDir(this.fsDir());
    }
    return true;
  }

  protected async onTabKeydown(
    ev: KeyboardEvent,
    current: ContextTab,
  ): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === current);
    if (idx < 0) return;
    let nextIdx = -1;
    if (ev.key === "ArrowRight") nextIdx = (idx + 1) % this.tabs.length;
    else if (ev.key === "ArrowLeft") {
      nextIdx = (idx - 1 + this.tabs.length) % this.tabs.length;
    } else if (ev.key === "Home") nextIdx = 0;
    else if (ev.key === "End") nextIdx = this.tabs.length - 1;
    if (nextIdx < 0 || nextIdx === idx) return;
    ev.preventDefault();
    const nextTab = this.tabs[nextIdx].id;
    if (await this.pickTab(nextTab)) {
      this.doc.getElementById(`context-tab-btn-${nextTab}`)?.focus();
    }
  }

  protected setEditorMode(m: string): void {
    if (m === "edit" || m === "split" || m === "preview") {
      this.editorMode.set(m);
    }
  }

  protected async selectScope(repo: string): Promise<void> {
    const clean = repo.trim();
    if (!clean && !this.canReadDeploymentScope()) return;
    const wasMenuOpen = this.repoMenuOpen();
    this.repoMenuOpen.set(false);
    if (scopeKey(clean) === scopeKey(this.selectedRepo())) return;
    if (this.savingDoc() || this.savingMemory()) return;
    if (wasMenuOpen) {
      this.repoTrigger()?.nativeElement.focus();
    }
    if (!(await this.confirmDiscardIfDirty())) return;
    this.docLoadSeq++;
    if (
      clean &&
      !this.allKnownRepos().some((r) => scopeKey(r) === scopeKey(clean))
    ) {
      this.extraRepos.update((list) => [...list, clean]);
    }
    this.selectedRepo.set(clean);
    this.clearDocumentEditor();
    this.syncUrl();
    if (!this.hasLoadedMemory && this.canReadMemory() && !this.loading()) {
      void this.refreshAll();
    }
  }

  protected openAddRepo(): void {
    if (!this.canAddRepoScope()) return;
    this.addingRepo.set(true);
  }

  protected commitAddRepo(): void {
    if (!this.canAddRepoScope()) {
      this.addingRepo.set(false);
      this.newRepoDraft.set("");
      return;
    }
    const r = this.newRepoDraft().trim();
    this.addingRepo.set(false);
    this.newRepoDraft.set("");
    if (r) void this.selectScope(r);
  }

  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        tab: this.tab() === "instructions" ? null : this.tab(),
        repo: this.selectedRepo() || null,
      },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  protected onMemoryInput(val: string): void {
    if (!this.canWriteMemory()) return;
    const k = this.currentScopeRow().key;
    const saved = this.currentScopeRow().text;
    this.memoryDrafts.update((prev) => {
      if (val === saved) {
        if (!(k in prev)) return prev;
        const next = { ...prev };
        delete next[k];
        return next;
      }
      return { ...prev, [k]: val };
    });
  }

  protected revertMemory(): void {
    if (!this.canWriteMemory()) return;
    const k = this.currentScopeRow().key;
    this.memoryDrafts.update((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });
  }

  protected saveMemory(): void {
    const repo = this.selectedRepo().trim();
    if (!this.canWriteRoute("PUT /api/memory", repo) || this.savingMemory()) {
      return;
    }
    const text = this.memoryDraft();
    if (text.trim() === "") {
      this.confirmReq.set({
        title: `Forget standing memory for ${scopeLabel(repo)}?`,
        message:
          "Saving an empty standing instruction deletes this scope's memory record.",
        accept: "Forget scope",
        destructive: true,
        run: () => this.performSaveMemory(repo, ""),
      });
      return;
    }
    void this.performSaveMemory(repo, text);
  }

  private async performSaveMemory(repo: string, text: string): Promise<void> {
    const cleanRepo = repo.trim();
    if (!this.canWriteRoute("PUT /api/memory", cleanRepo)) {
      this.snackbar.show(this.deniedWriteReason("PUT /api/memory", cleanRepo));
      return;
    }
    this.savingMemory.set(true);
    try {
      await this.api.put<Memory>("PUT /api/memory", undefined, {
        repo: cleanRepo,
        text,
      });
      const k = scopeKey(cleanRepo);
      this.memoryDrafts.update((prev) => {
        const next = { ...prev };
        delete next[k];
        return next;
      });
      this.snackbar.show(`Saved standing memory for ${scopeLabel(cleanRepo)}.`);
      await this.refreshAll();
    } catch (err) {
      this.snackbar.show(errorText(err));
    } finally {
      this.savingMemory.set(false);
    }
  }

  protected async startNewDocument(): Promise<void> {
    if (!this.canCreateDoc() || this.savingDoc()) return;
    if (this.creatingDoc() && !this.docDirty()) return;
    if (!(await this.confirmDiscardIfDirty())) return;
    this.docLoadSeq++;
    this.creatingDoc.set(true);
    this.selectedDocName.set("");
    this.selectedDocRepo.set(this.selectedRepo().trim());
    this.newDocNameDraft.set("");
    this.docSummaryDraft.set("");
    this.docTextDraft.set("");
    this.loadedDocSummary.set("");
    this.loadedDocText.set("");
  }

  protected async openDocument(doc: MemoryDocument): Promise<void> {
    const repo = (doc.repo || "").trim();
    if (!this.canRouteForScope("GET /api/memory/documents/{name}", repo)) {
      this.snackbar.show(this.deniedReadReason(repo));
      return;
    }
    if (this.savingDoc()) return;
    if (
      !this.creatingDoc() &&
      this.selectedDocName() === doc.name &&
      scopeKey(this.selectedDocRepo()) === scopeKey(repo)
    ) {
      return;
    }
    if (!(await this.confirmDiscardIfDirty())) return;
    const reqSeq = ++this.docLoadSeq;
    const initialSummary = doc.summary || "";
    const initialText = doc.text || "";
    this.creatingDoc.set(false);
    this.selectedDocRepo.set(repo);
    this.selectedDocName.set(doc.name);
    this.docSummaryDraft.set(initialSummary);
    this.loadedDocSummary.set(initialSummary);
    this.docTextDraft.set(initialText);
    this.loadedDocText.set(initialText);

    const params = new URLSearchParams();
    if (repo) params.set("repo", repo);
    try {
      const full = await this.api.get<MemoryDocument>(
        "GET /api/memory/documents/{name}",
        { name: doc.name },
        params.toString() || undefined,
      );
      if (
        reqSeq !== this.docLoadSeq ||
        this.creatingDoc() ||
        this.selectedDocName() !== doc.name ||
        scopeKey(this.selectedDocRepo()) !== scopeKey(repo)
      ) {
        return;
      }
      const sum = full?.summary ?? doc.summary ?? "";
      const txt = full?.text ?? "";
      if (this.docSummaryDraft() === initialSummary) {
        this.docSummaryDraft.set(sum);
      }
      if (this.docTextDraft() === initialText) {
        this.docTextDraft.set(txt);
      }
      this.loadedDocSummary.set(sum);
      this.loadedDocText.set(txt);
    } catch (err) {
      if (reqSeq === this.docLoadSeq) {
        this.snackbar.show(errorText(err));
      }
    }
  }

  protected onNewDocNameInput(val: string): void {
    if (!this.canCreateDoc()) return;
    this.newDocNameDraft.set(val);
  }

  protected onDocSummaryInput(val: string): void {
    if (!this.canWriteDoc()) return;
    this.docSummaryDraft.set(val);
  }

  protected onDocTextInput(val: string): void {
    if (!this.canWriteDoc()) return;
    this.docTextDraft.set(val);
  }

  protected revertDocument(): void {
    if (!this.canWriteDoc()) return;
    if (this.creatingDoc()) {
      this.creatingDoc.set(false);
      return;
    }
    this.docSummaryDraft.set(this.loadedDocSummary());
    this.docTextDraft.set(this.loadedDocText());
  }

  protected async saveDocument(): Promise<void> {
    if (!this.canSubmitDocument() || this.savingDoc()) return;
    const repo = (
      this.creatingDoc() ? this.selectedRepo() : this.selectedDocRepo()
    ).trim();
    if (!this.canWriteRoute("PUT /api/memory/documents", repo)) {
      this.snackbar.show(
        this.deniedWriteReason("PUT /api/memory/documents", repo),
      );
      return;
    }
    const name = (
      this.creatingDoc() ? this.newDocNameDraft() : this.selectedDocName()
    ).trim();
    const summary = this.docSummaryDraft().trim();
    const text = this.docTextDraft().trim();

    this.savingDoc.set(true);
    try {
      const saved = await this.api.put<MemoryDocument>(
        "PUT /api/memory/documents",
        undefined,
        { repo, name, summary, text },
      );
      this.creatingDoc.set(false);
      this.selectedDocRepo.set(repo);
      this.selectedDocName.set(saved?.name || name);
      this.loadedDocSummary.set(summary);
      this.loadedDocText.set(text);
      this.docSummaryDraft.set(summary);
      this.docTextDraft.set(text);
      this.snackbar.show(`Saved memory document "${name}".`);
      await this.refreshAll();
    } catch (err) {
      this.snackbar.show(errorText(err));
    } finally {
      this.savingDoc.set(false);
    }
  }

  protected confirmDeleteDocument(): void {
    const name = this.selectedDocName();
    const repo = this.selectedDocRepo().trim();
    if (!name || !this.canWriteRoute("PUT /api/memory/documents", repo)) {
      return;
    }
    this.confirmReq.set({
      title: `Delete memory document "${name}"?`,
      message: `Deletes "${name}" from ${scopeLabel(repo)}. Runs will no longer see it in their prompt index.`,
      accept: "Delete document",
      destructive: true,
      run: async () => {
        if (!this.canWriteRoute("PUT /api/memory/documents", repo)) {
          this.snackbar.show(
            this.deniedWriteReason("PUT /api/memory/documents", repo),
          );
          return;
        }
        await this.api.put("PUT /api/memory/documents", undefined, {
          repo,
          name,
          summary: "",
          text: "",
        });
        this.docLoadSeq++;
        this.clearDocumentEditor();
        this.snackbar.show(`Deleted memory document "${name}".`);
        await this.refreshAll();
      },
    });
  }

  private clearDocumentEditor(): void {
    this.creatingDoc.set(false);
    this.newDocNameDraft.set("");
    this.selectedDocName.set("");
    this.selectedDocRepo.set("");
    this.loadedDocSummary.set("");
    this.loadedDocText.set("");
    this.docSummaryDraft.set("");
    this.docTextDraft.set("");
  }

  private discardUnsavedChanges(): void {
    this.docLoadSeq++;
    this.memoryDrafts.set({});
    this.clearDocumentEditor();
  }

  private unsavedChangesMessage(): string {
    if (this.docDirty()) {
      if (this.creatingDoc()) {
        const draftName = this.newDocNameDraft().trim();
        return draftName
          ? `You have unsaved changes in new memory document "${draftName}". Leave and discard them?`
          : "You have unsaved changes in your new memory document. Leave and discard them?";
      }
      return `You have unsaved changes in memory document "${this.selectedDocName()}". Leave and discard them?`;
    }
    if (this.memoryDirty()) {
      return `You have unsaved changes in Standing Instructions for ${scopeLabel(this.selectedRepo())}. Leave and discard them?`;
    }
    return "You have unsaved changes in Standing Instructions. Leave and discard them?";
  }

  private confirmDiscardIfDirty(): Promise<boolean> {
    if (!this.hasUnsavedChanges()) {
      return Promise.resolve(true);
    }
    if (this.confirmReq() && !this.pendingDiscardResolve) {
      return Promise.resolve(false);
    }
    if (this.pendingDiscardResolve) {
      this.pendingDiscardResolve(false);
      this.pendingDiscardResolve = null;
    }
    return new Promise<boolean>((resolve) => {
      this.pendingDiscardResolve = resolve;
      this.confirmReq.set({
        title: "Discard unsaved changes?",
        message: this.unsavedChangesMessage(),
        accept: "Discard changes",
        destructive: true,
        run: () => {
          this.discardUnsavedChanges();
          return Promise.resolve();
        },
      });
    });
  }

  // Namespace Browser (/api/fs/memory/{path...} & /api/fs/config/{path...})
  private fsRouteKey() {
    return this.fsScheme() === "config"
      ? ("GET /api/fs/config/{path...}" as const)
      : ("GET /api/fs/memory/{path...}" as const);
  }

  private isPermittedMemoryContainerDir(fsPath: string): boolean {
    const segs = (fsPath || "")
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    if (segs.length === 0) return true;
    if (segs[0] !== "repos") return false;
    if (segs.length === 1) return true;
    if (segs.slice(1).some((s) => /\.md$/i.test(s))) return false;
    const dirPrefix = `${segs.slice(1).join("/").toLowerCase()}/`;
    return this.memoryReadLimits().some((repo) =>
      repo.trim().toLowerCase().startsWith(dirPrefix),
    );
  }

  private canReadFsPath(fsPath: string, isFile = false): boolean {
    const route = this.fsRouteKey();
    if (this.fsScheme() === "config") {
      return this.canReadConfigFs();
    }
    const fsRepo = repoFromMemoryFsPath(fsPath);
    if (fsRepo) {
      return this.access.can(route, fsRepo);
    }
    if (this.isMemoryReadRepoLimited()) {
      if (isFile) return false;
      return (
        this.access.can(route) && this.isPermittedMemoryContainerDir(fsPath)
      );
    }
    return this.canGlobalRoute(route);
  }

  private deniedFsPathReason(fsPath: string): string {
    const route = this.fsRouteKey();
    if (this.fsScheme() === "config") {
      const baseReason = this.access.deniedReason(route);
      if (baseReason) return baseReason;
      const settingsLimits = this.settingsReadLimits();
      if (settingsLimits.length > 0) {
        return `Your role ${this.access.roleLabel() || "limited"} holds settings:read only on ${settingsLimits.join(", ")} and cannot read deployment-wide config.`;
      }
      return this.deniedReadReason("");
    }
    const fsRepo = repoFromMemoryFsPath(fsPath);
    if (fsRepo) return this.access.deniedReason(route, fsRepo);
    if (this.isMemoryReadRepoLimited()) {
      return this.deniedReadReason("");
    }
    return this.access.deniedReason(route);
  }

  protected pickFsScheme(s: FsScheme): void {
    if (this.fsScheme() === s) return;
    if (s === "config" && !this.canReadConfigFs()) return;
    this.fsScheme.set(s);
    this.fsDir.set("");
    this.fsSelectedFile.set("");
    this.fsFileContent.set("");
    this.clearFsGrep();
    void this.loadFsDir("");
  }

  protected joinPath(dir: string, name: string): string {
    return dir ? `${dir}/${name}` : name;
  }

  protected openFsDir(dir: string): void {
    this.clearFsGrep();
    void this.loadFsDir(dir);
  }

  protected navigateFsUp(): void {
    const cur = this.fsDir();
    if (!cur) return;
    const idx = cur.lastIndexOf("/");
    this.openFsDir(idx < 0 ? "" : cur.slice(0, idx));
  }

  protected clearFsGrep(): void {
    this.fsGrepSeq++;
    this.fsGrepHits.set(null);
    this.fsGrepTruncated.set(false);
    this.fsGrepNotices.set([]);
  }

  async loadFsDir(dir: string): Promise<void> {
    if (!this.canReadFsPath(dir, false)) {
      this.snackbar.show(this.deniedFsPathReason(dir));
      return;
    }
    const route = this.fsRouteKey();
    this.fsDir.set(dir);
    try {
      const res = await this.api.get<FsListResponse | FsEntry[]>(
        route,
        { path: dir },
        "list=1&format=json",
      );
      const entries = Array.isArray(res) ? res : (res?.entries ?? []);
      const sorted = [...entries].sort((a, b) => {
        if ((a.type === "dir") !== (b.type === "dir")) {
          return a.type === "dir" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      this.fsEntries.set(sorted);
    } catch (err) {
      this.snackbar.show(errorText(err));
    }
  }

  protected onFsEntryClick(entry: FsEntry): void {
    const full = this.joinPath(this.fsDir(), entry.name);
    if (entry.type === "dir") {
      this.openFsDir(full);
    } else {
      void this.openFsFile(full);
    }
  }

  async openFsFile(filePath: string): Promise<void> {
    if (!this.canReadFsPath(filePath, true)) {
      this.snackbar.show(this.deniedFsPathReason(filePath));
      return;
    }
    const route = this.fsRouteKey();
    this.fsSelectedFile.set(filePath);
    try {
      const txt = await this.api.getText(route, { path: filePath });
      this.fsFileContent.set(txt ?? "");
    } catch (err) {
      this.fsFileContent.set(`Error reading ${filePath}: ${errorText(err)}`);
    }
  }

  private sanitizeGrepNotice(notice: string, grepDir: string): string {
    if (!this.isMemoryReadRepoLimited()) return notice;
    const m = /\bstopped at ([^;\]]+)/i.exec(notice);
    if (!m) return notice;
    const rawPath = m[1].trim();
    const clean = rawPath.replace(/^\/+|\/+$/g, "");
    const isFile = !rawPath.endsWith("/") && /\.[^/]+$/.test(clean);
    const candidates = [clean];
    if (grepDir && !clean.startsWith(`${grepDir}/`) && clean !== grepDir) {
      candidates.push(this.joinPath(grepDir, clean));
    }
    if (candidates.some((p) => this.canReadFsPath(p, isFile))) {
      return notice;
    }
    return "[truncated: walked entry limit reached; narrow the directory path to search the rest]";
  }

  protected async runFsGrep(): Promise<void> {
    const q = this.fsGrepQuery().trim();
    if (!q) {
      this.clearFsGrep();
      return;
    }
    const dir = this.fsDir();
    if (!this.canReadFsPath(dir, false)) {
      this.snackbar.show(this.deniedFsPathReason(dir));
      return;
    }
    const grepDir =
      this.fsScheme() === "memory" && !dir && this.isMemoryReadRepoLimited()
        ? "repos"
        : dir;
    const route = this.fsRouteKey();
    const params = new URLSearchParams();
    params.set("grep", q);
    params.set("i", "1");
    params.set("n", "1");
    const reqSeq = ++this.fsGrepSeq;
    try {
      let raw = "";
      let headerTruncated = false;
      let headerWalkTruncated = false;
      let headerMatches: number | null = null;
      if (typeof this.api.getTextResponse === "function") {
        const res = await this.api.getTextResponse(
          route,
          { path: grepDir },
          params.toString(),
        );
        raw = res?.body ?? "";
        headerTruncated =
          res?.headers?.get("X-Grain-Truncated")?.trim().toLowerCase() ===
          "true";
        headerWalkTruncated =
          res?.headers?.get("X-Grain-Walk-Truncated")?.trim().toLowerCase() ===
          "true";
        const mRaw = res?.headers?.get("X-Grain-Matches")?.trim();
        if (mRaw && /^\d+$/.test(mRaw)) {
          headerMatches = Number(mRaw);
        }
      } else {
        raw =
          (await this.api.getText(
            route,
            { path: grepDir },
            params.toString(),
          )) ?? "";
      }
      if (reqSeq !== this.fsGrepSeq) return;
      const parsed = parseGrepResult(raw, grepDir);
      const hits = parsed.hits.filter((h) => this.canReadFsPath(h.file, true));
      const walkTruncated = headerWalkTruncated || parsed.walkTruncated;
      const truncated = headerTruncated || walkTruncated || parsed.truncated;
      const notices = parsed.notices.map((n) =>
        this.sanitizeGrepNotice(n, grepDir),
      );
      if (truncated && notices.length === 0) {
        notices.push(buildGrepTruncationNotice(walkTruncated, headerMatches));
      }
      this.fsGrepHits.set(hits);
      this.fsGrepTruncated.set(truncated);
      this.fsGrepNotices.set(notices);
    } catch (err) {
      if (reqSeq !== this.fsGrepSeq) return;
      this.snackbar.show(errorText(err));
    }
  }

  protected copyFsContent(): void {
    void this.doc.defaultView?.navigator?.clipboard
      ?.writeText(this.fsFileContent())
      .then(() => this.snackbar.show("Copied file contents."))
      .catch(() => this.snackbar.show("Copied file contents."));
  }

  protected async onConfirmDone(accepted: boolean): Promise<void> {
    const req = this.confirmReq();
    const resolve = this.pendingDiscardResolve;
    this.confirmReq.set(null);
    this.pendingDiscardResolve = null;
    if (!accepted || !req) {
      resolve?.(false);
      return;
    }
    try {
      await req.run();
      resolve?.(true);
    } catch (err) {
      this.snackbar.show(errorText(err));
      resolve?.(false);
    }
  }

  protected toggleRepoMenu(ev: Event): void {
    ev.stopPropagation();
    this.repoMenuOpen.update((v) => !v);
  }

  protected onRepoTriggerKeydown(ev: KeyboardEvent): void {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    if (!this.repoMenuOpen()) {
      this.repoMenuOpen.set(true);
    }
    const wantLast = ev.key === "ArrowUp";
    setTimeout(() => {
      const opts = this.enabledListboxOptions();
      const target = wantLast ? opts[opts.length - 1] : opts[0];
      target?.focus();
    });
  }

  protected onListboxKeydown(ev: KeyboardEvent): void {
    const opts = this.enabledListboxOptions();
    if (opts.length === 0) return;
    const cur = opts.indexOf(this.doc.activeElement as HTMLButtonElement);
    let next = -1;
    if (ev.key === "ArrowDown") {
      next = cur < 0 ? 0 : (cur + 1) % opts.length;
    } else if (ev.key === "ArrowUp") {
      next = cur <= 0 ? opts.length - 1 : cur - 1;
    } else if (ev.key === "Home") {
      next = 0;
    } else if (ev.key === "End") {
      next = opts.length - 1;
    }
    if (next >= 0) {
      ev.preventDefault();
      opts[next]?.focus();
    }
  }

  private enabledListboxOptions(): HTMLButtonElement[] {
    const el = this.repoListbox()?.nativeElement;
    if (!el) return [];
    return Array.from(
      el.querySelectorAll<HTMLButtonElement>(
        'button[role="option"]:not(:disabled)',
      ),
    );
  }

  protected onDocClick(ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (this.repoMenuOpen() && !t?.closest(".pop-wrap")) {
      this.repoMenuOpen.set(false);
    }
  }

  protected onEscape(ev: Event): void {
    if (this.confirmReq()) {
      ev.preventDefault();
      void this.onConfirmDone(false);
      return;
    }
    if (this.repoMenuOpen()) {
      ev.preventDefault();
      this.repoMenuOpen.set(false);
      this.repoTrigger()?.nativeElement.focus();
    }
  }
}
