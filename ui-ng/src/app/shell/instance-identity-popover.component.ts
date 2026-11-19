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
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { GrainApi } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { ThemeService } from "../services/theme.service";
import { errorText } from "../sessions/session-helpers";
import {
  HEADER_COLOR_OPTIONS,
  HEADER_PATTERN_OPTIONS,
  type HeaderColorPreset,
  type HeaderPatternPreset,
  MAX_ENVIRONMENT_NAME_LEN,
  headerColorLabel,
  headerPatternLabel,
  normalizeHeaderColor,
  normalizeHeaderPattern,
} from "../shared/instance-identity";

const CHECK_PATH = "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";

@Component({
  selector: "g-instance-identity-popover",
  imports: [RouterLink],
  encapsulation: ViewEncapsulation.None,
  styleUrls: ["./instance-identity-popover.css"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(document:click)": "onDocClick($event)",
  },
  template: `
    <div
      #popEl
      class="identity-popover"
      id="instance-identity-popover"
      role="dialog"
      aria-label="Instance identity"
      data-testid="instance-identity-popover"
    >
      <div class="identity-pop-head">
        <div>
          <h2 class="identity-pop-title">Instance identity</h2>
          <p class="identity-pop-sub">
            Label and tint this deployment in headers and browser tabs.
          </p>
        </div>
      </div>

      <div class="identity-pop-body">
        @if (isLocked()) {
          <div
            class="identity-pop-lock"
            role="status"
            data-testid="identity-popover-locked"
          >
            Settings are locked on this deployment. Edit instance identity in a
            <code>grain/config</code> pull request.
          </div>
        }

        @if (saveError(); as err) {
          <div
            class="identity-pop-error"
            role="alert"
            data-testid="identity-popover-error"
          >
            {{ err }}
          </div>
        }

        <div class="identity-pop-field">
          <div class="identity-pop-label-row">
            <label class="identity-pop-label" for="identity-pop-name"
              >Instance name</label
            >
            <span class="identity-pop-meta tabular"
              >{{ draftName().length }}/{{ maxNameLen }}</span
            >
          </div>
          <input
            #nameInput
            id="identity-pop-name"
            class="identity-pop-input"
            type="text"
            [attr.maxlength]="maxNameLen"
            autocomplete="off"
            placeholder="e.g. prod-eu, staging, fork · dev"
            data-testid="identity-popover-name"
            [value]="draftName()"
            [disabled]="readOnly()"
            (input)="onNameInput($any($event.target).value)"
            (keydown.enter)="onEnter($event)"
          />
        </div>

        <div class="identity-pop-field">
          <div class="identity-pop-label-row">
            <span class="identity-pop-label" id="identity-color-label"
              >Header color</span
            >
            <span class="identity-pop-meta">{{ activeColorLabel() }}</span>
          </div>
          <div
            class="identity-swatch-grid"
            role="radiogroup"
            aria-labelledby="identity-color-label"
            data-testid="identity-color-group"
          >
            @for (c of colorOptions; track c.id) {
              <button
                type="button"
                class="identity-swatch"
                role="radio"
                [attr.data-header-color]="c.id"
                [attr.data-testid]="'identity-color-' + (c.id || 'default')"
                [attr.aria-label]="c.label"
                [attr.aria-checked]="draftColor() === c.id"
                [attr.tabindex]="draftColor() === c.id ? 0 : -1"
                [attr.title]="c.label"
                [disabled]="readOnly()"
                (click)="selectColor(c.id)"
                (keydown)="onColorKeydown($event)"
              >
                @if (draftColor() === c.id) {
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path [attr.d]="checkPath" fill="currentColor" />
                  </svg>
                }
              </button>
            }
          </div>
        </div>

        <div class="identity-pop-field">
          <div class="identity-pop-label-row">
            <span class="identity-pop-label" id="identity-pattern-label"
              >Header pattern</span
            >
            <span class="identity-pop-meta">{{ activePatternLabel() }}</span>
          </div>
          <div
            class="identity-pattern-grid"
            role="radiogroup"
            aria-labelledby="identity-pattern-label"
            data-testid="identity-pattern-group"
          >
            @for (p of patternOptions; track p.id) {
              <button
                type="button"
                class="identity-pattern-tile"
                role="radio"
                [attr.data-testid]="'identity-pattern-' + (p.id || 'solid')"
                [attr.aria-checked]="draftPattern() === p.id"
                [attr.tabindex]="draftPattern() === p.id ? 0 : -1"
                [disabled]="readOnly()"
                (click)="selectPattern(p.id)"
                (keydown)="onPatternKeydown($event)"
              >
                <span
                  class="identity-pattern-swatch"
                  [attr.data-header-color]="draftColor()"
                  [attr.data-header-pattern]="p.id || null"
                  aria-hidden="true"
                ></span>
                <span>{{ p.label }}</span>
              </button>
            }
          </div>
        </div>
      </div>

      <div class="identity-pop-foot">
        <a
          class="identity-pop-link"
          routerLink="/settings/general"
          data-testid="identity-popover-settings-link"
          (click)="onCancel(false)"
          >Settings → General</a
        >
        <div class="identity-pop-actions">
          <button
            #cancelBtn
            type="button"
            class="btn-text"
            data-testid="identity-popover-cancel"
            [disabled]="saving()"
            (click)="onCancel(true)"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="identity-popover-save"
            [disabled]="readOnly() || saving()"
            (click)="save()"
          >
            {{ saving() ? "Saving…" : "Save" }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class InstanceIdentityPopoverComponent
  implements OnInit, AfterViewInit, OnDestroy
{
  protected readonly access = inject(AccessService);
  private readonly theme = inject(ThemeService);
  private readonly api = inject(GrainApi);
  private readonly snackbar = inject(SnackbarService);
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);

  readonly closed = output<boolean>();

  protected readonly colorOptions = HEADER_COLOR_OPTIONS;
  protected readonly patternOptions = HEADER_PATTERN_OPTIONS;
  protected readonly maxNameLen = MAX_ENVIRONMENT_NAME_LEN;
  protected readonly checkPath = CHECK_PATH;

  protected readonly draftName = signal("");
  protected readonly draftColor = signal<HeaderColorPreset>("");
  protected readonly draftPattern = signal<HeaderPatternPreset>("");
  protected readonly saving = signal(false);
  protected readonly saveError = signal("");

  protected readonly isLocked = computed(() => {
    const c = this.access.rawConfig();
    return Boolean(
      c?.settingsLocked || c?.configRepoOnly || c?.externalConfigRepo,
    );
  });

  protected readonly readOnly = computed(
    () => this.isLocked() || !this.access.can("POST /api/settings"),
  );

  protected readonly activeColorLabel = computed(() =>
    headerColorLabel(this.draftColor()),
  );

  protected readonly activePatternLabel = computed(() =>
    headerPatternLabel(this.draftPattern()),
  );

  private readonly popEl = viewChild<ElementRef<HTMLElement>>("popEl");
  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>("nameInput");
  private readonly cancelBtn =
    viewChild<ElementRef<HTMLButtonElement>>("cancelBtn");

  private committed = false;

  private readonly onCaptureKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      this.zone.run(() => this.onEscape(ev));
    } else if (ev.key === "Tab") {
      this.zone.run(() => this.onTab(ev));
    }
  };

  ngOnInit(): void {
    this.draftName.set(this.theme.savedEnvironmentName());
    this.draftColor.set(this.theme.savedHeaderColor());
    this.draftPattern.set(this.theme.savedHeaderPattern());
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      this.doc.addEventListener("keydown", this.onCaptureKeydown, true);
    });
    if (!this.readOnly()) {
      const input = this.nameInput()?.nativeElement;
      input?.focus();
      input?.select?.();
    } else {
      this.cancelBtn()?.nativeElement.focus();
    }
  }

  ngOnDestroy(): void {
    this.doc.removeEventListener("keydown", this.onCaptureKeydown, true);
    if (!this.committed) {
      this.theme.clearHeaderPreview();
    }
  }

  private pushPreview(): void {
    if (this.readOnly()) return;
    this.theme.setHeaderPreview({
      environmentName: this.draftName(),
      headerColor: this.draftColor(),
      headerPattern: this.draftPattern(),
    });
  }

  protected onNameInput(value: string): void {
    this.saveError.set("");
    this.draftName.set(value);
    this.pushPreview();
  }

  protected selectColor(id: HeaderColorPreset): void {
    if (this.readOnly()) return;
    this.saveError.set("");
    this.draftColor.set(id);
    this.pushPreview();
  }

  protected selectPattern(id: HeaderPatternPreset): void {
    if (this.readOnly()) return;
    this.saveError.set("");
    this.draftPattern.set(id);
    this.pushPreview();
  }

  protected onColorKeydown(ev: KeyboardEvent): void {
    if (this.readOnly()) return;
    const step = this.radioStep(ev.key);
    if (step === 0) return;
    ev.preventDefault();
    const cur = this.colorOptions.findIndex((o) => o.id === this.draftColor());
    const nextIdx =
      (Math.max(0, cur) + step + this.colorOptions.length) %
      this.colorOptions.length;
    const next = this.colorOptions[nextIdx];
    this.selectColor(next.id);
    this.popEl()
      ?.nativeElement.querySelector<HTMLButtonElement>(
        `[data-testid="identity-color-${next.id || "default"}"]`,
      )
      ?.focus();
  }

  protected onPatternKeydown(ev: KeyboardEvent): void {
    if (this.readOnly()) return;
    const step = this.radioStep(ev.key);
    if (step === 0) return;
    ev.preventDefault();
    const cur = this.patternOptions.findIndex(
      (o) => o.id === this.draftPattern(),
    );
    const nextIdx =
      (Math.max(0, cur) + step + this.patternOptions.length) %
      this.patternOptions.length;
    const next = this.patternOptions[nextIdx];
    this.selectPattern(next.id);
    this.popEl()
      ?.nativeElement.querySelector<HTMLButtonElement>(
        `[data-testid="identity-pattern-${next.id || "solid"}"]`,
      )
      ?.focus();
  }

  private radioStep(key: string): number {
    if (key === "ArrowRight" || key === "ArrowDown") return 1;
    if (key === "ArrowLeft" || key === "ArrowUp") return -1;
    return 0;
  }

  protected onEnter(ev: Event): void {
    ev.preventDefault();
    if (!this.readOnly() && !this.saving()) {
      void this.save();
    }
  }

  protected async save(): Promise<void> {
    if (this.readOnly() || this.saving()) return;
    this.saving.set(true);
    this.saveError.set("");
    const payload = {
      environmentName: this.draftName().trim(),
      headerColor: this.draftColor(),
      headerPattern: this.draftPattern(),
    };
    try {
      const saved = await this.api.post<Record<string, unknown>>(
        "POST /api/settings",
        undefined,
        payload,
      );
      const nextName =
        typeof saved?.["environmentName"] === "string"
          ? saved["environmentName"]
          : payload.environmentName;
      const nextColor = normalizeHeaderColor(
        saved?.["headerColor"] ?? payload.headerColor,
      );
      const nextPattern = normalizeHeaderPattern(
        saved?.["headerPattern"] ?? payload.headerPattern,
      );
      this.api.clearConditionalCache?.("/api/config");
      this.access.patchConfig({
        environmentName: nextName,
        headerColor: nextColor,
        headerPattern: nextPattern,
      });
      this.committed = true;
      this.theme.clearHeaderPreview();
      if (typeof this.api.config === "function") {
        void this.api
          .config()
          .then((cfg) => {
            if (cfg) this.access.setConfig(cfg);
          })
          .catch(() => undefined);
      }
      this.snackbar.show("Instance identity saved");
      this.closed.emit(true);
    } catch (err) {
      this.saving.set(false);
      this.saveError.set(errorText(err));
    }
  }

  protected onCancel(restoreFocus: boolean): void {
    this.committed = false;
    this.theme.clearHeaderPreview();
    this.closed.emit(restoreFocus);
  }

  protected onDocClick(ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (
      !t?.closest("#instance-identity-popover") &&
      !t?.closest('[data-testid="instance-identity-badge"]') &&
      !t?.closest('[data-testid="instance-name-cue"]')
    ) {
      this.onCancel(false);
    }
  }

  protected onEscape(ev: Event): void {
    if (ev.defaultPrevented) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.onCancel(true);
  }

  protected onTab(ev: KeyboardEvent): void {
    const root = this.popEl()?.nativeElement;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not([disabled])',
      ),
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = this.doc.activeElement;
    if (ev.shiftKey && (active === first || !root.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !root.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  }
}
