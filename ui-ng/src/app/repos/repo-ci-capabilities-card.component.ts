// Copyright 2026 The Grain Authors
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
import type { GrainConfig } from "../api/models";
import {
  type GrantAttachEvent,
  GrantsPickerComponent,
} from "../shared/grants-picker.component";
import {
  NO_CI_CAPABILITIES_HINT,
  type RepoCiCapabilitiesState,
  capabilityRows,
  capabilityUnavailableHint,
  splitCiCapabilities,
} from "./repo-capabilities.helpers";

@Component({
  selector: "g-repo-ci-capabilities-card",
  imports: [GrantsPickerComponent],
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./repo-ci-capabilities-card.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="s-card" data-testid="card-repo-ci-capabilities">
      <div class="s-card-head">
        <div>
          <h2 class="s-card-title">CI capabilities</h2>
          <p class="s-card-desc">
            Capabilities and method grants provided to every Grain CI job in
            {{ repoSlug() }}.
          </p>
        </div>
      </div>

      @if (!canRead()) {
        <div
          class="s-banner readonly"
          data-testid="ci-capabilities-read-denied"
        >
          {{ readDeniedReason() }}
        </div>
      } @else if (loadError()) {
        <div
          class="s-banner error"
          role="alert"
          data-testid="ci-capabilities-error-banner"
        >
          <span>{{ loadError() }}</span>
          <button
            type="button"
            class="btn-tonal s-btn-sm"
            data-testid="retry-ci-capabilities-btn"
            (click)="retry.emit()"
          >
            Retry
          </button>
        </div>
      } @else if (data() === null) {
        <p class="s-hint" data-testid="ci-capabilities-loading">
          Loading CI capabilities…
        </p>
      } @else {
        @if (writeDeniedReason() && !configRepoOnly()) {
          <p
            class="s-hint"
            id="repo-ci-caps-denied-reason"
            data-testid="ci-capabilities-write-denied"
          >
            {{ writeDeniedReason() }}
          </p>
        }

        @if (saveError(); as sErr) {
          <div
            class="s-banner error"
            role="alert"
            data-testid="ci-capabilities-save-error"
          >
            <span>{{ sErr }}</span>
            <button
              type="button"
              class="btn-text s-btn-sm"
              (click)="dismissSaveError.emit()"
            >
              Dismiss
            </button>
          </div>
        }

        <div class="s-field">
          <span class="s-label" id="repo-ci-caps-picker-label">
            CI capabilities
          </span>
          @if (ciCapsRows().length === 0) {
            <p class="s-hint" data-testid="ci-capabilities-empty">
              {{ noCapabilitiesHint }}
            </p>
          } @else {
            <div
              class="repo-ci-cap-grid"
              role="group"
              aria-labelledby="repo-ci-caps-picker-label"
              [attr.aria-describedby]="pickerDescribedBy()"
              data-testid="ci-capabilities-picker"
            >
              @for (row of ciCapsRows(); track row.id) {
                @let selected = legacySet().has(row.id);
                @let unavail = row.retired ? "" : unavailableHint(row);
                <button
                  type="button"
                  class="repo-ci-cap-option"
                  [class.is-selected]="selected"
                  [class.is-warn]="row.retired || !!unavail"
                  [attr.aria-pressed]="selected"
                  [attr.aria-describedby]="pickerDescribedBy()"
                  [attr.title]="
                    row.description ? row.id + ' — ' + row.description : row.id
                  "
                  [disabled]="!canWrite() || saving()"
                  [attr.data-testid]="'ci-cap-option-' + row.id"
                  (click)="toggleCapability(row.id)"
                >
                  <span class="repo-ci-cap-check" aria-hidden="true">{{
                    selected ? "✓" : ""
                  }}</span>
                  <span class="repo-ci-cap-copy">
                    <span class="repo-ci-cap-name">{{
                      row.name || row.id
                    }}</span>
                    @if (row.retired) {
                      <span class="repo-ci-cap-warn">{{
                        row.description
                      }}</span>
                    } @else if (unavail) {
                      <span class="repo-ci-cap-warn">{{ unavail }}</span>
                    } @else if (row.description) {
                      <span class="repo-ci-cap-desc">{{
                        row.description
                      }}</span>
                    }
                  </span>
                </button>
              }
            </div>
          }
          <p class="s-hint" id="repo-ci-caps-helper">
            Granted to every CI job in this repo, starting with the next run.
            Each job gets its own credentials, which are revoked when it
            finishes. Task defaults are configured separately.
          </p>
        </div>

        <div class="s-field">
          <span class="s-label">CI grants</span>
          @if ((!canWrite() || configRepoOnly()) && grantRefs().length === 0) {
            <p class="s-hint" data-testid="ci-grants-empty">
              No extra CI method grants configured.
            </p>
          } @else {
            <g-grants-picker
              testid="repo-ci-grants"
              runKind="ci"
              [offered]="[]"
              [held]="grantRefs()"
              [repo]="repoSlug()"
              [disabled]="!canWrite() || saving()"
              (attachGrant)="onAttachGrant($event)"
              (detachGrant)="onDetachGrant($event)"
            />
          }
        </div>
      }
    </div>
  `,
})
export class RepoCiCapabilitiesCardComponent {
  readonly repoSlug = input.required<string>();
  readonly data = input<RepoCiCapabilitiesState | null>(null);
  readonly config = input<GrainConfig | null>(null);
  readonly saving = input<boolean>(false);
  readonly loadError = input<string | null>(null);
  readonly saveError = input<string | null>(null);
  readonly canRead = input<boolean>(true);
  readonly canWrite = input<boolean>(true);
  readonly configRepoOnly = input<boolean>(false);
  readonly readDeniedReason = input<string>("");
  readonly writeDeniedReason = input<string>("");

  readonly save = output<string[]>();
  readonly retry = output<void>();
  readonly dismissSaveError = output<void>();

  protected readonly noCapabilitiesHint = NO_CI_CAPABILITIES_HINT;

  private readonly split = computed(() => {
    const d = this.data();
    if (!d) {
      return {
        pickerSet: new Set<string>(),
        legacySelected: [] as string[],
        grantRefs: [] as string[],
      };
    }
    return splitCiCapabilities(d.ciCapabilities, d.availableCICapabilities);
  });

  protected readonly legacySelected = computed(
    () => this.split().legacySelected,
  );
  protected readonly legacySet = computed(() => new Set(this.legacySelected()));
  protected readonly grantRefs = computed(() => this.split().grantRefs);

  protected readonly ciCapsRows = computed(() => {
    const d = this.data();
    if (!d) return [];
    const cfg = this.config();
    const all = cfg?.ciCapabilities ?? cfg?.capabilities ?? [];
    const pickerSet = this.split().pickerSet;
    return capabilityRows(
      all.filter((c) => pickerSet.has(c.id)),
      this.legacySelected(),
    );
  });

  protected unavailableHint(
    row: ReturnType<typeof capabilityRows>[number],
  ): string {
    return capabilityUnavailableHint(row);
  }

  protected pickerDescribedBy(): string | null {
    const ids: string[] = [];
    if (this.configRepoOnly()) {
      ids.push("repo-config-readonly-banner");
    }
    if (this.writeDeniedReason()) {
      ids.push("repo-ci-caps-denied-reason");
    }
    ids.push("repo-ci-caps-helper");
    return ids.join(" ");
  }

  protected toggleCapability(id: string): void {
    if (!this.canWrite() || this.saving()) return;
    const cur = this.legacySelected();
    const nextLegacy = cur.includes(id)
      ? cur.filter((x) => x !== id)
      : [...cur, id];
    this.save.emit([...nextLegacy, ...this.grantRefs()]);
  }

  protected onAttachGrant(ev: GrantAttachEvent): void {
    if (!this.canWrite() || this.saving()) return;
    const grant = (ev.recorded || ev.grant || "").trim();
    if (!grant) return;
    const refs = this.grantRefs();
    const nextRefs = refs.includes(grant) ? refs : [...refs, grant];
    this.save.emit([...this.legacySelected(), ...nextRefs]);
  }

  protected onDetachGrant(ev: { id?: string; grant?: string }): void {
    if (!this.canWrite() || this.saving()) return;
    const target = ev.grant ?? ev.id;
    if (!target) return;
    const nextRefs = this.grantRefs().filter((g) => g !== target);
    this.save.emit([...this.legacySelected(), ...nextRefs]);
  }
}
