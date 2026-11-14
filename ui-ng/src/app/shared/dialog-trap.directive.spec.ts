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
import { TestBed } from "@angular/core/testing";
import { DialogTrapDirective } from "./dialog-trap.directive";

@Component({
  selector: "g-trap-host-test",
  imports: [DialogTrapDirective],
  template: `
    <button type="button" data-testid="opener">Opener</button>
    <div
      data-testid="trap-box"
      gDialogTrap
      [gDialogTrapActive]="active()"
      [gDialogTrapRestoreFocus]="restore()"
      (gDialogClose)="closedCount = closedCount + 1"
    >
      <h2 tabindex="-1" data-testid="heading">Heading</h2>
      @if (withControls()) {
        <button type="button" data-testid="first">First</button>
        <button type="button" disabled data-testid="disabled">Disabled</button>
        <input type="hidden" value="x" />
        <button type="button" data-testid="last">Last</button>
      }
      <div tabindex="-1" data-testid="tail">Tail</div>
    </div>
  `,
})
class TrapHostComponent {
  readonly active = signal(false);
  readonly restore = signal(true);
  readonly withControls = signal(true);
  closedCount = 0;
}

function key(k: string, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: k,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(ev);
  return ev;
}

describe("DialogTrapDirective", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("activates/deactivates via gDialogTrapActive, handles non-tabbable children, and restores focus", async () => {
    const f = TestBed.createComponent(TrapHostComponent);
    f.autoDetectChanges();
    await f.whenStable();

    const el = f.nativeElement as HTMLElement;
    const opener = el.querySelector('[data-testid="opener"]') as HTMLElement;
    const box = el.querySelector('[data-testid="trap-box"]') as HTMLElement;
    const heading = el.querySelector('[data-testid="heading"]') as HTMLElement;
    const first = el.querySelector('[data-testid="first"]') as HTMLElement;
    const last = el.querySelector('[data-testid="last"]') as HTMLElement;
    const tail = el.querySelector('[data-testid="tail"]') as HTMLElement;

    expect(box.getAttribute("tabindex")).toBe("-1");

    // Inactive: Tab on opener is not intercepted.
    opener.focus();
    expect(key("Tab").defaultPrevented).toBe(false);

    // Activate: initial focus enters trap.
    f.componentInstance.active.set(true);
    f.detectChanges();
    await Promise.resolve();
    await f.whenStable();
    expect(document.activeElement).toBe(first);

    // Shift+Tab from heading (tabindex="-1" before first) wraps to last.
    heading.focus();
    expect(key("Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Tab from tail (tabindex="-1" after last) wraps to first.
    tail.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    // Escape emits gDialogClose.
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(f.componentInstance.closedCount).toBe(1);

    // Deactivate restores focus to opener.
    f.componentInstance.active.set(false);
    f.detectChanges();
    await Promise.resolve();
    await f.whenStable();
    expect(document.activeElement).toBe(opener);

    f.destroy();
  });

  it("falls back to host focus when there are no focusable controls", async () => {
    const f = TestBed.createComponent(TrapHostComponent);
    f.componentInstance.withControls.set(false);
    f.componentInstance.active.set(true);
    f.autoDetectChanges();
    await Promise.resolve();
    await f.whenStable();

    const box = (f.nativeElement as HTMLElement).querySelector(
      '[data-testid="trap-box"]',
    ) as HTMLElement;
    expect(document.activeElement).toBe(box);
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(key("Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(box);

    f.destroy();
  });
});
