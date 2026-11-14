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

interface ExternalTokenRow {
  id: string;
  name: string;
  tokenPrefix?: string;
  prefix?: string;
  owner?: string;
  scopeSet?: string;
  scopes?: string[];
  resolvedScopes?: string[];
  repos?: string[];
  revokedAt?: string | null;
  revoked?: boolean;
  expiresAt?: string | null;
  active?: boolean;
}

interface GcpKeyRow {
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

export interface TokenScopeValidation {
  scopes: string[];
  error: string | null;
}

export interface TokenScopeSummary {
  label: string;
  resolvedDetail: string | null;
  missingScopes: boolean;
}

/** Validates comma-separated gma_ token scope specifications before submission. */
export function validateTokenScopes(raw: string): TokenScopeValidation {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return {
      scopes: [],
      error:
        "Enter at least one token scope (for example tasks:read,tasks:write).",
    };
  }
  const scopes: string[] = [];
  const repoRe = /^[^/\s@]+\/[^/\s@]+$/;
  const nameRe = /^[a-z0-9:*._-]+$/i;
  for (const part of parts) {
    if (/\s/.test(part)) {
      return {
        scopes: [],
        error: `Scope "${part}" contains whitespace; separate scopes with commas.`,
      };
    }
    const stripped = part.startsWith("api:") ? part.slice(4) : part;
    if (!stripped) {
      return {
        scopes: [],
        error: `Scope "${part}" is missing a scope or scope-set name after "api:".`,
      };
    }
    const atIdx = stripped.indexOf("@");
    const target = atIdx >= 0 ? stripped.slice(0, atIdx) : stripped;
    if (!target) {
      return {
        scopes: [],
        error: `Scope "${part}" is missing a scope name before "@".`,
      };
    }
    if (atIdx >= 0) {
      const repo = stripped.slice(atIdx + 1);
      if (!repoRe.test(repo)) {
        return {
          scopes: [],
          error: `Scope "${part}" must target a repository formatted as owner/name.`,
        };
      }
    }
    if (target.toLowerCase() === "internal") {
      return {
        scopes: [],
        error: `Scope "${part}" uses "internal", which is reserved for Grain internals and cannot be granted.`,
      };
    }
    if (
      !nameRe.test(target) ||
      target.startsWith(":") ||
      target.endsWith(":")
    ) {
      return {
        scopes: [],
        error: `Scope "${part}" has invalid syntax; use <area>:<level> (for example tasks:read) or a named preset.`,
      };
    }
    if (!scopes.includes(part)) {
      scopes.push(part);
    }
  }
  return { scopes, error: null };
}

