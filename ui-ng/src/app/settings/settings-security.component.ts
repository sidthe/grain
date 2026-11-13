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
  OnChanges,
  OnInit,
  ViewEncapsulation,
  type WritableSignal,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import { GrainApi } from "../api/grain-api.service";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import {
  ConfirmDialogComponent,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import type { SettingsSectionId } from "./settings-sections";
import { SettingsStateService, errText } from "./settings-state.service";

interface PrincipalRow {
  entry: string;
  role: string;
  label?: string;
  addedBy?: string;
}

interface AccessRoleChoiceDto {
  name: string;
  description?: string;
  builtin?: boolean;
  person?: boolean;
  denies?: boolean;
}

export interface ExternalTokenRow {
  id: string;
  name: string;
  tokenPrefix?: string;
  prefix?: string;
  owner?: string;
  scopeSet?: string;
  scopes?: string[];
  resolvedScopes?: string[];
  resolvedScopeCount?: number;
  resolvedScopesTruncated?: boolean;
  repos?: string[];
  revokedAt?: string | null;
  revoked?: boolean;
  expiresAt?: string | null;
  active?: boolean;
}

export interface GcpKeyRow {
  name: string;
  projectId?: string;
  serviceAccountEmail?: string;
  serviceAccountCount?: number;
  maxKeyAge?: string;
  minterCredential?: string;
}

interface AuditEventRow {
  id: string;
  at: string;
  actor: string;
  kind: "config" | "secret" | "access";
  action: string;
  detail: string;
}

const DEFAULT_ROLE_OPTIONS: readonly PillOption[] = [
  { value: "grain/operator", label: "grain/operator (full)" },
  { value: "grain/admin", label: "grain/admin" },
  { value: "grain/developer", label: "grain/developer" },
  { value: "grain/viewer", label: "grain/viewer (read-only)" },
];

/** Extracts a readable error string from HttpErrorResponse, Error, or plain API error objects. */
export function formatSecurityError(err: unknown): string {
  if (err && typeof err === "object" && !(err instanceof Error)) {
    const rec = err as Record<string, unknown>;
    const inner = rec["error"];
    if (typeof inner === "string" && inner.trim()) return inner.trim();
    if (inner && typeof inner === "object") {
      const innerRec = inner as Record<string, unknown>;
      const nested = innerRec["error"] ?? innerRec["message"];
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
    const msg = rec["message"];
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  return errText(err);
}

/** Extracts the first array found directly or under any candidate response key. */
export function pickFirstArray(
  raw: unknown,
  keys: readonly string[],
): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  for (const key of keys) {
    const val = rec[key];
    if (Array.isArray(val)) return val;
  }
  return [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Validates comma-separated external agent token scopes or scope sets. */
export function validateExternalTokenScopes(raw: string): {
  scopes: string[];
  error: string | null;
} {
  const scopes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    return {
      scopes: [],
      error:
        "Enter at least one required scope or scope set (for example, tasks:read,tasks:write).",
    };
  }
  for (const entry of scopes) {
    if (/\s/.test(entry)) {
      return {
        scopes,
        error: `Scopes must be comma-separated without spaces (invalid: "${entry}").`,
      };
    }
    const stripped = entry.startsWith("api:") ? entry.slice(4) : entry;
    const atIdx = stripped.indexOf("@");
    const what = atIdx >= 0 ? stripped.slice(0, atIdx) : stripped;
    const repo = atIdx >= 0 ? stripped.slice(atIdx + 1) : "";
    if (!what) {
      return {
        scopes,
        error: `Scope "${entry}" is missing a scope or scope set name.`,
      };
    }
    if (what.toLowerCase() === "internal") {
      return {
        scopes,
        error: 'Scope "internal" cannot be granted to external agent tokens.',
      };
    }
    if (atIdx >= 0 && !/^[^/\s@]+\/[^/\s@]+(?:\/[^/\s@]+)?$/.test(repo)) {
      return {
        scopes,
        error: `Repository filter in "${entry}" must use owner/name format.`,
      };
    }
    if (
      what.includes(":") &&
      !/^(?:[a-zA-Z0-9_-]+|\*):(?:[a-zA-Z0-9_-]+|\*)$/.test(what)
    ) {
      return {
        scopes,
        error: `Scope "${entry}" must use <area>:<level> format (for example, tasks:read) or a scope set name.`,
      };
    }
  }
  return { scopes, error: null };
}

/** Reports whether an external agent token carries at least one scope or scope set. */
export function externalTokenHasScopes(tok: ExternalTokenRow): boolean {
  const scopeSet = asString(tok.scopeSet);
  if (scopeSet.length > 0 && scopeSet.toLowerCase() !== "custom") {
    return true;
  }
  if (tok.scopes?.some((s) => asString(s).length > 0)) return true;
  if (tok.resolvedScopes?.some((s) => asString(s).length > 0)) return true;
  return (
    typeof tok.resolvedScopeCount === "number" && tok.resolvedScopeCount > 0
  );
}

/** Formats an external agent token's scope set or scope list for display. */
export function externalTokenScopeSummary(tok: ExternalTokenRow): string {
  const rawSet = asString(tok.scopeSet);
  const scopeSet = rawSet.toLowerCase() === "custom" ? "" : rawSet;
  const scopes = (tok.scopes ?? []).map((s) => asString(s)).filter(Boolean);
  const resolved = (tok.resolvedScopes ?? [])
    .map((s) => asString(s))
    .filter(Boolean);
  if (scopeSet && scopes.length > 0) {
    return `${scopeSet} + ${scopes.join(", ")}`;
  }
  if (scopeSet) return scopeSet;
  if (scopes.length > 0) return scopes.join(", ");
  if (resolved.length > 0) return resolved.join(", ");
  if (
    typeof tok.resolvedScopeCount === "number" &&
    tok.resolvedScopeCount > 0
  ) {
    return `${tok.resolvedScopeCount} resolved scope(s)`;
  }
  return "";
}

/** Normalizes GET /api/access/principals responses when optional keys are absent. */
export function normalizePrincipalResponse(raw: unknown): {
  rows: PrincipalRow[];
  roles?: AccessRoleChoiceDto[];
} {
  const rows = pickFirstArray(raw, ["entries", "principals", "items"])
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((r) => ({
      entry: asString(r["entry"]),
      role: asString(r["role"]) || "none",
      label: asString(r["label"]) || undefined,
      addedBy: asString(r["addedBy"]) || undefined,
    }))
    .filter((r) => r.entry.length > 0);

  let roles: AccessRoleChoiceDto[] | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rawRoles = (raw as Record<string, unknown>)["roles"];
    if (Array.isArray(rawRoles)) {
      const parsed = rawRoles
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
        )
        .map((r) => ({
          name: asString(r["name"]),
          description: asString(r["description"]) || undefined,
          builtin: typeof r["builtin"] === "boolean" ? r["builtin"] : undefined,
          person: typeof r["person"] === "boolean" ? r["person"] : undefined,
          denies: typeof r["denies"] === "boolean" ? r["denies"] : undefined,
        }))
        .filter((r) => r.name.length > 0);
      if (parsed.length > 0) roles = parsed;
    }
  }
  return { rows, roles };
}

/** Normalizes GET /api/external-agents/tokens responses when keys are missing. */
export function normalizeExternalTokenRows(raw: unknown): ExternalTokenRow[] {
  return pickFirstArray(raw, ["tokens", "items"])
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((r) => {
      const name = asString(r["name"]);
      const id = asString(r["id"]) || name;
      return {
        id,
        name: name || id,
        tokenPrefix: asString(r["tokenPrefix"]) || undefined,
        prefix: asString(r["prefix"]) || undefined,
        owner: asString(r["owner"]) || undefined,
        scopeSet: asString(r["scopeSet"]) || undefined,
        scopes: asStringArray(r["scopes"]),
        resolvedScopes: asStringArray(r["resolvedScopes"]),
        resolvedScopeCount:
          typeof r["resolvedScopeCount"] === "number"
            ? r["resolvedScopeCount"]
            : undefined,
        resolvedScopesTruncated:
          typeof r["resolvedScopesTruncated"] === "boolean"
            ? r["resolvedScopesTruncated"]
            : undefined,
        repos: asStringArray(r["repos"]),
        revokedAt:
          typeof r["revokedAt"] === "string" || r["revokedAt"] === null
            ? r["revokedAt"]
            : undefined,
        revoked: typeof r["revoked"] === "boolean" ? r["revoked"] : undefined,
        expiresAt:
          typeof r["expiresAt"] === "string" || r["expiresAt"] === null
            ? r["expiresAt"]
            : undefined,
        active: typeof r["active"] === "boolean" ? r["active"] : undefined,
      };
    })
    .filter((t) => t.id.length > 0);
}

/** Normalizes GET /api/gcp-keys responses across camelCase, snake_case, and missing keys. */
export function normalizeGcpKeyRows(raw: unknown): GcpKeyRow[] {
  return pickFirstArray(raw, ["keys", "items"])
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((r) => {
      const count = r["serviceAccountCount"] ?? r["service_account_count"];
      return {
        name: asString(r["name"]),
        projectId: asString(r["projectId"] ?? r["project_id"]) || undefined,
        serviceAccountEmail:
          asString(r["serviceAccountEmail"] ?? r["service_account_email"]) ||
          undefined,
        serviceAccountCount: typeof count === "number" ? count : undefined,
        maxKeyAge: asString(r["maxKeyAge"] ?? r["max_key_age"]) || undefined,
        minterCredential:
          asString(r["minterCredential"] ?? r["minter_credential"]) ||
          undefined,
      };
    })
    .filter((k) => k.name.length > 0);
}

/** Reports whether a GCP key entry is missing both project ID and service account email. */
export function isGcpKeyIncomplete(gk: GcpKeyRow): boolean {
  return !asString(gk.projectId) && !asString(gk.serviceAccountEmail);
}

@Component({
  selector: "g-settings-security",
  imports: [PillSelectComponent, ConfirmDialogComponent],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (section()) {
      @case ("access") {
        <div class="s-card" data-testid="card-rbac-principals">
          <div class="s-card-head">
            <div>
              <h3 class="s-card-title">RBAC allowlist &amp; roles</h3>
              <p class="s-card-desc">
                Assign signed-in users, groups, or OIDC subjects to Grain roles.
                Access stays outside the config repo so a bad PR cannot lock
                operators out.
              </p>
            </div>
            <span class="status-pill neutral s-mono"
              >Your role: {{ access.roleLabel() || "operator" }}</span
            >
          </div>

          @if (!access.can("GET /api/access/principals")) {
            <div class="s-banner warn" data-testid="principals-restricted">
              {{ access.deniedReason("GET /api/access/principals") }}
            </div>
          } @else {
            @if (principalsError(); as pErr) {
              <div
                class="s-banner error"
                role="alert"
                data-testid="principals-error"
              >
                {{ pErr }}
              </div>
            }
            @if (principals().length > 0) {
              <div class="s-table-wrap">
                <table class="s-table" aria-label="Access principals">
                  <thead>
                    <tr>
                      <th>Principal</th>
                      <th>Role</th>
                      <th class="s-actions-cell">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of principals(); track p.entry) {
                      <tr [attr.data-testid]="'principal-row-' + p.entry">
                        <td>
                          <div class="s-cell-stack">
                            <span class="s-cell-title">{{
                              p.label || p.entry
                            }}</span>
                            @if (p.label) {
                              <span class="s-meta-mono">{{ p.entry }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          <g-pill-select
                            [testid]="'role-select-' + p.entry"
                            [ariaLabel]="'Role for ' + p.entry"
                            align="left"
                            [options]="roleOptions()"
                            [value]="p.role"
                            [disabled]="
                              !access.can(
                                'PATCH /api/access/principals/{entry}'
                              )
                            "
                            (valueChange)="updatePrincipalRole(p.entry, $event)"
                          />
                        </td>
                        <td class="s-actions-cell">
                          <div class="s-row-actions">
                            <button
                              type="button"
                              class="btn-text s-btn-sm"
                              [attr.data-testid]="'remove-principal-' + p.entry"
                              [disabled]="
                                !access.can(
                                  'DELETE /api/access/principals/{entry}'
                                )
                              "
                              [attr.title]="
                                !access.can(
                                  'DELETE /api/access/principals/{entry}'
                                )
                                  ? access.deniedReason(
                                      'DELETE /api/access/principals/{entry}'
                                    )
                                  : null
                              "
                              (click)="removePrincipal(p.entry)"
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else if (!principalsError()) {
              <div class="s-banner warn" data-testid="principals-empty">
                No access principals configured. Add an email, group, or OIDC
                subject below to grant access.
              </div>
            }

            <div class="s-subsection">
              <div class="s-subhead">
                <h4 class="s-subhead-title">Grant access</h4>
              </div>
              @if (!access.can("POST /api/access/principals")) {
                <div
                  class="s-banner warn"
                  data-testid="principals-write-restricted"
                >
                  {{ access.deniedReason("POST /api/access/principals") }}
                </div>
              }
              @if (principalActionError(); as paErr) {
                <div
                  class="s-banner error"
                  role="alert"
                  data-testid="principals-action-error"
                >
                  {{ paErr }}
                </div>
              }
              <div class="s-grid">
                <div class="s-field">
                  <label class="s-label" for="pr-entry"
                    >Email, group, or subject</label
                  >
                  <input
                    id="pr-entry"
                    class="s-input s-mono"
                    type="text"
                    data-testid="input-principal-entry"
                    placeholder="alice@example.com"
                    [value]="newPrincipalEntry()"
                    [disabled]="!access.can('POST /api/access/principals')"
                    (input)="newPrincipalEntry.set($any($event.target).value)"
                  />
                </div>
                <div class="s-field">
                  <span class="s-label">Role</span>
                  <g-pill-select
                    testid="select-new-principal-role"
                    ariaLabel="New principal role"
                    align="left"
                    [options]="roleOptions()"
                    [value]="newPrincipalRole()"
                    [disabled]="!access.can('POST /api/access/principals')"
                    (valueChange)="newPrincipalRole.set($event)"
                  />
                </div>
                <div class="s-field">
                  <label class="s-label" for="pr-reason"
                    >Reason (audit — required for operator/veto changes)</label
                  >
                  <input
                    id="pr-reason"
                    class="s-input"
                    type="text"
                    data-testid="input-principal-reason"
                    placeholder="Onboard or update team member"
                    [value]="newPrincipalReason()"
                    [disabled]="
                      !access.can('POST /api/access/principals') &&
                      !access.can('PATCH /api/access/principals/{entry}') &&
                      !access.can('DELETE /api/access/principals/{entry}')
                    "
                    (input)="newPrincipalReason.set($any($event.target).value)"
                  />
                </div>
              </div>
              <div class="s-inline">
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="add-principal-btn"
                  [disabled]="
                    !newPrincipalEntry().trim() ||
                    !access.can('POST /api/access/principals')
                  "
                  [attr.title]="
                    !access.can('POST /api/access/principals')
                      ? access.deniedReason('POST /api/access/principals')
                      : null
                  "
                  (click)="addPrincipal()"
                >
                  Grant access
                </button>
              </div>
            </div>
          }
        </div>

        <div class="s-card" data-testid="card-external-agent-tokens">
          <div class="s-card-head">
            <div>
              <h3 class="s-card-title">External agent tokens (gma_)</h3>
              <p class="s-card-desc">
                Scoped bearer tokens for external CI/CLI agents calling this
                Grain API.
              </p>
            </div>
            @if (
              tokens().length > 0 &&
              access.can("POST /api/external-agents/tokens/revoke-all")
            ) {
              <button
                type="button"
                class="s-btn-danger s-btn-sm"
                data-testid="revoke-all-tokens-btn"
                (click)="revokeAllTokens()"
              >
                Revoke all
              </button>
            }
          </div>

          <div class="s-toggle-row">
            <div class="s-toggle-copy">
              <span class="s-toggle-name">Accept external agent tokens</span>
              <span class="s-hint"
                >Allow external callers bearing gma_ tokens to
                authenticate.</span
              >
            </div>
            <button
              type="button"
              class="g-switch"
              role="switch"
              data-testid="switch-external-agent-api"
              [attr.aria-checked]="Boolean(state.val('externalAgentApi', true))"
              [disabled]="!canWriteSettings()"
              [attr.title]="
                !canWriteSettings() ? writeSettingsDeniedReason() : null
              "
              aria-label="Accept external agent tokens"
              (click)="
                state.setField(
                  'externalAgentApi',
                  !state.val('externalAgentApi', true)
                )
              "
            ></button>
          </div>

          @if (mintedTokenSecret(); as secret) {
            <div class="s-banner ok" data-testid="minted-gma-token">
              <span
                >Copy token now (shown once):
                <strong>{{ secret }}</strong></span
              >
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="mintedTokenSecret.set(null)"
              >
                Dismiss
              </button>
            </div>
          }

          @if (mintedTokenMissingWarning(); as missWarn) {
            <div
              class="s-banner warn"
              role="alert"
              data-testid="gma-token-missing-key"
            >
              <span>{{ missWarn }}</span>
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="mintedTokenMissingWarning.set(null)"
              >
                Dismiss
              </button>
            </div>
          }

          @if (tokenActionError(); as tokErr) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="gma-token-error"
            >
              <span>{{ tokErr }}</span>
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="tokenActionError.set(null)"
              >
                Dismiss
              </button>
            </div>
          }

          @if (!access.can("GET /api/external-agents/tokens")) {
            <div class="s-banner warn" data-testid="tokens-restricted">
              {{ access.deniedReason("GET /api/external-agents/tokens") }}
            </div>
          } @else if (tokensError()) {
            <div class="s-banner error" role="alert" data-testid="tokens-error">
              {{ tokensError() }}
            </div>
          } @else if (tokens().length === 0) {
            <div class="s-banner warn" data-testid="tokens-empty">
              No external agent tokens minted yet.
            </div>
          } @else {
            @if (missingScopeTokensCount() > 0) {
              <div
                class="s-banner warn"
                role="alert"
                data-testid="gma-tokens-missing-scopes-banner"
              >
                {{ missingScopeTokensCount() }} token(s) are missing required
                scopes and cannot authorize API requests cleanly.
              </div>
            }
            <div class="s-table-wrap">
              <table class="s-table" aria-label="External agent tokens">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Scopes</th>
                    <th>State</th>
                    <th class="s-actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  @for (tok of tokens(); track tok.id) {
                    @let tokState = tokenStatus(tok);
                    <tr [attr.data-testid]="'gma-token-row-' + tok.id">
                      <td class="s-mono">{{ tok.name }}</td>
                      <td>
                        @if (tokenHasScopes(tok)) {
                          <span class="s-mono">{{
                            tokenScopeSummary(tok)
                          }}</span>
                        } @else {
                          <span
                            class="status-pill error"
                            [attr.data-testid]="
                              'gma-token-missing-scopes-' + tok.id
                            "
                          >
                            Missing required scopes
                          </span>
                        }
                      </td>
                      <td>
                        <span
                          [class]="
                            'status-pill ' +
                            (tokState === 'active'
                              ? 'healthy'
                              : tokState === 'revoked'
                                ? 'error'
                                : 'neutral')
                          "
                          [attr.data-testid]="'gma-token-status-' + tok.id"
                        >
                          {{ tokState }}
                        </span>
                      </td>
                      <td class="s-actions-cell">
                        <div class="s-row-actions">
                          <button
                            type="button"
                            class="btn-tonal s-btn-sm"
                            [attr.data-testid]="'rotate-token-' + tok.id"
                            [disabled]="
                              !access.can(
                                'POST /api/external-agents/tokens/{id}/rotate'
                              )
                            "
                            [attr.title]="
                              !access.can(
                                'POST /api/external-agents/tokens/{id}/rotate'
                              )
                                ? access.deniedReason(
                                    'POST /api/external-agents/tokens/{id}/rotate'
                                  )
                                : null
                            "
                            (click)="rotateToken(tok.id)"
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            class="btn-tonal s-btn-sm"
                            [attr.data-testid]="'revoke-token-' + tok.id"
                            [disabled]="
                              !access.can(
                                'POST /api/external-agents/tokens/{id}/revoke'
                              ) || tokState !== 'active'
                            "
                            [attr.title]="
                              !access.can(
                                'POST /api/external-agents/tokens/{id}/revoke'
                              )
                                ? access.deniedReason(
                                    'POST /api/external-agents/tokens/{id}/revoke'
                                  )
                                : null
                            "
                            (click)="revokeToken(tok.id)"
                          >
                            Revoke
                          </button>
                          <button
                            type="button"
                            class="btn-text s-btn-sm"
                            [disabled]="
                              !access.can(
                                'DELETE /api/external-agents/tokens/{id}'
                              )
                            "
                            [attr.title]="
                              !access.can(
                                'DELETE /api/external-agents/tokens/{id}'
                              )
                                ? access.deniedReason(
                                    'DELETE /api/external-agents/tokens/{id}'
                                  )
                                : null
                            "
                            (click)="deleteToken(tok.id)"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <div class="s-subsection">
            <div class="s-subhead">
              <h4 class="s-subhead-title">Mint external agent token</h4>
            </div>
            @if (!access.can("POST /api/external-agents/tokens")) {
              <div class="s-banner warn" data-testid="tokens-write-restricted">
                {{ access.deniedReason("POST /api/external-agents/tokens") }}
              </div>
            }
            <div class="s-grid">
              <div class="s-field">
                <label class="s-label" for="tk-name">Token name</label>
                <input
                  id="tk-name"
                  class="s-input s-mono"
                  type="text"
                  data-testid="input-gma-token-name"
                  placeholder="ci-bot"
                  [value]="newTokenName()"
                  [disabled]="!access.can('POST /api/external-agents/tokens')"
                  (input)="newTokenName.set($any($event.target).value)"
                />
              </div>
              <div class="s-field">
                <label class="s-label" for="tk-scopes"
                  >Scopes (comma-separated)</label
                >
                <input
                  id="tk-scopes"
                  class="s-input s-mono"
                  type="text"
                  data-testid="input-gma-token-scopes"
                  placeholder="tasks:read,tasks:write"
                  [value]="newTokenScopes()"
                  [attr.aria-invalid]="tokenScopesError() ? 'true' : null"
                  [attr.aria-describedby]="
                    tokenScopesError() ? 'tk-scopes-err' : null
                  "
                  [disabled]="!access.can('POST /api/external-agents/tokens')"
                  [attr.title]="
                    !access.can('POST /api/external-agents/tokens')
                      ? access.deniedReason('POST /api/external-agents/tokens')
                      : null
                  "
                  (input)="onTokenScopesInput($any($event.target).value)"
                />
                @if (tokenScopesError(); as scopeErr) {
                  <span
                    id="tk-scopes-err"
                    class="s-field-error"
                    role="alert"
                    data-testid="error-gma-token-scopes"
                  >
                    {{ scopeErr }}
                  </span>
                }
              </div>
            </div>
            <div class="s-inline">
              <button
                type="button"
                class="btn-tonal"
                data-testid="mint-gma-token-btn"
                [disabled]="
                  !newTokenName().trim() ||
                  !access.can('POST /api/external-agents/tokens')
                "
                [attr.title]="
                  !access.can('POST /api/external-agents/tokens')
                    ? access.deniedReason('POST /api/external-agents/tokens')
                    : null
                "
                (click)="mintToken()"
              >
                Mint gma_ token
              </button>
            </div>
          </div>
        </div>

        <div class="s-card" data-testid="card-gcp-keys">
          <h3 class="s-card-title">GCP service account keys</h3>
          <div class="s-grid">
            <div class="s-field">
              <label class="s-label" for="gcp-proj"
                >Default GCP project ID</label
              >
              <input
                id="gcp-proj"
                class="s-input s-mono"
                type="text"
                data-testid="input-default-gcp-project"
                [value]="state.val('gcpProject', '')"
                [disabled]="!canWriteSettings()"
                [attr.title]="
                  !canWriteSettings() ? writeSettingsDeniedReason() : null
                "
                (input)="
                  state.setField('gcpProject', $any($event.target).value)
                "
              />
            </div>
            <div class="s-field">
              <label class="s-label" for="gcp-sa"
                >Default GCP service account email</label
              >
              <input
                id="gcp-sa"
                class="s-input s-mono"
                type="text"
                data-testid="input-default-gcp-sa"
                [value]="state.val('gcpServiceAccountEmail', '')"
                [disabled]="!canWriteSettings()"
                [attr.title]="
                  !canWriteSettings() ? writeSettingsDeniedReason() : null
                "
                (input)="
                  state.setField(
                    'gcpServiceAccountEmail',
                    $any($event.target).value
                  )
                "
              />
            </div>
          </div>
          @if (!access.can("GET /api/gcp-keys")) {
            <div class="s-banner warn" data-testid="gcp-keys-restricted">
              {{ access.deniedReason("GET /api/gcp-keys") }}
            </div>
          } @else if (gcpKeysError()) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="gcp-keys-error"
            >
              {{ gcpKeysError() }}
            </div>
          } @else if (gcpKeys().length === 0) {
            <div class="s-banner warn" data-testid="gcp-keys-empty">
              No GCP service account keys configured. Add a key alias, project
              ID, and service account email below.
            </div>
          } @else {
            <div class="s-inline">
              @for (gk of gcpKeys(); track gk.name) {
                @let incomplete = isGcpKeyIncomplete(gk);
                <span
                  [class]="
                    'status-pill s-mono ' + (incomplete ? 'error' : 'neutral')
                  "
                  [attr.data-testid]="'gcp-key-pill-' + gk.name"
                  [attr.title]="
                    incomplete
                      ? 'Missing project ID and service account email'
                      : null
                  "
                >
                  {{ gk.name
                  }}{{
                    gk.projectId
                      ? " · " + gk.projectId
                      : gk.serviceAccountEmail
                        ? " · " + gk.serviceAccountEmail
                        : " (missing project/SA)"
                  }}
                  <button
                    type="button"
                    class="btn-text s-btn-sm"
                    style="padding: 0 4px; min-width: 24px; min-height: 24px"
                    [attr.aria-label]="'Delete GCP key ' + gk.name"
                    [attr.data-testid]="'delete-gcp-key-' + gk.name"
                    [disabled]="!access.can('DELETE /api/gcp-keys/{name}')"
                    [attr.title]="
                      !access.can('DELETE /api/gcp-keys/{name}')
                        ? access.deniedReason('DELETE /api/gcp-keys/{name}')
                        : null
                    "
                    (click)="deleteGcpKey(gk.name)"
                  >
                    ×
                  </button>
                </span>
              }
            </div>
          }
          @if (!access.can("POST /api/gcp-keys")) {
            <div class="s-banner warn" data-testid="gcp-keys-write-restricted">
              {{ access.deniedReason("POST /api/gcp-keys") }}
            </div>
          }
          @if (gcpKeyActionError(); as gkActErr) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="gcp-keys-action-error"
            >
              {{ gkActErr }}
            </div>
          }
          <div class="s-grid">
            <div class="s-field">
              <label class="s-label" for="gcp-kname">Key alias</label>
              <input
                id="gcp-kname"
                class="s-input s-mono"
                type="text"
                data-testid="input-gcp-key-name"
                placeholder="vertex-runner"
                [value]="newGcpKeyName()"
                [disabled]="!access.can('POST /api/gcp-keys')"
                (input)="newGcpKeyName.set($any($event.target).value)"
              />
            </div>
            <div class="s-field">
              <label class="s-label" for="gcp-kproj">Project ID</label>
              <input
                id="gcp-kproj"
                class="s-input s-mono"
                type="text"
                data-testid="input-gcp-key-project"
                placeholder="my-gcp-project"
                [value]="newGcpKeyProject()"
                [disabled]="!access.can('POST /api/gcp-keys')"
                (input)="newGcpKeyProject.set($any($event.target).value)"
              />
            </div>
            <div class="s-field">
              <label class="s-label" for="gcp-ksa">Service account email</label>
              <input
                id="gcp-ksa"
                class="s-input"
                type="email"
                data-testid="input-gcp-key-sa"
                placeholder="runner@my-gcp-project.iam.gserviceaccount.com"
                [value]="newGcpKeySaEmail()"
                [disabled]="!access.can('POST /api/gcp-keys')"
                (input)="newGcpKeySaEmail.set($any($event.target).value)"
              />
            </div>
            <div class="s-field">
              <label class="s-label" for="gcp-kcnt"
                >Account pool count (optional)</label
              >
              <input
                id="gcp-kcnt"
                class="s-input s-num"
                type="number"
                min="0"
                data-testid="input-gcp-key-count"
                [value]="newGcpKeyCount()"
                [disabled]="!access.can('POST /api/gcp-keys')"
                (input)="newGcpKeyCount.set($any($event.target).value)"
              />
            </div>
            <div class="s-field">
              <label class="s-label" for="gcp-kage"
                >Max key age (Go duration, optional)</label
              >
              <input
                id="gcp-kage"
                class="s-input s-num"
                type="text"
                data-testid="input-gcp-key-max-age"
                placeholder="24h"
                [value]="newGcpKeyMaxAge()"
                [disabled]="!access.can('POST /api/gcp-keys')"
                (input)="newGcpKeyMaxAge.set($any($event.target).value)"
              />
            </div>
            <div class="s-field">
              <label class="s-label" for="gcp-kminter"
                >Minter credential secret (optional)</label
              >
              <input
                id="gcp-kminter"
                class="s-input s-mono"
                type="text"
                data-testid="input-gcp-key-minter"
                placeholder="gcp-minter"
                [value]="newGcpKeyMinter()"
                [disabled]="!access.can('POST /api/gcp-keys')"
                (input)="newGcpKeyMinter.set($any($event.target).value)"
              />
            </div>
          </div>
          <div class="s-inline">
            <button
              type="button"
              class="btn-tonal s-btn-sm"
              data-testid="save-gcp-key-btn"
              [disabled]="
                !newGcpKeyName().trim() ||
                !newGcpKeyProject().trim() ||
                !newGcpKeySaEmail().trim() ||
                !access.can('POST /api/gcp-keys')
              "
              [attr.title]="
                !access.can('POST /api/gcp-keys')
                  ? access.deniedReason('POST /api/gcp-keys')
                  : null
              "
              (click)="saveGcpKey()"
            >
              Save GCP key
            </button>
          </div>
        </div>
      }

      @case ("audit") {
        <div class="s-card" data-testid="card-audit-viewer">
          <div class="s-card-head">
            <div>
              <h3 class="s-card-title">Audit log viewer</h3>
              <p class="s-card-desc">
                Attributed operator changes across settings, secrets, and RBAC
                principals.
              </p>
            </div>
            <button
              type="button"
              class="btn-tonal s-btn-sm"
              data-testid="refresh-audit-btn"
              (click)="loadAuditLogs()"
            >
              Refresh
            </button>
          </div>

          @if (auditRestrictedReason(); as auditWarn) {
            <div class="s-banner warn" data-testid="audit-restricted">
              {{ auditWarn }}
            </div>
          }
          @if (auditError(); as aErr) {
            <div class="s-banner error" role="alert" data-testid="audit-error">
              {{ aErr }}
            </div>
          }

          <form
            class="s-inline"
            role="search"
            autocomplete="off"
            (submit)="$event.preventDefault()"
          >
            <input
              class="s-input s-input-inline"
              type="search"
              name="grain-audit-filter"
              autocomplete="off"
              spellcheck="false"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              aria-label="Filter by actor or action"
              data-testid="audit-actor-filter"
              placeholder="Filter actor or action…"
              [value]="auditFilterText()"
              (input)="auditFilterText.set($any($event.target).value)"
            />
            <g-pill-select
              testid="audit-kind-filter"
              ariaLabel="Audit log category"
              align="left"
              [options]="auditKindOptions"
              [value]="auditKindFilter()"
              (valueChange)="auditKindFilter.set($event)"
            />
            <g-pill-select
              testid="audit-time-filter"
              ariaLabel="Audit time window"
              align="left"
              [options]="auditTimeOptions"
              [value]="auditTimeFilter()"
              (valueChange)="auditTimeFilter.set($event)"
            />
          </form>

          @if (filteredAuditEvents().length === 0) {
            <p class="s-card-desc" data-testid="audit-empty">
              No matching audit events in this window.
            </p>
          } @else {
            <div class="s-table-wrap">
              <table class="s-table" aria-label="Audit events">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Category</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ev of filteredAuditEvents(); track ev.id) {
                    <tr data-testid="audit-row">
                      <td class="s-num">{{ ev.at }}</td>
                      <td>
                        <span class="status-pill neutral">{{ ev.kind }}</span>
                      </td>
                      <td class="s-mono">{{ ev.actor }}</td>
                      <td class="s-mono">{{ ev.action }}</td>
                      <td>{{ ev.detail }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      }
    }

    @if (confirmRequest(); as req) {
      <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
    }
  `,
})
export class SettingsSecurityComponent implements OnInit, OnChanges {
  protected readonly api = inject(GrainApi);
  protected readonly access = inject(AccessService);
  protected readonly state = inject(SettingsStateService);
  private readonly snackbar = inject(SnackbarService);

  readonly section = input.required<SettingsSectionId>();

  protected readonly Boolean = Boolean;
  private initialized = false;

  protected readonly confirmRequest = signal<ConfirmRequest | null>(null);
  protected readonly roleOptions =
    signal<readonly PillOption[]>(DEFAULT_ROLE_OPTIONS);
  protected readonly auditKindOptions: readonly PillOption[] = [
    { value: "all", label: "All categories" },
    { value: "config", label: "Config changes" },
    { value: "secret", label: "Secret operations" },
    { value: "access", label: "Access & principals" },
  ];
  protected readonly auditTimeOptions: readonly PillOption[] = [
    { value: "all", label: "All time" },
    { value: "24h", label: "Last 24 hours" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
  ];

  protected readonly principals = signal<PrincipalRow[]>([]);
  protected readonly newPrincipalEntry = signal("");
  protected readonly newPrincipalRole = signal("grain/developer");
  protected readonly newPrincipalReason = signal("");
  protected readonly principalsError = signal<string | null>(null);
  protected readonly principalActionError = signal<string | null>(null);

  protected readonly tokens = signal<ExternalTokenRow[]>([]);
  protected readonly newTokenName = signal("");
  protected readonly newTokenScopes = signal("tasks:read,tasks:write");
  protected readonly mintedTokenSecret = signal<string | null>(null);
  protected readonly mintedTokenMissingWarning = signal<string | null>(null);
  protected readonly tokensError = signal<string | null>(null);
  protected readonly tokenActionError = signal<string | null>(null);
  protected readonly tokenScopesError = signal<string | null>(null);

  protected readonly gcpKeys = signal<GcpKeyRow[]>([]);
  protected readonly newGcpKeyName = signal("");
  protected readonly newGcpKeyProject = signal("");
  protected readonly newGcpKeySaEmail = signal("");
  protected readonly newGcpKeyCount = signal("");
  protected readonly newGcpKeyMaxAge = signal("");
  protected readonly newGcpKeyMinter = signal("");
  protected readonly gcpKeysError = signal<string | null>(null);
  protected readonly gcpKeyActionError = signal<string | null>(null);

  protected readonly auditEvents = signal<AuditEventRow[]>([]);
  protected readonly auditFilterText = signal("");
  protected readonly auditKindFilter = signal("all");
  protected readonly auditTimeFilter = signal("all");
  protected readonly auditError = signal<string | null>(null);

  protected readonly missingScopeTokensCount = computed(
    () => this.tokens().filter((tok) => !externalTokenHasScopes(tok)).length,
  );

  protected readonly auditRestrictedReason = computed<string | null>(() => {
    const reasons: string[] = [];
    if (!this.access.can("GET /api/deployment/config-audit")) {
      reasons.push(
        this.access.deniedReason("GET /api/deployment/config-audit"),
      );
    }
    if (
      !this.access.can("GET /api/deployment/audit-logs") &&
      !this.access.can("GET /api/deployment/secret-audit")
    ) {
      reasons.push(this.access.deniedReason("GET /api/deployment/audit-logs"));
    }
    if (!this.access.can("GET /api/access/history")) {
      reasons.push(this.access.deniedReason("GET /api/access/history"));
    }
    const unique = Array.from(new Set(reasons.filter(Boolean)));
    if (unique.length === 0) return null;
    return unique.length === 3
      ? `Audit logs unavailable: ${unique.join(" ")}`
      : `Some audit categories are restricted: ${unique.join(" ")}`;
  });

  protected readonly filteredAuditEvents = computed(() => {
    const q = this.auditFilterText().trim().toLowerCase();
    const kind = this.auditKindFilter();
    const win = this.auditTimeFilter();
    const now = Date.now();
    const cutoff =
      win === "24h"
        ? now - 86400_000
        : win === "7d"
          ? now - 7 * 86400_000
          : win === "30d"
            ? now - 30 * 86400_000
            : 0;
    return this.auditEvents().filter((ev) => {
      if (kind !== "all" && ev.kind !== kind) return false;
      if (cutoff > 0 && ev.at) {
        const ts = Date.parse(ev.at);
        if (!Number.isNaN(ts) && ts < cutoff) return false;
      }
      if (!q) return true;
      return `${ev.actor} ${ev.action} ${ev.detail}`.toLowerCase().includes(q);
    });
  });

  ngOnInit(): void {
    this.initialized = true;
    this.loadForSection();
  }

  ngOnChanges(): void {
    if (this.initialized) {
      this.loadForSection();
    }
  }

  protected canWriteSettings(): boolean {
    return (
      this.access.can("POST /api/settings") &&
      !this.state.configRepoOnly() &&
      !this.state.sectionLocked(this.section())
    );
  }

  protected writeSettingsDeniedReason(): string {
    if (!this.access.can("POST /api/settings")) {
      return this.access.deniedReason("POST /api/settings");
    }
    if (this.state.configRepoOnly()) {
      return "Settings are managed by the config repository and are read-only here.";
    }
    if (this.state.sectionLocked(this.section())) {
      return "This settings section is locked by deployment configuration.";
    }
    return "";
  }

  protected tokenHasScopes(tok: ExternalTokenRow): boolean {
    return externalTokenHasScopes(tok);
  }

  protected tokenScopeSummary(tok: ExternalTokenRow): string {
    return externalTokenScopeSummary(tok);
  }

  protected isGcpKeyIncomplete(gk: GcpKeyRow): boolean {
    return isGcpKeyIncomplete(gk);
  }

  protected onTokenScopesInput(raw: string): void {
    this.newTokenScopes.set(raw);
    const { error } = validateExternalTokenScopes(raw);
    this.tokenScopesError.set(error);
    if (!error) {
      this.tokenActionError.set(null);
    }
  }

  protected tokenStatus(
    tok: ExternalTokenRow,
  ): "revoked" | "expired" | "active" {
    if (tok.revokedAt || tok.revoked) return "revoked";
    if (tok.active === false) return "expired";
    return "active";
  }

  protected async onConfirmDone(accepted: boolean): Promise<void> {
    const req = this.confirmRequest();
    this.confirmRequest.set(null);
    if (accepted && req) {
      await req.run();
    }
  }

  private settleCall<T>(
    promise: Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
    // Attach rejection handler synchronously so Zone.js does not report
    // synchronously-rejected mock/cached promises as unhandled before native await.
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  }

  private recordCardError(
    target: WritableSignal<string | null>,
    err: unknown,
    forwardToState = true,
  ): string {
    const msg = formatSecurityError(err);
    target.set(msg);
    if (forwardToState) {
      this.state.recordError(err);
    }
    return msg;
  }

  private loadForSection(): void {
    if (this.section() === "access") {
      this.principalsError.set(null);
      this.principalActionError.set(null);
      this.tokensError.set(null);
      this.tokenActionError.set(null);
      this.gcpKeysError.set(null);
      this.gcpKeyActionError.set(null);
      void this.loadAccessData();
    } else if (this.section() === "audit") {
      this.auditError.set(null);
      void this.loadAuditLogs();
    }
  }

  private async loadAccessData(): Promise<void> {
    if (this.access.can("GET /api/access/principals")) {
      const pRes = await this.settleCall(
        this.api.get<unknown>("GET /api/access/principals"),
      );
      if (pRes.ok) {
        this.principalsError.set(null);
        const normalized = normalizePrincipalResponse(pRes.value);
        this.principals.set(normalized.rows);
        if (normalized.roles) {
          this.roleOptions.set(
            normalized.roles.map((r) => ({
              value: r.name,
              label: r.description ? `${r.name} — ${r.description}` : r.name,
            })),
          );
        }
      } else {
        this.principals.set([]);
        this.recordCardError(this.principalsError, pRes.err, false);
      }
    } else {
      this.principals.set([]);
      this.principalsError.set(null);
    }

    if (this.access.can("GET /api/external-agents/tokens")) {
      const tRes = await this.settleCall(
        this.api.get<unknown>("GET /api/external-agents/tokens"),
      );
      if (tRes.ok) {
        this.tokensError.set(null);
        this.tokens.set(normalizeExternalTokenRows(tRes.value));
      } else {
        this.tokens.set([]);
        this.recordCardError(this.tokensError, tRes.err, false);
      }
    } else {
      this.tokens.set([]);
      this.tokensError.set(null);
    }

    if (this.access.can("GET /api/gcp-keys")) {
      const gRes = await this.settleCall(
        this.api.get<unknown>("GET /api/gcp-keys"),
      );
      if (gRes.ok) {
        this.gcpKeysError.set(null);
        this.gcpKeys.set(normalizeGcpKeyRows(gRes.value));
      } else {
        this.gcpKeys.set([]);
        this.recordCardError(this.gcpKeysError, gRes.err, false);
      }
    } else {
      this.gcpKeys.set([]);
      this.gcpKeysError.set(null);
    }
  }

  protected async addPrincipal(): Promise<void> {
    this.principalActionError.set(null);
    const entry = this.newPrincipalEntry().trim();
    if (!entry) return;
    const reason = this.newPrincipalReason().trim();
    const res = await this.settleCall(
      this.api.post("POST /api/access/principals", undefined, {
        entry,
        role: this.newPrincipalRole(),
        ...(reason ? { reason } : {}),
      }),
    );
    if (!res.ok) {
      this.recordCardError(this.principalActionError, res.err);
      return;
    }
    this.newPrincipalEntry.set("");
    this.newPrincipalReason.set("");
    await this.loadAccessData();
    this.snackbar.show(`Granted ${this.newPrincipalRole()} to ${entry}`);
  }

  private isSelfPrincipal(entry: string): boolean {
    const viewer = this.access.viewer().trim().toLowerCase();
    return Boolean(viewer && entry.trim().toLowerCase() === viewer);
  }

  private isSelfConfirmRefusal(err: unknown): boolean {
    const msg = errText(err).toLowerCase();
    return (
      msg.includes("confirmself") ||
      msg.includes("matches the caller") ||
      msg.includes("your own access") ||
      msg.includes("yourself")
    );
  }

  protected async updatePrincipalRole(
    entry: string,
    role: string,
  ): Promise<void> {
    this.principalActionError.set(null);
    const reason = this.newPrincipalReason().trim();
    if (this.isSelfPrincipal(entry)) {
      this.promptSelfRoleConfirm(entry, role, reason);
      return;
    }
    const res = await this.settleCall(
      this.api.patch(
        "PATCH /api/access/principals/{entry}",
        { entry },
        { role, ...(reason ? { reason } : {}) },
      ),
    );
    if (res.ok) {
      await this.loadAccessData();
      this.snackbar.show(`Updated ${entry} to ${role}`);
    } else if (this.isSelfConfirmRefusal(res.err)) {
      this.promptSelfRoleConfirm(entry, role, reason);
    } else {
      await this.loadAccessData();
      this.recordCardError(this.principalActionError, res.err);
    }
  }

  private promptSelfRoleConfirm(
    entry: string,
    role: string,
    reason: string,
  ): void {
    this.confirmRequest.set({
      title: "Change your own access role?",
      message: `Changing "${entry}" to "${role}" affects your own signed-in session and may narrow or revoke your operator permissions.`,
      accept: "Confirm role change",
      destructive: true,
      run: async () => {
        const res = await this.settleCall(
          this.api.patch(
            "PATCH /api/access/principals/{entry}",
            { entry },
            {
              role,
              confirmSelf: true,
              ...(reason ? { reason } : {}),
            },
          ),
        );
        await this.loadAccessData();
        if (res.ok) {
          this.snackbar.show(`Updated ${entry} to ${role}`);
        } else {
          this.recordCardError(this.principalActionError, res.err);
        }
      },
    });
  }

  protected async removePrincipal(entry: string): Promise<void> {
    this.principalActionError.set(null);
    const reason = this.newPrincipalReason().trim();
    if (this.isSelfPrincipal(entry)) {
      this.promptSelfRemoveConfirm(entry, reason);
      return;
    }
    const q = reason ? `reason=${encodeURIComponent(reason)}` : undefined;
    const res = await this.settleCall(
      this.api.delete(
        "DELETE /api/access/principals/{entry}",
        { entry },
        undefined,
        q,
      ),
    );
    if (res.ok) {
      await this.loadAccessData();
      this.snackbar.show(`Removed ${entry}`);
    } else if (this.isSelfConfirmRefusal(res.err)) {
      this.promptSelfRemoveConfirm(entry, reason);
    } else {
      this.recordCardError(this.principalActionError, res.err);
    }
  }

  private promptSelfRemoveConfirm(entry: string, reason: string): void {
    this.confirmRequest.set({
      title: "Remove your own access entry?",
      message: `Removing "${entry}" revokes access matching your own signed-in identity and may lock you out immediately.`,
      accept: "Confirm self-removal",
      destructive: true,
      run: async () => {
        const params = ["confirmSelf=1"];
        if (reason) params.push(`reason=${encodeURIComponent(reason)}`);
        const res = await this.settleCall(
          this.api.delete(
            "DELETE /api/access/principals/{entry}",
            { entry },
            undefined,
            params.join("&"),
          ),
        );
        if (res.ok) {
          await this.loadAccessData();
          this.snackbar.show(`Removed ${entry}`);
        } else {
          this.recordCardError(this.principalActionError, res.err);
        }
      },
    });
  }

  protected async mintToken(): Promise<void> {
    this.tokenActionError.set(null);
    this.mintedTokenMissingWarning.set(null);
    if (!this.access.can("POST /api/external-agents/tokens")) {
      this.tokenActionError.set(
        this.access.deniedReason("POST /api/external-agents/tokens"),
      );
      return;
    }
    const name = this.newTokenName().trim();
    if (!name) {
      this.tokenActionError.set("Enter a token name before minting.");
      return;
    }
    const { scopes, error } = validateExternalTokenScopes(
      this.newTokenScopes(),
    );
    this.tokenScopesError.set(error);
    if (error) {
      this.tokenActionError.set(error);
      return;
    }
    const callRes = await this.settleCall(
      this.api.post<{ token?: unknown }>(
        "POST /api/external-agents/tokens",
        undefined,
        { name, scopes },
      ),
    );
    if (!callRes.ok) {
      const msg = this.recordCardError(this.tokenActionError, callRes.err);
      if (msg.toLowerCase().includes("scope")) {
        this.tokenScopesError.set(msg);
      }
      return;
    }
    this.newTokenName.set("");
    const minted = asString(callRes.value?.token);
    if (minted) {
      this.mintedTokenSecret.set(minted);
      this.snackbar.show(`Minted token ${name}`);
    } else {
      this.mintedTokenSecret.set(null);
      this.mintedTokenMissingWarning.set(
        "Token was minted, but the API response did not include a one-time token key. Rotate the token to issue a new secret key.",
      );
      this.snackbar.show(
        `Minted token ${name}, but response omitted the token key`,
      );
    }
    await this.loadAccessData();
  }

  protected async rotateToken(id: string): Promise<void> {
    this.tokenActionError.set(null);
    this.mintedTokenMissingWarning.set(null);
    const callRes = await this.settleCall(
      this.api.post<{ token?: unknown }>(
        "POST /api/external-agents/tokens/{id}/rotate",
        { id },
        {},
      ),
    );
    if (!callRes.ok) {
      this.recordCardError(this.tokenActionError, callRes.err);
      return;
    }
    const minted = asString(callRes.value?.token);
    if (minted) {
      this.mintedTokenSecret.set(minted);
      this.snackbar.show("Token rotated");
    } else {
      this.mintedTokenSecret.set(null);
      this.mintedTokenMissingWarning.set(
        "Token was rotated, but the API response did not include a replacement token key.",
      );
      this.snackbar.show("Token rotated, but response omitted the token key");
    }
    await this.loadAccessData();
  }

  protected async revokeToken(id: string): Promise<void> {
    this.tokenActionError.set(null);
    const res = await this.settleCall(
      this.api.post("POST /api/external-agents/tokens/{id}/revoke", { id }, {}),
    );
    if (!res.ok) {
      this.recordCardError(this.tokenActionError, res.err);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show("Token revoked");
  }

  protected async revokeAllTokens(): Promise<void> {
    this.tokenActionError.set(null);
    const res = await this.settleCall(
      this.api.post(
        "POST /api/external-agents/tokens/revoke-all",
        undefined,
        {},
      ),
    );
    if (!res.ok) {
      this.recordCardError(this.tokenActionError, res.err);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show("Revoked all external agent tokens");
  }

  protected async deleteToken(id: string): Promise<void> {
    this.tokenActionError.set(null);
    const res = await this.settleCall(
      this.api.delete("DELETE /api/external-agents/tokens/{id}", { id }),
    );
    if (!res.ok) {
      this.recordCardError(this.tokenActionError, res.err);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show("Deleted token");
  }

  protected async saveGcpKey(): Promise<void> {
    this.gcpKeyActionError.set(null);
    const name = this.newGcpKeyName().trim();
    const projectId = this.newGcpKeyProject().trim();
    const serviceAccountEmail = this.newGcpKeySaEmail().trim();
    if (!name || !projectId || !serviceAccountEmail) {
      this.gcpKeyActionError.set(
        "Key alias, project ID, and service account email are required.",
      );
      return;
    }
    const count = Math.floor(Number(this.newGcpKeyCount()) || 0);
    const maxKeyAge = this.newGcpKeyMaxAge().trim();
    const minterCredential = this.newGcpKeyMinter().trim();
    const res = await this.settleCall(
      this.api.post("POST /api/gcp-keys", undefined, {
        name,
        projectId,
        serviceAccountEmail,
        ...(count > 0 ? { serviceAccountCount: count } : {}),
        ...(maxKeyAge ? { maxKeyAge } : {}),
        ...(minterCredential ? { minterCredential } : {}),
      }),
    );
    if (!res.ok) {
      this.recordCardError(this.gcpKeyActionError, res.err);
      return;
    }
    this.newGcpKeyName.set("");
    this.newGcpKeyProject.set("");
    this.newGcpKeySaEmail.set("");
    this.newGcpKeyCount.set("");
    this.newGcpKeyMaxAge.set("");
    this.newGcpKeyMinter.set("");
    await this.loadAccessData();
    this.snackbar.show(`Saved GCP key ${name}`);
  }

  protected async deleteGcpKey(name: string): Promise<void> {
    this.gcpKeyActionError.set(null);
    const res = await this.settleCall(
      this.api.delete("DELETE /api/gcp-keys/{name}", { name }),
    );
    if (!res.ok) {
      this.recordCardError(this.gcpKeyActionError, res.err);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show(`Deleted GCP key ${name}`);
  }

  protected async loadAuditLogs(): Promise<void> {
    this.auditError.set(null);
    const combined: AuditEventRow[] = [];
    const seenConfigAuditKeys = new Set<string>();
    const errors: string[] = [];

    const unwrapItems = (raw: unknown): unknown[] =>
      pickFirstArray(raw, ["items", "entries", "logs", "history"]);

    const formatActor = (r: Record<string, unknown>): string => {
      const raw = r["actor"] ?? r["principal"] ?? r["by"];
      if (raw && typeof raw === "object") {
        const p = raw as { id?: string; kind?: string };
        return p.id || p.kind || "system";
      }
      if (typeof raw === "string" && raw) return raw;
      if (typeof r["taskId"] === "string" && r["taskId"]) {
        return `task:${r["taskId"]}`;
      }
      return "system";
    };

    const norm = (
      raw: unknown,
      source: "config" | "secret" | "access",
    ): void => {
      const arr = unwrapItems(raw);
      arr.forEach((item, idx) => {
        if (!item || typeof item !== "object") return;
        const r = item as Record<string, unknown>;
        const at = String(r["createdAt"] ?? r["at"] ?? r["timestamp"] ?? "");
        const surface = typeof r["surface"] === "string" ? r["surface"] : "";
        const effectiveKind: "config" | "secret" | "access" =
          source === "access" || surface === "access" ? "access" : source;

        // Deduplicate config_audit rows shared between /api/deployment/config-audit
        // and /api/access/history (both query Store.ConfigAudit*).
        if (source === "config" || source === "access") {
          const dedupKey =
            r["id"] !== undefined
              ? `cfg-id:${String(r["id"])}`
              : `cfg-sig:${at}:${String(r["summary"] ?? r["detail"] ?? "")}`;
          if (seenConfigAuditKeys.has(dedupKey)) return;
          seenConfigAuditKeys.add(dedupKey);
        }

        const secretRef = r["secretName"]
          ? r["key"]
            ? `${String(r["secretName"])}/${String(r["key"])}`
            : String(r["secretName"])
          : "";
        const detailParts = [
          r["resource"] ? String(r["resource"]) : "",
          secretRef,
          r["credential"] ? `cred:${String(r["credential"])}` : "",
          (r["detail"] ??
          r["summary"] ??
          r["outcome"] ??
          r["target"] ??
          r["entry"])
            ? String(
                r["detail"] ??
                  r["summary"] ??
                  r["outcome"] ??
                  r["target"] ??
                  r["entry"],
              )
            : "",
        ].filter(Boolean);

        combined.push({
          id: `${effectiveKind}-${r["id"] ?? idx}-${at}-${combined.length}`,
          at,
          actor: formatActor(r),
          kind: effectiveKind,
          action: String(
            r["action"] ??
              r["event"] ??
              r["operation"] ??
              surface ??
              effectiveKind,
          ),
          detail: Array.from(new Set(detailParts)).join(" · "),
        });
      });
    };

    const jobs: Promise<void>[] = [];
    if (this.access.can("GET /api/deployment/config-audit")) {
      jobs.push(
        this.api
          .get("GET /api/deployment/config-audit", undefined, "limit=100")
          .then((r) => norm(r, "config"))
          .catch((err: unknown) => {
            errors.push(`Config audit: ${formatSecurityError(err)}`);
          }),
      );
    }
    if (this.access.can("GET /api/deployment/audit-logs")) {
      jobs.push(
        this.api
          .get("GET /api/deployment/audit-logs", undefined, "limit=100")
          .then((r) => norm(r, "secret"))
          .catch((err: unknown) => {
            errors.push(`Secret audit: ${formatSecurityError(err)}`);
          }),
      );
    } else if (this.access.can("GET /api/deployment/secret-audit")) {
      jobs.push(
        this.api
          .get("GET /api/deployment/secret-audit")
          .then((r) => norm(r, "secret"))
          .catch((err: unknown) => {
            errors.push(`Secret audit: ${formatSecurityError(err)}`);
          }),
      );
    }
    if (this.access.can("GET /api/access/history")) {
      jobs.push(
        this.api
          .get("GET /api/access/history")
          .then((r) => norm(r, "access"))
          .catch((err: unknown) => {
            errors.push(`Access history: ${formatSecurityError(err)}`);
          }),
      );
    }
    await Promise.all(jobs);
    if (errors.length > 0) {
      this.auditError.set(errors.join(" "));
    }
    combined.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    this.auditEvents.set(combined);
  }
}
