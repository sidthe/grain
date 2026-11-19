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

import { APP_BASE_HREF } from "@angular/common";
import { TestBed } from "@angular/core/testing";
import { provideRouter, TitleStrategy } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { GrainConfig } from "../api/models";
import { AppComponent } from "../app.component";
import { GrainTitleStrategy } from "../app.config";
import { AccessService } from "../services/access.service";
import { ThemeService } from "../services/theme.service";
import { CHLADNI_ROSETTE_PATH } from "../shared/brand-mark";
import { InstanceIdentityPopoverComponent } from "./instance-identity-popover.component";

class FakeIdentityShellApi {
  configBody: GrainConfig = {
    version: "v3.6.0-test",
    deploymentId: "dep-1234",
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
  };
  postCalls: Array<{ key: string; body: unknown }> = [];
  clearedPrefixes: Array<string | undefined> = [];
  configCalls = 0;

  config = () => {
    this.configCalls++;
    return Promise.resolve({ ...this.configBody });
  };
  tasks = () => Promise.resolve([]);
  get = () => Promise.resolve({ sessions: [] });
  getIfChanged = (route: string) => {
    if (route === "GET /api/tasks") {
      return Promise.resolve({ body: [], changed: true });
    }
    return Promise.resolve({ body: [], changed: false });
  };
  post = (key: string, _params?: unknown, body?: unknown) => {
    this.postCalls.push({ key, body });
    if (key === "POST /api/settings" && body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (typeof rec["environmentName"] === "string") {
        this.configBody.environmentName = rec["environmentName"].trim();
      }
      if (typeof rec["headerColor"] === "string") {
        this.configBody.headerColor = rec["headerColor"];
      }
      if (typeof rec["headerPattern"] === "string") {
        this.configBody.headerPattern = rec["headerPattern"];
      }
      return Promise.resolve({
        environmentName: this.configBody.environmentName ?? "",
        headerColor: this.configBody.headerColor ?? "",
        headerPattern: this.configBody.headerPattern ?? "",
      });
    }
    return Promise.resolve({});
  };
  clearConditionalCache = (prefix?: string) => {
    this.clearedPrefixes.push(prefix);
  };
  whoami = () =>
    Promise.resolve({
      authenticated: true,
      actor: { kind: "human", id: "op@example.com", label: "Operator" },
    });
  notifications = () => Promise.resolve([]);
  openNotifications = () => Promise.resolve([]);
  localScriptApprovals = () => Promise.resolve([]);
}

