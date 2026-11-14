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
  NgZone,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { DomSanitizer, type SafeHtml } from "@angular/platform-browser";
import { GrainApi } from "../api/grain-api.service";
import type {
  Comment,
  MemoryDocument,
  MemoryDocumentsResponse,
  TreeNode,
  WorkTree,
} from "../api/models";
import { AccessService } from "../services/access.service";
import { isTypingTarget } from "../services/keyboard.service";
import { SnackbarService } from "../services/snackbar.service";
import { MarkdownDirective } from "../shared/code-highlight";
import {
  ConfirmDialogComponent,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import {
  extractSessionArtifacts,
  wrapSandboxedHtml,
} from "./session-artifacts";
import { errorText } from "./session-helpers";
import { SessionsStore } from "./sessions.store";

export type CanvasTab = "docs" | "html" | "plan" | "memory";

@Component({
  selector: "g-session-canvas",
  imports: [RouterLink, MarkdownDirective, ConfirmDialogComponent],
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./session-canvas.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(keydown.escape)": "onEscape($event)",
    "(document:keydown.escape)": "onEscape($event)",
    "(focusin)": "onHostFocusIn($event)",
  },
  template: `
    <aside
      #canvasAside
      class="session-canvas"
      aria-label="Session artifacts and workspace canvas"
      data-testid="session-canvas"
      [attr.inert]="confirmReq() ? '' : null"
    >
      <header class="canvas-head">
        <div class="canvas-tabs" role="tablist" aria-label="Artifact types">
          <button
            type="button"
            role="tab"
            class="canvas-tab"
            data-testid="canvas-tab-docs"
            [class.is-active]="activeTab() === 'docs'"
            [attr.aria-selected]="activeTab() === 'docs'"
            (click)="activeTab.set('docs')"
          >
            Docs ({{ artifacts().docs.length }})
          </button>
          <button
            type="button"
            role="tab"
            class="canvas-tab"
            data-testid="canvas-tab-html"
            [class.is-active]="activeTab() === 'html'"
            [attr.aria-selected]="activeTab() === 'html'"
            (click)="activeTab.set('html')"
          >
            HTML Mock ({{ artifacts().htmlMocks.length }})
          </button>
          <button
            type="button"
            role="tab"
            class="canvas-tab"
            data-testid="canvas-tab-plan"
            [class.is-active]="activeTab() === 'plan'"
            [attr.aria-selected]="activeTab() === 'plan'"
            (click)="activeTab.set('plan')"
          >
            Workstream ({{ planBadgeCount() }})
          </button>
          @if (canReadMemory()) {
            <button
              type="button"
              role="tab"
              class="canvas-tab"
              data-testid="canvas-tab-memory"
              [class.is-active]="activeTab() === 'memory'"
              [attr.aria-selected]="activeTab() === 'memory'"
              (click)="openMemoryTab()"
            >
              Memory ({{ memoryDocs().length }})
            </button>
          }
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close workspace canvas"
          data-testid="canvas-close"
          (click)="requestClose(true)"
        >
          ✕
        </button>
      </header>

      <div class="canvas-body">
        @switch (activeTab()) {
          @case ("docs") {
            @if (artifacts().docs.length === 0) {
              <p class="canvas-empty">
                Markdown proposals, specs, or <code>grain-doc</code> fences
                shared in this conversation appear here for reading and pinning
                to Memory.
              </p>
            } @else {
              @if (artifacts().docs.length > 1) {
                <div class="canvas-selector">
                  @for (d of artifacts().docs; track d.id) {
                    <button
                      type="button"
                      class="canvas-chip"
                      [class.is-active]="activeDocId() === d.id"
                      (click)="selectDoc(d.id)"
                    >
                      {{ d.title }}
                    </button>
                  }
                </div>
              }
              @if (selectedDoc(); as doc) {
                <div class="canvas-card">
                  <div class="canvas-toolbar">
                    <strong>{{ doc.title }}</strong>
                    @if (canWriteMemory()) {
                      <button
                        #pinToggleBtn
                        type="button"
                        class="btn-outlined"
                        data-testid="canvas-pin-memory-toggle"
                        (click)="togglePinForm(doc)"
                      >
                        {{ pinOpen() ? "Cancel" : "Pin to Memory" }}
                      </button>
                    }
                  </div>
                  @if (pinOpen()) {
                    <form
                      class="canvas-pin-form"
                      (submit)="pinDoc($event, doc)"
                    >
                      <input
                        type="text"
                        data-testid="pin-memory-name"
                        placeholder="Document slug (e.g. rollout-spec)"
                        [value]="pinName()"
                        (input)="pinName.set($any($event.target).value)"
                      />
                      <input
                        type="text"
                        data-testid="pin-memory-summary"
                        placeholder="One-line summary carried in future prompts"
                        [value]="pinSummary()"
                        (input)="pinSummary.set($any($event.target).value)"
                      />
                      <div class="canvas-toolbar">
                        <span class="muted" style="font-size: 11px">{{
                          repo() || "Deployment memory"
                        }}</span>
                        <div class="canvas-btn-group">
                          @if (pinDirty()) {
                            <span
                              class="status-pill blast"
                              data-testid="canvas-pin-dirty"
                              >Unsaved</span
                            >
                          }
                          <button
                            type="submit"
                            class="btn-primary"
                            data-testid="pin-memory-save"
                            [disabled]="
                              pinBusy() ||
                              !pinName().trim() ||
                              !pinSummary().trim()
                            "
                          >
                            {{ pinBusy() ? "Saving..." : "Save to Memory" }}
                          </button>
                        </div>
                      </div>
                    </form>
                  }
                  <div
                    class="canvas-markdown-wrap"
                    data-testid="canvas-doc-markdown"
                  >
                    <div class="msg-body" [gMarkdown]="doc.markdown"></div>
                  </div>
                </div>
              }
            }
          }

          @case ("html") {
            @if (artifacts().htmlMocks.length === 0) {
              <p class="canvas-empty">
                Fenced <code>html</code> or <code>grain-html</code> blocks in
                this conversation render here inside a network-isolated
                sandboxed preview.
              </p>
            } @else {
              @if (artifacts().htmlMocks.length > 1) {
                <div class="canvas-selector">
                  @for (h of artifacts().htmlMocks; track h.id) {
                    <button
                      type="button"
                      class="canvas-chip"
                      [class.is-active]="activeHtmlId() === h.id"
                      (click)="selectedHtmlId.set(h.id)"
                    >
                      {{ h.title }}
                    </button>
                  }
                </div>
              }
              @if (selectedHtml(); as mock) {
                <div class="canvas-toolbar">
                  <div class="canvas-btn-group">
                    <button
                      type="button"
                      class="canvas-chip"
                      data-testid="html-mode-preview"
                      [class.is-active]="htmlView() === 'preview'"
                      (click)="htmlView.set('preview')"
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      class="canvas-chip"
                      data-testid="html-mode-source"
                      [class.is-active]="htmlView() === 'source'"
                      (click)="htmlView.set('source')"
                    >
                      Source
                    </button>
                  </div>
                  <div class="canvas-btn-group">
                    <button
                      type="button"
                      class="canvas-chip"
                      data-testid="html-theme-toggle"
                      (click)="
                        htmlTheme.set(
                          htmlTheme() === 'light' ? 'dark' : 'light'
                        )
                      "
                    >
                      Theme: {{ htmlTheme() }}
                    </button>
                  </div>
                </div>
                @if (htmlView() === "preview") {
                  <div
                    class="canvas-preview-wrap"
                    data-testid="canvas-preview-wrap"
                  >
                    <iframe
                      class="canvas-iframe"
                      data-testid="canvas-html-iframe"
                      sandbox="allow-scripts"
                      [attr.title]="mock.title"
                      [srcdoc]="safeSrcdoc()"
                    ></iframe>
                  </div>
                } @else {
                  <pre class="canvas-source" data-testid="canvas-html-source">{{
                    mock.html
                  }}</pre>
                }
              }
            }
          }

          @case ("plan") {
            @if (
              artifacts().plans.length === 0 && proposedTreeNodes().length === 0
            ) {
              <p class="canvas-empty">
                Ask the session to break a feature into a
                <code>grain-plan</code>
                block or propose child tasks to review the DAG and launch a
                Workstream directly from here.
              </p>
            } @else {
              @for (p of artifacts().plans; track p.id) {
                <div class="canvas-card" data-testid="canvas-plan-card">
                  <div class="canvas-toolbar">
                    <strong>{{ p.plan.title || "Proposed Workstream" }}</strong>
                    @if (p.plan.repo) {
                      <span class="status-pill neutral">{{ p.plan.repo }}</span>
                    }
                  </div>
                  @if (p.plan.summary) {
                    <p class="muted" style="margin: 0; font-size: 12.5px">
                      {{ p.plan.summary }}
                    </p>
                  }
                  @for (t of p.plan.tasks; track t.title) {
                    <div class="plan-node" data-testid="plan-node">
                      <span>{{ t.title }}</span>
                      @if (t.dependsOn?.length) {
                        <span class="muted mono" style="font-size: 11px"
                          >after {{ t.dependsOn?.join(", ") }}</span
                        >
                      }
                    </div>
                  }
                  @if (canLaunchTasks()) {
                    <div class="canvas-toolbar">
                      <span class="muted" style="font-size: 11.5px"
                        >{{ p.plan.tasks.length }} task{{
                          p.plan.tasks.length === 1 ? "" : "s"
                        }}</span
                      >
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="canvas-launch-plan"
                        [disabled]="sessions.isBusy('launch-plan')"
                        (click)="launchPlan(p.plan)"
                      >
                        {{
                          sessions.isBusy("launch-plan")
                            ? "Launching..."
                            : "Approve & Launch Workstream"
                        }}
                      </button>
                    </div>
                  }
                </div>
              }

              @if (proposedTreeNodes().length > 0) {
                <div class="canvas-card" data-testid="canvas-tree-proposals">
                  <div class="canvas-toolbar">
                    <strong>Pending task proposals</strong>
                    @if (canApproveProposals()) {
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="canvas-approve-proposals"
                        [disabled]="treeBusy()"
                        (click)="approveTreeProposals()"
                      >
                        {{
                          treeBusy()
                            ? "Approving..."
                            : "Approve " + proposedTreeNodes().length
                        }}
                      </button>
                    }
                  </div>
                  @for (n of proposedTreeNodes(); track n.id) {
                    <div class="plan-node">
                      <a
                        [routerLink]="['/task', n.id]"
                        (click)="onTaskLinkClick($event, n.id)"
                        >#{{ n.id }} · {{ n.title }}</a
                      >
                      <span class="status-pill neutral">{{ n.status }}</span>
                    </div>
                  }
                </div>
              }
            }
          }

          @case ("memory") {
            @if (memoryError(); as err) {
              <p class="banner banner-error" role="alert">{{ err }}</p>
            }
            @if (memoryDocs().length === 0) {
              <p class="canvas-empty">No Memory documents saved yet.</p>
            } @else {
              <div class="canvas-selector">
                @for (m of memoryDocs(); track m.name + (m.repo || "")) {
                  <button
                    type="button"
                    class="canvas-chip"
                    [class.is-active]="isActiveMemoryDoc(m)"
                    (click)="selectMemoryDoc(m)"
                  >
                    {{ m.repo ? m.repo + " / " : "" }}{{ m.name }}
                  </button>
                }
              </div>
              @if (activeMemDoc(); as mdoc) {
                <div class="canvas-card" data-testid="canvas-memory-editor">
                  <div class="canvas-toolbar">
                    <strong>{{ mdoc.name }}</strong>
                    <div class="canvas-btn-group">
                      @if (memDirty()) {
                        <span
                          class="status-pill blast"
                          data-testid="canvas-memory-dirty"
                          >Unsaved</span
                        >
                      }
                      <span class="muted" style="font-size: 11px">{{
                        mdoc.repo || "deployment"
                      }}</span>
                    </div>
                  </div>
                  @if (canWriteMemory()) {
                    <form
                      class="canvas-pin-form"
                      (submit)="saveMemoryDoc($event)"
                    >
                      <input
                        type="text"
                        aria-label="Memory summary"
                        data-testid="canvas-memory-summary"
                        [value]="memSummary()"
                        (input)="memSummary.set($any($event.target).value)"
                      />
                      <textarea
                        rows="8"
                        aria-label="Memory document text"
                        data-testid="canvas-memory-text"
                        [value]="memText()"
                        (input)="memText.set($any($event.target).value)"
                      ></textarea>
                      <div class="canvas-toolbar">
                        <span class="muted" style="font-size: 11px"
                          >{{ memText().length }} chars</span
                        >
                        <button
                          type="submit"
                          class="btn-primary"
                          data-testid="canvas-memory-save"
                          [disabled]="pinBusy()"
                        >
                          {{ pinBusy() ? "Saving..." : "Save Memory doc" }}
                        </button>
                      </div>
                    </form>
                  } @else {
                    <div
                      class="canvas-markdown-wrap"
                      data-testid="canvas-memory-markdown"
                    >
                      <div class="msg-body" [gMarkdown]="memText()"></div>
                    </div>
                  }
                </div>
              }
            }
          }
        }
      </div>
    </aside>

    @if (confirmReq(); as req) {
      <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
    }
  `,
})
export class SessionCanvasComponent implements OnInit, OnDestroy {
  protected readonly sessions = inject(SessionsStore);
  private readonly api = inject(GrainApi);
  private readonly access = inject(AccessService);
  private readonly snackbar = inject(SnackbarService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly doc = inject(DOCUMENT);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  readonly sessionTaskId = input<string | undefined>(undefined);
  readonly repo = input<string | undefined>(undefined);
  readonly comments = input<Comment[]>([]);
  readonly requestedTab = input<CanvasTab | null>(null);
  readonly requestedArtifactId = input<string | null>(null);
  readonly returnFocusTo = input<HTMLElement | null>(null);

  readonly closed = output<void>();

  private readonly canvasAside =
    viewChild<ElementRef<HTMLElement>>("canvasAside");
  private readonly pinToggleBtn =
    viewChild<ElementRef<HTMLButtonElement>>("pinToggleBtn");

  protected readonly activeTab = signal<CanvasTab>("docs");
  protected readonly selectedDocId = signal<string | null>(null);
  protected readonly selectedHtmlId = signal<string | null>(null);
  protected readonly htmlView = signal<"preview" | "source">("preview");
  protected readonly htmlTheme = signal<"light" | "dark">("light");

  protected readonly pinOpen = signal(false);
  protected readonly pinName = signal("");
  protected readonly pinSummary = signal("");
  protected readonly pinBusy = signal(false);
  private readonly pinBaselineName = signal("");
  private readonly pinBaselineSummary = signal("");
  private readonly pinTargetDocId = signal("");

  protected readonly treeNodes = signal<TreeNode[]>([]);
  protected readonly treeBusy = signal(false);

  protected readonly memoryDocs = signal<MemoryDocument[]>([]);
  protected readonly memoryError = signal<string | null>(null);
  protected readonly activeMemDoc = signal<MemoryDocument | null>(null);
  protected readonly activeMemName = signal<string>("");
  protected readonly memSummary = signal("");
  protected readonly memText = signal("");
  private readonly memBaselineSummary = signal("");
  private readonly memBaselineText = signal("");

  protected readonly confirmReq = signal<ConfirmRequest | null>(null);

  private previousFocus: HTMLElement | null = null;
  private pinOpener: HTMLElement | null = null;
  private confirmReturnFocus: HTMLElement | null = null;
  private lastHandledEscape: Event | null = null;
  private lastSessionTaskId: string | undefined;

  private readonly onDocFocusIn = (ev: FocusEvent): void => {
    if (this.isValidReturnTarget(ev.target)) {
      this.previousFocus = ev.target;
    }
  };

  protected readonly artifacts = computed(() =>
    extractSessionArtifacts(this.comments()),
  );

  protected readonly proposedTreeNodes = computed(() => {
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (!n.root && n.status === "proposed") out.push(n);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(this.treeNodes());
    return out;
  });

  protected readonly planBadgeCount = computed(
    () => this.artifacts().plans.length + this.proposedTreeNodes().length,
  );

  protected readonly selectedDoc = computed(() => {
    const list = this.artifacts().docs;
    const picked = this.selectedDocId();
    return (
      (picked ? list.find((d) => d.id === picked) : undefined) ??
      list[list.length - 1] ??
      null
    );
  });

  protected readonly selectedHtml = computed(() => {
    const list = this.artifacts().htmlMocks;
    const picked = this.selectedHtmlId();
    return (
      (picked ? list.find((h) => h.id === picked) : undefined) ??
      list[list.length - 1] ??
      null
    );
  });

  protected readonly activeDocId = computed(() => this.selectedDoc()?.id ?? "");
  protected readonly activeHtmlId = computed(
    () => this.selectedHtml()?.id ?? "",
  );

  protected readonly wrappedSrcdoc = computed(() => {
    const mock = this.selectedHtml();
    return mock ? wrapSandboxedHtml(mock.html, this.htmlTheme()) : "";
  });

  // Safe: rendered only inside <iframe sandbox="allow-scripts"> (opaque null origin,
  // no allow-same-origin, strict CSP connect-src 'none').
  protected readonly safeSrcdoc = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.wrappedSrcdoc()),
  );

  protected readonly canReadMemory = computed(() => {
    const r = this.repo();
    return r
      ? this.access.can("GET /api/memory/documents", r)
      : this.access.canGlobalScope("memory:read");
  });
  protected readonly canWriteMemory = computed(() => {
    const r = this.repo();
    return r
      ? this.access.can("PUT /api/memory/documents", r)
      : this.access.canGlobalScope("memory:write");
  });
  protected readonly canLaunchTasks = computed(() => {
    const r = this.repo();
    return r
      ? this.access.can("POST /api/tasks", r)
      : this.access.canGlobalScope("tasks:write");
  });
  protected readonly canApproveProposals = computed(() => {
    const r = this.repo();
    return r
      ? this.access.can("POST /api/tasks/{id}/approve", r)
      : this.access.canGlobalScope("tasks:admin");
  });

  readonly pinDirty = computed(
    () =>
      this.canWriteMemory() &&
      this.pinOpen() &&
      (this.pinName() !== this.pinBaselineName() ||
        this.pinSummary() !== this.pinBaselineSummary()),
  );

  readonly memDirty = computed(
    () =>
      this.canWriteMemory() &&
      !!this.activeMemDoc() &&
      (this.memSummary() !== this.memBaselineSummary() ||
        this.memText() !== this.memBaselineText()),
  );

  readonly hasUnsavedChanges = computed(
    () => this.pinDirty() || this.memDirty(),
  );

  constructor() {
    const active = this.doc.activeElement;
    if (this.isValidReturnTarget(active)) {
      this.previousFocus = active;
    }

    effect(() => {
      const tab = this.requestedTab();
      const aid = this.requestedArtifactId();
      untracked(() => {
        if (tab) this.activeTab.set(tab);
        if (aid) {
          if (tab === "html") this.selectedHtmlId.set(aid);
          if (tab === "docs") this.selectDoc(aid);
        }
      });
    });

    effect(() => {
      const tid = this.sessionTaskId();
      untracked(() => {
        if (
          this.lastSessionTaskId !== undefined &&
          tid !== this.lastSessionTaskId
        ) {
          this.closePinForm(false);
          this.selectedDocId.set(null);
          this.selectedHtmlId.set(null);
          this.confirmReq.set(null);
          this.confirmReturnFocus = null;
        }
        this.lastSessionTaskId = tid;
        if (tid) {
          void this.loadTree(tid);
        } else {
          this.treeNodes.set([]);
        }
      });
    });
  }

  ngOnInit(): void {
    if (
      !this.previousFocus &&
      this.isValidReturnTarget(this.doc.activeElement)
    ) {
      this.previousFocus = this.doc.activeElement;
    }
    this.zone.runOutsideAngular(() => {
      this.doc.addEventListener("focusin", this.onDocFocusIn, true);
    });
    if (this.canReadMemory()) {
      void this.loadMemoryDocs();
    }
  }

  ngOnDestroy(): void {
    this.doc.removeEventListener("focusin", this.onDocFocusIn, true);
  }

  requestClose(restoreFocus = true): void {
    if (this.confirmReq()) return;
    if (this.hasUnsavedChanges()) {
      this.openConfirm({
        title: "Discard unsaved canvas changes?",
        message: this.unsavedDiscardMessage("Closing the canvas"),
        accept: "Discard",
        destructive: true,
        run: async () => {
          this.discardUnsavedState();
          this.emitClosed(restoreFocus);
        },
      });
      return;
    }
    this.emitClosed(restoreFocus);
  }

  requestOpenArtifact(tab: CanvasTab, id: string, apply: () => void): void {
    const switchArtifact = () => {
      this.activeTab.set(tab);
      if (tab === "docs") this.selectedDocId.set(id);
      if (tab === "html") this.selectedHtmlId.set(id);
      apply();
    };
    if (
      tab === "docs" &&
      this.pinOpen() &&
      id !== this.activeDocId() &&
      this.pinDirty()
    ) {
      this.openConfirm({
        title: "Discard Pin to Memory draft?",
        message:
          "Switching documents will discard your unsaved edits in the Pin to Memory form.",
        accept: "Discard",
        destructive: true,
        run: async () => {
          this.closePinForm(false);
          switchArtifact();
        },
      });
      return;
    }
    if (tab === "docs" && this.pinOpen() && id !== this.activeDocId()) {
      this.closePinForm(false);
    }
    switchArtifact();
  }

  confirmDiscard(onDiscard: () => void): void {
    if (!this.hasUnsavedChanges()) {
      onDiscard();
      return;
    }
    this.openConfirm({
      title: "Discard unsaved canvas changes?",
      message: this.unsavedDiscardMessage("Leaving this session"),
      accept: "Discard",
      destructive: true,
      run: async () => {
        this.discardUnsavedState();
        onDiscard();
      },
    });
  }

  protected onHostFocusIn(ev: FocusEvent): void {
    if (this.isValidReturnTarget(ev.relatedTarget)) {
      this.previousFocus = ev.relatedTarget;
    }
  }

  protected onEscape(ev: Event): void {
    if (ev.defaultPrevented || this.lastHandledEscape === ev) return;
    if (this.hasHigherOverlay()) return;
    const target = ev.target as Node | null;
    const insideCanvas = !!(
      target && this.hostEl.nativeElement.contains(target)
    );
    if (this.confirmReq()) {
      this.lastHandledEscape = ev;
      ev.preventDefault();
      ev.stopPropagation();
      void this.onConfirmDone(false);
      return;
    }
    if (!insideCanvas && isTypingTarget(ev.target)) {
      return;
    }
    if (this.activeTab() === "docs" && this.pinOpen()) {
      this.lastHandledEscape = ev;
      ev.preventDefault();
      ev.stopPropagation();
      this.requestClosePinForm(true);
      return;
    }
    this.lastHandledEscape = ev;
    ev.preventDefault();
    ev.stopPropagation();
    this.requestClose(true);
  }

  protected async onConfirmDone(ok: boolean): Promise<void> {
    const req = this.confirmReq();
    const back = this.confirmReturnFocus;
    this.confirmReq.set(null);
    this.confirmReturnFocus = null;
    this.canvasAside()?.nativeElement.removeAttribute("inert");
    if (!ok) {
      if (back?.isConnected) {
        back.focus();
      }
      return;
    }
    if (req) {
      await req.run();
    }
  }

  private openConfirm(req: ConfirmRequest): void {
    const active = this.doc.activeElement;
    this.confirmReturnFocus =
      active instanceof HTMLElement &&
      active !== this.doc.body &&
      !active.closest('[data-testid="confirm-dialog"]')
        ? active
        : null;
    this.confirmReq.set(req);
  }

  private isValidReturnTarget(el: EventTarget | null): el is HTMLElement {
    return (
      el instanceof HTMLElement &&
      el !== this.doc.body &&
      el !== this.doc.documentElement &&
      !this.hostEl.nativeElement.contains(el)
    );
  }

  private hasHigherOverlay(): boolean {
    const host = this.hostEl.nativeElement;
    const modals = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[aria-modal="true"], dialog[open]',
      ),
    );
    for (const m of modals) {
      if (!host.contains(m)) {
        return true;
      }
    }
    if (
      this.doc.querySelector(
        "#create-menu, #rail-more-menu, #more-sheet, #account-popover, .pill-select-menu, #director-drawer:not([hidden])",
      )
    ) {
      return true;
    }
    return false;
  }

  private unsavedDiscardMessage(actionLabel: string): string {
    const hasPin = this.pinDirty();
    const hasMem = this.memDirty();
    const memName = this.activeMemDoc()?.name;
    if (hasPin && hasMem) {
      return `You have unsaved Pin to Memory edits and changes to "${memName ?? "Memory"}". ${actionLabel} will discard them.`;
    }
    if (hasMem) {
      return `You have unsaved changes to "${memName ?? "this Memory document"}". ${actionLabel} will discard them.`;
    }
    return `You have unsaved edits in the Pin to Memory form. ${actionLabel} will discard them.`;
  }

  private discardUnsavedState(): void {
    this.closePinForm(false);
    if (this.memDirty()) {
      this.memSummary.set(this.memBaselineSummary());
      this.memText.set(this.memBaselineText());
    }
  }

  private emitClosed(restoreFocus: boolean): void {
    if (restoreFocus) {
      this.restoreCanvasFocus();
    }
    this.closed.emit();
  }

  private restoreCanvasFocus(): void {
    const target =
      (this.previousFocus?.isConnected ? this.previousFocus : null) ??
      (this.returnFocusTo()?.isConnected ? this.returnFocusTo() : null);
    target?.focus();
  }

  private async loadTree(id: string): Promise<void> {
    if (typeof this.api.get !== "function") return;
    try {
      const res = await this.api.get<WorkTree>("GET /api/tasks/{id}/tree", {
        id,
      });
      if (this.sessionTaskId() === id) {
        this.treeNodes.set(res?.nodes ?? []);
      }
    } catch {
      // Optional tree read.
    }
  }

  protected openMemoryTab(): void {
    this.activeTab.set("memory");
    if (this.canReadMemory()) {
      void this.loadMemoryDocs();
    }
  }

  private async loadMemoryDocs(): Promise<void> {
    if (typeof this.api.get !== "function") return;
    try {
      const res = await this.api.get<MemoryDocumentsResponse>(
        "GET /api/memory/documents",
      );
      this.memoryDocs.set(res?.documents ?? []);
      this.memoryError.set(null);
    } catch (err) {
      this.memoryError.set(errorText(err));
    }
  }

  protected isActiveMemoryDoc(doc: MemoryDocument): boolean {
    const cur = this.activeMemDoc();
    if (!cur) return this.activeMemName() === doc.name;
    return cur.name === doc.name && (cur.repo || "") === (doc.repo || "");
  }

  protected selectDoc(docId: string): void {
    if (docId === this.activeDocId()) return;
    if (this.pinDirty()) {
      this.openConfirm({
        title: "Discard Pin to Memory draft?",
        message:
          "Switching documents will discard your unsaved edits in the Pin to Memory form.",
        accept: "Discard",
        destructive: true,
        run: async () => {
          this.closePinForm(false);
          this.selectedDocId.set(docId);
        },
      });
      return;
    }
    if (this.pinOpen()) {
      this.closePinForm(false);
    }
    this.selectedDocId.set(docId);
  }

  protected selectMemoryDoc(doc: MemoryDocument): void {
    if (this.isActiveMemoryDoc(doc)) return;
    if (this.memDirty()) {
      const curName = this.activeMemDoc()?.name ?? "this document";
      this.openConfirm({
        title: "Discard unsaved Memory changes?",
        message: `You have unsaved changes to "${curName}". Switching documents will discard them.`,
        accept: "Discard",
        destructive: true,
        run: () => this.loadSelectedMemoryDoc(doc),
      });
      return;
    }
    void this.loadSelectedMemoryDoc(doc);
  }

  private async loadSelectedMemoryDoc(doc: MemoryDocument): Promise<void> {
    this.activeMemName.set(doc.name);
    this.activeMemDoc.set(doc);
    this.memBaselineSummary.set(doc.summary);
    this.memBaselineText.set(doc.text ?? "");
    this.memSummary.set(doc.summary);
    this.memText.set(doc.text ?? "");
    if (typeof this.api.get !== "function") return;
    try {
      const full = await this.api.get<MemoryDocument>(
        "GET /api/memory/documents/{name}",
        { name: doc.name },
        doc.repo ? `repo=${encodeURIComponent(doc.repo)}` : undefined,
      );
      if (full && this.isActiveMemoryDoc(doc) && !this.memDirty()) {
        const nextSummary = full.summary || doc.summary;
        const nextText = full.text ?? "";
        this.activeMemDoc.set(full);
        this.memBaselineSummary.set(nextSummary);
        this.memBaselineText.set(nextText);
        this.memSummary.set(nextSummary);
        this.memText.set(nextText);
      }
    } catch {
      // Keep cached index metadata on read failure.
    }
  }

  protected togglePinForm(doc: {
    id?: string;
    title: string;
    summary: string;
  }): void {
    if (this.pinOpen()) {
      this.requestClosePinForm(true);
      return;
    }
    const active = this.doc.activeElement;
    this.pinOpener =
      active instanceof HTMLElement &&
      this.hostEl.nativeElement.contains(active)
        ? active
        : (this.pinToggleBtn()?.nativeElement ?? null);
    const slug =
      doc.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "session-note";
    const summary = doc.summary || doc.title;
    if (doc.id) {
      this.selectedDocId.set(doc.id);
      this.pinTargetDocId.set(doc.id);
    }
    this.pinBaselineName.set(slug);
    this.pinBaselineSummary.set(summary);
    this.pinName.set(slug);
    this.pinSummary.set(summary);
    this.pinOpen.set(true);
  }

  private requestClosePinForm(restoreFocus: boolean): void {
    if (!this.pinOpen()) return;
    if (this.pinDirty()) {
      this.openConfirm({
        title: "Discard Pin to Memory draft?",
        message:
          "You have unsaved edits in the Pin to Memory form. Cancelling will discard them.",
        accept: "Discard",
        destructive: true,
        run: async () => {
          this.closePinForm(restoreFocus);
        },
      });
      return;
    }
    this.closePinForm(restoreFocus);
  }

  private closePinForm(restoreFocus: boolean): void {
    const opener = this.pinOpener;
    this.pinOpener = null;
    this.pinOpen.set(false);
    this.pinName.set("");
    this.pinSummary.set("");
    this.pinBaselineName.set("");
    this.pinBaselineSummary.set("");
    this.pinTargetDocId.set("");
    if (restoreFocus) {
      const target =
        (opener?.isConnected ? opener : null) ??
        this.pinToggleBtn()?.nativeElement ??
        null;
      target?.focus();
    }
  }

  protected async pinDoc(ev: Event, doc: { markdown: string }): Promise<void> {
    ev.preventDefault();
    if (this.pinBusy()) return;
    this.pinBusy.set(true);
    const pinnedName = this.pinName().trim();
    try {
      await this.api.put("PUT /api/memory/documents", undefined, {
        ...(this.repo() ? { repo: this.repo() } : {}),
        name: pinnedName,
        summary: this.pinSummary().trim(),
        text: doc.markdown,
      });
      this.closePinForm(false);
      this.snackbar.show(`Pinned "${pinnedName}" to Memory`);
      void this.loadMemoryDocs();
    } catch (err) {
      this.snackbar.show(`Could not pin Memory document: ${errorText(err)}`);
    } finally {
      this.pinBusy.set(false);
    }
  }

  protected async saveMemoryDoc(ev: Event): Promise<void> {
    ev.preventDefault();
    const doc = this.activeMemDoc();
    if (!doc || this.pinBusy()) return;
    this.pinBusy.set(true);
    const savedSummary = this.memSummary().trim() || doc.summary;
    const savedText = this.memText();
    try {
      await this.api.put("PUT /api/memory/documents", undefined, {
        ...(doc.repo ? { repo: doc.repo } : {}),
        name: doc.name,
        summary: savedSummary,
        text: savedText,
      });
      this.activeMemDoc.set({
        ...doc,
        summary: savedSummary,
        text: savedText,
      });
      this.memBaselineSummary.set(savedSummary);
      this.memBaselineText.set(savedText);
      this.memSummary.set(savedSummary);
      this.snackbar.show(`Saved Memory "${doc.name}"`);
      void this.loadMemoryDocs();
    } catch (err) {
      this.snackbar.show(`Save failed: ${errorText(err)}`);
    } finally {
      this.pinBusy.set(false);
    }
  }

  protected onTaskLinkClick(ev: MouseEvent, taskId: string): void {
    if (
      ev.button !== 0 ||
      ev.ctrlKey ||
      ev.metaKey ||
      ev.shiftKey ||
      ev.altKey
    ) {
      return;
    }
    if (!this.hasUnsavedChanges()) return;
    ev.preventDefault();
    this.openConfirm({
      title: "Discard unsaved canvas changes?",
      message: this.unsavedDiscardMessage(`Opening #${taskId}`),
      accept: "Discard & Leave",
      destructive: true,
      run: async () => {
        this.discardUnsavedState();
        await this.router.navigate(["/task", taskId]);
      },
    });
  }

  protected async launchPlan(
    plan: Parameters<SessionsStore["launchWorkstreamPlan"]>[0],
  ): Promise<void> {
    if (this.hasUnsavedChanges()) {
      this.openConfirm({
        title: "Discard unsaved canvas changes?",
        message: this.unsavedDiscardMessage("Launching this workstream"),
        accept: "Discard & Launch",
        destructive: true,
        run: async () => {
          this.discardUnsavedState();
          await this.performLaunchPlan(plan);
        },
      });
      return;
    }
    await this.performLaunchPlan(plan);
  }

  private async performLaunchPlan(
    plan: Parameters<SessionsStore["launchWorkstreamPlan"]>[0],
  ): Promise<void> {
    const origin = await this.sessions.launchWorkstreamPlan(plan);
    if (origin) {
      this.snackbar.show(`Launched workstream (${plan.tasks.length} tasks)`);
      await this.router.navigate(["/workstreams", origin]);
    }
  }

  protected async approveTreeProposals(): Promise<void> {
    const nodes = this.proposedTreeNodes();
    if (!nodes.length || this.treeBusy()) return;
    this.treeBusy.set(true);
    try {
      for (const n of nodes) {
        await this.api.post("POST /api/tasks/{id}/approve", { id: n.id });
      }
      this.snackbar.show(
        `Approved ${nodes.length} proposed task${nodes.length === 1 ? "" : "s"}`,
      );
      const tid = this.sessionTaskId();
      if (tid) void this.loadTree(tid);
    } catch (err) {
      this.snackbar.show(`Approval failed: ${errorText(err)}`);
    } finally {
      this.treeBusy.set(false);
    }
  }
}
