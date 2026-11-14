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
  DestroyRef,
  Directive,
  ElementRef,
  Injectable,
  inject,
  signal,
} from "@angular/core";
import { PHONE_QUERY } from "../shared/split";

function isNarrowViewport(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  return (
    Number.isFinite(win.innerWidth) &&
    win.innerWidth > 0 &&
    win.innerWidth < 600
  );
}

function detectMobileViewport(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  const mqlMatches =
    typeof win.matchMedia === "function" &&
    Boolean(win.matchMedia(PHONE_QUERY)?.matches);
  return mqlMatches || isNarrowViewport(doc);
}

/** Tracks `< 600px` mobile phone viewport state for Fleet bottom clearance. */
@Injectable()
export class FleetMobileTracker {
  private readonly doc = inject(DOCUMENT);
  private readonly host = inject(ElementRef) as ElementRef<HTMLElement>;
  readonly isMobile = signal(false);

  constructor() {
    const destroyRef = inject(DestroyRef);
    const win = this.doc.defaultView;
    const mql =
      win && typeof win.matchMedia === "function"
        ? (win.matchMedia(PHONE_QUERY) ?? null)
        : null;
    const apply = (mobile: boolean): void => {
      this.isMobile.set(mobile);
      this.host.nativeElement.classList.toggle("is-mobile", mobile);
    };
    const sync = (): void => {
      apply(detectMobileViewport(this.doc));
    };
    const onMqlChange = (ev: MediaQueryListEvent): void => {
      apply(ev.matches || isNarrowViewport(this.doc));
    };
    sync();
    mql?.addEventListener?.("change", onMqlChange);
    win?.addEventListener?.("resize", sync);
    destroyRef.onDestroy(() => {
      mql?.removeEventListener?.("change", onMqlChange);
      win?.removeEventListener?.("resize", sync);
    });
  }
}

/** Applies `.is-mobile` class to Fleet containers under 600px viewports. */
@Directive({
  selector: "[gFleetMobile]",
  host: {
    "[class.is-mobile]": "tracker.isMobile()",
  },
})
export class FleetMobileDirective {
  protected readonly tracker = inject(FleetMobileTracker);
}
