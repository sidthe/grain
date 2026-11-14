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
  TreeNode,
  WorkTree,
} from "../api/models";
import { AccessService } from "../services/access.service";
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
    "(document:keydown.escape)": "onEscape($event)",
    "(keydown.escape)": "onEscape($event)",
    "(focusin)": "onFocusIn($event)",
  },
  template: `
    <aside
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
          (click)="requestClose()"
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
                      [attr.data-doc-id]="d.id"
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
                        [attr.aria-expanded]="pinOpen()"
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
                        #pinNameInput
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
                        <div class="canvas-btn-group">
                          <span class="muted" style="font-size: 11px">{{
                            repo() || "Deployment memory"
                          }}</span>
                          @if (pinDirty()) {
                            <span
                              class="status-pill blast"
                              data-testid="pin-dirty-pill"
                              >Unsaved</span
                            >
                          }
                        </div>
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
                    </form>
                  }
                  <div class="canvas-overflow-wrap">
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
                  <iframe
                    class="canvas-iframe"
                    data-testid="canvas-html-iframe"
                    sandbox="allow-scripts"
                    [attr.title]="mock.title"
                    [srcdoc]="safeSrcdoc()"
                  ></iframe>
                } @else {
                  <div class="canvas-overflow-wrap">
                    <pre
                      class="canvas-source"
                      data-testid="canvas-html-source"
                      >{{ mock.html }}</pre>
                  </div>
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
                        (click)="openTaskNode($event, n.id)"
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
                    [attr.data-doc-key]="memoryDocKey(m)"
                    [class.is-active]="isMemoryDocActive(m)"
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
                          data-testid="memory-dirty-pill"
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
                        data-testid="memory-summary-input"
                        aria-label="Memory summary"
                        [value]="memSummary()"
                        (input)="memSummary.set($any($event.target).value)"
                      />
                      <textarea
                        #memTextInput
                        rows="8"
                        data-testid="memory-text-input"
                        aria-label="Memory document text"
                        [value]="memText()"
                        (input)="memText.set($any($event.target).value)"
                      ></textarea>
                      <div class="canvas-toolbar">
                        <span class="muted" style="font-size: 11px"
                          >{{ memText().length }} chars</span
                        >
                        <div class="canvas-btn-group">
                          @if (memDirty()) {
                            <button
                              type="button"
                              class="btn-text"
                              data-testid="canvas-memory-discard"
                              [disabled]="pinBusy()"
                              (click)="discardMemoryEdits()"
                            >
                              Discard
                            </button>
                          }
                          <button
                            type="submit"
                            class="btn-primary"
                            data-testid="canvas-memory-save"
                            [disabled]="pinBusy()"
                          >
                            {{ pinBusy() ? "Saving..." : "Save Memory doc" }}
                          </button>
                        </div>
                      </div>
                    </form>
                  } @else {
                    <div class="canvas-overflow-wrap">
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
export class SessionCanvasComponent implements OnInit {
  protected readonly sessions = inject(SessionsStore);
  private readonly api = inject(GrainApi);
  private readonly access = inject(AccessService);
  private readonly snackbar = inject(SnackbarService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);

  readonly sessionTaskId = input<string | undefined>(undefined);
  readonly repo = input<string | undefined>(undefined);
  readonly comments = input<Comment[]>([]);
  readonly requestedTab = input<CanvasTab | null>(null);
  readonly requestedArtifactId = input<string | null>(null);
  readonly returnFocus = input<HTMLElement | null>(null);

  readonly closed = output<void>();

  private readonly pinToggleBtn =
    viewChild<ElementRef<HTMLButtonElement>>("pinToggleBtn");
  private readonly pinNameInput =
    viewChild<ElementRef<HTMLInputElement>>("pinNameInput");
  private readonly memTextInput =
    viewChild<ElementRef<HTMLTextAreaElement>>("memTextInput");

  protected readonly activeTab = signal<CanvasTab>("docs");
  protected readonly selectedDocId = signal<string | null>(null);
  protected readonly selectedHtmlId = signal<string | null>(null);
  protected readonly htmlView = signal<"preview" | "source">("preview");
  protected readonly htmlTheme = signal<"light" | "dark">("light");

  protected readonly pinOpen = signal(false);
  protected readonly pinName = signal("");
  protected readonly pinSummary = signal("");
  protected readonly pinInitialName = signal("");
  protected readonly pinInitialSummary = signal("");
  protected readonly pinBusy = signal(false);

  protected readonly treeNodes = signal<TreeNode[]>([]);
  protected readonly treeBusy = signal(false);

  protected readonly memoryDocs = signal<MemoryDocument[]>([]);
  protected readonly memoryError = signal<string | null>(null);
  protected readonly activeMemDoc = signal<MemoryDocument | null>(null);
  protected readonly activeMemName = signal<string>("");
  protected readonly memSummary = signal("");
  protected readonly memText = signal("");
  protected readonly loadedMemSummary = signal("");
  protected readonly loadedMemText = signal("");
  protected readonly confirmReq = signal<ConfirmRequest | null>(null);

  private previousFocus: HTMLElement | null = this.captureExternalFocus();
  private pinReturnFocus: HTMLElement | null = null;
  private confirmReturnFocus: HTMLElement | null = null;
  private memLoadSeq = 0;
  private readonly handledEscapes = new WeakSet<Event>();

  protected readonly pinDirty = computed(
    () =>
      this.canWriteMemory() &&
      this.pinOpen() &&
      (this.pinName() !== this.pinInitialName() ||
        this.pinSummary() !== this.pinInitialSummary()),
  );

  protected readonly memDirty = computed(
    () =>
      this.canWriteMemory() &&
      this.activeMemDoc() !== null &&
      (this.memSummary() !== this.loadedMemSummary() ||
        this.memText() !== this.loadedMemText()),
  );

  readonly hasUnsavedChanges = computed(
    () => this.pinDirty() || this.memDirty(),
  );

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

  constructor() {
    effect(() => {
      const tab = this.requestedTab();
      const aid = this.requestedArtifactId();
      untracked(() => {
        if (tab) this.activeTab.set(tab);
        if (aid) {
          if (tab === "html") this.selectedHtmlId.set(aid);
          if (tab === "docs") {
            this.resetPinForm();
            this.selectedDocId.set(aid);
          }
        }
        if (tab === "memory" && this.canReadMemory()) {
          void this.loadMemoryDocs();
        }
      });
    });

    effect(() => {
      const tid = this.sessionTaskId();
      untracked(() => {
        if (tid) {
          void this.loadTree(tid);
        } else {
          this.treeNodes.set([]);
        }
      });
    });
  }

  ngOnInit(): void {
    if (this.canReadMemory()) {
      void this.loadMemoryDocs();
    }
  }

  containsFocus(): boolean {
    const active = this.doc.activeElement;
    return (
      active instanceof HTMLElement &&
      this.hostEl.nativeElement.contains(active)
    );
  }

  requestClose(): void {
    if (this.hasUnsavedChanges()) {
      this.confirmDiscard(
        "Discard unsaved canvas changes?",
        this.unsavedMessage(),
        "Discard & close",
        () => this.emitClose(),
      );
      return;
    }
    this.emitClose();
  }

  confirmLeave(onProceed: () => Promise<unknown> | void): void {
    if (this.hasUnsavedChanges()) {
      this.confirmDiscard(
        "Discard unsaved canvas changes?",
        this.unsavedMessage(),
        "Discard & leave",
        async () => {
          this.resetUnsavedState();
          await onProceed();
        },
      );
      return;
    }
    void onProceed();
  }

  openArtifact(tab: CanvasTab, id: string): void {
    if (tab === "docs") {
      this.selectDoc(id);
      return;
    }
    this.activeTab.set(tab);
    if (tab === "html") this.selectedHtmlId.set(id);
    if (tab === "memory" && this.canReadMemory()) {
      void this.loadMemoryDocs();
    }
  }

  protected onFocusIn(ev: FocusEvent): void {
    const prev = ev.relatedTarget;
    const host = this.hostEl.nativeElement;
    if (
      prev instanceof HTMLElement &&
      prev !== this.doc.body &&
      !host.contains(prev)
    ) {
      this.previousFocus = prev;
    }
  }

  protected onEscape(ev: Event): void {
    if (ev.defaultPrevented || this.handledEscapes.has(ev)) return;
    this.handledEscapes.add(ev);
    if (this.hostEl.nativeElement.closest("[inert]")) return;
    if (this.hasExternalModal()) return;

    if (this.confirmReq()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelConfirm();
      return;
    }

    if (this.activeTab() === "docs" && this.pinOpen()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.requestClosePinForm();
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();
    this.requestClose();
  }

  protected onConfirmDone(accepted: boolean): void {
    const req = this.confirmReq();
    this.confirmReq.set(null);
    const back = this.confirmReturnFocus;
    this.confirmReturnFocus = null;
    if (!accepted) {
      if (back?.isConnected) back.focus();
      return;
    }
    if (req) {
      void req.run();
    }
  }

  protected memoryDocKey(doc: MemoryDocument): string {
    return `${doc.repo ?? ""}::${doc.name}`;
  }

  protected isMemoryDocActive(doc: MemoryDocument): boolean {
    const cur = this.activeMemDoc();
    if (!cur) return this.activeMemName() === doc.name;
    return cur.name === doc.name && (cur.repo ?? "") === (doc.repo ?? "");
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
      const res = await this.api.get<
        | MemoryDocument[]
        | { items?: MemoryDocument[]; documents?: MemoryDocument[] }
      >("GET /api/memory/documents");
      const list = Array.isArray(res)
        ? res
        : (res?.items ?? res?.documents ?? []);
      this.memoryDocs.set(list);
      this.memoryError.set(null);
    } catch (err) {
      this.memoryError.set(errorText(err));
    }
  }

  protected selectDoc(docId: string): void {
    if (docId === this.activeDocId()) {
      this.activeTab.set("docs");
      return;
    }
    const apply = (focusChip: boolean) => {
      this.resetPinForm();
      this.selectedDocId.set(docId);
      this.activeTab.set("docs");
      if (focusChip) this.focusDocChip(docId);
    };
    if (this.pinDirty()) {
      this.confirmDiscard(
        "Discard unsaved Pin to Memory changes?",
        "Switching documents discards your edited Pin to Memory fields.",
        "Discard & switch",
        () => apply(true),
      );
      return;
    }
    apply(false);
  }

  protected selectMemoryDoc(doc: MemoryDocument): void {
    const cur = this.activeMemDoc();
    if (cur && cur.name === doc.name && (cur.repo ?? "") === (doc.repo ?? "")) {
      return;
    }
    if (this.memDirty()) {
      this.confirmDiscard(
        `Discard unsaved changes to "${cur?.name || "Memory document"}"?`,
        "Switching Memory documents discards your unsaved summary and body edits.",
        "Discard & switch",
        async () => {
          await this.loadMemoryDoc(doc);
          this.focusMemoryChip(doc);
        },
      );
      return;
    }
    void this.loadMemoryDoc(doc);
  }

  protected discardMemoryEdits(): void {
    if (!this.memDirty()) return;
    const cur = this.activeMemDoc();
    this.confirmDiscard(
      `Discard unsaved changes to "${cur?.name || "Memory document"}"?`,
      "Reverts the summary and body to the last saved version.",
      "Discard changes",
      () => {
        this.memSummary.set(this.loadedMemSummary());
        this.memText.set(this.loadedMemText());
        this.focusMemoryText();
      },
    );
  }

  private async loadMemoryDoc(doc: MemoryDocument): Promise<void> {
    const seq = ++this.memLoadSeq;
    const initSummary = doc.summary ?? "";
    const initText = doc.text ?? "";
    this.activeMemName.set(doc.name);
    this.activeMemDoc.set(doc);
    this.loadedMemSummary.set(initSummary);
    this.loadedMemText.set(initText);
    this.memSummary.set(initSummary);
    this.memText.set(initText);
    if (typeof this.api.get !== "function") return;
    try {
      const full = await this.api.get<MemoryDocument>(
        "GET /api/memory/documents/{name}",
        { name: doc.name },
        doc.repo ? `repo=${encodeURIComponent(doc.repo)}` : undefined,
      );
      if (
        full &&
        seq === this.memLoadSeq &&
        this.activeMemName() === doc.name &&
        (this.activeMemDoc()?.repo ?? "") === (doc.repo ?? "")
      ) {
        const wasEditedInFlight = this.memDirty();
        const nextSummary = full.summary || doc.summary || "";
        const nextText = full.text ?? "";
        this.activeMemDoc.set(full);
        this.loadedMemSummary.set(nextSummary);
        this.loadedMemText.set(nextText);
        if (!wasEditedInFlight) {
          this.memSummary.set(nextSummary);
          this.memText.set(nextText);
        }
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
      this.requestClosePinForm();
      return;
    }
    this.openPinForm(doc);
  }

  private openPinForm(doc: {
    id?: string;
    title: string;
    summary: string;
  }): void {
    const active = this.doc.activeElement;
    this.pinReturnFocus =
      active instanceof HTMLElement &&
      active !== this.doc.body &&
      this.hostEl.nativeElement.contains(active)
        ? active
        : (this.pinToggleBtn()?.nativeElement ?? null);
    if (doc.id && !this.selectedDocId()) {
      this.selectedDocId.set(doc.id);
    }
    const slug = doc.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const initName = slug || "session-note";
    const initSummary = doc.summary || doc.title;
    this.pinInitialName.set(initName);
    this.pinInitialSummary.set(initSummary);
    this.pinName.set(initName);
    this.pinSummary.set(initSummary);
    this.pinOpen.set(true);
    setTimeout(() => this.pinNameInput()?.nativeElement.focus());
  }

  private requestClosePinForm(): void {
    if (!this.pinOpen()) return;
    const finish = () => {
      this.resetPinForm();
      this.restorePinFocus();
    };
    if (this.pinDirty()) {
      this.confirmDiscard(
        "Discard unsaved Pin to Memory changes?",
        "Closing this form discards your edited document name and summary.",
        "Discard changes",
        finish,
      );
      return;
    }
    finish();
  }

  protected async pinDoc(ev: Event, doc: { markdown: string }): Promise<void> {
    ev.preventDefault();
    if (this.pinBusy()) return;
    this.pinBusy.set(true);
    const name = this.pinName().trim();
    const summary = this.pinSummary().trim();
    try {
      await this.api.put("PUT /api/memory/documents", undefined, {
        ...(this.repo() ? { repo: this.repo() } : {}),
        name,
        summary,
        text: doc.markdown,
      });
      this.resetPinForm();
      this.snackbar.show(`Pinned "${name}" to Memory`);
      this.restorePinFocus();
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
      this.activeMemDoc.set({ ...doc, summary: savedSummary, text: savedText });
      this.memSummary.set(savedSummary);
      this.loadedMemSummary.set(savedSummary);
      this.loadedMemText.set(savedText);
      this.snackbar.show(`Saved Memory "${doc.name}"`);
      void this.loadMemoryDocs();
    } catch (err) {
      this.snackbar.show(`Save failed: ${errorText(err)}`);
    } finally {
      this.pinBusy.set(false);
    }
  }

  protected launchPlan(
    plan: Parameters<SessionsStore["launchWorkstreamPlan"]>[0],
  ): void {
    this.confirmLeave(() => this.executeLaunchPlan(plan));
  }

  private async executeLaunchPlan(
    plan: Parameters<SessionsStore["launchWorkstreamPlan"]>[0],
  ): Promise<void> {
    const origin = await this.sessions.launchWorkstreamPlan(plan);
    if (origin) {
      this.snackbar.show(`Launched workstream (${plan.tasks.length} tasks)`);
      await this.router.navigate(["/workstreams", origin]);
    }
  }

  protected openTaskNode(ev: MouseEvent, id: string): void {
    if (
      ev.defaultPrevented ||
      ev.button !== 0 ||
      ev.metaKey ||
      ev.ctrlKey ||
      ev.shiftKey ||
      ev.altKey ||
      !this.hasUnsavedChanges()
    ) {
      return;
    }
    ev.preventDefault();
    this.confirmLeave(() => this.router.navigate(["/task", id]));
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

  private captureExternalFocus(): HTMLElement | null {
    const active = this.doc.activeElement;
    const host = this.hostEl.nativeElement;
    if (
      active instanceof HTMLElement &&
      active !== this.doc.body &&
      !host.contains(active)
    ) {
      return active;
    }
    return null;
  }

  private resolvePreviousFocus(): HTMLElement | null {
    const host = this.hostEl.nativeElement;
    for (const el of [this.previousFocus, this.returnFocus()]) {
      if (el && el.isConnected && !host.contains(el)) {
        return el;
      }
    }
    return null;
  }

  private hasExternalModal(): boolean {
    const host = this.hostEl.nativeElement;
    const modals = this.doc.querySelectorAll<HTMLElement>(
      '[aria-modal="true"], dialog[open], #account-popover',
    );
    for (const m of Array.from(modals)) {
      if (host.contains(m)) continue;
      if (m.hasAttribute("inert") || m.getAttribute("aria-hidden") === "true") {
        continue;
      }
      return true;
    }
    return false;
  }

  private confirmDiscard(
    title: string,
    message: string,
    accept: string,
    onDiscard: () => Promise<unknown> | void,
  ): void {
    const active = this.doc.activeElement;
    this.confirmReturnFocus =
      active instanceof HTMLElement && active !== this.doc.body ? active : null;
    this.confirmReq.set({
      title,
      message,
      accept,
      destructive: true,
      run: async () => {
        await onDiscard();
      },
    });
  }

  private cancelConfirm(): void {
    this.confirmReq.set(null);
    const back = this.confirmReturnFocus;
    this.confirmReturnFocus = null;
    if (back?.isConnected) {
      back.focus();
    }
  }

  private emitClose(): void {
    const back = this.resolvePreviousFocus();
    this.resetUnsavedState();
    if (back?.isConnected) {
      back.focus();
    }
    this.closed.emit();
    if (back?.isConnected) {
      queueMicrotask(() => {
        if (back.isConnected) back.focus();
      });
    }
  }

  private resetPinForm(): void {
    this.pinOpen.set(false);
    this.pinInitialName.set("");
    this.pinInitialSummary.set("");
    this.pinName.set("");
    this.pinSummary.set("");
  }

  private resetUnsavedState(): void {
    this.resetPinForm();
    this.memSummary.set(this.loadedMemSummary());
    this.memText.set(this.loadedMemText());
  }

  private restorePinFocus(): void {
    const target =
      this.pinReturnFocus?.isConnected === true
        ? this.pinReturnFocus
        : (this.pinToggleBtn()?.nativeElement ?? null);
    this.pinReturnFocus = null;
    if (target?.isConnected) {
      target.focus();
      queueMicrotask(() => {
        if (target.isConnected) target.focus();
      });
    }
  }

  private focusDocChip(docId: string): void {
    setTimeout(() => {
      const chips =
        this.hostEl.nativeElement.querySelectorAll<HTMLButtonElement>(
          "[data-doc-id]",
        );
      for (const chip of Array.from(chips)) {
        if (chip.dataset["docId"] === docId) {
          chip.focus();
          return;
        }
      }
    });
  }

  private focusMemoryChip(doc: MemoryDocument): void {
    const key = this.memoryDocKey(doc);
    setTimeout(() => {
      const chips =
        this.hostEl.nativeElement.querySelectorAll<HTMLButtonElement>(
          "[data-doc-key]",
        );
      for (const chip of Array.from(chips)) {
        if (chip.dataset["docKey"] === key) {
          chip.focus();
          return;
        }
      }
    });
  }

  private focusMemoryText(): void {
    setTimeout(() => this.memTextInput()?.nativeElement.focus());
  }

  private unsavedMessage(): string {
    const parts: string[] = [];
    if (this.pinDirty()) parts.push("Pin to Memory draft");
    if (this.memDirty()) {
      const name = this.activeMemDoc()?.name;
      parts.push(name ? `Memory edits to "${name}"` : "Memory document edits");
    }
    return `You have unsaved ${parts.join(" and ")}. Continuing will discard those changes.`;
  }
}