function setInput(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Instance identity top-bar, popover, title, and tinted favicon", () => {
  let faviconLink: HTMLLinkElement;

  beforeEach(() => {
    document.title = "Inbox · grain";
    document.head
      .querySelectorAll("#grain-favicon-svg, #grain-favicon-png")
      .forEach((n) => n.remove());
    faviconLink = document.createElement("link");
    faviconLink.id = "grain-favicon-svg";
    faviconLink.rel = "icon";
    faviconLink.href = "grain-favicon-light.svg";
    document.head.appendChild(faviconLink);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    document.title = "Grain";
    delete document.documentElement.dataset["headerColor"];
    document.head
      .querySelectorAll("#grain-favicon-svg, #grain-favicon-png")
      .forEach((n) => n.remove());
  });

  async function mountShell(configPatch: Partial<GrainConfig> = {}) {
    const api = new FakeIdentityShellApi();
    api.configBody = { ...api.configBody, ...configPatch };
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        { provide: APP_BASE_HREF, useValue: "/next/" },
        provideRouter([
          { path: "inbox", title: "Inbox · grain", component: AppComponent },
          {
            path: "settings/general",
            title: "Settings · grain",
            component: AppComponent,
          },
          { path: "**", redirectTo: "inbox" },
        ]),
        { provide: TitleStrategy, useClass: GrainTitleStrategy },
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    TestBed.flushEffects();
    return {
      fixture,
      api,
      root: fixture.nativeElement as HTMLElement,
    };
  }

  it("renders + Name instance cue only when unnamed, admin, and unlocked", async () => {
    const { root, fixture } = await mountShell({ environmentName: "" });
    const access = TestBed.inject(AccessService);

    expect(
      root
        .querySelector('[data-testid="instance-name-cue"]')
        ?.textContent?.trim(),
    ).toBe("+ Name instance");
    expect(
      root.querySelector('[data-testid="instance-identity-badge"]'),
    ).toBeNull();

    // Read-only viewer must never see + Name instance cue.
    access.setConfig({
      deploymentId: "dep-1234",
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["tasks:read", "settings:read"],
      },
    });
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="instance-name-cue"]')).toBeNull();

    // Locked settings must also hide + Name instance cue.
    access.setConfig({
      deploymentId: "dep-1234",
      settingsLocked: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    });
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="instance-name-cue"]')).toBeNull();
  });

  it("renders themed badge, prefixed document.title, and tinted SVG favicon when named", async () => {
    const { root, fixture } = await mountShell({
      environmentName: "staging · eu",
      headerColor: "ocean",
      headerPattern: "waves",
      deploymentId: "eu-west-1",
    });

    const topBar = root.querySelector("header.top-bar")!;
    expect(topBar.getAttribute("data-header-color")).toBe("ocean");
    expect(topBar.getAttribute("data-header-pattern")).toBe("waves");

    const badge = root.querySelector(
      '[data-testid="instance-identity-badge"]',
    )!;
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.textContent).toContain("staging · eu");
    expect(root.querySelector('[data-testid="instance-name-cue"]')).toBeNull();

    expect(document.title).toBe("[staging · eu] Inbox · grain");
    const svgHref = faviconLink.getAttribute("href") ?? "";
    expect(svgHref.startsWith("data:image/svg+xml,")).toBe(true);
    const decodedSvg = decodeURIComponent(
      svgHref.slice("data:image/svg+xml,".length),
    );
    expect(decodedSvg).toContain(CHLADNI_ROSETTE_PATH);
    expect(decodedSvg).toContain("#1a73e8");

    // Viewer gets a non-interactive pill with full environment name + deployment ID.
    const access = TestBed.inject(AccessService);
    access.setConfig({
      environmentName: "staging · eu",
      headerColor: "ocean",
      headerPattern: "waves",
      deploymentId: "eu-west-1",
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["tasks:read"],
      },
    });
    fixture.detectChanges();
    const viewerBadge = root.querySelector(
      '[data-testid="instance-identity-badge"]',
    )!;
    expect(viewerBadge.tagName).toBe("SPAN");
    expect(viewerBadge.textContent).toContain("staging · eu");
  });

  it("live-previews changes in Quick Identity Popover, reverts on cancel/Escape, and saves via POST /api/settings", async () => {
    const { root, fixture, api } = await mountShell({
      environmentName: "",
      headerColor: "",
      headerPattern: "",
    });
    const topBar = root.querySelector("header.top-bar")!;

    // Open popover via + Name instance cue.
    root
      .querySelector<HTMLButtonElement>('[data-testid="instance-name-cue"]')!
      .click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pop = root.querySelector('[data-testid="instance-identity-popover"]');
    expect(pop).not.toBeNull();

    // Type a name, select coral + grid -> immediate live preview on .top-bar, title, and favicon.
    setInput(
      root.querySelector<HTMLInputElement>(
        '[data-testid="identity-popover-name"]',
      )!,
      "fork · dev",
    );
    root
      .querySelector<HTMLButtonElement>('[data-testid="identity-color-coral"]')!
      .click();
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="identity-pattern-grid"]',
      )!
      .click();
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(topBar.getAttribute("data-header-color")).toBe("coral");
    expect(topBar.getAttribute("data-header-pattern")).toBe("grid");
    expect(
      root.querySelector('[data-testid="instance-identity-badge"]')
        ?.textContent,
    ).toContain("fork · dev");
    expect(document.title).toBe("[fork · dev] Inbox · grain");
    expect(faviconLink.getAttribute("href")).toContain("data:image/svg+xml,");

    // Cancel reverts cleanly.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="identity-popover-cancel"]',
      )!
      .click();
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(
      root.querySelector('[data-testid="instance-identity-popover"]'),
    ).toBeNull();
    expect(topBar.getAttribute("data-header-color")).toBeNull();
    expect(topBar.getAttribute("data-header-pattern")).toBeNull();
    expect(
      root.querySelector('[data-testid="instance-name-cue"]'),
    ).not.toBeNull();
    expect(document.title).toBe("Inbox · grain");
    expect(faviconLink.getAttribute("href")).toBe("grain-favicon-light.svg");

    // Reopen, edit, press Escape -> reverts cleanly too.
    root
      .querySelector<HTMLButtonElement>('[data-testid="instance-name-cue"]')!
      .click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    root
      .querySelector<HTMLButtonElement>('[data-testid="identity-color-teal"]')!
      .click();
    fixture.detectChanges();
    expect(topBar.getAttribute("data-header-color")).toBe("teal");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    fixture.detectChanges();
    TestBed.flushEffects();
    expect(topBar.getAttribute("data-header-color")).toBeNull();
    expect(
      root.querySelector('[data-testid="instance-identity-popover"]'),
    ).toBeNull();

    // Reopen, set name + plum + dots, and Save.
    root
      .querySelector<HTMLButtonElement>('[data-testid="instance-name-cue"]')!
      .click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    setInput(
      root.querySelector<HTMLInputElement>(
        '[data-testid="identity-popover-name"]',
      )!,
      "prod · canary",
    );
    root
      .querySelector<HTMLButtonElement>('[data-testid="identity-color-plum"]')!
      .click();
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="identity-pattern-dots"]',
      )!
      .click();
    fixture.detectChanges();

    const beforeConfigCalls = api.configCalls;
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="identity-popover-save"]',
      )!
      .click();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(api.postCalls).toContainEqual({
      key: "POST /api/settings",
      body: {
        environmentName: "prod · canary",
        headerColor: "plum",
        headerPattern: "dots",
      },
    });
    expect(api.clearedPrefixes).toContain("/api/config");
    expect(api.configCalls).toBeGreaterThan(beforeConfigCalls);
    expect(
      root.querySelector('[data-testid="instance-identity-popover"]'),
    ).toBeNull();
    expect(topBar.getAttribute("data-header-color")).toBe("plum");
    expect(topBar.getAttribute("data-header-pattern")).toBe("dots");
    expect(
      root.querySelector('[data-testid="instance-identity-badge"]')
        ?.textContent,
    ).toContain("prod · canary");
    expect(document.title).toBe("[prod · canary] Inbox · grain");
  });

  it("disables Quick Identity Popover fields and explains grain/config PRs when settingsLocked is true", async () => {
    const api = new FakeIdentityShellApi();
    TestBed.configureTestingModule({
      imports: [InstanceIdentityPopoverComponent],
      providers: [provideRouter([]), { provide: GrainApi, useValue: api }],
    });
    const access = TestBed.inject(AccessService);
    access.setConfig({
      environmentName: "locked-prod",
      headerColor: "forest",
      headerPattern: "diagonal",
      settingsLocked: true,
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    });
    const fixture = TestBed.createComponent(InstanceIdentityPopoverComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('[data-testid="identity-popover-locked"]')
        ?.textContent,
    ).toContain("grain/config");
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-testid="identity-popover-name"]',
      )?.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-color-ocean"]',
      )?.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-pattern-waves"]',
      )?.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-popover-save"]',
      )?.disabled,
    ).toBe(true);
  });

  it("updates tinted favicon polarity when ThemeService switches between light and dark", async () => {
    await mountShell({
      environmentName: "staging",
      headerColor: "amber",
      headerPattern: "",
    });
    const theme = TestBed.inject(ThemeService);

    theme.setMode("light");
    TestBed.flushEffects();
    expect(
      decodeURIComponent(faviconLink.getAttribute("href") ?? ""),
    ).toContain("#b45309");

    theme.setMode("dark");
    TestBed.flushEffects();
    expect(
      decodeURIComponent(faviconLink.getAttribute("href") ?? ""),
    ).toContain("#f5b041");
  });

  it("restores keyboard focus to the swapped top-bar button after cancelling a preview name change", async () => {
    const { root, fixture } = await mountShell({
      environmentName: "",
      headerColor: "",
      headerPattern: "",
    });
    // Attach fixture element to document.body so .focus() updates document.activeElement.
    document.body.appendChild(root);
    try {
      // Case 1: unnamed -> open via cue -> type preview name (mounts badge, destroys cue) -> Escape.
      root
        .querySelector<HTMLButtonElement>('[data-testid="instance-name-cue"]')!
        .click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      setInput(
        root.querySelector<HTMLInputElement>(
          '[data-testid="identity-popover-name"]',
        )!,
        "preview-swap",
      );
      fixture.detectChanges();
      expect(
        root.querySelector('[data-testid="instance-identity-badge"]'),
      ).not.toBeNull();
      expect(
        root.querySelector('[data-testid="instance-name-cue"]'),
      ).toBeNull();

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();

      const restoredCue = root.querySelector<HTMLButtonElement>(
        '[data-testid="instance-name-cue"]',
      );
      expect(restoredCue).not.toBeNull();
      expect(document.activeElement).toBe(restoredCue);

      // Case 2: named -> open via badge -> clear name in preview (mounts cue, destroys badge) -> Cancel.
      const access = TestBed.inject(AccessService);
      access.patchConfig({ environmentName: "prod-west" });
      fixture.detectChanges();
      TestBed.flushEffects();

      root
        .querySelector<HTMLButtonElement>(
          '[data-testid="instance-identity-badge"]',
        )!
        .click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      setInput(
        root.querySelector<HTMLInputElement>(
          '[data-testid="identity-popover-name"]',
        )!,
        "",
      );
      fixture.detectChanges();
      expect(
        root.querySelector('[data-testid="instance-name-cue"]'),
      ).not.toBeNull();

      root
        .querySelector<HTMLButtonElement>(
          '[data-testid="identity-popover-cancel"]',
        )!
        .click();
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();

      const restoredBadge = root.querySelector<HTMLButtonElement>(
        '[data-testid="instance-identity-badge"]',
      );
      expect(restoredBadge).not.toBeNull();
      expect(document.activeElement).toBe(restoredBadge);
    } finally {
      root.remove();
    }
  });

  it("uses roving tabindex on popover radiogroups and skips non-roving/disabled radios in focus trap", async () => {
    const api = new FakeIdentityShellApi();
    TestBed.configureTestingModule({
      imports: [InstanceIdentityPopoverComponent],
      providers: [provideRouter([]), { provide: GrainApi, useValue: api }],
    });
    const access = TestBed.inject(AccessService);
    access.setConfig({
      environmentName: "staging",
      headerColor: "ocean",
      headerPattern: "dots",
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    });
    const fixture = TestBed.createComponent(InstanceIdentityPopoverComponent);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    try {
      fixture.detectChanges();

      const colorRadios = Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          '[data-testid="identity-color-group"] [role="radio"]',
        ),
      );
      expect(
        colorRadios.filter((b) => b.getAttribute("tabindex") === "0").length,
      ).toBe(1);
      const oceanBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-color-ocean"]',
      )!;
      expect(oceanBtn.getAttribute("tabindex")).toBe("0");
      expect(
        root
          .querySelector('[data-testid="identity-color-default"]')
          ?.getAttribute("tabindex"),
      ).toBe("-1");

      // ArrowRight moves selection, focus, and roving tabindex="0" to teal.
      oceanBtn.focus();
      oceanBtn.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      fixture.detectChanges();
      const tealBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-color-teal"]',
      )!;
      expect(tealBtn.getAttribute("aria-checked")).toBe("true");
      expect(tealBtn.getAttribute("tabindex")).toBe("0");
      expect(oceanBtn.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(tealBtn);

      const patternRadios = Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          '[data-testid="identity-pattern-group"] [role="radio"]',
        ),
      );
      expect(
        patternRadios.filter((b) => b.getAttribute("tabindex") === "0").length,
      ).toBe(1);
      expect(
        root
          .querySelector('[data-testid="identity-pattern-dots"]')
          ?.getAttribute("tabindex"),
      ).toBe("0");

      // Focus trap wraps Save -> Name input (and Shift+Tab Name input -> Save), never onto tabindex="-1".
      const pop = root.querySelector<HTMLElement>(
        '[data-testid="instance-identity-popover"]',
      )!;
      const nameInput = root.querySelector<HTMLInputElement>(
        '[data-testid="identity-popover-name"]',
      )!;
      const saveBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-popover-save"]',
      )!;

      saveBtn.focus();
      pop.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      expect(document.activeElement).toBe(nameInput);

      pop.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
        }),
      );
      expect(document.activeElement).toBe(saveBtn);

      // When locked (readOnly), Shift+Tab from Settings link wraps to Cancel, skipping disabled radios.
      access.setConfig({
        environmentName: "staging",
        headerColor: "ocean",
        headerPattern: "dots",
        settingsLocked: true,
        access: {
          role: "grain/operator",
          roles: ["grain/operator"],
          full: true,
          scopes: [],
        },
      });
      fixture.detectChanges();
      const settingsLink = root.querySelector<HTMLAnchorElement>(
        '[data-testid="identity-popover-settings-link"]',
      )!;
      const cancelBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="identity-popover-cancel"]',
      )!;
      settingsLink.focus();
      pop.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
        }),
      );
      expect(document.activeElement).toBe(cancelBtn);
    } finally {
      root.remove();
    }
  });
});
