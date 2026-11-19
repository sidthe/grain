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

import { Injectable, computed, effect, inject, signal } from "@angular/core";
import { AccessService } from "./access.service";
import {
  type HeaderColorPreset,
  type HeaderPatternPreset,
  buildTintedFaviconDataUrl,
  formatDocumentTitle,
  headerColorOption,
  normalizeHeaderColor,
  normalizeHeaderPattern,
  stripEnvironmentPrefix,
} from "../shared/instance-identity";

export type ThemeMode = "light" | "dark" | "auto";

export interface HeaderIdentityPreview {
  environmentName: string;
  headerColor: HeaderColorPreset;
  headerPattern: HeaderPatternPreset;
}

// The same localStorage key ui/src/ThemeModeContext.jsx (via
// ui-shared/themeMode.js) reads, so one setting themes both UIs.
export const THEME_STORAGE_KEY = "grain.themeMode";
// The per-browser default for pages that exist in both UIs: "1" sends
// the classic page to its /next/ counterpart (design doc, "Moving pages
// over"). The classic page reads the same key.
export const PREFER_NEXT_STORAGE_KEY = "grain.ui.preferNext";

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

function storedMode(): ThemeMode {
  const raw = readStorage(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto";
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly access = inject(AccessService);
  private readonly _mode = signal<ThemeMode>(storedMode());
  private readonly _systemDark = signal(systemPrefersDark());
  private readonly _preferNext = signal(
    readStorage(PREFER_NEXT_STORAGE_KEY) === "1",
  );
  private readonly _baseTitle = signal<string>(
    typeof document !== "undefined"
      ? stripEnvironmentPrefix(document.title)
      : "Grain",
  );
  private readonly _headerPreview = signal<HeaderIdentityPreview | null>(null);

  readonly mode = this._mode.asReadonly();
  readonly preferNext = this._preferNext.asReadonly();
  readonly baseTitle = this._baseTitle.asReadonly();
  readonly headerPreview = this._headerPreview.asReadonly();
  readonly resolved = computed<"light" | "dark">(() => {
    const m = this._mode();
    if (m !== "auto") return m;
    return this._systemDark() ? "dark" : "light";
  });

  readonly savedEnvironmentName = computed(() =>
    (this.access.rawConfig()?.environmentName ?? "").trim(),
  );
  readonly savedHeaderColor = computed<HeaderColorPreset>(() =>
    normalizeHeaderColor(this.access.rawConfig()?.headerColor),
  );
  readonly savedHeaderPattern = computed<HeaderPatternPreset>(() =>
    normalizeHeaderPattern(this.access.rawConfig()?.headerPattern),
  );

  readonly effectiveEnvironmentName = computed(() => {
    const p = this._headerPreview();
    return p !== null ? p.environmentName.trim() : this.savedEnvironmentName();
  });
  readonly effectiveHeaderColor = computed<HeaderColorPreset>(() => {
    const p = this._headerPreview();
    return p !== null ? p.headerColor : this.savedHeaderColor();
  });
  readonly effectiveHeaderPattern = computed<HeaderPatternPreset>(() => {
    const p = this._headerPreview();
    return p !== null ? p.headerPattern : this.savedHeaderPattern();
  });

  constructor() {
    if (typeof window !== "undefined" && window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener?.("change", (e) => this._systemDark.set(e.matches));
    }
    effect(() => {
      const polarity = this.resolved();
      const color = this.effectiveHeaderColor();
      if (typeof document !== "undefined") {
        document.documentElement.dataset["theme"] = polarity;
        if (color) {
          document.documentElement.dataset["headerColor"] = color;
        } else {
          delete document.documentElement.dataset["headerColor"];
        }
        const svg = document.getElementById(
          "grain-favicon-svg",
        ) as HTMLLinkElement | null;
        if (svg) {
          if (!color) {
            svg.setAttribute("href", `grain-favicon-${polarity}.svg`);
          } else {
            const fill = this.resolveFaviconColor(color, polarity);
            svg.setAttribute("href", buildTintedFaviconDataUrl(fill));
          }
        }
        const png = document.getElementById(
          "grain-favicon-png",
        ) as HTMLLinkElement | null;
        png?.setAttribute("href", `grain-mark-${polarity}.png`);
      }
    });
    effect(() => {
      const base = this._baseTitle();
      const env = this.effectiveEnvironmentName();
      if (typeof document !== "undefined") {
        document.title = formatDocumentTitle(base, env);
      }
    });
  }

  private resolveFaviconColor(
    color: HeaderColorPreset,
    polarity: "light" | "dark",
  ): string {
    if (
      typeof document !== "undefined" &&
      typeof getComputedStyle === "function"
    ) {
      const cssVal = getComputedStyle(document.documentElement)
        .getPropertyValue("--grain-header-favicon")
        .trim();
      if (cssVal) return cssVal;
    }
    const opt = headerColorOption(color);
    return polarity === "dark" ? opt.darkFavicon : opt.lightFavicon;
  }

  setBaseTitle(title: string): void {
    const clean = stripEnvironmentPrefix(title);
    this._baseTitle.set(clean);
    if (typeof document !== "undefined") {
      document.title = formatDocumentTitle(
        clean,
        this.effectiveEnvironmentName(),
      );
    }
  }

  setHeaderPreview(preview: HeaderIdentityPreview | null): void {
    this._headerPreview.set(preview);
  }

  clearHeaderPreview(): void {
    this._headerPreview.set(null);
  }

  toggle(): void {
    this.setMode(this.resolved() === "dark" ? "light" : "dark");
  }

  setMode(mode: ThemeMode): void {
    this._mode.set(mode);
    writeStorage(THEME_STORAGE_KEY, mode);
  }

  setPreferNext(on: boolean): void {
    this._preferNext.set(on);
    writeStorage(PREFER_NEXT_STORAGE_KEY, on ? "1" : null);
  }
}