/** Validates GCP service account key form fields prior to submission. */
export function validateGcpKeyForm(form: {
  name: string;
  projectId: string;
  serviceAccountEmail: string;
  countRaw: string;
  maxKeyAge: string;
}): { error: string | null; count: number } {
  const name = form.name.trim();
  const projectId = form.projectId.trim();
  const sa = form.serviceAccountEmail.trim();
  if (!name || !projectId || !sa) {
    return {
      error:
        "Key alias, project ID, and service account email are all required.",
      count: 0,
    };
  }
  if (!sa.includes("@") || /\s/.test(sa)) {
    return {
      error: `Service account email "${sa}" must be a valid email address.`,
      count: 0,
    };
  }
  const rawCount = form.countRaw.trim();
  let count = 0;
  if (rawCount) {
    const parsed = Number(rawCount);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return {
        error: "Account pool count must be a non-negative integer.",
        count: 0,
      };
    }
    count = parsed;
  }
  const age = form.maxKeyAge.trim();
  if (age && !/^(\d+(?:\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(age)) {
    return {
      error: `Max key age "${age}" must be a valid Go duration (for example 24h or 30m).`,
      count: 0,
    };
  }
  return { error: null, count };
}

/** Summarizes an existing token's configured scopes and detects missing scopes. */
export function summarizeTokenScopes(tok: ExternalTokenRow): TokenScopeSummary {
  const scopeSet = tok.scopeSet?.trim() ?? "";
  const explicit = (tok.scopes ?? []).map((s) => s.trim()).filter(Boolean);
  const resolved = (tok.resolvedScopes ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const repos = (tok.repos ?? []).map((r) => r.trim()).filter(Boolean);
  if (!scopeSet && explicit.length === 0 && resolved.length === 0) {
    return {
      label: "Missing scopes",
      resolvedDetail: null,
      missingScopes: true,
    };
  }
  const primaryParts: string[] = [];
  if (scopeSet) primaryParts.push(scopeSet);
  if (explicit.length > 0) primaryParts.push(explicit.join(", "));
  const label =
    primaryParts.length > 0 ? primaryParts.join(" + ") : resolved.join(", ");
  const details: string[] = [];
  if (resolved.length > 0 && primaryParts.length > 0) {
    const joined = resolved.join(", ");
    if (joined !== label) {
      details.push(`resolved: ${joined}`);
    }
  }
  if (repos.length > 0) {
    details.push(`repos: ${repos.join(", ")}`);
  }
  return {
    label,
    resolvedDetail: details.length > 0 ? details.join(" · ") : null,
    missingScopes: false,
  };
}

/** Lists missing required metadata fields on a stored GCP key entry. */
export function missingGcpKeyFields(gk: GcpKeyRow): string[] {
  const missing: string[] = [];
  if (!gk.name?.trim()) missing.push("name");
  if (!gk.projectId?.trim()) missing.push("projectId");
  if (!gk.serviceAccountEmail?.trim()) missing.push("serviceAccountEmail");
  return missing;
}

function unwrapArrayPayload(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown>[] {
  let list: unknown = raw;
  if (!Array.isArray(list) && raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(rec[k])) {
        list = rec[k];
        break;
      }
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Normalizes principal rows defensively when API responses omit expected keys. */
export function normalizePrincipals(raw: unknown): PrincipalRow[] {
  return unwrapArrayPayload(raw, ["entries", "principals", "items"]).map(
    (r) => ({
      entry: typeof r["entry"] === "string" ? r["entry"].trim() : "",
      role: typeof r["role"] === "string" ? r["role"].trim() : "",
      label: typeof r["label"] === "string" ? r["label"].trim() : undefined,
      addedBy:
        typeof r["addedBy"] === "string" ? r["addedBy"].trim() : undefined,
    }),
  );
}

/** Normalizes external agent token rows defensively when API responses omit keys. */
export function normalizeExternalTokens(raw: unknown): ExternalTokenRow[] {
  return unwrapArrayPayload(raw, ["tokens", "items"]).map((r) => ({
    id: typeof r["id"] === "string" ? r["id"].trim() : "",
    name: typeof r["name"] === "string" ? r["name"].trim() : "",
    tokenPrefix:
      typeof r["tokenPrefix"] === "string"
        ? r["tokenPrefix"].trim()
        : undefined,
    prefix: typeof r["prefix"] === "string" ? r["prefix"].trim() : undefined,
    owner: typeof r["owner"] === "string" ? r["owner"].trim() : undefined,
    scopeSet:
      typeof r["scopeSet"] === "string" ? r["scopeSet"].trim() : undefined,
    scopes: asStringList(r["scopes"]),
    resolvedScopes: asStringList(r["resolvedScopes"]),
    repos: asStringList(r["repos"]),
    revokedAt: typeof r["revokedAt"] === "string" ? r["revokedAt"] : null,
    revoked: Boolean(r["revoked"]),
    expiresAt: typeof r["expiresAt"] === "string" ? r["expiresAt"] : null,
    active: typeof r["active"] === "boolean" ? r["active"] : undefined,
  }));
}

/** Normalizes GCP key rows defensively when API responses omit keys. */
export function normalizeGcpKeys(raw: unknown): GcpKeyRow[] {
  return unwrapArrayPayload(raw, ["keys", "items"]).map((r) => ({
    name: typeof r["name"] === "string" ? r["name"].trim() : "",
    projectId:
      typeof r["projectId"] === "string" ? r["projectId"].trim() : undefined,
    serviceAccountEmail:
      typeof r["serviceAccountEmail"] === "string"
        ? r["serviceAccountEmail"].trim()
        : undefined,
    serviceAccountCount:
      typeof r["serviceAccountCount"] === "number"
        ? r["serviceAccountCount"]
        : undefined,
    maxKeyAge:
      typeof r["maxKeyAge"] === "string" ? r["maxKeyAge"].trim() : undefined,
    minterCredential:
      typeof r["minterCredential"] === "string"
        ? r["minterCredential"].trim()
        : undefined,
  }));
}

const DEFAULT_ROLE_OPTIONS: readonly PillOption[] = [
  { value: "grain/operator", label: "grain/operator (full)" },
  { value: "grain/admin", label: "grain/admin" },
  { value: "grain/developer", label: "grain/developer" },
  { value: "grain/viewer", label: "grain/viewer (read-only)" },
];

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

          @if (missingRoleSets().length > 0) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="access-missing-role-sets"
            >
              <span
                >Missing required role scope sets:
                <strong class="s-mono">{{
                  missingRoleSets().join(", ")
                }}</strong
                >. Tokens or role assignments referencing these sets lack
                required scope definitions.</span
              >
            </div>
          }

          @if (!access.can("GET /api/access/principals")) {
            <div
              class="s-banner warn"
              role="status"
              data-testid="principals-restricted"
            >
              {{ access.deniedReason("GET /api/access/principals") }}
            </div>
          } @else {
            @if (principalsError(); as pErr) {
              <div
                class="s-banner error"
                role="alert"
                data-testid="principals-error"
              >
                <span>{{ pErr }}</span>
                <button
                  type="button"
                  class="btn-text s-btn-sm"
                  (click)="principalsError.set(null)"
                >
                  Dismiss
                </button>
              </div>
            }

            @if (!canWritePrincipals()) {
              <div
                class="s-banner readonly"
                role="status"
                data-testid="principals-write-restricted"
              >
                {{ access.deniedReason("POST /api/access/principals") }}
              </div>
            }

            @if (principals().length > 0) {
              <div
                class="s-table-wrap"
                tabindex="0"
                role="region"
                aria-label="Access principals"
              >
                <table class="s-table" aria-label="Access principals">
                  <thead>
                    <tr>
                      <th>Principal</th>
                      <th>Role</th>
                      <th class="s-actions-cell">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of principals(); track p.entry || $index) {
                      <tr
                        [attr.data-testid]="
                          'principal-row-' + (p.entry || $index)
                        "
                      >
                        <td>
                          <div class="s-cell-stack">
                            <span class="s-cell-title">{{
                              p.label || p.entry || "(missing principal)"
                            }}</span>
                            @if (p.label && p.entry) {
                              <span class="s-meta-mono">{{ p.entry }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          @if (!p.role) {
                            <span
                              class="status-pill warn"
                              [attr.data-testid]="
                                'principal-missing-role-' + (p.entry || $index)
                              "
                              >Missing role</span
                            >
                          } @else {
                            <g-pill-select
                              [testid]="'role-select-' + p.entry"
                              [ariaLabel]="'Role for ' + p.entry"
                              align="left"
                              [options]="roleOptions()"
                              [value]="p.role"
                              [disabled]="
                                !p.entry ||
                                !access.can(
                                  'PATCH /api/access/principals/{entry}'
                                )
                              "
                              (valueChange)="
                                updatePrincipalRole(p.entry, $event)
                              "
                            />
                          }
                        </td>
                        <td class="s-actions-cell">
                          <div class="s-row-actions">
                            <button
                              type="button"
                              class="btn-text s-btn-sm"
                              [attr.data-testid]="
                                'remove-principal-' + (p.entry || $index)
                              "
                              [attr.title]="
                                !p.entry
                                  ? 'Principal entry key is missing'
                                  : !access.can(
                                        'DELETE /api/access/principals/{entry}'
                                      )
                                    ? access.deniedReason(
                                        'DELETE /api/access/principals/{entry}'
                                      )
                                    : null
                              "
                              [disabled]="
                                !p.entry ||
                                !access.can(
                                  'DELETE /api/access/principals/{entry}'
                                )
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
              <p class="s-card-desc" data-testid="principals-empty">
                No explicit RBAC principals configured.
              </p>
            }

            <div class="s-subsection">
              <div class="s-subhead">
                <h4 class="s-subhead-title">Grant access</h4>
              </div>
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
                  [attr.title]="
                    !access.can('POST /api/access/principals')
                      ? access.deniedReason('POST /api/access/principals')
                      : null
                  "
                  [disabled]="
                    !newPrincipalEntry().trim() ||
                    !access.can('POST /api/access/principals')
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
              <span id="external-agent-api-hint" class="s-hint"
                >Allow external callers bearing gma_ tokens to
                authenticate.</span
              >
            </div>
            <button
              type="button"
              class="g-switch"
              role="switch"
              data-testid="switch-external-agent-api"
              [attr.aria-checked]="
                Boolean(state.val('externalAgentApi', true)) ? 'true' : 'false'
              "
              [attr.title]="
                !canWriteSettings()
                  ? access.deniedReason('POST /api/settings')
                  : null
              "
              [disabled]="!canWriteSettings()"
              aria-label="Accept external agent tokens"
              aria-describedby="external-agent-api-hint"
              (click)="
                state.setField(
                  'externalAgentApi',
                  !state.val('externalAgentApi', true)
                )
              "
            ></button>
          </div>

          @if (tokensError(); as tErr) {
            <div class="s-banner error" role="alert" data-testid="tokens-error">
              <span>{{ tErr }}</span>
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="tokensError.set(null)"
              >
                Dismiss
              </button>
            </div>
          }

          @if (mintedTokenSecret(); as secret) {
            <div
              class="s-banner ok"
              role="status"
              data-testid="minted-gma-token"
            >
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

          @if (!access.can("GET /api/external-agents/tokens")) {
            <div
              class="s-banner warn"
              role="status"
              data-testid="tokens-restricted"
            >
              {{ access.deniedReason("GET /api/external-agents/tokens") }}
            </div>
          } @else if (tokens().length > 0) {
            <div
              class="s-table-wrap"
              tabindex="0"
              role="region"
              aria-label="External agent tokens"
            >
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
                  @for (tok of tokens(); track tok.id || $index) {
                    @let tokState = tokenStatus(tok);
                    @let scopeInfo = tokenScopeSummary(tok);
                    @let tokKey = tok.id || $index;
                    <tr [attr.data-testid]="'gma-token-row-' + tokKey">
                      <td>
                        <div class="s-cell-stack">
                          <span class="s-cell-title s-mono">{{
                            tok.name || "(unnamed token)"
                          }}</span>
                          @if (tok.tokenPrefix || tok.prefix) {
                            <span class="s-meta-mono"
                              >{{ tok.tokenPrefix || tok.prefix }}…</span
                            >
                          }
                          @if (!tok.id) {
                            <span
                              class="status-pill warn"
                              [attr.data-testid]="
                                'gma-token-missing-id-' + tokKey
                              "
                              >Missing token ID</span
                            >
                          }
                        </div>
                      </td>
                      <td>
                        @if (scopeInfo.missingScopes) {
                          <span
                            class="status-pill warn"
                            [attr.data-testid]="
                              'gma-token-missing-scopes-' + tokKey
                            "
                            >{{ scopeInfo.label }}</span
                          >
                        } @else {
                          <div class="s-cell-stack">
                            <span
                              class="s-mono"
                              [attr.data-testid]="'gma-token-scopes-' + tokKey"
                              >{{ scopeInfo.label }}</span
                            >
                            @if (scopeInfo.resolvedDetail; as detail) {
                              <span class="s-meta">{{ detail }}</span>
                            }
                          </div>
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
                          [attr.data-testid]="'gma-token-status-' + tokKey"
                        >
                          {{ tokState }}
                        </span>
                      </td>
                      <td class="s-actions-cell">
                        <div class="s-row-actions">
                          <button
                            type="button"
                            class="btn-tonal s-btn-sm"
                            [attr.data-testid]="'rotate-token-' + tokKey"
                            [attr.title]="
                              !tok.id
                                ? 'Missing token id key'
                                : !access.can(
                                      'POST /api/external-agents/tokens/{id}/rotate'
                                    )
                                  ? access.deniedReason(
                                      'POST /api/external-agents/tokens/{id}/rotate'
                                    )
                                  : null
                            "
                            [disabled]="
                              !tok.id ||
                              !access.can(
                                'POST /api/external-agents/tokens/{id}/rotate'
                              )
                            "
                            (click)="rotateToken(tok.id)"
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            class="btn-tonal s-btn-sm"
                            [attr.data-testid]="'revoke-token-' + tokKey"
                            [attr.title]="
                              !tok.id
                                ? 'Missing token id key'
                                : !access.can(
                                      'POST /api/external-agents/tokens/{id}/revoke'
                                    )
                                  ? access.deniedReason(
                                      'POST /api/external-agents/tokens/{id}/revoke'
                                    )
                                  : null
                            "
                            [disabled]="
                              !tok.id ||
                              !access.can(
                                'POST /api/external-agents/tokens/{id}/revoke'
                              ) ||
                              tokState !== 'active'
                            "
                            (click)="revokeToken(tok.id)"
                          >
                            Revoke
                          </button>
                          <button
                            type="button"
                            class="btn-text s-btn-sm"
                            [attr.data-testid]="'delete-token-' + tokKey"
                            [attr.title]="
                              !tok.id
                                ? 'Missing token id key'
                                : !access.can(
                                      'DELETE /api/external-agents/tokens/{id}'
                                    )
                                  ? access.deniedReason(
                                      'DELETE /api/external-agents/tokens/{id}'
                                    )
                                  : null
                            "
                            [disabled]="
                              !tok.id ||
                              !access.can(
                                'DELETE /api/external-agents/tokens/{id}'
                              )
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
          } @else if (!tokensError()) {
            <p class="s-card-desc" data-testid="tokens-empty">
              No external agent tokens have been minted yet.
            </p>
          }

          <div class="s-subsection">
            <div class="s-subhead">
              <h4 class="s-subhead-title">Mint external agent token</h4>
            </div>
            @if (!canMintTokens()) {
              <div
                class="s-banner warn"
                role="status"
                data-testid="tokens-admin-restricted"
              >
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
                  [disabled]="!canMintTokens()"
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
                  [disabled]="!canMintTokens()"
                  [attr.aria-invalid]="
                    canMintTokens() && tokenScopesError() ? 'true' : null
                  "
                  [attr.aria-describedby]="
                    canMintTokens() && tokenScopesError()
                      ? 'tk-scopes-error'
                      : null
                  "
                  (input)="newTokenScopes.set($any($event.target).value)"
                />
                @if (canMintTokens() && tokenScopesError(); as scErr) {
                  <span
                    id="tk-scopes-error"
                    class="s-field-error"
                    role="alert"
                    data-testid="gma-token-scopes-error"
                    >{{ scErr }}</span
                  >
                }
              </div>
            </div>
            <div class="s-inline">
              <button
                type="button"
                class="btn-tonal"
                data-testid="mint-gma-token-btn"
                [attr.title]="
                  !canMintTokens()
                    ? access.deniedReason('POST /api/external-agents/tokens')
                    : null
                "
                [disabled]="!newTokenName().trim() || !canMintTokens()"
                (click)="mintToken()"
              >
                Mint gma_ token
              </button>
            </div>
          </div>
        </div>

        <div class="s-card" data-testid="card-gcp-keys">
          <h3 class="s-card-title">GCP service account keys</h3>
          @if (gcpKeysError(); as gErr) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="gcp-keys-error"
            >
              <span>{{ gErr }}</span>
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="gcpKeysError.set(null)"
              >
                Dismiss
              </button>
            </div>
          }
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
                [attr.title]="
                  !canWriteSettings()
                    ? access.deniedReason('POST /api/settings')
                    : null
                "
                [disabled]="!canWriteSettings()"
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
                [attr.title]="
                  !canWriteSettings()
                    ? access.deniedReason('POST /api/settings')
                    : null
                "
                [disabled]="!canWriteSettings()"
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
            <div
              class="s-banner warn"
              role="status"
              data-testid="gcp-keys-restricted"
            >
              {{ access.deniedReason("GET /api/gcp-keys") }}
            </div>
          } @else if (gcpKeys().length > 0) {
            <div class="s-inline">
              @for (gk of gcpKeys(); track gk.name || $index) {
                @let missingFields = missingGcpFields(gk);
                @let gkKey = gk.name || $index;
                <span
                  [class]="
                    'status-pill s-mono ' +
                    (missingFields.length > 0 ? 'warn' : 'neutral')
                  "
                  [attr.data-testid]="'gcp-key-pill-' + gkKey"
                  [attr.title]="
                    missingFields.length > 0
                      ? 'Missing required API key metadata: ' +
                        missingFields.join(', ')
                      : gk.serviceAccountEmail || null
                  "
                >
                  {{ gk.name || "(unnamed key)"
                  }}{{ gk.projectId ? " · " + gk.projectId : ""
                  }}{{
                    missingFields.length > 0
                      ? " (missing " + missingFields.join(", ") + ")"
                      : ""
                  }}
                  <button
                    type="button"
                    class="btn-text s-btn-sm"
                    style="padding: 0 4px; min-width: 24px; min-height: 24px"
                    [attr.aria-label]="
                      'Delete GCP key ' + (gk.name || 'unnamed')
                    "
                    [attr.data-testid]="'delete-gcp-key-' + gkKey"
                    [attr.title]="
                      !gk.name
                        ? 'GCP key entry is missing its name key'
                        : !access.can('DELETE /api/gcp-keys/{name}')
                          ? access.deniedReason('DELETE /api/gcp-keys/{name}')
                          : null
                    "
                    [disabled]="
                      !gk.name || !access.can('DELETE /api/gcp-keys/{name}')
                    "
                    (click)="deleteGcpKey(gk.name)"
                  >
                    ×
                  </button>
                </span>
              }
            </div>
          } @else if (!gcpKeysError()) {
            <p class="s-card-desc" data-testid="gcp-keys-empty">
              No GCP service account keys configured.
            </p>
          }

          @if (!access.can("POST /api/gcp-keys")) {
            <div
              class="s-banner warn"
              role="status"
              data-testid="gcp-keys-write-restricted"
            >
              {{ access.deniedReason("POST /api/gcp-keys") }}
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
              [attr.title]="
                !access.can('POST /api/gcp-keys')
                  ? access.deniedReason('POST /api/gcp-keys')
                  : null
              "
              [disabled]="
                !newGcpKeyName().trim() ||
                !newGcpKeyProject().trim() ||
                !newGcpKeySaEmail().trim() ||
                !access.can('POST /api/gcp-keys')
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
              [disabled]="!canViewAudit()"
              [attr.title]="
                !canViewAudit()
                  ? 'Requires at least one of settings:read, secrets:read, or access:read'
                  : null
              "
              (click)="loadAuditLogs()"
            >
              Refresh
            </button>
          </div>

          @if (!canViewAudit()) {
            <div
              class="s-banner warn"
              role="status"
              data-testid="audit-restricted"
            >
              <span>
                Your current role or token lacks required audit read scopes
                (<span class="s-mono">settings:read</span>,
                <span class="s-mono">secrets:read</span>, or
                <span class="s-mono">access:read</span>).
              </span>
            </div>
          } @else {
            @if (auditError(); as aErr) {
              <div
                class="s-banner error"
                role="alert"
                data-testid="audit-error"
              >
                <span>{{ aErr }}</span>
                <button
                  type="button"
                  class="btn-text s-btn-sm"
                  (click)="auditError.set(null)"
                >
                  Dismiss
                </button>
              </div>
            }

            @if (missingAuditScopes().length > 0) {
              <div
                class="s-banner readonly"
                role="status"
                data-testid="audit-partial-restricted"
              >
                <span>
                  Partial audit coverage: your token lacks
                  <span class="s-mono">{{
                    missingAuditScopes().join(", ")
                  }}</span>
                  , so those event streams are hidden.
                </span>
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
              <div
                class="s-table-wrap"
                tabindex="0"
                role="region"
                aria-label="Audit events"
              >
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
  protected readonly tokenScopeSummary = summarizeTokenScopes;
  protected readonly missingGcpFields = missingGcpKeyFields;

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
  protected readonly principalsError = signal<string | null>(null);
  protected readonly newPrincipalEntry = signal("");
  protected readonly newPrincipalRole = signal("grain/developer");
  protected readonly newPrincipalReason = signal("");

  protected readonly tokens = signal<ExternalTokenRow[]>([]);
  protected readonly tokensError = signal<string | null>(null);
  protected readonly newTokenName = signal("");
  protected readonly newTokenScopes = signal("tasks:read,tasks:write");
  protected readonly mintedTokenSecret = signal<string | null>(null);

  protected readonly gcpKeys = signal<GcpKeyRow[]>([]);
  protected readonly gcpKeysError = signal<string | null>(null);
  protected readonly newGcpKeyName = signal("");
  protected readonly newGcpKeyProject = signal("");
  protected readonly newGcpKeySaEmail = signal("");
  protected readonly newGcpKeyCount = signal("");
  protected readonly newGcpKeyMaxAge = signal("");
  protected readonly newGcpKeyMinter = signal("");

  protected readonly auditEvents = signal<AuditEventRow[]>([]);
  protected readonly auditError = signal<string | null>(null);
  protected readonly auditFilterText = signal("");
  protected readonly auditKindFilter = signal("all");
  protected readonly auditTimeFilter = signal("all");

  private initialized = false;

  protected readonly missingRoleSets = computed(() =>
    (this.state.config()?.access?.missing ?? []).filter(Boolean),
  );

  protected readonly tokenScopeCheck = computed(() =>
    validateTokenScopes(this.newTokenScopes()),
  );

  protected readonly tokenScopesError = computed(
    () => this.tokenScopeCheck().error,
  );

  protected readonly canWritePrincipals = computed(
    () =>
      this.access.can("POST /api/access/principals") ||
      this.access.can("PATCH /api/access/principals/{entry}") ||
      this.access.can("DELETE /api/access/principals/{entry}"),
  );

  protected readonly canMintTokens = computed(() =>
    this.access.can("POST /api/external-agents/tokens"),
  );

  protected readonly canViewAudit = computed(
    () =>
      this.access.can("GET /api/deployment/config-audit") ||
      this.access.can("GET /api/deployment/audit-logs") ||
      this.access.can("GET /api/deployment/secret-audit") ||
      this.access.can("GET /api/access/history"),
  );

  protected readonly missingAuditScopes = computed(() => {
    const missing: string[] = [];
    if (!this.access.can("GET /api/deployment/config-audit")) {
      missing.push("settings:read");
    }
    if (
      !this.access.can("GET /api/deployment/audit-logs") &&
      !this.access.can("GET /api/deployment/secret-audit")
    ) {
      missing.push("secrets:read");
    }
    if (!this.access.can("GET /api/access/history")) {
      missing.push("access:read");
    }
    return missing;
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

  private loadForSection(): void {
    if (this.section() === "access") {
      void this.loadAccessData();
    } else if (this.section() === "audit") {
      void this.loadAuditLogs();
    }
  }

  private capture<T>(
    p: Promise<T>,
  ): Promise<{ value: T; error: null } | { value: null; error: unknown }> {
    return p.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
  }

  private async loadAccessData(): Promise<void> {
    if (this.access.can("GET /api/access/principals")) {
      const res = await this.capture(
        this.api.get<
          | PrincipalRow[]
          | {
              entries?: PrincipalRow[];
              principals?: PrincipalRow[];
              items?: PrincipalRow[];
              roles?: AccessRoleChoiceDto[];
            }
        >("GET /api/access/principals"),
      );
      if (res.error) {
        this.principalsError.set(errText(res.error));
      } else {
        this.principalsError.set(null);
        const p = res.value;
        this.principals.set(normalizePrincipals(p));
        if (
          p &&
          !Array.isArray(p) &&
          Array.isArray(p.roles) &&
          p.roles.length > 0
        ) {
          this.roleOptions.set(
            p.roles.map((r) => ({
              value: r.name,
              label: r.description ? `${r.name} — ${r.description}` : r.name,
            })),
          );
        }
      }
    } else {
      this.principals.set([]);
      this.principalsError.set(null);
    }
    if (this.access.can("GET /api/external-agents/tokens")) {
      const res = await this.capture(
        this.api.get<
          | ExternalTokenRow[]
          | { tokens?: ExternalTokenRow[]; items?: ExternalTokenRow[] }
        >("GET /api/external-agents/tokens"),
      );
      if (res.error) {
        this.tokensError.set(errText(res.error));
      } else {
        this.tokensError.set(null);
        this.tokens.set(normalizeExternalTokens(res.value));
      }
    } else {
      this.tokens.set([]);
      this.tokensError.set(null);
    }
    if (this.access.can("GET /api/gcp-keys")) {
      const res = await this.capture(
        this.api.get<GcpKeyRow[] | { keys?: GcpKeyRow[]; items?: GcpKeyRow[] }>(
          "GET /api/gcp-keys",
        ),
      );
      if (res.error) {
        this.gcpKeysError.set(errText(res.error));
      } else {
        this.gcpKeysError.set(null);
        this.gcpKeys.set(normalizeGcpKeys(res.value));
      }
    } else {
      this.gcpKeys.set([]);
      this.gcpKeysError.set(null);
    }
  }

  private recordSectionError(
    target: { set(v: string | null): void },
    err: unknown,
  ): void {
    target.set(errText(err));
    this.state.recordError(err);
  }

  protected async addPrincipal(): Promise<void> {
    const entry = this.newPrincipalEntry().trim();
    if (!entry) return;
    this.principalsError.set(null);
    const reason = this.newPrincipalReason().trim();
    const res = await this.capture(
      this.api.post("POST /api/access/principals", undefined, {
        entry,
        role: this.newPrincipalRole(),
        ...(reason ? { reason } : {}),
      }),
    );
    if (res.error) {
      this.recordSectionError(this.principalsError, res.error);
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
    if (!entry) return;
    this.principalsError.set(null);
    const reason = this.newPrincipalReason().trim();
    if (this.isSelfPrincipal(entry)) {
      this.promptSelfRoleConfirm(entry, role, reason);
      return;
    }
    const res = await this.capture(
      this.api.patch(
        "PATCH /api/access/principals/{entry}",
        { entry },
        { role, ...(reason ? { reason } : {}) },
      ),
    );
    if (!res.error) {
      await this.loadAccessData();
      this.snackbar.show(`Updated ${entry} to ${role}`);
      return;
    }
    if (this.isSelfConfirmRefusal(res.error)) {
      this.promptSelfRoleConfirm(entry, role, reason);
    } else {
      await this.loadAccessData();
      this.recordSectionError(this.principalsError, res.error);
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
        const res = await this.capture(
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
        if (res.error) {
          this.recordSectionError(this.principalsError, res.error);
          return;
        }
        this.snackbar.show(`Updated ${entry} to ${role}`);
      },
    });
  }

  protected async removePrincipal(entry: string): Promise<void> {
    if (!entry) return;
    this.principalsError.set(null);
    const reason = this.newPrincipalReason().trim();
    if (this.isSelfPrincipal(entry)) {
      this.promptSelfRemoveConfirm(entry, reason);
      return;
    }
    const q = reason ? `reason=${encodeURIComponent(reason)}` : undefined;
    const res = await this.capture(
      this.api.delete(
        "DELETE /api/access/principals/{entry}",
        { entry },
        undefined,
        q,
      ),
    );
    if (!res.error) {
      await this.loadAccessData();
      this.snackbar.show(`Removed ${entry}`);
      return;
    }
    if (this.isSelfConfirmRefusal(res.error)) {
      this.promptSelfRemoveConfirm(entry, reason);
    } else {
      this.recordSectionError(this.principalsError, res.error);
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
        const res = await this.capture(
          this.api.delete(
            "DELETE /api/access/principals/{entry}",
            { entry },
            undefined,
            params.join("&"),
          ),
        );
        if (res.error) {
          this.recordSectionError(this.principalsError, res.error);
          return;
        }
        await this.loadAccessData();
        this.snackbar.show(`Removed ${entry}`);
      },
    });
  }

  protected async mintToken(): Promise<void> {
    const name = this.newTokenName().trim();
    if (!name) return;
    const { scopes, error } = validateTokenScopes(this.newTokenScopes());
    if (error) {
      this.tokensError.set(error);
      return;
    }
    this.tokensError.set(null);
    const res = await this.capture(
      this.api.post<{ token?: string }>(
        "POST /api/external-agents/tokens",
        undefined,
        { name, scopes },
      ),
    );
    if (res.error) {
      this.recordSectionError(this.tokensError, res.error);
      return;
    }
    const secret =
      typeof res.value?.token === "string" ? res.value.token.trim() : "";
    if (!secret) {
      await this.loadAccessData();
      this.recordSectionError(
        this.tokensError,
        new Error(
          `Token "${name}" response is missing the issued token secret key; verify permissions or rotate before retrying.`,
        ),
      );
      return;
    }
    this.newTokenName.set("");
    this.mintedTokenSecret.set(secret);
    await this.loadAccessData();
    this.snackbar.show(`Minted token ${name}`);
  }

  protected async rotateToken(id: string): Promise<void> {
    if (!id) return;
    this.tokensError.set(null);
    const res = await this.capture(
      this.api.post<{ token?: string }>(
        "POST /api/external-agents/tokens/{id}/rotate",
        { id },
        {},
      ),
    );
    if (res.error) {
      this.recordSectionError(this.tokensError, res.error);
      return;
    }
    const secret =
      typeof res.value?.token === "string" ? res.value.token.trim() : "";
    if (!secret) {
      await this.loadAccessData();
      this.recordSectionError(
        this.tokensError,
        new Error(
          "Token rotation response is missing the rotated token secret key.",
        ),
      );
      return;
    }
    this.mintedTokenSecret.set(secret);
    await this.loadAccessData();
    this.snackbar.show("Token rotated");
  }

  protected async revokeToken(id: string): Promise<void> {
    if (!id) return;
    this.tokensError.set(null);
    const res = await this.capture(
      this.api.post("POST /api/external-agents/tokens/{id}/revoke", { id }, {}),
    );
    if (res.error) {
      this.recordSectionError(this.tokensError, res.error);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show("Token revoked");
  }

  protected async revokeAllTokens(): Promise<void> {
    this.tokensError.set(null);
    const res = await this.capture(
      this.api.post(
        "POST /api/external-agents/tokens/revoke-all",
        undefined,
        {},
      ),
    );
    if (res.error) {
      this.recordSectionError(this.tokensError, res.error);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show("Revoked all external agent tokens");
  }

  protected async deleteToken(id: string): Promise<void> {
    if (!id) return;
    this.tokensError.set(null);
    const res = await this.capture(
      this.api.delete("DELETE /api/external-agents/tokens/{id}", { id }),
    );
    if (res.error) {
      this.recordSectionError(this.tokensError, res.error);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show("Deleted token");
  }

  protected async saveGcpKey(): Promise<void> {
    const name = this.newGcpKeyName().trim();
    const projectId = this.newGcpKeyProject().trim();
    const serviceAccountEmail = this.newGcpKeySaEmail().trim();
    const validation = validateGcpKeyForm({
      name,
      projectId,
      serviceAccountEmail,
      countRaw: this.newGcpKeyCount(),
      maxKeyAge: this.newGcpKeyMaxAge(),
    });
    if (validation.error) {
      this.gcpKeysError.set(validation.error);
      return;
    }
    this.gcpKeysError.set(null);
    const maxKeyAge = this.newGcpKeyMaxAge().trim();
    const minterCredential = this.newGcpKeyMinter().trim();
    const res = await this.capture(
      this.api.post("POST /api/gcp-keys", undefined, {
        name,
        projectId,
        serviceAccountEmail,
        ...(validation.count > 0
          ? { serviceAccountCount: validation.count }
          : {}),
        ...(maxKeyAge ? { maxKeyAge } : {}),
        ...(minterCredential ? { minterCredential } : {}),
      }),
    );
    if (res.error) {
      this.recordSectionError(this.gcpKeysError, res.error);
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
    if (!name) return;
    this.gcpKeysError.set(null);
    const res = await this.capture(
      this.api.delete("DELETE /api/gcp-keys/{name}", { name }),
    );
    if (res.error) {
      this.recordSectionError(this.gcpKeysError, res.error);
      return;
    }
    await this.loadAccessData();
    this.snackbar.show(`Deleted GCP key ${name}`);
  }

  protected async loadAuditLogs(): Promise<void> {
    if (!this.canViewAudit()) {
      this.auditEvents.set([]);
      this.auditError.set(null);
      return;
    }

    const combined: AuditEventRow[] = [];
    const seenConfigAuditKeys = new Set<string>();
    const streamErrors: string[] = [];

    const unwrapItems = (raw: unknown): unknown[] => {
      if (Array.isArray(raw)) return raw;
      if (!raw || typeof raw !== "object") return [];
      const rec = raw as Record<string, unknown>;
      const list =
        rec["items"] ?? rec["entries"] ?? rec["logs"] ?? rec["history"];
      return Array.isArray(list) ? list : [];
    };

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

    const fetchStream = (
      route:
        | "GET /api/deployment/config-audit"
        | "GET /api/deployment/audit-logs"
        | "GET /api/deployment/secret-audit"
        | "GET /api/access/history",
      source: "config" | "secret" | "access",
      query?: string,
    ): Promise<void> =>
      this.api
        .get(route, undefined, query)
        .then((r) => norm(r, source))
        .catch((err) => {
          streamErrors.push(`${source}: ${errText(err)}`);
        });

    const jobs: Promise<void>[] = [];
    if (this.access.can("GET /api/deployment/config-audit")) {
      jobs.push(
        fetchStream("GET /api/deployment/config-audit", "config", "limit=100"),
      );
    }
    if (this.access.can("GET /api/deployment/audit-logs")) {
      jobs.push(
        fetchStream("GET /api/deployment/audit-logs", "secret", "limit=100"),
      );
    } else if (this.access.can("GET /api/deployment/secret-audit")) {
      jobs.push(fetchStream("GET /api/deployment/secret-audit", "secret"));
    }
    if (this.access.can("GET /api/access/history")) {
      jobs.push(fetchStream("GET /api/access/history", "access"));
    }
    await Promise.all(jobs);
    combined.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    this.auditEvents.set(combined);
    this.auditError.set(
      streamErrors.length > 0 ? streamErrors.join(" | ") : null,
    );
  }
}
