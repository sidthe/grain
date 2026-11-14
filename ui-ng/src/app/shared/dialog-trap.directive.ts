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

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';

const INITIAL_FOCUS_SELECTOR =
  'input:not([disabled]):not([readonly]):not([type="hidden"]), textarea:not([disabled]):not([readonly]), button:not([disabled]), a[href], area[href], [tabindex]:not([tabindex="-1"])';

function isFocusableVisible(
  el: HTMLElement,
  host: HTMLElement,
  win: Window | null,
): boolean {
  if (
    el.hidden ||
    el.closest("[hidden],[inert],fieldset[disabled]") ||
    (el as HTMLButtonElement).disabled ||
    el.getAttribute("tabindex") === "-1"
  ) {
    return false;
  }
  if (!win || typeof win.getComputedStyle !== "function") return true;
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    const st = win.getComputedStyle(cur);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (cur === host) break;
  }
  return true;
}

function findAdjacentItem(
  items: readonly HTMLElement[],
  active: HTMLElement,
  dir: "prev" | "next",
): HTMLElement | null {
  if (dir === "prev") {
    for (let i = items.length - 1; i >= 0; i--) {
      if (
        (items[i].compareDocumentPosition(active) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
      ) {
        return items[i];
      }
    }
    return null;
  }
  for (const item of items) {
    if (
      (active.compareDocumentPosition(item) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0
    ) {
      return item;
    }
  }
  return null;
}

@Directive({
  selector: "[gDialogTrap]",
  host: {
    "(keydown)": "onHostKeydown($event)",
  },
})
export class DialogTrapDirective implements OnInit, AfterViewInit, OnDestroy {
  readonly gDialogTrapActive = input(true);
  readonly gDialogTrapOutside = input(true);
  readonly gDialogTrapRestoreFocus = input(true);
  readonly gDialogClose = output<void>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private previousFocus: HTMLElement | null = null;
  private initialized = false;
  private activeState = false;
  private listenerAttached = false;
  private readonly handledEvents = new WeakSet<Event>();

  private readonly onKeydown = (ev: KeyboardEvent): void => {
    this.handleKeydown(ev);
  };

  constructor() {
    effect(() => {
      const shouldBeActive = this.gDialogTrapActive();
      if (!this.initialized) return;
      this.syncActive(shouldBeActive);
    });
  }

  ngOnInit(): void {
    if (this.gDialogTrapActive()) {
      this.capturePreviousFocus();
    }
  }

  ngAfterViewInit(): void {
    this.initialized = true;
    const host = this.el.nativeElement;
    if (!host.hasAttribute("tabindex")) {
      host.setAttribute("tabindex", "-1");
    }
    this.syncActive(this.gDialogTrapActive());
  }

  ngOnDestroy(): void {
    this.detachListener();
    const shouldRestore = this.activeState && this.gDialogTrapRestoreFocus();
    this.activeState = false;
    this.restoreFocus(shouldRestore);
  }

  protected onHostKeydown(ev: KeyboardEvent): void {
    this.handleKeydown(ev);
  }

  private capturePreviousFocus(): void {
    const active = this.doc.activeElement;
    const host = this.el.nativeElement;
    this.previousFocus =
      active instanceof HTMLElement && !host.contains(active) ? active : null;
  }

  private attachListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    this.zone.runOutsideAngular(() => {
      this.doc.addEventListener("keydown", this.onKeydown, true);
    });
  }

  private detachListener(): void {
    if (!this.listenerAttached) return;
    this.listenerAttached = false;
    this.doc.removeEventListener("keydown", this.onKeydown, true);
  }

  private syncActive(nextActive: boolean): void {
    if (nextActive === this.activeState) return;
    this.activeState = nextActive;
    if (nextActive) {
      if (!this.previousFocus) {
        this.capturePreviousFocus();
      }
      this.attachListener();
      this.focusInitial();
    } else {
      this.detachListener();
      this.restoreFocus(this.gDialogTrapRestoreFocus());
    }
  }

  private focusInitial(): void {
    const host = this.el.nativeElement;
    const focusNow = () => {
      if (!this.activeState || !host.isConnected) return;
      const active = this.doc.activeElement;
      if (active && host.contains(active) && active !== host) return;
      const win = this.doc.defaultView;
      const first = Array.from(
        host.querySelectorAll<HTMLElement>(INITIAL_FOCUS_SELECTOR),
      ).find((item) => isFocusableVisible(item, host, win));
      (first ?? host).focus();
    };
    if (host.isConnected) {
      focusNow();
    }
    queueMicrotask(focusNow);
  }

  private restoreFocus(shouldRestore: boolean): void {
    const prev = this.previousFocus;
    this.previousFocus = null;
    if (!shouldRestore || !prev) return;
    queueMicrotask(() => {
      if (prev.isConnected) prev.focus();
    });
  }

  private handleKeydown(ev: KeyboardEvent): void {
    if (
      !this.activeState ||
      ev.defaultPrevented ||
      this.handledEvents.has(ev)
    ) {
      return;
    }
    this.handledEvents.add(ev);
    const host = this.el.nativeElement;
    if (this.hasHigherModalOverlay(host)) return;

    if (ev.key === "Escape") {
      if (
        host.getAttribute("aria-modal") !== "true" &&
        this.doc.querySelector("#create-menu, #rail-more-menu, #more-sheet")
      ) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.zone.run(() => this.gDialogClose.emit());
      return;
    }
    if (ev.key === "Tab") {
      this.trapTab(ev);
    }
  }

  private hasHigherModalOverlay(host: HTMLElement): boolean {
    const modals = this.doc.querySelectorAll<HTMLElement>(
      '[aria-modal="true"], dialog[open], #account-popover',
    );
    const active = this.doc.activeElement;
    for (const m of Array.from(modals)) {
      if (m === host || m.contains(host)) continue;
      if (m.hasAttribute("inert") || m.getAttribute("aria-hidden") === "true") {
        continue;
      }
      if (
        host.contains(m) ||
        host.getAttribute("aria-modal") !== "true" ||
        (host.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) !==
          0 ||
        (active instanceof HTMLElement && m.contains(active))
      ) {
        return true;
      }
    }
    return false;
  }

  private trapTab(ev: KeyboardEvent): void {
    const host = this.el.nativeElement;
    const win = this.doc.defaultView;
    const items = Array.from(
      host.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((item) => isFocusableVisible(item, host, win));
    const active =
      this.doc.activeElement instanceof HTMLElement
        ? this.doc.activeElement
        : null;
    const inside = active !== null && host.contains(active);

    if (!inside && !this.gDialogTrapOutside() && active !== this.doc.body) {
      return;
    }

    if (items.length === 0) {
      ev.preventDefault();
      host.focus();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];

    if (!inside || active === host) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
      return;
    }

    const idx = items.indexOf(active);
    if (ev.shiftKey) {
      if (idx === 0) {
        ev.preventDefault();
        last.focus();
      } else if (idx === -1) {
        const prev = findAdjacentItem(items, active, "prev");
        ev.preventDefault();
        (prev ?? last).focus();
      }
    } else {
      if (idx === items.length - 1) {
        ev.preventDefault();
        first.focus();
      } else if (idx === -1) {
        const next = findAdjacentItem(items, active, "next");
        ev.preventDefault();
        (next ?? first).focus();
      }
    }
  }
}
