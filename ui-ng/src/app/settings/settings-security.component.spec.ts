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
import { HttpErrorResponse } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { describe, expect, it } from "vitest";
import { GrainApi, type RouteParams } from "../api/grain-api.service";
import type { AccessInfo, GrainConfig } from "../api/models";
import { AccessService } from "../services/access.service";
import { SettingsPageComponent } from "./settings-page.component";
import {
  externalTokenHasScopes,
  externalTokenScopeSummary,
  formatSecurityError,
  isGcpKeyIncomplete,
  normalizeExternalTokenRows,
  normalizeGcpKeyRows,
  normalizePrincipalResponse,
  parseSettingBoolean,
  validateExternalTokenScopes,
} from "./settings-security.component";

interface RecordedCall {
  method: string;
  key: string;
  params?: RouteParams;
  body?: unknown;
  query?: string;
}

class FakeSecurityApi {
  calls: RecordedCall[] = [];
  access: AccessInfo = {
    role: "grain/operator",
    roles: ["grain/operator"],
    full: true,
    scopes: [],
  };
  principalsResponse: unknown = {
    entries: [
      { entry: "alice@example.com", role: "grain/operator", label: "Alice" },
    ],
  };
  tokensResponse: unknown = { tokens: [] };
  gcpKeysResponse: unknown = { keys: [] };
  configAuditResponse: unknown = { items: [] };
  auditLogsResponse: unknown = { items: [] };
  secretAuditResponse: unknown = { items: [] };
  accessHistoryResponse: unknown = { items: [] };
  configRepoOnly = false;
  settingsResponse: Record<string, unknown> = {
    environmentName: "Staging",
    externalAgentApi: true,
    gcpProject: "",
    gcpServiceAccountEmail: "",
  };

  mintResponse: unknown = {
    token: "gma_live_secret_token_999",
    name: "ci-bot",
  };
  rotateResponse: unknown = { token: "gma_rotated_secret_888" };

  errors = new Map<string, unknown>();

  config = (): Promise<GrainConfig> =>
    Promise.resolve({
      version: "v3.6.0",
      configRepoOnly: this.configRepoOnly,
      access: this.access,
    });

  get = (
    key: string,
    params?: RouteParams,
    query?: string,
  ): Promise<unknown> => {
    this.calls.push({ method: "GET", key, params, query });
    if (this.errors.has(key)) {
      return Promise.reject(this.errors.get(key));
    }
    switch (key) {
      case "GET /api/settings":
        return Promise.resolve(structuredClone(this.settingsResponse));
      case "GET /api/deployment":
        return Promise.resolve({});
      case "GET /api/access/principals":
        return Promise.resolve(structuredClone(this.principalsResponse));
      case "GET /api/external-agents/tokens":
        return Promise.resolve(structuredClone(this.tokensResponse));
      case "GET /api/gcp-keys":
        return Promise.resolve(structuredClone(this.gcpKeysResponse));
      case "GET /api/deployment/config-audit":
        return Promise.resolve(structuredClone(this.configAuditResponse));
      case "GET /api/deployment/audit-logs":
        return Promise.resolve(structuredClone(this.auditLogsResponse));
      case "GET /api/deployment/secret-audit":
        return Promise.resolve(structuredClone(this.secretAuditResponse));
      case "GET /api/access/history":
        return Promise.resolve(structuredClone(this.accessHistoryResponse));
      default:
        return Promise.resolve({});
    }
  };

  getText = () => Promise.resolve("");

