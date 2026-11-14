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
  type AfterViewInit,
  Directive,
  ElementRef,
  NgZone,
  type OnDestroy,
  type OnInit,
  effect,
  inject,
  input,
  output,
} from "@angular/core";

const ACTIVE_TRAPS: DialogTrapDirective[] = [];

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const INITIAL_FOCUS_SELECTOR =
  'input:not([disabled]):not([type="hidden"]):not([readonly]), textarea:not([disabled]):not([readonly]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function isFocusableVisible(
  el: HTMLElement,
  host: HTMLElement,
  win: Window | null,
): boolean {
  if (el.hidden || el.closest("[hidden],[inert]")) return false;
  if (!win || typeof win.getComputedStyle !== "function") return true;
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    const st = win.getComputedStyle(cur);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (cur === host) break;
  }
  return true;
}

@Directive({
  selector: "[gDialogTrap]",
})
export class DialogTrapDirective implements OnInit, AfterViewInit, OnDestroy {
  readonly gDialogTrapActive = input(true);
  readonly gDialogTrapRestoreFocus = input(true);
  readonly gDialogClose = output<void>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private previousFocus: HTMLElement | null = null;
  private listening = false;
  private viewReady = false;

  private readonly onKeydown = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented) return;
    if (ACTIVE_TRAPS[ACTIVE_TRAPS.length - 1] !== this) return;
    if (this.hasHigherModal(ev)) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      this.zone.run(() => this.gDialogClose.emit());
      return;
    }
    if (ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      this.trapTab(ev);
    }
  };

  constructor() {
    effect(() => {
      const active = this.gDialogTrapActive();
      if (!this.viewReady) return;
      if (active) this.activate(true);
      else this.deactivate(this.gDialogTrapRestoreFocus());
    });
  }

  ngOnInit(): void {
    if (this.gDialogTrapActive()) {
      this.capturePreviousFocus();
    }
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    const host = this.el.nativeElement;
    if (!host.hasAttribute("tabindex")) {
      host.setAttribute("tabindex", "-1");
    }
    if (this.gDialogTrapActive()) {
      this.activate(true);
    }
  }

  ngOnDestroy(): void {
    this.deactivate(this.gDialogTrapRestoreFocus());
  }

  private capturePreviousFocus(): void {
    const active = this.doc.activeElement;
    if (
      active instanceof HTMLElement &&
      !this.el.nativeElement.contains(active)
    ) {
      this.previousFocus = active;
    }
  }

  private activate(focusInitial: boolean): void {
    if (this.listening) return;
    const host = this.el.nativeElement;
    if (!this.previousFocus) {
      this.capturePreviousFocus();
    }
    this.listening = true;
    if (!ACTIVE_TRAPS.includes(this)) {
      ACTIVE_TRAPS.push(this);
    }
    this.zone.runOutsideAngular(() => {
      this.doc.addEventListener("keydown", this.onKeydown, true);
    });
    if (focusInitial) {
      queueMicrotask(() => {
        if (!this.listening || !host.isConnected) return;
        const win = this.doc.defaultView;
        const first = Array.from(
          host.querySelectorAll<HTMLElement>(INITIAL_FOCUS_SELECTOR),
        ).find((item) => isFocusableVisible(item, host, win));
        (first ?? host).focus();
      });
    }
  }

  private deactivate(restoreFocus: boolean): void {
    const wasListening = this.listening;
    if (this.listening) {
      this.listening = false;
      this.doc.removeEventListener("keydown", this.onKeydown, true);
    }
    const idx = ACTIVE_TRAPS.indexOf(this);
    if (idx >= 0) ACTIVE_TRAPS.splice(idx, 1);
    const prev = this.previousFocus;
    this.previousFocus = null;
    if (wasListening && restoreFocus && prev) {
      queueMicrotask(() => {
        if (prev.isConnected) prev.focus();
      });
    }
  }

  private hasHigherModal(ev: KeyboardEvent): boolean {
    const host = this.el.nativeElement;
    const modals = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[aria-modal="true"], dialog[open]',
      ),
    );
    for (const m of modals) {
      if (m !== host && !m.contains(host)) {
        return true;
      }
    }
    if (
      host.getAttribute("aria-modal") !== "true" &&
      this.doc.querySelector(
        "#create-menu, #rail-more-menu, #more-sheet, #account-popover",
      ) &&
      (ev.key === "Escape" ||
        (ev.target instanceof Node && !host.contains(ev.target)))
    ) {
      return true;
    }
    return false;
  }

  private trapTab(ev: KeyboardEvent): void {
    const host = this.el.nativeElement;
    const win = this.doc.defaultView;
    const items = Array.from(
      host.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((item) => isFocusableVisible(item, host, win));
    if (items.length === 0) {
      ev.preventDefault();
      host.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.doc.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      !host.contains(active) ||
      active === host
    ) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
      return;
    }
    if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
      return;
    }
    if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
      return;
    }
    if (!items.includes(active)) {
      ev.preventDefault();
      if (ev.shiftKey) {
        let prev: HTMLElement | null = null;
        for (const item of items) {
          if (
            item.compareDocumentPosition(active) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ) {
            prev = item;
          }
        }
        (prev ?? last).focus();
      } else {
        const next = items.find(
          (item) =>
            active.compareDocumentPosition(item) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        (next ?? first).focus();
      }
    }
  }
}
