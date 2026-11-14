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
  untracked,
} from "@angular/core";
import { GrainApi } from "../api/grain-api.service";
import type {
  APIScopeSetRow,
  APIScopeSetsResponse,
  CapabilityMethod,
  CapabilityOption,
  GrantCheck,
} from "../api/models";
import { AccessService } from "../services/access.service";
import {
  errorText,
  grantName,
  isApiCapability,
} from "../sessions/session-helpers";
import { type PillOption, PillSelectComponent } from "./pill-select.component";

export interface GrantAttachEvent {
  // Simple capability toggle id (when toggling offered capabilities).
  id?: string;
  // Structured method/API grant (capability + optional with args) or raw grant string.
  capability?: string;
  with?: Record<string, unknown>;
  grant?: string;
  recorded: string;
}

@Component({
  selector: "g-grants-picker",
  imports: [PillSelectComponent],
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./grants-picker.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grants-picker" [attr.data-testid]="testid() || 'grants-picker'">
      @if (toggleItems().length) {
        <div
          class="grants-toggle-list"
          role="group"
          [attr.aria-label]="toggleAriaLabel()"
          [attr.aria-describedby]="describedBy() || null"
        >
          @for (c of toggleItems(); track c.id) {
            @let on = heldSet().has(c.id);
            <button
              type="button"
              class="grant-pill"
              [attr.aria-pressed]="on"
              [attr.title]="capTip(c)"
              [attr.aria-describedby]="describedBy() || null"
              [disabled]="disabled()"
              [attr.data-testid]="(testid() || 'gp') + '-cap-' + c.id"
              (click)="onToggle(c.id, !on)"
            >
              {{ on ? "✓ " : "" }}{{ c.name || c.id }}
            </button>
          }
        </div>
      }

      @if (extraHeld().length) {
        <ul
          class="grants-held-list"
          [attr.aria-label]="
            isCi() ? 'Attached CI grants' : 'Attached method and API grants'
          "
        >
          @for (g of extraHeld(); track g) {
            <li
              class="grant-held-chip"
              [attr.data-testid]="'held-grant-' + $index"
            >
              <span [title]="g">{{ shortGrant(g) }}</span>
              @if (!disabled()) {
                <button
                  type="button"
                  class="grant-held-remove"
                  [attr.aria-label]="'Remove grant ' + g"
                  [attr.aria-describedby]="describedBy() || null"
                  [attr.data-testid]="'remove-grant-' + $index"
                  (click)="onRemoveGrant(g)"
                >
                  ×
                </button>
              }
            </li>
          }
        </ul>
      }

      @if (!disabled() && canReadCatalogue()) {
        @if (!builderOpen()) {
          <div>
            <button
              type="button"
              class="btn-text"
              [attr.aria-describedby]="describedBy() || null"
              [attr.data-testid]="(testid() || 'gp') + '-add-open'"
              (click)="openBuilder()"
            >
              {{
                isCi() ? "+ Add CI grant" : "+ Add API scope or method grant"
              }}
            </button>
          </div>
        } @else {
          <div
            class="grants-builder"
            [attr.data-testid]="(testid() || 'gp') + '-builder'"
          >
            <div class="grants-mode-tabs" role="group" aria-label="Grant kind">
              @if (!isCi()) {
                <button
                  type="button"
                  class="grant-pill"
                  [attr.aria-pressed]="effectiveMode() === 'api'"
                  [attr.data-testid]="(testid() || 'gp') + '-mode-api'"
                  (click)="mode.set('api')"
                >
                  API scope
                </button>
              }
              <button
                type="button"
                class="grant-pill"
                [attr.aria-pressed]="effectiveMode() === 'method'"
                [attr.data-testid]="(testid() || 'gp') + '-mode-method'"
                (click)="mode.set('method')"
              >
                Capability method
              </button>
              <button
                type="button"
                class="grant-pill"
                [attr.aria-pressed]="effectiveMode() === 'raw'"
                [attr.data-testid]="(testid() || 'gp') + '-mode-raw'"
                (click)="mode.set('raw')"
              >
                Custom grant
              </button>
            </div>

            @switch (effectiveMode()) {
              @case ("api") {
                <div class="grants-builder-row">
                  <g-pill-select
                    [options]="apiOptions()"
                    [value]="selectedApiSet()"
                    placeholder="Select API scope set"
                    ariaLabel="API scope set"
                    align="left"
                    [testid]="(testid() || 'gp') + '-api-set'"
                    (valueChange)="selectedApiSet.set($event)"
                  />
                  <input
                    type="text"
                    class="grants-builder-input"
                    placeholder="Optional @repo (e.g. owner/name)"
                    aria-label="Scope repository filter"
                    [attr.data-testid]="(testid() || 'gp') + '-api-repo'"
                    [value]="apiRepoFilter()"
                    (input)="apiRepoFilter.set($any($event.target).value)"
                  />
                </div>
              }
              @case ("method") {
                <div class="grants-builder-row">
                  @if (methodOptions().length > 0) {
                    <g-pill-select
                      [options]="methodOptions()"
                      [value]="selectedMethod()"
                      placeholder="Select capability method"
                      ariaLabel="Capability method"
                      align="left"
                      [testid]="(testid() || 'gp') + '-method-ref'"
                      (valueChange)="selectedMethod.set($event)"
                    />
                  } @else {
                    <span class="s-hint">
                      No capability methods available — use Custom grant or
                      attach a capability server.
                    </span>
                  }
                  <input
                    type="text"
                    class="grants-builder-input"
                    placeholder='Optional JSON args, e.g. {"space":"ops"}'
                    aria-label="Method JSON arguments"
                    [attr.data-testid]="(testid() || 'gp') + '-method-args'"
                    [value]="methodArgsJson()"
                    (input)="methodArgsJson.set($any($event.target).value)"
                  />
                </div>
              }
              @case ("raw") {
                <div class="grants-builder-row">
                  <input
                    type="text"
                    class="grants-builder-input"
                    [placeholder]="
                      isCi()
                        ? 'e.g. repo-read:owner/name or server#method'
                        : 'e.g. api:tasks-read or server#method'
                    "
                    aria-label="Grant string"
                    [attr.data-testid]="(testid() || 'gp') + '-raw-input'"
                    [value]="rawGrant()"
                    (input)="rawGrant.set($any($event.target).value)"
                  />
                </div>
              }
            }

            @if (checkError(); as err) {
              <p
                class="banner banner-error"
                role="alert"
                [attr.data-testid]="(testid() || 'gp') + '-error'"
              >
                {{ err }}
              </p>
            }

            <div class="grants-builder-row">
              <button
                type="button"
                class="btn-tonal"
                [disabled]="checking()"
                [attr.data-testid]="(testid() || 'gp') + '-attach'"
                (click)="attachFromBuilder()"
              >
                Add grant
              </button>
              <button
                type="button"
                class="btn-text"
                (click)="builderOpen.set(false)"
              >
                Done
              </button>
            </div>
          </div>
        }
      }
    </div>
  `,
})
export class GrantsPickerComponent {
  private readonly api = inject(GrainApi);
  private readonly access = inject(AccessService);

  readonly offered = input<readonly CapabilityOption[]>([]);
  readonly held = input<readonly string[]>([]);
  readonly repo = input<string | undefined>(undefined);
  readonly runKind = input<"task" | "process" | "ci">("task");
  readonly toggleAriaLabel = input<string>("Capabilities");
  readonly describedBy = input<string | null>(null);
  readonly disabled = input<boolean>(false);
  readonly testid = input<string>("");

  // Emits full updated string[] for state-list forms (Sessions, New Task),
  // AND granular attach/detach events for TaskDetail's POST .../capabilities!
  readonly heldChange = output<string[]>();
  readonly attachGrant = output<GrantAttachEvent>();
  readonly detachGrant = output<{ id?: string; grant?: string }>();

  protected readonly builderOpen = signal(false);
  protected readonly mode = signal<"api" | "method" | "raw">("api");
  protected readonly scopeSets = signal<APIScopeSetRow[]>([]);
  protected readonly methods = signal<CapabilityMethod[]>([]);
  protected readonly selectedApiSet = signal("");
  protected readonly apiRepoFilter = signal("");
  protected readonly selectedMethod = signal("");
  protected readonly methodArgsJson = signal("");
  protected readonly rawGrant = signal("");
  protected readonly checking = signal(false);
  protected readonly checkError = signal<string | null>(null);
  private loadedCatalogueKey: string | null = null;

  protected readonly isCi = computed(() => this.runKind() === "ci");
  protected readonly effectiveMode = computed<"api" | "method" | "raw">(() =>
    this.isCi() && this.mode() === "api" ? "method" : this.mode(),
  );
  private readonly catalogueQueryKey = computed(() => {
    const kind = this.runKind();
    const repo = this.repo();
    return repo
      ? `kind=${kind}&repo=${encodeURIComponent(repo)}`
      : `kind=${kind}`;
  });

  constructor() {
    let prevKey: string | null = null;
    effect(() => {
      const key = this.catalogueQueryKey();
      if (prevKey !== null && prevKey !== key) {
        untracked(() => {
          this.loadedCatalogueKey = null;
          this.methods.set([]);
          this.selectedMethod.set("");
          this.methodArgsJson.set("");
          this.rawGrant.set("");
          this.checkError.set(null);
          if (this.builderOpen()) {
            void this.loadCatalogue();
          }
        });
      }
      prevKey = key;
    });
  }

  protected readonly heldSet = computed(() => new Set(this.held()));

  protected readonly toggleItems = computed(() => {
    const has = this.heldSet();
    return this.offered().filter(
      (c) => (c.ready !== false || has.has(c.id)) && !isApiCapability(c.id),
    );
  });

  protected readonly extraHeld = computed(() => {
    const shown = new Set(this.toggleItems().map((c) => c.id));
    return this.held().filter((g) => !shown.has(g));
  });

  protected readonly apiOptions = computed<PillOption[]>(() => {
    const sets = this.scopeSets();
    if (!sets.length) {
      return [
        { value: "tasks-read", label: "api:tasks-read" },
        { value: "ci-read", label: "api:ci-read" },
        { value: "repos-read", label: "api:repos-read" },
      ];
    }
    return sets
      .filter((s) => !s.catalogue?.disabled)
      .map((s) => ({
        value: s.name,
        label: s.description
          ? `api:${s.name} — ${s.description}`
          : `api:${s.name}`,
      }));
  });

  protected readonly methodOptions = computed<PillOption[]>(() =>
    this.methods()
      .filter((m) => !m.policyRefusal)
      .map((m) => ({
        value: m.ref,
        label: m.description ? `${m.ref} — ${m.description}` : m.ref,
      })),
  );

  protected canReadCatalogue(): boolean {
    if (this.isCi()) {
      return (
        this.access.can("GET /api/capability-methods", this.repo()) ||
        this.access.can("POST /api/capability-grants/check", this.repo())
      );
    }
    return (
      this.access.can("GET /api/capability-methods", this.repo()) ||
      this.access.can("GET /api/api-scope-sets", this.repo()) ||
      this.access.can("POST /api/capability-grants/check", this.repo())
    );
  }

  protected capTip(c: CapabilityOption): string {
    if (c.ready === false) {
      const needs = Array.isArray(c.needs) ? c.needs : c.needs ? [c.needs] : [];
      const gap = needs.length
        ? ` — needs ${needs.join(", ")}`
        : " on this deployment";
      const base = c.description ? `${c.description} ` : "";
      return `${base}Not ready${gap}.`;
    }
    return c.description || c.id;
  }

  protected shortGrant(g: string): string {
    if (g.startsWith("api:")) return g;
    return grantName(g);
  }

  protected onToggle(id: string, nextOn: boolean): void {
    if (this.disabled()) return;
    const cur = this.held();
    const method = this.methods().find((m) => m.ref === id);
    const idsToAdd =
      method?.aliasOf?.length && method.aliasOf.length > 1
        ? method.aliasOf
        : [id];
    let next: string[] = [...cur];
    if (nextOn) {
      for (const alias of idsToAdd) {
        if (!next.includes(alias)) next.push(alias);
      }
    } else {
      next = next.filter((x) => !idsToAdd.includes(x));
    }
    this.heldChange.emit(next);
    if (nextOn) {
      this.attachGrant.emit({ id, recorded: id });
    } else {
      this.detachGrant.emit({ id });
    }
  }

  protected onRemoveGrant(g: string): void {
    if (this.disabled()) return;
    this.heldChange.emit(this.held().filter((x) => x !== g));
    this.detachGrant.emit({ grant: g });
  }

  protected async openBuilder(): Promise<void> {
    this.builderOpen.set(true);
    this.checkError.set(null);
    if (this.isCi() && this.mode() === "api") {
      this.mode.set("method");
    }
    await this.loadCatalogue();
  }

  private async loadCatalogue(): Promise<void> {
    const query = this.catalogueQueryKey();
    if (this.loadedCatalogueKey === query) return;
    this.loadedCatalogueKey = query;
    const repo = this.repo();
    const isCi = this.isCi();
    const [setsRes, methodsRes] = await Promise.allSettled([
      !isCi && this.access.can("GET /api/api-scope-sets", repo)
        ? this.api.get<APIScopeSetsResponse>("GET /api/api-scope-sets")
        : Promise.resolve({ sets: [] }),
      this.access.can("GET /api/capability-methods", repo)
        ? this.api.get<{ items?: CapabilityMethod[] }>(
            "GET /api/capability-methods",
            undefined,
            query,
          )
        : Promise.resolve({ items: [] }),
    ]);
    if (this.catalogueQueryKey() !== query) return;
    if (setsRes.status === "fulfilled") {
      const sets = setsRes.value?.sets ?? [];
      this.scopeSets.set(sets);
      if (!this.selectedApiSet() && sets[0]) {
        this.selectedApiSet.set(sets[0].name);
      }
    }
    if (methodsRes.status === "fulfilled") {
      const val = methodsRes.value as {
        items?: CapabilityMethod[];
        methods?: CapabilityMethod[];
      };
      const list = Array.isArray(val)
        ? val
        : (val?.items ?? val?.methods ?? []);
      this.methods.set(list);
      const allowed = list.filter((m) => !m.policyRefusal);
      if (
        (!this.selectedMethod() ||
          !allowed.some((m) => m.ref === this.selectedMethod())) &&
        allowed[0]
      ) {
        this.selectedMethod.set(allowed[0].ref);
      }
    }
    if (!isCi && !this.selectedApiSet()) {
      this.selectedApiSet.set(this.apiOptions()[0]?.value ?? "tasks-read");
    }
  }

  protected async attachFromBuilder(): Promise<void> {
    if (this.checking()) return;
    this.checkError.set(null);
    const mode = this.effectiveMode();
    let reqItem: {
      capability?: string;
      with?: Record<string, unknown>;
      grant?: string;
    };
    let fallbackRecorded = "";

    if (mode === "api") {
      const set = (
        this.selectedApiSet() ||
        this.apiOptions()[0]?.value ||
        ""
      ).trim();
      if (!set) {
        this.checkError.set("Choose an API scope set.");
        return;
      }
      const repoSuffix = this.apiRepoFilter().trim().replace(/^@/, "");
      const grant = repoSuffix ? `api:${set}@${repoSuffix}` : `api:${set}`;
      reqItem = { grant };
      fallbackRecorded = grant;
    } else if (mode === "method") {
      const ref = (
        this.selectedMethod() ||
        this.methodOptions()[0]?.value ||
        ""
      ).trim();
      if (!ref) {
        this.checkError.set("Choose a capability method.");
        return;
      }
      let parsedWith: Record<string, unknown> | undefined;
      const rawArgs = this.methodArgsJson().trim();
      if (rawArgs) {
        try {
          const obj = JSON.parse(rawArgs) as unknown;
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            this.checkError.set("Method arguments must be a JSON object.");
            return;
          }
          parsedWith = obj as Record<string, unknown>;
        } catch {
          this.checkError.set("Method arguments must be valid JSON.");
          return;
        }
      }
      reqItem = {
        capability: ref,
        ...(parsedWith ? { with: parsedWith } : {}),
      };
      fallbackRecorded = parsedWith
        ? `${ref}=${JSON.stringify(parsedWith)}`
        : `${ref}={}`;
    } else {
      const g = this.rawGrant().trim();
      if (!g) {
        this.checkError.set(
          this.isCi()
            ? "Enter a CI capability or method grant."
            : "Enter a capability or API grant.",
        );
        return;
      }
      if (this.isCi() && isApiCapability(g)) {
        this.checkError.set("CI jobs cannot hold agent API scope grants.");
        return;
      }
      reqItem = { grant: g };
      fallbackRecorded = g;
    }

    this.checking.set(true);
    try {
      let recorded = fallbackRecorded;
      if (this.access.can("POST /api/capability-grants/check", this.repo())) {
        const res = await this.api.post<
          GrantCheck[] | { checks?: GrantCheck[] }
        >("POST /api/capability-grants/check", undefined, {
          grants: [reqItem],
          ...(!this.isCi() && this.repo()
            ? { subject: { repo: this.repo() } }
            : {}),
        });
        const list = Array.isArray(res) ? res : (res?.checks ?? []);
        const check = list[0];
        if (check?.error) {
          this.checkError.set(check.error);
          return;
        }
        if (check?.recorded) recorded = check.recorded;
      }
      const cur = this.held();
      if (!cur.includes(recorded)) {
        this.heldChange.emit([...cur, recorded]);
      }
      this.attachGrant.emit({
        ...reqItem,
        recorded,
      });
      this.rawGrant.set("");
      this.methodArgsJson.set("");
    } catch (err) {
      this.checkError.set(errorText(err));
    } finally {
      this.checking.set(false);
    }
  }
}