  post = (
    key: string,
    params?: RouteParams,
    body?: unknown,
  ): Promise<unknown> => {
    this.calls.push({ method: "POST", key, params, body });
    if (this.errors.has(key)) {
      return Promise.reject(this.errors.get(key));
    }
    if (key === "POST /api/settings") {
      Object.assign(
        this.settingsResponse,
        (body as Record<string, unknown>) ?? {},
      );
      return Promise.resolve(structuredClone(this.settingsResponse));
    }
    if (key === "POST /api/external-agents/tokens") {
      return Promise.resolve(structuredClone(this.mintResponse));
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
    if (this.errors.has(key)) {
      return Promise.reject(this.errors.get(key));
    }
    return Promise.resolve({ ok: true });
  };

  delete = (key: string, params?: RouteParams, body?: unknown) => {
    this.calls.push({ method: "DELETE", key, params, body });
    if (this.errors.has(key)) {
      return Promise.reject(this.errors.get(key));
    }
    return Promise.resolve({ ok: true });
  };
}

async function mountSecurity(
  section: "access" | "audit" = "access",
  configure?: (api: FakeSecurityApi) => void,
) {
  TestBed.resetTestingModule();
  localStorage.clear();
  const api = new FakeSecurityApi();
  configure?.(api);

  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [{ path: "settings/:section", component: SettingsPageComponent }],
        withComponentInputBinding(),
      ),
      { provide: APP_BASE_HREF, useValue: "/next/" },
      { provide: GrainApi, useValue: api },
    ],
  });

  const accessService = TestBed.inject(AccessService);
  accessService.setConfig({
    version: "v3.6.0",
    access: api.access,
  });

  const harness = await RouterTestingHarness.create(`/settings/${section}`);
  harness.fixture.autoDetectChanges(true);
  await harness.fixture.whenStable();
  await new Promise((r) => setTimeout(r, 25));
  await harness.fixture.whenStable();

  const el = harness.fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) =>
    el.querySelector<T>(sel);
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 15));
    await harness.fixture.whenStable();
  };
  const setInput = async (testid: string, value: string) => {
    const input = q<HTMLInputElement>(`[data-testid="${testid}"]`);
    if (!input) throw new Error(`missing input ${testid}`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  };

  return { el, api, q, settle, setInput };
}

describe("settings security helpers", () => {
  it("validates external agent token scopes and rejects empty, whitespace, internal, and malformed scopes", () => {
    expect(validateExternalTokenScopes("")).toEqual({
      scopes: [],
      error:
        "Enter at least one required scope or scope set (for example, tasks:read,tasks:write).",
    });
    expect(validateExternalTokenScopes("  ,  ").error).toContain(
      "Enter at least one required scope",
    );
    expect(validateExternalTokenScopes("tasks read").error).toContain(
      "without spaces",
    );
    expect(validateExternalTokenScopes("internal").error).toContain(
      '"internal" cannot be granted',
    );
    expect(
      validateExternalTokenScopes("api:internal@org/repo").error,
    ).toContain('"internal" cannot be granted');
    expect(validateExternalTokenScopes("tasks:read@noslash").error).toContain(
      "owner/name format",
    );
    expect(validateExternalTokenScopes("tasks:").error).toContain(
      "<area>:<level>",
    );
    expect(validateExternalTokenScopes("@org/repo").error).toContain(
      "missing a scope or scope set name",
    );

    expect(
      validateExternalTokenScopes("tasks:read, ci , api:tasks:write@a/b"),
    ).toEqual({
      scopes: ["tasks:read", "ci", "api:tasks:write@a/b"],
      error: null,
    });
  });

  it("detects missing token scopes including empty custom scope sets", () => {
    expect(externalTokenHasScopes({ id: "t1", name: "empty" })).toBe(false);
    expect(
      externalTokenHasScopes({
        id: "t2",
        name: "custom-empty",
        scopeSet: "custom",
        scopes: [],
      }),
    ).toBe(false);
    expect(
      externalTokenScopeSummary({
        id: "t2",
        name: "custom-empty",
        scopeSet: "custom",
        scopes: [],
      }),
    ).toBe("");

    expect(
      externalTokenHasScopes({ id: "t3", name: "ci-bot", scopeSet: "ci" }),
    ).toBe(true);
    expect(
      externalTokenScopeSummary({ id: "t3", name: "ci-bot", scopeSet: "ci" }),
    ).toBe("ci");

    expect(
      externalTokenHasScopes({
        id: "t4",
        name: "reader",
        scopeSet: "custom",
        scopes: ["tasks:read", "runs:read"],
      }),
    ).toBe(true);
    expect(
      externalTokenScopeSummary({
        id: "t4",
        name: "reader",
        scopeSet: "custom",
        scopes: ["tasks:read", "runs:read"],
      }),
    ).toBe("tasks:read, runs:read");

    expect(
      externalTokenHasScopes({
        id: "t5",
        name: "resolved",
        resolvedScopeCount: 3,
      }),
    ).toBe(true);
    expect(
      externalTokenScopeSummary({
        id: "t5",
        name: "resolved",
        resolvedScopeCount: 3,
      }),
    ).toBe("3 resolved scope(s)");
  });

  it("normalizes missing JSON keys and snake_case GCP key fields safely", () => {
    expect(normalizePrincipalResponse({})).toEqual({
      rows: [],
      roles: undefined,
    });
    expect(normalizePrincipalResponse(null)).toEqual({
      rows: [],
      roles: undefined,
    });
    expect(normalizeExternalTokenRows({})).toEqual([]);
    expect(normalizeExternalTokenRows(undefined)).toEqual([]);
    expect(normalizeGcpKeyRows({})).toEqual([]);

    const gcp = normalizeGcpKeyRows({
      keys: [
        {
          name: "vertex",
          project_id: "my-proj",
          service_account_email: "runner@my-proj.iam.gserviceaccount.com",
          service_account_count: 2,
          max_key_age: "12h",
          minter_credential: "gcp-minter",
        },
        { name: "incomplete" },
        { name: "" },
      ],
    });
    expect(gcp).toEqual([
      {
        name: "vertex",
        projectId: "my-proj",
        serviceAccountEmail: "runner@my-proj.iam.gserviceaccount.com",
        serviceAccountCount: 2,
        maxKeyAge: "12h",
        minterCredential: "gcp-minter",
      },
      {
        name: "incomplete",
        projectId: undefined,
        serviceAccountEmail: undefined,
        serviceAccountCount: undefined,
        maxKeyAge: undefined,
        minterCredential: undefined,
      },
    ]);
    expect(isGcpKeyIncomplete(gcp[0])).toBe(false);
    expect(isGcpKeyIncomplete(gcp[1])).toBe(true);
  });

  it("formats HttpErrorResponse and structured API error messages", () => {
    expect(
      formatSecurityError(
        new HttpErrorResponse({
          status: 403,
          statusText: "Forbidden",
          error: { error: "caller lacks scope tasks:admin" },
        }),
      ),
    ).toBe("caller lacks scope tasks:admin");
    expect(formatSecurityError({ error: "missing key" })).toBe("missing key");
    expect(formatSecurityError(new Error("network down"))).toBe("network down");
  });
});

