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
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { GrainApi, type RouteParams } from "../api/grain-api.service";
import type { GrainConfig } from "../api/models";
import { SettingsPageComponent } from "./settings-page.component";
import {
  missingGcpKeyFields,
  normalizeExternalTokens,
  normalizeGcpKeys,
  normalizePrincipals,
  summarizeTokenScopes,
  validateGcpKeyForm,
  validateTokenScopes,
} from "./settings-security.component";

interface Call {
  method: "GET" | "TEXT" | "POST" | "PUT" | "PATCH" | "DELETE";
  key: string;
  params?: RouteParams;
  body?: unknown;
}

class FakeSecurityApi {
  calls: Call[] = [];

  configBody: GrainConfig & Record<string, unknown> = {
    version: "v3.6.0",
    configRepoOnly: false,
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
  };

  principalsResponse: unknown = [
    { entry: "operator@example.com", role: "grain/operator" },
  ];
  tokensResponse: unknown = [];
  gcpKeysResponse: unknown = [];
  auditConfigResponse: unknown = [];
  auditSecretResponse: unknown = [];
  auditAccessResponse: unknown = [];

  principalsError: Error | null = null;
  tokensError: Error | null = null;
  gcpKeysError: Error | null = null;
  auditError: Error | null = null;

  mintResponse: unknown = { token: "gma_secret_ok_123" };
  rotateResponse: unknown = { token: "gma_rotated_ok_456" };
  mintError: Error | null = null;

  config = () => Promise.resolve(structuredClone(this.configBody));

  private rejectAsync(err: Error): Promise<never> {
    return Promise.resolve().then(() => {
      throw err;
    });
  }

  get = (key: string, params?: RouteParams) => {
    this.calls.push({ method: "GET", key, params });
    if (key === "GET /api/settings") {
      return Promise.resolve({
        environmentName: "Staging",
        externalAgentApi: true,
      });
    }
    if (key === "GET /api/deployment") {
      return Promise.resolve({});
    }
    if (key === "GET /api/access/principals") {
      return this.principalsError
        ? this.rejectAsync(this.principalsError)
        : Promise.resolve(structuredClone(this.principalsResponse));
    }
    if (key === "GET /api/external-agents/tokens") {
      return this.tokensError
        ? this.rejectAsync(this.tokensError)
        : Promise.resolve(structuredClone(this.tokensResponse));
    }
    if (key === "GET /api/gcp-keys") {
      return this.gcpKeysError
        ? this.rejectAsync(this.gcpKeysError)
        : Promise.resolve(structuredClone(this.gcpKeysResponse));
    }
    if (key === "GET /api/deployment/config-audit") {
      return this.auditError
        ? this.rejectAsync(this.auditError)
        : Promise.resolve(structuredClone(this.auditConfigResponse));
    }
    if (
      key === "GET /api/deployment/audit-logs" ||
      key === "GET /api/deployment/secret-audit"
    ) {
      return this.auditError
        ? this.rejectAsync(this.auditError)
        : Promise.resolve(structuredClone(this.auditSecretResponse));
    }
    if (key === "GET /api/access/history") {
      return this.auditError
        ? this.rejectAsync(this.auditError)
        : Promise.resolve(structuredClone(this.auditAccessResponse));
    }
    return Promise.resolve({});
  };

  getText = () => Promise.resolve("");

  post = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "POST", key, params, body });
    if (key === "POST /api/external-agents/tokens") {
      return this.mintError
        ? this.rejectAsync(this.mintError)
        : Promise.resolve(structuredClone(this.mintResponse));
    }
    if (key === "POST /api/external-agents/tokens/{id}/rotate") {
      return Promise.resolve(structuredClone(this.rotateResponse));
    }
    return Promise.resolve({ ok: true });
  };

  put = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "PUT", key, params, body });
    return Promise.resolve({ ok: true });
  };

  patch = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "PATCH", key, params, body });
    return Promise.resolve({ ok: true });
  };

  delete = (key: string, params?: RouteParams) => {
    this.calls.push({ method: "DELETE", key, params });
    return Promise.resolve({ ok: true });
  };
}

