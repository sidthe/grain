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

import { Component, signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { DialogTrapDirective } from "./dialog-trap.directive";

@Component({
  imports: [DialogTrapDirective],
  template: `
    <button type="button" data-testid="opener">Open</button>
    <div
      data-testid="trap"
      role="dialog"
      aria-modal="true"
      gDialogTrap
      [gDialogTrapActive]="active()"
      (gDialogClose)="closedCount = closedCount + 1; active.set(false)"
    >
      <h2 tabindex="-1" data-testid="heading">Title</h2>
      <button type="button" data-testid="first">First</button>
      <button type="button" disabled data-testid="disabled">Disabled</button>
      <button type="button" hidden data-testid="hidden">Hidden</button>
      <button type="button" data-testid="last">Last</button>
    </div>
  `,
})
class TrapHostComponent {
  readonly active = signal(false);
  closedCount = 0;
}

describe("DialogTrapDirective", () => {
  let fixture: ComponentFixture<TrapHostComponent> | null = null;

  afterEach(() => {
    fixture?.destroy();
    (fixture?.nativeElement as HTMLElement | undefined)?.remove();
    fixture = null;
    TestBed.resetTestingModule();
  });

  function setup(): ComponentFixture<TrapHostComponent> {
    TestBed.configureTestingModule({ imports: [TrapHostComponent] });
    fixture = TestBed.createComponent(TrapHostComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.autoDetectChanges();
    return fixture;
  }

  function press(target: EventTarget, key: string, shiftKey = false) {
    const ev = new KeyboardEvent("keydown", {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
    return ev;
  }

  it("wraps Tab/Shift+Tab, skips hidden/disabled elements, prevents Shift+Tab escape from heading, and restores focus", async () => {
    const f = setup();
    const el = f.nativeElement as HTMLElement;
    const opener = el.querySelector('[data-testid="opener"]') as HTMLElement;
    const trap = el.querySelector('[data-testid="trap"]') as HTMLElement;
    const heading = el.querySelector('[data-testid="heading"]') as HTMLElement;
    const first = el.querySelector('[data-testid="first"]') as HTMLElement;
    const last = el.querySelector('[data-testid="last"]') as HTMLElement;

    opener.focus();
    expect(press(document, "Escape").defaultPrevented).toBe(false);

    f.componentInstance.active.set(true);
    f.detectChanges();
    await f.whenStable();

    expect(trap.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(first);

    // Shift+Tab from a non-tabbable heading inside the dialog must wrap to last, not escape.
    heading.focus();
    expect(press(heading, "Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Tab from last wraps to first, skipping disabled and hidden buttons.
    expect(press(last, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    // Escape closes and restores focus to opener.
    expect(press(document, "Escape").defaultPrevented).toBe(true);
    f.detectChanges();
    await f.whenStable();
    expect(f.componentInstance.closedCount).toBe(1);
    expect(document.activeElement).toBe(opener);
  });
});