describe("SettingsSecurityComponent missing keys and token scope error states", () => {
  it("shows empty state when GET /api/gcp-keys omits the keys field", async () => {
    const { q } = await mountSecurity("access", (api) => {
      api.gcpKeysResponse = {};
    });
    expect(q('[data-testid="gcp-keys-empty"]')?.textContent).toContain(
      "No GCP service account keys configured",
    );
  });

  it("highlights incomplete GCP key entries while rendering snake_case keys cleanly", async () => {
    const { q } = await mountSecurity("access", (api) => {
      api.gcpKeysResponse = {
        keys: [
          { name: "orphan" },
          {
            name: "vertex",
            project_id: "proj-1",
            service_account_email: "sa@proj-1.iam.gserviceaccount.com",
          },
        ],
      };
    });
    const orphanPill = q('[data-testid="gcp-key-pill-orphan"]');
    expect(orphanPill).toBeTruthy();
    expect(orphanPill?.className).toContain("error");
    expect(orphanPill?.textContent).toContain("missing project/SA");

    const okPill = q('[data-testid="gcp-key-pill-vertex"]');
    expect(okPill?.className).toContain("neutral");
    expect(okPill?.textContent).toContain("vertex · proj-1");
  });

  it("surfaces GET and POST /api/gcp-keys errors inside the GCP keys card", async () => {
    const { q, settle, setInput } = await mountSecurity("access", (api) => {
      api.errors.set(
        "GET /api/gcp-keys",
        new HttpErrorResponse({
          status: 500,
          statusText: "Server Error",
          error: { error: "secret store unreachable" },
        }),
      );
      api.errors.set(
        "POST /api/gcp-keys",
        new HttpErrorResponse({
          status: 400,
          statusText: "Bad Request",
          error: { error: "missing minter credential key" },
        }),
      );
    });
    expect(q('[data-testid="gcp-keys-error"]')?.textContent).toContain(
      "secret store unreachable",
    );

    await setInput("input-gcp-key-name", "runner");
    await setInput("input-gcp-key-project", "proj-2");
    await setInput("input-gcp-key-sa", "sa@proj-2.iam.gserviceaccount.com");
    q<HTMLButtonElement>('[data-testid="save-gcp-key-btn"]')!.click();
    await settle();
    expect(q('[data-testid="gcp-keys-action-error"]')?.textContent).toContain(
      "missing minter credential key",
    );
  });

  it("validates token scopes before minting and surfaces server scope errors", async () => {
    const { api, q, settle, setInput } = await mountSecurity("access");

    await setInput("input-gma-token-scopes", "");
    const scopesInput = q<HTMLInputElement>(
      '[data-testid="input-gma-token-scopes"]',
    )!;
    expect(scopesInput.getAttribute("aria-invalid")).toBe("true");
    expect(q('[data-testid="error-gma-token-scopes"]')?.textContent).toContain(
      "Enter at least one required scope",
    );

    await setInput("input-gma-token-name", "ci-bot");
    q<HTMLButtonElement>('[data-testid="mint-gma-token-btn"]')!.click();
    await settle();
    expect(q('[data-testid="gma-token-error"]')?.textContent).toContain(
      "Enter at least one required scope",
    );
    expect(
      api.calls.filter(
        (c) =>
          c.method === "POST" && c.key === "POST /api/external-agents/tokens",
      ),
    ).toHaveLength(0);

    await setInput("input-gma-token-scopes", "internal");
    expect(q('[data-testid="error-gma-token-scopes"]')?.textContent).toContain(
      '"internal" cannot be granted',
    );
    q<HTMLButtonElement>('[data-testid="mint-gma-token-btn"]')!.click();
    await settle();
    expect(
      api.calls.filter(
        (c) =>
          c.method === "POST" && c.key === "POST /api/external-agents/tokens",
      ),
    ).toHaveLength(0);

    api.errors.set(
      "POST /api/external-agents/tokens",
      new HttpErrorResponse({
        status: 403,
        statusText: "Forbidden",
        error: { error: "caller lacks scope tasks:admin" },
      }),
    );
    await setInput("input-gma-token-scopes", "tasks:admin");
    expect(q('[data-testid="error-gma-token-scopes"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="mint-gma-token-btn"]')!.click();
    await settle();
    expect(q('[data-testid="gma-token-error"]')?.textContent).toContain(
      "caller lacks scope tasks:admin",
    );
    expect(q('[data-testid="error-gma-token-scopes"]')?.textContent).toContain(
      "caller lacks scope tasks:admin",
    );
  });

  it("clears stale secret and warns when mint or rotate response omits the token key, and flags tokens missing scopes", async () => {
    const { api, q, settle, setInput } = await mountSecurity(
      "access",
      (fake) => {
        fake.tokensResponse = {
          tokens: [
            {
              id: "tok-missing",
              name: "unscoped-bot",
              scopeSet: "custom",
              scopes: [],
              active: true,
            },
            {
              id: "tok-ok",
              name: "scoped-bot",
              scopes: ["tasks:read", "tasks:write"],
              active: true,
            },
          ],
        };
      },
    );

    expect(
      q('[data-testid="gma-tokens-missing-scopes-banner"]')?.textContent,
    ).toContain("1 token(s) are missing required scopes");
    expect(
      q('[data-testid="gma-token-missing-scopes-tok-missing"]')?.textContent,
    ).toContain("Missing required scopes");
    expect(q('[data-testid="gma-token-missing-scopes-tok-ok"]')).toBeNull();
    expect(q('[data-testid="gma-token-row-tok-ok"]')?.textContent).toContain(
      "tasks:read, tasks:write",
    );

    await setInput("input-gma-token-name", "first-bot");
    q<HTMLButtonElement>('[data-testid="mint-gma-token-btn"]')!.click();
    await settle();
    expect(q('[data-testid="minted-gma-token"]')?.textContent).toContain(
      "gma_live_secret_token_999",
    );

    api.mintResponse = { name: "second-bot" };
    await setInput("input-gma-token-name", "second-bot");
    q<HTMLButtonElement>('[data-testid="mint-gma-token-btn"]')!.click();
    await settle();
    expect(q('[data-testid="minted-gma-token"]')).toBeNull();
    expect(q('[data-testid="gma-token-missing-key"]')?.textContent).toContain(
      "did not include a one-time token key",
    );

    api.rotateResponse = {};
    q<HTMLButtonElement>('[data-testid="rotate-token-tok-ok"]')!.click();
    await settle();
    expect(q('[data-testid="minted-gma-token"]')).toBeNull();
    expect(q('[data-testid="gma-token-missing-key"]')?.textContent).toContain(
      "did not include a replacement token key",
    );
  });

  it("shows empty state when GET /api/access/principals omits entries", async () => {
    const { q } = await mountSecurity("access", (api) => {
      api.principalsResponse = {};
    });
    expect(q('[data-testid="principals-empty"]')?.textContent).toContain(
      "No access principals configured",
    );
  });

  it("surfaces GET /api/access/principals load errors", async () => {
    const { q } = await mountSecurity("access", (api) => {
      api.errors.set(
        "GET /api/access/principals",
        new HttpErrorResponse({
          status: 500,
          statusText: "Server Error",
          error: { error: "rbac backend failed" },
        }),
      );
    });
    expect(q('[data-testid="principals-error"]')?.textContent).toContain(
      "rbac backend failed",
    );
  });

  it("shows clear read-restricted banners and skips denied GET calls when caller lacks read scopes", async () => {
    const { api, q } = await mountSecurity("access", (fake) => {
      fake.access = {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["settings:read"],
      };
    });

    expect(q('[data-testid="principals-restricted"]')?.textContent).toContain(
      "access:read",
    );
    expect(q('[data-testid="tokens-restricted"]')?.textContent).toContain(
      "capabilities:read",
    );
    expect(q('[data-testid="tokens-write-restricted"]')?.textContent).toContain(
      "capabilities:admin",
    );
    expect(q('[data-testid="gcp-keys-restricted"]')?.textContent).toContain(
      "secrets:read",
    );
    expect(
      q('[data-testid="gcp-keys-write-restricted"]')?.textContent,
    ).toContain("secrets:write");

    expect(
      api.calls.some(
        (c) =>
          c.key === "GET /api/access/principals" ||
          c.key === "GET /api/external-agents/tokens" ||
          c.key === "GET /api/gcp-keys",
      ),
    ).toBe(false);
  });

  it("shows write-restricted banners and disabled tooltips when caller holds read scopes only", async () => {
    const { q } = await mountSecurity("access", (fake) => {
      fake.access = {
        role: "auditor",
        roles: ["auditor"],
        full: false,
        scopes: ["access:read", "capabilities:read", "secrets:read"],
      };
    });

    expect(
      q('[data-testid="principals-write-restricted"]')?.textContent,
    ).toContain("access:write");
    expect(q('[data-testid="tokens-write-restricted"]')?.textContent).toContain(
      "capabilities:admin",
    );
    expect(
      q('[data-testid="gcp-keys-write-restricted"]')?.textContent,
    ).toContain("secrets:write");

    const mintBtn = q<HTMLButtonElement>('[data-testid="mint-gma-token-btn"]')!;
    expect(mintBtn.disabled).toBe(true);
    expect(mintBtn.title).toContain("capabilities:admin");
  });

  it("shows missing audit scope warnings and audit API failure banners on /settings/audit", async () => {
    const { api, q } = await mountSecurity("audit", (fake) => {
      fake.access = {
        role: "config-reader",
        roles: ["config-reader"],
        full: false,
        scopes: ["settings:read"],
      };
      fake.errors.set(
        "GET /api/deployment/config-audit",
        new HttpErrorResponse({
          status: 503,
          statusText: "Service Unavailable",
          error: { error: "audit log query timed out" },
        }),
      );
    });

    const restricted = q('[data-testid="audit-restricted"]')?.textContent;
    expect(restricted).toContain("Some audit categories are restricted");
    expect(restricted).toContain("secrets:read");
    expect(restricted).toContain("access:read");
    expect(q('[data-testid="audit-error"]')?.textContent).toContain(
      "Config audit: audit log query timed out",
    );
    expect(
      api.calls.some(
        (c) =>
          c.key === "GET /api/deployment/audit-logs" ||
          c.key === "GET /api/access/history",
      ),
    ).toBe(false);
  });
});

describe("SettingsSecurityComponent ARIA toggle semantics", () => {
  it("normalizes boolean and string/numeric boolean setting values", () => {
    expect(parseSettingBoolean(true, false)).toBe(true);
    expect(parseSettingBoolean(false, true)).toBe(false);
    expect(parseSettingBoolean("false", true)).toBe(false);
    expect(parseSettingBoolean(" FALSE ", true)).toBe(false);
    expect(parseSettingBoolean("0", true)).toBe(false);
    expect(parseSettingBoolean("off", true)).toBe(false);
    expect(parseSettingBoolean("no", true)).toBe(false);
    expect(parseSettingBoolean("true", false)).toBe(true);
    expect(parseSettingBoolean("1", false)).toBe(true);
    expect(parseSettingBoolean("on", false)).toBe(true);
    expect(parseSettingBoolean("yes", false)).toBe(true);
    expect(parseSettingBoolean(0, true)).toBe(false);
    expect(parseSettingBoolean(1, false)).toBe(true);
    expect(parseSettingBoolean("", true)).toBe(true);
    expect(parseSettingBoolean(undefined, true)).toBe(true);
    expect(parseSettingBoolean(null, false)).toBe(false);
  });

  it("exposes switch role, accessible name/description, and updates aria-checked across toggle, discard, and save", async () => {
    const { api, q, settle } = await mountSecurity("access");
    const sw = q<HTMLButtonElement>(
      '[data-testid="switch-external-agent-api"]',
    );
    expect(sw).toBeTruthy();
    expect(sw!.getAttribute("role")).toBe("switch");
    expect(sw!.getAttribute("aria-label")).toBe("Accept external agent tokens");
    expect(sw!.getAttribute("aria-describedby")).toBe(
      "switch-external-agent-api-hint",
    );
    expect(q("#switch-external-agent-api-hint")?.textContent).toContain(
      "gma_ tokens",
    );
    expect(sw!.getAttribute("aria-checked")).toBe("true");

    sw!.click();
    await settle();
    expect(sw!.getAttribute("aria-checked")).toBe("false");
    expect(q('[data-testid="settings-save-bar"]')).toBeTruthy();

    // Discard restores aria-checked to saved state.
    q<HTMLButtonElement>('[data-testid="settings-discard-btn"]')!.click();
    await settle();
    expect(sw!.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="settings-save-bar"]')).toBeNull();

    // Toggle off and save commits false and preserves aria-checked="false".
    sw!.click();
    await settle();
    expect(sw!.getAttribute("aria-checked")).toBe("false");
    q<HTMLButtonElement>('[data-testid="settings-save-btn"]')!.click();
    await settle();

    const saveCall = api.calls.find((c) => c.key === "POST /api/settings");
    expect(saveCall?.body).toEqual({ externalAgentApi: false });
    expect(sw!.getAttribute("aria-checked")).toBe("false");
    expect(q('[data-testid="settings-save-bar"]')).toBeNull();

    // Toggling back on flips aria-checked to "true".
    sw!.click();
    await settle();
    expect(sw!.getAttribute("aria-checked")).toBe("true");
  });

  it("represents false and string 'false' settings with aria-checked='false'", async () => {
    const { q: qBool } = await mountSecurity("access", (api) => {
      api.settingsResponse["externalAgentApi"] = false;
    });
    expect(
      qBool('[data-testid="switch-external-agent-api"]')?.getAttribute(
        "aria-checked",
      ),
    ).toBe("false");

    const { q: qStr } = await mountSecurity("access", (api) => {
      api.settingsResponse["externalAgentApi"] = "false";
    });
    expect(
      qStr('[data-testid="switch-external-agent-api"]')?.getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
  });

  it("keeps aria-checked accurate and switch disabled when settings write is forbidden or configRepoOnly", async () => {
    const { q, settle } = await mountSecurity("access", (fake) => {
      fake.access = {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["settings:read"],
      };
      fake.settingsResponse["externalAgentApi"] = false;
    });

    const sw = q<HTMLButtonElement>(
      '[data-testid="switch-external-agent-api"]',
    )!;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.title).toContain("settings:write");

    sw.click();
    await settle();
    expect(sw.getAttribute("aria-checked")).toBe("false");

    const { q: qRepo } = await mountSecurity("access", (fake) => {
      fake.configRepoOnly = true;
      fake.settingsResponse["externalAgentApi"] = true;
    });
    const swRepo = qRepo<HTMLButtonElement>(
      '[data-testid="switch-external-agent-api"]',
    )!;
    expect(swRepo.disabled).toBe(true);
    expect(swRepo.getAttribute("aria-checked")).toBe("true");
    expect(swRepo.title).toContain("config repository");
  });
});