async function mountSecurity(url: string, api = new FakeSecurityApi()) {
  await TestBed.configureTestingModule({
    imports: [SettingsPageComponent],
    providers: [
      provideRouter(
        [
          { path: "settings", component: SettingsPageComponent },
          { path: "settings/:section", component: SettingsPageComponent },
        ],
        withComponentInputBinding(),
      ),
      { provide: APP_BASE_HREF, useValue: "/next/" },
      { provide: GrainApi, useValue: api },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  harness.fixture.autoDetectChanges(true);
  await harness.fixture.whenStable();
  await new Promise((r) => setTimeout(r, 30));
  await harness.fixture.whenStable();
  return {
    harness,
    el: harness.fixture.nativeElement as HTMLElement,
    api,
  };
}

function setInput(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SettingsSecurityComponent helpers & error states", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("validates token scopes and flags empty, internal, whitespace, and malformed repo scopes", () => {
    expect(validateTokenScopes("").error).toContain("Enter at least one");
    expect(validateTokenScopes(" , , ").error).toContain("Enter at least one");
    expect(validateTokenScopes("tasks:read ci:read").error).toContain(
      "whitespace",
    );
    expect(validateTokenScopes("internal").error).toContain("internal");
    expect(validateTokenScopes("api:internal").error).toContain("internal");
    expect(validateTokenScopes("api:").error).toContain('after "api:"');
    expect(validateTokenScopes("@acme/widgets").error).toContain('before "@"');
    expect(validateTokenScopes("tasks:read@").error).toContain("owner/name");
    expect(validateTokenScopes("tasks:read@noslash").error).toContain(
      "owner/name",
    );
    expect(validateTokenScopes("tasks:").error).toContain("invalid syntax");

    expect(
      validateTokenScopes(
        "tasks:read, tasks:*, ci-monitor, api:tasks:write@acme/widgets, tasks:read",
      ),
    ).toEqual({
      scopes: [
        "tasks:read",
        "tasks:*",
        "ci-monitor",
        "api:tasks:write@acme/widgets",
      ],
      error: null,
    });
  });

  it("validates GCP key forms and detects missing API metadata keys", () => {
    expect(
      validateGcpKeyForm({
        name: "k1",
        projectId: "proj",
        serviceAccountEmail: "not-an-email",
        countRaw: "",
        maxKeyAge: "",
      }).error,
    ).toContain("valid email");

    expect(
      validateGcpKeyForm({
        name: "k1",
        projectId: "proj",
        serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
        countRaw: "-1",
        maxKeyAge: "",
      }).error,
    ).toContain("non-negative integer");

    expect(
      validateGcpKeyForm({
        name: "k1",
        projectId: "proj",
        serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
        countRaw: "2",
        maxKeyAge: "forever",
      }).error,
    ).toContain("Go duration");

    expect(
      validateGcpKeyForm({
        name: "k1",
        projectId: "proj",
        serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
        countRaw: "2",
        maxKeyAge: "24h",
      }),
    ).toEqual({ error: null, count: 2 });

    expect(missingGcpKeyFields({ name: "", projectId: "" })).toEqual([
      "name",
      "projectId",
      "serviceAccountEmail",
    ]);

    expect(
      summarizeTokenScopes({ id: "t1", name: "empty-tok", scopes: [] }),
    ).toEqual({
      label: "Missing scopes",
      resolvedDetail: null,
      missingScopes: true,
    });

    expect(
      normalizeExternalTokens({ tokens: [null, { name: "no-id" }] }),
    ).toEqual([
      {
        id: "",
        name: "no-id",
        tokenPrefix: undefined,
        prefix: undefined,
        owner: undefined,
        scopeSet: undefined,
        scopes: [],
        resolvedScopes: [],
        repos: [],
        revokedAt: null,
        revoked: false,
        expiresAt: null,
        active: undefined,
      },
    ]);
    expect(normalizeGcpKeys(null)).toEqual([]);
    expect(normalizePrincipals({ items: [{ entry: "a@b.com" }] })).toEqual([
      { entry: "a@b.com", role: "", label: undefined, addedBy: undefined },
    ]);
  });

  it("blocks minting and renders inline validation errors when token scopes are empty or invalid", async () => {
    const { el, api, harness } = await mountSecurity("/settings/access");

    const nameInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-gma-token-name"]',
    )!;
    const scopesInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-gma-token-scopes"]',
    )!;
    const mintBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="mint-gma-token-btn"]',
    )!;

    setInput(nameInput, "ci-bot");
    setInput(scopesInput, "");
    harness.detectChanges();

    expect(scopesInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      el.querySelector('[data-testid="gma-token-scopes-error"]')?.textContent,
    ).toContain("Enter at least one token scope");

    mintBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    harness.detectChanges();

    expect(
      api.calls.some((c) => c.key === "POST /api/external-agents/tokens"),
    ).toBe(false);
    expect(
      el.querySelector('[data-testid="tokens-error"]')?.textContent,
    ).toContain("Enter at least one token scope");

    setInput(scopesInput, "internal");
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="gma-token-scopes-error"]')?.textContent,
    ).toContain("reserved for Grain internals");

    setInput(scopesInput, "tasks:read,ci:read");
    harness.detectChanges();
    expect(scopesInput.getAttribute("aria-invalid")).toBeNull();
    expect(
      el.querySelector('[data-testid="gma-token-scopes-error"]'),
    ).toBeNull();

    mintBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    harness.detectChanges();
    expect(
      api.calls.some((c) => c.key === "POST /api/external-agents/tokens"),
    ).toBe(true);
    expect(
      el.querySelector('[data-testid="minted-gma-token"]')?.textContent,
    ).toContain("gma_secret_ok_123");
  });

  it("surfaces clear errors when mint or rotate response omits the issued token key", async () => {
    const api = new FakeSecurityApi();
    api.mintResponse = {};
    api.rotateResponse = { token: "   " };
    api.tokensResponse = [
      { id: "tok-1", name: "existing", scopes: ["tasks:read"], active: true },
    ];

    const { el, harness } = await mountSecurity("/settings/access", api);

    const nameInput = el.querySelector<HTMLInputElement>(
      '[data-testid="input-gma-token-name"]',
    )!;
    setInput(nameInput, "broken-mint");
    harness.detectChanges();

    el.querySelector<HTMLButtonElement>(
      '[data-testid="mint-gma-token-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 30));
    harness.detectChanges();

    expect(el.querySelector('[data-testid="minted-gma-token"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="tokens-error"]')?.textContent,
    ).toContain("missing the issued token secret key");
    expect(nameInput.value).toBe("broken-mint");

    el.querySelector<HTMLButtonElement>(
      '[data-testid="rotate-token-tok-1"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 30));
    harness.detectChanges();

    expect(el.querySelector('[data-testid="minted-gma-token"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="tokens-error"]')?.textContent,
    ).toContain("missing the rotated token secret key");
  });

  it("handles missing keys, missing token scopes, and empty lists across principals, tokens, and GCP keys", async () => {
    const api = new FakeSecurityApi();
    api.tokensResponse = [
      { id: "tok-no-scopes", name: "orphan-bot", active: true },
      { id: "", name: "", scopes: ["ci:read"], active: true },
    ];
    api.gcpKeysResponse = [{ name: "partial-gcp", projectId: "" }];
    api.principalsResponse = [];

    const { el } = await mountSecurity("/settings/access", api);

    expect(el.querySelector('[data-testid="principals-empty"]')).not.toBeNull();
    expect(
      el.querySelector('[data-testid="gma-token-missing-scopes-tok-no-scopes"]')
        ?.textContent,
    ).toContain("Missing scopes");
    expect(
      el.querySelector('[data-testid="gma-token-missing-id-1"]')?.textContent,
    ).toContain("Missing token ID");
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="rotate-token-1"]')
        ?.disabled,
    ).toBe(true);
    expect(
      el.querySelector('[data-testid="gcp-key-pill-partial-gcp"]')?.textContent,
    ).toContain("missing projectId, serviceAccountEmail");
  });

  it("shows scope restriction banners when caller token lacks required access, token, and secret scopes", async () => {
    const api = new FakeSecurityApi();
    api.configBody.access = {
      role: "grain/viewer",
      roles: ["grain/viewer"],
      full: false,
      missing: ["ops-custom-set"],
      scopes: ["settings:read", "access:read"],
    };

    const { el, harness } = await mountSecurity("/settings/access", api);

    expect(
      el.querySelector('[data-testid="access-missing-role-sets"]')?.textContent,
    ).toContain("ops-custom-set");
    expect(
      el.querySelector('[data-testid="principals-write-restricted"]')
        ?.textContent,
    ).toContain("access:write");
    expect(
      el.querySelector('[data-testid="tokens-restricted"]')?.textContent,
    ).toContain("capabilities:read");
    expect(
      el.querySelector('[data-testid="tokens-admin-restricted"]')?.textContent,
    ).toContain("capabilities:admin");
    expect(
      el.querySelector('[data-testid="gcp-keys-restricted"]')?.textContent,
    ).toContain("secrets:read");
    expect(
      el.querySelector('[data-testid="gcp-keys-write-restricted"]')
        ?.textContent,
    ).toContain("secrets:write");

    expect(
      api.calls.some((c) => c.key === "GET /api/external-agents/tokens"),
    ).toBe(false);
    expect(api.calls.some((c) => c.key === "GET /api/gcp-keys")).toBe(false);

    // Partial audit scopes show hidden streams banner on /settings/audit
    await harness.navigateByUrl("/settings/audit");
    await new Promise((r) => setTimeout(r, 30));
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="audit-partial-restricted"]')?.textContent,
    ).toContain("secrets:read");
  });

  it("shows explicit error banners when list fetches or token minting fail with server scope errors", async () => {
    const api = new FakeSecurityApi();
    api.principalsError = new Error("403 forbidden: missing access:read");
    api.tokensError = new Error("403 forbidden: missing capabilities:read");
    api.gcpKeysError = new Error("500 secret store unavailable");

    const { el, harness } = await mountSecurity("/settings/access", api);

    expect(
      el.querySelector('[data-testid="principals-error"]')?.textContent,
    ).toContain("missing access:read");
    expect(
      el.querySelector('[data-testid="tokens-error"]')?.textContent,
    ).toContain("missing capabilities:read");
    expect(
      el.querySelector('[data-testid="gcp-keys-error"]')?.textContent,
    ).toContain("secret store unavailable");

    // Server 403/400 on mint is also rendered in card-level tokens-error
    api.mintError = new Error(
      "403 requires_person: token includes dangerous scope",
    );
    setInput(
      el.querySelector<HTMLInputElement>(
        '[data-testid="input-gma-token-name"]',
      )!,
      "danger-bot",
    );
    setInput(
      el.querySelector<HTMLInputElement>(
        '[data-testid="input-gma-token-scopes"]',
      )!,
      "settings:write",
    );
    harness.detectChanges();
    el.querySelector<HTMLButtonElement>(
      '[data-testid="mint-gma-token-btn"]',
    )!.click();
    await new Promise((r) => setTimeout(r, 30));
    harness.detectChanges();
    expect(
      el.querySelector('[data-testid="tokens-error"]')?.textContent,
    ).toContain("requires_person");
  });

  it("shows audit-restricted when all audit read scopes are missing and audit-error on API failure", async () => {
    const auditApi = new FakeSecurityApi();
    auditApi.configBody.access = {
      role: "grain/minimal",
      roles: ["grain/minimal"],
      full: false,
      scopes: ["tasks:read"],
    };
    const res = await mountSecurity("/settings/audit", auditApi);
    expect(
      res.el.querySelector('[data-testid="audit-restricted"]')?.textContent,
    ).toContain("settings:read");
    expect(res.el.querySelector('[data-testid="audit-empty"]')).toBeNull();
    expect(
      res.el.querySelector<HTMLButtonElement>(
        '[data-testid="refresh-audit-btn"]',
      )?.disabled,
    ).toBe(true);
    expect(
      auditApi.calls.some((c) => c.key === "GET /api/deployment/config-audit"),
    ).toBe(false);

    // Operator with audit scopes sees audit-error banner if backend audit endpoints fail
    TestBed.resetTestingModule();
    const errApi = new FakeSecurityApi();
    errApi.auditError = new Error("503 audit store unavailable");
    const errRes = await mountSecurity("/settings/audit", errApi);
    expect(
      errRes.el.querySelector('[data-testid="audit-error"]')?.textContent,
    ).toContain("audit store unavailable");
  });
});
