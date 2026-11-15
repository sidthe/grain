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
  input,
  signal,
} from "@angular/core";
import {
  type ComposedField,
  type ComposedTask,
  type Composition,
  describeSuiteMode,
} from "./processes.models";

const LIST_FIELD_NAMES = new Set([
  "reads",
  "writes",
  "capabilities",
  "customFields",
]);

const BODY_CHAR_CLAMP = 600;
const BODY_LINE_CLAMP = 12;

@Component({
  selector: "g-composition-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (composition(); as comp) {
      <div class="comp-box" data-testid="composition-preview">
        <div class="comp-head">
          <strong>{{ heading() }}</strong>
          @if (comp.kind === "suite" && comp.mode) {
            <span class="ci-provider-tag">{{
              modeLabel(comp.mode, comp.count, comp.maxPasses)
            }}</span>
          }
          @if (comp.repo) {
            <span class="tabular muted"
              >{{ comp.repo }}{{ comp.base ? " @ " + comp.base : "" }}</span
            >
          }
        </div>
        @if (comp.tasks.length === 0) {
          <p class="muted" style="margin: 6px 0 0">
            Select a template or prompt to preview composed fields.
          </p>
        } @else {
          @for (t of comp.tasks; track $index; let taskIdx = $index) {
            <div class="comp-task">
              <div class="comp-task-title">
                <span class="tabular muted">#{{ taskIdx + 1 }}</span>
                <strong>{{ t.title || "(untitled task)" }}</strong>
                @if (t.templateName) {
                  <span class="muted">· from {{ t.templateName }}</span>
                }
              </div>
              <dl class="comp-grid comp-meta-grid">
                @for (f of metaFields(t); track f.name) {
                  <div
                    class="comp-row"
                    [class.comp-row-wide]="isWideListField(f)"
                    [attr.data-testid]="'comp-field-' + f.name"
                  >
                    <dt>{{ f.name }}</dt>
                    <dd>
                      <span>{{
                        f.values && f.values.length > 0
                          ? f.values.join(", ")
                          : "—"
                      }}</span>
                      @if (f.source) {
                        <span class="comp-layer">{{ f.source }}</span>
                      }
                    </dd>
                  </div>
                }
                @if (bodyField(t); as bf) {
                  <div
                    class="comp-row comp-row-wide comp-body-row"
                    data-testid="comp-field-body"
                  >
                    <dt class="comp-body-head">
                      <span>{{ bf.name }}</span>
                      @if (bf.source) {
                        <span class="comp-layer">{{ bf.source }}</span>
                      }
                      @if (isLongBody(bf)) {
                        <button
                          type="button"
                          class="btn-text comp-body-toggle"
                          data-testid="composition-body-toggle"
                          [attr.aria-expanded]="isBodyExpanded(taskIdx)"
                          (click)="toggleBody(taskIdx)"
                        >
                          {{
                            isBodyExpanded(taskIdx)
                              ? "Collapse prompt"
                              : "Expand full prompt"
                          }}
                        </button>
                      }
                    </dt>
                    <dd class="comp-body-dd">
                      <div
                        class="comp-body-well"
                        [class.is-clamped]="
                          isLongBody(bf) && !isBodyExpanded(taskIdx)
                        "
                        data-testid="composition-body-well"
                      >
                        {{ bodyText(bf) }}
                      </div>
                    </dd>
                  </div>
                }
              </dl>
            </div>
          }
        }
      </div>
    }
  `,
})
export class CompositionViewComponent {
  readonly composition = input<Composition | null>(null);
  readonly heading = input<string>(
    "Composition preview (what next firing files)",
  );

  protected readonly modeLabel = describeSuiteMode;
  protected readonly expandedBodies = signal<Record<number, boolean>>({});

  protected metaFields(t: ComposedTask): ComposedField[] {
    const titleTrimmed = (t.title ?? "").trim();
    const scalars: ComposedField[] = [];
    const nonEmptyLists: ComposedField[] = [];
    for (const f of t.fields ?? []) {
      if (f.name === "body") continue;
      if (f.name === "title") {
        const val = (f.values ?? []).join(", ").trim();
        if (!val || val === titleTrimmed) continue;
      }
      if (this.isWideListField(f)) {
        nonEmptyLists.push(f);
      } else {
        scalars.push(f);
      }
    }
    return [...scalars, ...nonEmptyLists];
  }

  protected isWideListField(f: ComposedField): boolean {
    return (
      LIST_FIELD_NAMES.has(f.name) && Boolean(f.values && f.values.length > 0)
    );
  }

  protected bodyField(t: ComposedTask): ComposedField | null {
    return (t.fields ?? []).find((f) => f.name === "body") ?? null;
  }

  protected bodyText(f: ComposedField): string {
    return f.values && f.values.length > 0 ? f.values.join("\n") : "—";
  }

  protected isLongBody(f: ComposedField): boolean {
    const text = this.bodyText(f);
    if (text === "—") return false;
    return (
      text.length > BODY_CHAR_CLAMP ||
      text.split(/\r?\n/).length > BODY_LINE_CLAMP
    );
  }

  protected isBodyExpanded(taskIdx: number): boolean {
    return !!this.expandedBodies()[taskIdx];
  }

  protected toggleBody(taskIdx: number): void {
    this.expandedBodies.update((m) => ({
      ...m,
      [taskIdx]: !m[taskIdx],
    }));
  }
}
