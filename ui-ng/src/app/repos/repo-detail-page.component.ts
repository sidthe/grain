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
  ChangeDetectionStrategy,
  Component,
  Injector,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { Subscription } from "rxjs";
import type { RouteKey } from "../api/generated-routes";
import { GrainApi, splitRepo } from "../api/grain-api.service";
import type { CapabilityOption } from "../api/models";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";
import { grantName, isApiCapability } from "../sessions/session-helpers";
import { errText } from "../settings/settings-state.service";
import {
  ConfirmDialogComponent,
  bypassConfirm,
  type ConfirmRequest,
} from "../shared/confirm-dialog.component";
import { GrantsPickerComponent } from "../shared/grants-picker.component";
import {
  type PillOption,
  PillSelectComponent,
} from "../shared/pill-select.component";
import { StatusIconComponent } from "../shared/status-icon.component";
import { TipDirective } from "../shared/tip.directive";

export type RepoTabId =
  | "overview"
  | "ci"
  | "merge-queue"
  | "agents"
  | "branches"
  | "releases"
  | "declarations";

const REPO_TABS: readonly { id: RepoTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "ci", label: "CI & Workflows" },
  { id: "merge-queue", label: "Merge Queue" },
  { id: "agents", label: "Agents & Grants" },
  { id: "branches", label: "Branches" },
  { id: "releases", label: "Releases" },
  { id: "declarations", label: "Declarations" },
];

function isRepoTabId(val: string | null | undefined): val is RepoTabId {
  const clean = (val ?? "").toLowerCase();
  return REPO_TABS.some((t) => t.id === clean);
}

function normalizeWorkflowPath(raw: string): string {
  const clean = raw.trim().replace(/^\/+/, "");
  if (!clean) return "";
  if (clean.includes("/")) return clean;
  const withExt =
    clean.endsWith(".yml") || clean.endsWith(".yaml") ? clean : `${clean}.yml`;
  return `.grain/workflows/${withExt}`;
}

interface BranchRow {
  name: string;
  sha?: string;
  head?: string;
  protected?: boolean;
}

interface RepoWorkflowRow {
  path: string;
  text: string;
  name?: string;
}

interface ReleaseRow {
  name: string;
  latestBranch?: string;
  prodBranch?: string;
  status?: string;
  pullRequestUrl?: string;
  error?: string;
}

interface CandidateRow {
  id: number | string;
  release?: string;
  number?: number;
  branch?: string;
  status?: string;
  version?: string;
  error?: string;
}

interface RepoReleaseSecretRow {
  name: string;
  present?: boolean;
}

interface PendingReleaseRow {
  version: string;
  summary?: string;
  soakReady?: boolean;
}

interface DeclaredPushRefRow {
  ref?: string;
  pattern?: string;
  force?: boolean;
  delete?: boolean;
}

interface DeclaredPushRow {
  repo?: string;
  path: string;
  commit?: string;
  refs?: DeclaredPushRefRow[];
}

interface RepoDeclarationsStatusRow {
  commit?: string;
  checkedAt?: string;
  syncedAt?: string;
  error?: string;
  templates?: string[];
  suites?: string[];
  schedules?: string[];
  triggers?: string[];
  pushes?: DeclaredPushRow[];
  mergeRules?: string;
  warnings?: string[];
}

interface RepoPortDirectionRow {
  from: string;
  to: string;
  paired?: boolean;
  operatorTypes?: string[];
  declaredTypes?: string[];
  types?: string[];
}

interface RepoDeclarationsData {
  declarations?: boolean;
  declarationsStatus?: RepoDeclarationsStatusRow | null;
  pairedBranches?: string[];
  portBranches?: string[];
  declaredPortBranches?: string[];
  portDirections?: RepoPortDirectionRow[];
  portWarnings?: string[];
}

function declaredSummaryText(status: RepoDeclarationsStatusRow): string {
  return (
    `${(status.templates ?? []).length} template(s), ` +
    `${(status.suites ?? []).length} suite(s), ` +
    `${(status.schedules ?? []).length} schedule(s), ` +
    `${(status.triggers ?? []).length} trigger(s)` +
    (status.mergeRules ? `, merge rules in ${status.mergeRules}` : "")
  );
}

function formatDeclaredPushRef(r: DeclaredPushRefRow): string {
  const name = r.ref ?? r.pattern ?? "";
  const flags = [r.force && "force", r.delete && "delete"].filter(Boolean);
  return flags.length ? `${name} (${flags.join(", ")})` : name;
}

type OwnershipState = "" | "on" | "off";

interface WorkOwnershipDeclarationRow {
  repo?: string;
  path: string;
}

interface RepoWorkItemRow {
  item: string;
  kind: string;
  title?: string;
  override: OwnershipState;
  runs: boolean;
  paused?: boolean;
  declaration?: WorkOwnershipDeclarationRow | null;
}

interface RepoWorkOwnershipData {
  repo?: string;
  default: OwnershipState;
  defaultRuns: boolean;
  items: RepoWorkItemRow[];
}

const OWNERSHIP_STATES: readonly { value: OwnershipState; label: string }[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "", label: "Say nothing" },
];

function normalizeOwnershipState(raw: unknown): OwnershipState {
  const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (clean === "on" || clean === "off") return clean;
  return "";
}

function isValidOwnershipState(raw: unknown): raw is OwnershipState {
  return raw === "" || raw === "on" || raw === "off";
}

function validateWorkItemId(raw: unknown): string | null {
  if (typeof raw !== "string") return "Work item ID must be a string.";
  if (!raw.trim()) return "Work item ID cannot be empty.";
  if (raw !== raw.trim()) {
    return `Work item "${raw}" cannot have leading or trailing spaces.`;
  }
  if (raw.includes(",") || raw.includes("=")) {
    return `Work item "${raw}" cannot contain "," or "=".`;
  }
  return null;
}

function normalizeWorkOwnership(
  res:
    Partial<RepoWorkOwnershipData> | Record<string, unknown> | null | undefined,
): RepoWorkOwnershipData {
  const def = normalizeOwnershipState(res?.["default"]);
  const rawItems = Array.isArray(res?.["items"]) ? res["items"] : [];
  const items: RepoWorkItemRow[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const item = typeof rec["item"] === "string" ? rec["item"] : "";
    if (!item) continue;
    const declRaw = rec["declaration"];
    let declaration: WorkOwnershipDeclarationRow | null = null;
    if (declRaw && typeof declRaw === "object") {
      const d = declRaw as Record<string, unknown>;
      const path = typeof d["path"] === "string" ? d["path"] : "";
      if (path) {
        declaration = {
          ...(typeof d["repo"] === "string" ? { repo: d["repo"] } : {}),
          path,
        };
      }
    }
    items.push({
      item,
      kind: typeof rec["kind"] === "string" ? rec["kind"] : "",
      ...(typeof rec["title"] === "string" && rec["title"]
        ? { title: rec["title"] }
        : {}),
      override: normalizeOwnershipState(rec["override"]),
      runs: Boolean(rec["runs"]),
      paused: Boolean(rec["paused"]),
      declaration,
    });
  }
  return {
    ...(typeof res?.["repo"] === "string" ? { repo: res["repo"] } : {}),
    default: def,
    defaultRuns:
      typeof res?.["defaultRuns"] === "boolean"
        ? res["defaultRuns"]
        : def !== "off",
    items,
  };
}

interface UnfixableChecksData {
  unfixableChecks: string[];
  grainCICheckName: string;
}

function sameCheckName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function validateUnfixableCheckName(
  rawName: string,
  grainCICheckName: string,
): string | null {
  const name = rawName.trim();
  if (!name) return null;
  if (sameCheckName(name, grainCICheckName)) {
    return `${grainCICheckName} judges one exact commit on the branch, so its verdict is always that branch's own answer and declaring it here would change nothing. Grain would go on repairing it.`;
  }
  if (name.includes(",")) {
    return `Check name "${name}" cannot contain "," — these are stored as a comma-separated list; add one check per entry.`;
  }
  return null;
}

function normalizeUnfixableChecks(
  res:
    Partial<UnfixableChecksData> | Record<string, unknown> | null | undefined,
): UnfixableChecksData {
  const rawList = Array.isArray(res?.["unfixableChecks"])
    ? (res["unfixableChecks"] as unknown[])
    : [];
  const seen = new Set<string>();
  const unfixableChecks: string[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unfixableChecks.push(clean);
  }
  const rawCiName = res?.["grainCICheckName"];
  const grainCICheckName =
    typeof rawCiName === "string" && rawCiName.trim()
      ? rawCiName.trim()
      : "grain CI";
  return { unfixableChecks, grainCICheckName };
}

interface CiCapabilitiesData {
  ciCapabilities: string[];
  availableCICapabilities: string[];
}

const KNOWN_CI_CAPABILITY_LABELS: Record<string, string> = {
  "github-sandbox": "GitHub sandbox",
  "https://grain.dev/capabilities/github#sandbox-repo={}": "GitHub sandbox",
  "package-publish": "Package publish",
  "https://grain.dev/capabilities/release#package-publish={}":
    "Package publish",
  "registry-push": "Registry push",
  "https://grain.dev/capabilities/release#registry-push={}": "Registry push",
  "image-signing": "Image signing",
  "https://grain.dev/capabilities/release#image-signing={}": "Image signing",
  "gcp-key": "GCP key",
};

function formatCiCapabilityLabel(id: string): string {
  const known = KNOWN_CI_CAPABILITY_LABELS[id];
  if (known) return known;
  if (id.startsWith("https://")) return grantName(id);
  return id;
}

function normalizeCiCapabilities(
  res: Partial<CiCapabilitiesData> | Record<string, unknown> | null | undefined,
): CiCapabilitiesData {
  const dedupeList = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
      const id =
        typeof entry === "string"
          ? entry.trim()
          : entry &&
              typeof entry === "object" &&
              typeof (entry as { id?: unknown }).id === "string"
            ? ((entry as { id: string }).id ?? "").trim()
            : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  return {
    ciCapabilities: dedupeList(res?.["ciCapabilities"]),
    availableCICapabilities: dedupeList(res?.["availableCICapabilities"]),
  };
}

export type AgentFieldKey = "setup" | "prompt" | "caps";

export interface AgentSettingsValidation {
  valid: boolean;
  setupCommand: string;
  promptExtension: string;
  defaultCapabilities: string[];
  fieldErrors: Partial<Record<AgentFieldKey, string>>;
  orderedErrors: { field: AgentFieldKey; label: string; message: string }[];
}

function hasDisallowedControlChars(
  value: string,
  allowLineBreaks = false,
): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code === 0x7f ||
      (code < 0x20 &&
        (!allowLineBreaks || (code !== 0x09 && code !== 0x0a && code !== 0x0d)))
    ) {
      return true;
    }
  }
  return false;
}

export function parseDefaultCapabilitiesList(raw: string): {
  capabilities: string[];
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (raw.includes(",")) {
      return {
        capabilities: [],
        error:
          "Default capabilities contains an empty entry between commas — clear the field or remove extra commas.",
      };
    }
    return { capabilities: [], error: null };
  }

  const segments: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--;
    } else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      segments.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(raw.slice(start));

  if (inString || braceDepth !== 0 || bracketDepth !== 0) {
    return {
      capabilities: [],
      error: "Default capabilities has unclosed braces, brackets, or quotes.",
    };
  }

  const capabilities: string[] = [];
  for (const seg of segments) {
    const token = seg.trim();
    if (!token) {
      return {
        capabilities: [],
        error:
          "Default capabilities contains an empty entry between commas — remove leading, trailing, or repeated commas.",
      };
    }
    if (hasDisallowedControlChars(token, false)) {
      return {
        capabilities: [],
        error: `Capability "${token}" contains invalid control characters.`,
      };
    }
    const eq = token.indexOf("=");
    const ref = eq >= 0 ? token.slice(0, eq) : token;
    if (ref.startsWith("https://") || eq >= 0) {
      if (/\s/.test(ref) || !ref.includes("#") || ref.endsWith("#")) {
        return {
          capabilities: [],
          error: ref.startsWith("https://")
            ? `Capability reference "${token}" must have the form https://host/path#method.`
            : `Capability "${token}" must have the form <capability>#<method>=<json>.`,
        };
      }
      if (eq >= 0) {
        try {
          const parsed = JSON.parse(token.slice(eq + 1)) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
              capabilities: [],
              error: `Capability "${token}" JSON arguments must be a JSON object.`,
            };
          }
        } catch {
          return {
            capabilities: [],
            error: `Capability "${token}" has invalid JSON arguments.`,
          };
        }
      }
    } else if (/\s/.test(token)) {
      return {
        capabilities: [],
        error: `Capability "${token}" cannot contain spaces — separate capabilities with ",".`,
      };
    }

    const refPart = ref.toLowerCase();
    if (
      refPart === "grain-ci" ||
      refPart === "grain#ci" ||
      refPart === "https://grain.dev/capabilities/grain#ci"
    ) {
      return {
        capabilities: [],
        error: `${token} is managed by the repository's CI mode and cannot be added to default task capabilities.`,
      };
    }
    if (
      refPart === "package-publish" ||
      refPart === "registry-push" ||
      refPart === "image-signing" ||
      refPart === "release-gate-read" ||
      refPart === "release#package-publish" ||
      refPart === "release#registry-push" ||
      refPart === "release#image-signing" ||
      refPart === "https://grain.dev/capabilities/release#package-publish" ||
      refPart === "https://grain.dev/capabilities/release#registry-push" ||
      refPart === "https://grain.dev/capabilities/release#image-signing" ||
      refPart.startsWith("repo-read:") ||
      refPart.startsWith("repo-write:") ||
      refPart === "repo#read" ||
      refPart === "https://grain.dev/capabilities/repo#read" ||
      refPart === "repo#target" ||
      refPart === "https://grain.dev/capabilities/repo#target"
    ) {
      return {
        capabilities: [],
        error: `Capability "${token}" cannot be added to repository default task capabilities.`,
      };
    }
    capabilities.push(token);
  }
  return { capabilities, error: null };
}

export function validateAgentSettingsForm(input: {
  setupCommand: string;
  promptExtension: string;
  repoCaps: string;
  canSetup: boolean;
  canPrompt: boolean;
  canCaps: boolean;
}): AgentSettingsValidation {
  const fieldErrors: Partial<Record<AgentFieldKey, string>> = {};
  const orderedErrors: {
    field: AgentFieldKey;
    label: string;
    message: string;
  }[] = [];

  if (input.canSetup && hasDisallowedControlChars(input.setupCommand, true)) {
    const msg = "Sandbox setup command cannot contain control characters.";
    fieldErrors.setup = msg;
    orderedErrors.push({
      field: "setup",
      label: "Sandbox setup command",
      message: msg,
    });
  }

  if (
    input.canPrompt &&
    hasDisallowedControlChars(input.promptExtension, true)
  ) {
    const msg = "Standing prompt extension cannot contain control characters.";
    fieldErrors.prompt = msg;
    orderedErrors.push({
      field: "prompt",
      label: "Standing prompt extension",
      message: msg,
    });
  }

  let defaultCapabilities: string[] = [];
  if (input.canCaps) {
    const parsed = parseDefaultCapabilitiesList(input.repoCaps);
    if (parsed.error) {
      fieldErrors.caps = parsed.error;
      orderedErrors.push({
        field: "caps",
        label: "Default capabilities",
        message: parsed.error,
      });
    } else {
      defaultCapabilities = parsed.capabilities;
    }
  }

  return {
    valid: orderedErrors.length === 0,
    setupCommand: input.setupCommand.trim(),
    promptExtension: input.promptExtension.trim(),
    defaultCapabilities,
    fieldErrors,
    orderedErrors,
  };
}

@Component({
  selector: "g-repo-detail-page",
  imports: [
    RouterLink,
    PillSelectComponent,
    StatusIconComponent,
    ConfirmDialogComponent,
    GrantsPickerComponent,
    TipDirective,
  ],
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    "../shared/work-surface.css",
    "../shared/pill-select.css",
    "../settings/settings-forms.css",
    "./repo-detail.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="view-panel is-active" aria-labelledby="repo-page-heading">
      <div class="repo-page-scroll">
        <div class="repo-page-inner">
          <div class="repo-top-nav">
            <a
              class="btn-text"
              routerLink="/settings/repositories"
              data-testid="back-to-repos-link"
              >← Repositories</a
            >
            <a
              class="btn-tonal s-btn-sm"
              style="text-decoration: none"
              [routerLink]="['/tasks']"
              [queryParams]="{ repo: repoSlug() }"
              >View tasks in {{ repoSlug() }}</a
            >
          </div>

          <div>
            <h1
              class="view-headline tabular"
              id="repo-page-heading"
              data-testid="repo-detail-heading"
            >
              {{ repoSlug() }}
            </h1>
            <p class="view-subtitle">
              Per-repository Git connection, CI workflows, merge gates, agents,
              branches, releases, and declarations.
            </p>
          </div>

          <nav class="repo-tabs" aria-label="Repository sections">
            @for (t of tabs; track t.id) {
              <button
                type="button"
                class="repo-tab-btn"
                [class.is-active]="activeTab() === t.id"
                [attr.aria-current]="activeTab() === t.id ? 'page' : null"
                [attr.data-testid]="'repo-tab-' + t.id"
                (click)="selectTab(t.id)"
              >
                {{ t.label }}
              </button>
            }
          </nav>

          @if (configRepoOnly()) {
            <div
              id="repo-readonly-banner"
              class="s-banner readonly"
              data-testid="repo-readonly-banner"
            >
              Repository configuration is managed in the config repository;
              operational actions (branches, issue import, and releases) remain
              available according to your role.
            </div>
          }

          @if (error(); as err) {
            <div
              class="s-banner error"
              role="alert"
              data-testid="repo-error-banner"
            >
              <span>{{ err }}</span>
              <button
                type="button"
                class="btn-text s-btn-sm"
                (click)="error.set(null)"
              >
                Dismiss
              </button>
            </div>
          }

          @if (ready()) {
            @switch (activeTab()) {
              @case ("overview") {
                <div class="s-card" data-testid="card-repo-config">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Repository config &amp; Git connection
                      </h2>
                      <p class="s-card-desc">
                        Clone URL override and pinned Git credential.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-repo-config-btn"
                      [disabled]="
                        configRepoOnly() ||
                        !can('PUT /api/deployment/repos/{owner}/{name}/config')
                      "
                      (click)="saveRepoConfig()"
                    >
                      Save config
                    </button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="rc-clone">Clone URL</label>
                      <input
                        id="rc-clone"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-repo-clone-url"
                        placeholder="https://github.com/owner/repo.git"
                        [value]="cloneUrl()"
                        [disabled]="
                          configRepoOnly() ||
                          !can(
                            'PUT /api/deployment/repos/{owner}/{name}/config'
                          )
                        "
                        (input)="cloneUrl.set($any($event.target).value)"
                      />
                    </div>
                    <div class="s-field">
                      <span class="s-label">Git connection</span>
                      <div class="s-inline">
                        <g-pill-select
                          testid="select-repo-git-conn"
                          ariaLabel="Git connection"
                          align="left"
                          [options]="gitConnOptions()"
                          [value]="gitCredential()"
                          [disabled]="
                            configRepoOnly() ||
                            !can(
                              'PUT /api/deployment/repos/{owner}/{name}/git-connection'
                            )
                          "
                          (valueChange)="pinGitConnection($event)"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div class="s-card" data-testid="card-repo-operations">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Issue importer &amp; lifecycle refresh
                      </h2>
                      <p class="s-card-desc">
                        Configure GitHub issue import settings, trigger an
                        immediate import pass, or refresh repository lifecycle
                        state.
                      </p>
                    </div>
                    <div class="s-inline">
                      <span
                        class="status-pill neutral tabular"
                        data-testid="repo-lifecycle-state"
                        >{{ lifecycleState() }}</span
                      >
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="refresh-lifecycle-btn"
                        [disabled]="
                          !can(
                            'POST /api/repos/{owner}/{name}/lifecycle/refresh'
                          )
                        "
                        (click)="refreshLifecycle()"
                      >
                        Refresh lifecycle
                      </button>
                    </div>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Enable issue importer</span>
                      <span class="s-hint"
                        >Periodically import open GitHub issues matching the
                        configured label.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      data-testid="switch-issue-import-enabled"
                      [attr.aria-checked]="importEnabled()"
                      [disabled]="!canWriteSettings()"
                      aria-label="Enable issue importer"
                      (click)="importEnabled.set(!importEnabled())"
                    ></button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="imp-label"
                        >Issue label filter</label
                      >
                      <input
                        id="imp-label"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-import-label"
                        placeholder="grain-ready"
                        [value]="importLabel()"
                        [disabled]="!canWriteSettings()"
                        (input)="importLabel.set($any($event.target).value)"
                      />
                    </div>
                    <div class="s-field">
                      <label class="s-label" for="imp-repo"
                        >Source repository (empty = this repo)</label
                      >
                      <input
                        id="imp-repo"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-import-repo"
                        placeholder="upstream/repo (optional)"
                        [value]="importSourceRepo()"
                        [disabled]="!canWriteSettings()"
                        (input)="
                          importSourceRepo.set($any($event.target).value)
                        "
                      />
                    </div>
                  </div>

                  <div class="s-inline">
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-issue-import-btn"
                      [disabled]="!canWriteSettings()"
                      (click)="saveIssueImportSettings()"
                    >
                      Save issue import
                    </button>
                    <button
                      type="button"
                      class="btn-tonal s-btn-sm"
                      data-testid="import-issues-btn"
                      [disabled]="
                        !can('POST /api/repos/{owner}/{name}/import-issues')
                      "
                      (click)="importIssues()"
                    >
                      Import issues now
                    </button>
                  </div>
                </div>
              }

              @case ("ci") {
                <div class="s-card" data-testid="card-repo-ci">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        CI mode &amp; base-branch runs
                      </h2>
                      <p class="s-card-desc">
                        Choose whether Grain runs .grain/workflows, waits for
                        GitHub checks, or merges without waiting for CI.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-tonal s-btn-sm"
                      data-testid="trigger-base-ci-btn"
                      [disabled]="
                        !can('POST /api/repos/{owner}/{name}/base-branch-runs')
                      "
                      (click)="triggerBaseCiRun()"
                    >
                      Run base-branch CI
                    </button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <span class="s-label">CI mode</span>
                      <g-pill-select
                        testid="select-repo-ci-mode"
                        ariaLabel="Repository CI mode"
                        align="left"
                        [options]="ciModeOptions"
                        [value]="ciMode()"
                        [disabled]="
                          configRepoOnly() ||
                          !can('PUT /api/repos/{owner}/{name}/ci-mode')
                        "
                        (valueChange)="saveCiMode($event)"
                      />
                    </div>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Watch default branch</span>
                      <span class="s-hint"
                        >Automatically file repair tasks when trunk CI turns
                        red.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      [attr.aria-checked]="watchDefaultBranch()"
                      [disabled]="
                        configRepoOnly() ||
                        !can(
                          'PUT /api/repos/{owner}/{name}/watch-default-branch'
                        )
                      "
                      aria-label="Watch default branch"
                      (click)="toggleWatchDefaultBranch()"
                    ></button>
                  </div>

                  <div class="s-field">
                    <div class="s-row">
                      <label class="s-label" for="wf-yaml">
                        Declared workflow ({{ selectedWorkflowPath() }})
                      </label>
                      <div class="s-inline">
                        @if (workflowOptions().length > 0) {
                          <g-pill-select
                            testid="select-repo-workflow"
                            ariaLabel="Select workflow file"
                            align="left"
                            [options]="workflowOptions()"
                            [value]="selectedWorkflowPath()"
                            (valueChange)="selectWorkflow($event)"
                          />
                        }
                        <input
                          class="s-input s-input-inline tabular"
                          type="text"
                          aria-label="New workflow file path"
                          data-testid="input-new-workflow-path"
                          placeholder=".grain/workflows/release.yml"
                          [value]="newWorkflowPath()"
                          [disabled]="
                            configRepoOnly() ||
                            !can('PUT /api/repos/{owner}/{name}/workflows')
                          "
                          (input)="
                            newWorkflowPath.set($any($event.target).value)
                          "
                        />
                        <button
                          type="button"
                          class="btn-tonal s-btn-sm"
                          data-testid="add-repo-workflow-btn"
                          [disabled]="
                            !newWorkflowPath().trim() ||
                            configRepoOnly() ||
                            !can('PUT /api/repos/{owner}/{name}/workflows')
                          "
                          (click)="addWorkflowFile()"
                        >
                          Add file
                        </button>
                      </div>
                    </div>
                    <textarea
                      id="wf-yaml"
                      class="s-textarea tabular"
                      rows="5"
                      data-testid="input-repo-workflow"
                      [value]="workflowYaml()"
                      [disabled]="
                        configRepoOnly() ||
                        !can('PUT /api/repos/{owner}/{name}/workflows')
                      "
                      (input)="onEditWorkflowText($any($event.target).value)"
                    ></textarea>
                    <div class="s-inline">
                      <button
                        type="button"
                        class="btn-primary s-btn-sm"
                        data-testid="save-repo-workflow-btn"
                        [disabled]="
                          configRepoOnly() ||
                          !can('PUT /api/repos/{owner}/{name}/workflows')
                        "
                        (click)="saveWorkflows()"
                      >
                        Save workflows
                      </button>
                      @if (workflows().length > 0) {
                        <button
                          type="button"
                          class="btn-text s-btn-sm"
                          data-testid="delete-repo-workflow-btn"
                          [disabled]="
                            configRepoOnly() ||
                            !can('PUT /api/repos/{owner}/{name}/workflows')
                          "
                          (click)="deleteSelectedWorkflow()"
                        >
                          Remove selected file
                        </button>
                      }
                    </div>
                  </div>
                </div>

                <div
                  class="s-card"
                  data-testid="card-repo-ci-capabilities"
                  [attr.aria-busy]="
                    ciCapsLoading() || ciCapsSaving() ? 'true' : null
                  "
                >
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">CI capabilities</h2>
                      <p class="s-card-desc">
                        Granted to every CI job in {{ repoSlug() }}, starting
                        with the next run. Each job gets its own credentials,
                        which are revoked when it finishes. Task defaults are
                        configured separately.
                      </p>
                    </div>
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/ci-capabilities",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="repo-ci-caps-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/ci-capabilities",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (ciCapsLoadError() && ciCapsData() === null) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="repo-ci-caps-load-error"
                    >
                      <span>{{ ciCapsLoadError() }}</span>
                      <button
                        type="button"
                        class="btn-text s-btn-sm"
                        data-testid="repo-ci-caps-retry"
                        (click)="loadCiCapabilities()"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (ciCapsData() === null) {
                    <p class="repo-note" data-testid="repo-ci-caps-loading">
                      Loading CI capabilities…
                    </p>
                  } @else {
                    @if (
                      !configRepoOnly() &&
                      !access.can(
                        "PUT /api/repos/{owner}/{name}/ci-capabilities",
                        repoSlug()
                      )
                    ) {
                      <div
                        id="repo-ci-caps-readonly"
                        class="s-banner readonly"
                        data-testid="repo-ci-caps-readonly"
                      >
                        {{ ciCapsDeniedReason() }}
                      </div>
                    }

                    @if (ciCapsError(); as ciErr) {
                      <div
                        id="repo-ci-caps-error"
                        class="s-banner error"
                        role="alert"
                        data-testid="repo-ci-caps-error"
                      >
                        <span>{{ ciErr }}</span>
                        <button
                          type="button"
                          class="btn-text s-btn-sm"
                          (click)="ciCapsError.set(null)"
                        >
                          Dismiss
                        </button>
                      </div>
                    }

                    @if (
                      visibleCiCapOptions().length === 0 &&
                      ciCapabilities().length === 0
                    ) {
                      <p class="repo-note" data-testid="repo-ci-caps-empty">
                        None offered -- grant access under Grants
                      </p>
                    }

                    <g-grants-picker
                      testid="repo-ci-grants"
                      toggleAriaLabel="CI capabilities"
                      [offered]="ciCapOptions()"
                      [held]="ciCapabilities()"
                      [repo]="repoSlug()"
                      runKind="ci"
                      [describedBy]="ciCapsDescribedBy()"
                      [gTip]="ciCapsDeniedReason()"
                      [disabled]="!canWriteCiCaps() || ciCapsSaving()"
                      (heldChange)="saveCiCapabilities($event)"
                    />

                    @if (ciCapWarnings().length > 0) {
                      <div
                        class="s-banner warn"
                        data-testid="repo-ci-caps-warnings"
                      >
                        <ul class="repo-error-list">
                          @for (w of ciCapWarnings(); track w) {
                            <li>{{ w }}</li>
                          }
                        </ul>
                      </div>
                    }
                  }
                </div>
              }

              @case ("merge-queue") {
                <div class="s-card" data-testid="card-repo-merge-queue">
                  <h2 class="s-card-title">Merge queue &amp; gate policy</h2>
                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Merge on green</span>
                      <span class="s-hint"
                        >Land approved pull requests automatically once checks
                        succeed.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      data-testid="switch-merge-on-green"
                      [attr.aria-checked]="mergeOnGreen()"
                      [disabled]="
                        configRepoOnly() ||
                        !can('PUT /api/repos/{owner}/{name}/merge-on-green')
                      "
                      aria-label="Merge on green"
                      (click)="toggleMergeOnGreen()"
                    ></button>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name"
                        >Require branch up to date before merge</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      [attr.aria-checked]="requireUpToDate()"
                      [disabled]="
                        configRepoOnly() ||
                        !can(
                          'PUT /api/repos/{owner}/{name}/require-branch-up-to-date'
                        )
                      "
                      aria-label="Require branch up to date"
                      (click)="toggleRequireUpToDate()"
                    ></button>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name"
                        >Base-branch repairs bypass human review gates</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      [attr.aria-checked]="bypassHumanGates()"
                      [disabled]="
                        configRepoOnly() ||
                        !can(
                          'PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates'
                        )
                      "
                      aria-label="Base-branch repairs bypass human review gates"
                      (click)="toggleBypassHumanGates()"
                    ></button>
                  </div>
                </div>

                <div
                  class="s-card unfixable-card"
                  data-testid="card-repo-unfixable-checks"
                  [attr.aria-busy]="
                    unfixableLoading() || unfixableSaving() ? 'true' : null
                  "
                >
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Checks no commit here can clear
                      </h2>
                      <p class="s-card-desc">
                        Checks on {{ repoSlug() }} that will never pass for a
                        pull request grain&#39;s agents author, whatever is
                        pushed to the branch — a CLA bot asserting who signed an
                        agreement is the case this exists for.
                        <strong>This does not exempt them.</strong> A pull
                        request with one of these red is still not merged, and a
                        person clears it or nothing merges; what grain stops
                        spending is the base merge and the repair run it would
                        have made trying to reach a green that is not reachable,
                        saying so on the row and in one comment instead. Not for
                        a job that is merely flaky: a real regression in a check
                        named here still holds the queue, which is exactly why
                        naming one is safe.
                      </p>
                    </div>
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/unfixable-checks",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="repo-unfixable-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/unfixable-checks",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (
                    unfixableLoadError() && unfixableData() === null
                  ) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="repo-unfixable-load-error"
                    >
                      <span>{{ unfixableLoadError() }}</span>
                      <button
                        type="button"
                        class="btn-text s-btn-sm"
                        (click)="loadUnfixableChecks()"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (unfixableData() === null) {
                    <p class="repo-note" data-testid="repo-unfixable-loading">
                      Loading unfixable checks…
                    </p>
                  } @else {
                    @if (
                      !configRepoOnly() &&
                      !access.can(
                        "PUT /api/repos/{owner}/{name}/unfixable-checks",
                        repoSlug()
                      )
                    ) {
                      <div
                        id="repo-unfixable-readonly"
                        class="s-banner readonly"
                        data-testid="repo-unfixable-readonly"
                      >
                        {{ unfixableDeniedReason() }}
                      </div>
                    }

                    @if (unfixableChecks().length === 0) {
                      <p class="repo-note" data-testid="repo-unfixable-empty">
                        grain treats every check {{ repoSlug() }} reports as one
                        a commit could turn green.
                      </p>
                    } @else {
                      <ul
                        class="unfixable-list"
                        aria-label="Checks declared unfixable"
                        data-testid="unfixable-checks-list"
                      >
                        @for (check of unfixableChecks(); track check) {
                          <li
                            class="unfixable-chip"
                            [class.has-remove]="canWriteUnfixableChecks()"
                            [attr.data-testid]="'unfixable-chip-' + check"
                          >
                            <span class="unfixable-chip-label tabular">{{
                              check
                            }}</span>
                            @if (canWriteUnfixableChecks()) {
                              <button
                                type="button"
                                class="unfixable-chip-remove"
                                [attr.aria-label]="
                                  'Stop declaring ' + check + ' unfixable'
                                "
                                [attr.title]="
                                  'Stop declaring ' + check + ' unfixable'
                                "
                                [attr.data-testid]="'remove-unfixable-' + check"
                                [disabled]="unfixableSaving()"
                                (click)="removeUnfixableCheck(check)"
                              >
                                ×
                              </button>
                            }
                          </li>
                        }
                      </ul>
                    }

                    @if (unfixableError(); as uErr) {
                      <div
                        id="unfixable-check-error"
                        class="s-banner error"
                        role="alert"
                        data-testid="repo-unfixable-error"
                      >
                        <span>{{ uErr }}</span>
                        <button
                          type="button"
                          class="btn-text s-btn-sm"
                          (click)="unfixableError.set(null)"
                        >
                          Dismiss
                        </button>
                      </div>
                    }

                    <form
                      class="unfixable-form"
                      (submit)="addUnfixableCheck($event)"
                    >
                      <div class="s-field">
                        <label class="s-label" for="unfixable-check-input">
                          Check that cannot pass
                        </label>
                        <div class="unfixable-form-row">
                          <input
                            id="unfixable-check-input"
                            name="unfixableCheck"
                            class="s-input tabular unfixable-input"
                            type="text"
                            autocomplete="off"
                            placeholder="cla/google"
                            data-testid="input-unfixable-check"
                            [value]="unfixableDraft()"
                            [disabled]="
                              !canWriteUnfixableChecks() || unfixableSaving()
                            "
                            [gTip]="unfixableDeniedReason()"
                            [attr.aria-invalid]="
                              unfixableError() ? 'true' : null
                            "
                            [attr.aria-describedby]="
                              unfixableInputDescribedBy()
                            "
                            (input)="
                              onUnfixableDraftInput($any($event.target).value)
                            "
                          />
                          <button
                            type="submit"
                            class="btn-primary s-btn-sm"
                            data-testid="add-unfixable-check-btn"
                            [disabled]="
                              !canWriteUnfixableChecks() ||
                              unfixableSaving() ||
                              !unfixableDraft().trim()
                            "
                            [gTip]="unfixableDeniedReason()"
                            [attr.aria-describedby]="unfixableDescribedBy()"
                          >
                            Add
                          </button>
                        </div>
                        <span id="unfixable-check-helper" class="s-hint">
                          The check&#39;s exact name, as the pull request
                          reports it — matched without case, never by part of a
                          name. {{ grainCICheckName() }} cannot be named here:
                          it judges this exact commit, so its verdict is always
                          the branch&#39;s own.
                        </span>
                      </div>
                    </form>
                  }
                </div>
              }

              @case ("agents") {
                <div
                  class="s-card"
                  data-testid="card-repo-agents"
                  [attr.aria-busy]="agentsSaving() ? 'true' : null"
                >
                  <h2 class="s-card-title">
                    Repository instructions, setup &amp; capability grants
                  </h2>
                  @if (!configRepoOnly() && !canSaveRepoAgents()) {
                    <div
                      id="repo-agents-readonly"
                      class="s-banner readonly"
                      data-testid="repo-agents-readonly"
                    >
                      {{ saveAgentsDeniedReason() }}
                    </div>
                  }
                  @if (agentsError(); as aErr) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="repo-agents-error"
                    >
                      <div>
                        @if (agentsOrderedErrors().length > 1) {
                          <span>{{ aErr }}</span>
                          <ul class="repo-error-list">
                            @for (item of agentsOrderedErrors(); track item) {
                              <li>{{ item }}</li>
                            }
                          </ul>
                        } @else {
                          <span>{{ aErr }}</span>
                        }
                      </div>
                      <button
                        type="button"
                        class="btn-text s-btn-sm"
                        (click)="clearAgentsErrors()"
                      >
                        Dismiss
                      </button>
                    </div>
                  }
                  <div class="s-field">
                    <label class="s-label" for="rp-setup"
                      >Sandbox setup command</label
                    >
                    <input
                      id="rp-setup"
                      class="s-input tabular"
                      type="text"
                      data-testid="input-repo-setup-cmd"
                      placeholder="npm ci"
                      [value]="setupCommand()"
                      [attr.aria-invalid]="
                        agentsFieldErrors().setup ? 'true' : null
                      "
                      [attr.aria-describedby]="agentsSetupDescribedBy()"
                      [disabled]="
                        agentsSaving() ||
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/setup-command',
                          repoSlug()
                        )
                      "
                      (input)="onAgentSetupInput($any($event.target).value)"
                    />
                    @if (agentsFieldErrors().setup; as setupErr) {
                      <span
                        id="rp-setup-error"
                        class="s-field-error"
                        role="alert"
                        data-testid="error-repo-setup-cmd"
                        >{{ setupErr }}</span
                      >
                    }
                  </div>
                  <div class="s-field">
                    <label class="s-label" for="rp-prompt"
                      >Standing prompt extension</label
                    >
                    <textarea
                      id="rp-prompt"
                      class="s-textarea"
                      rows="4"
                      data-testid="input-repo-prompt-ext"
                      [value]="promptExtension()"
                      [attr.aria-invalid]="
                        agentsFieldErrors().prompt ? 'true' : null
                      "
                      [attr.aria-describedby]="agentsPromptDescribedBy()"
                      [disabled]="
                        agentsSaving() ||
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/prompt-extension',
                          repoSlug()
                        )
                      "
                      (input)="onAgentPromptInput($any($event.target).value)"
                    ></textarea>
                    @if (agentsFieldErrors().prompt; as promptErr) {
                      <span
                        id="rp-prompt-error"
                        class="s-field-error"
                        role="alert"
                        data-testid="error-repo-prompt-ext"
                        >{{ promptErr }}</span
                      >
                    }
                  </div>
                  <div class="s-field">
                    <label class="s-label" for="rp-caps"
                      >Default capabilities (comma-separated)</label
                    >
                    <input
                      id="rp-caps"
                      class="s-input tabular"
                      type="text"
                      data-testid="input-repo-caps"
                      [value]="repoCaps()"
                      [attr.aria-invalid]="
                        agentsFieldErrors().caps ? 'true' : null
                      "
                      [attr.aria-describedby]="agentsCapsDescribedBy()"
                      [disabled]="
                        agentsSaving() ||
                        configRepoOnly() ||
                        !access.can(
                          'PUT /api/repos/{owner}/{name}/capabilities',
                          repoSlug()
                        )
                      "
                      (input)="onAgentCapsInput($any($event.target).value)"
                    />
                    <span id="rp-caps-helper" class="s-hint">
                      Comma-separated task default capability IDs or grant refs
                      (leave empty for none).
                    </span>
                    @if (agentsFieldErrors().caps; as capsErr) {
                      <span
                        id="rp-caps-error"
                        class="s-field-error"
                        role="alert"
                        data-testid="error-repo-caps"
                        >{{ capsErr }}</span
                      >
                    }
                  </div>
                  <div class="s-inline">
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-repo-agents-btn"
                      [disabled]="!canSaveRepoAgents() || agentsSaving()"
                      [attr.aria-describedby]="agentsActionDescribedBy()"
                      [gTip]="saveAgentsDeniedReason()"
                      (click)="saveAgentTabSettings()"
                    >
                      {{ agentsSaving() ? "Saving…" : "Save agent settings" }}
                    </button>
                  </div>
                </div>
              }

              @case ("branches") {
                <div class="s-card" data-testid="card-repo-branches">
                  <h2 class="s-card-title">Repository branches</h2>
                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/branches",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="repo-branches-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/branches",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (branchesError() && !branchesLoaded()) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="repo-branches-error"
                    >
                      <span>{{ branchesError() }}</span>
                      <button
                        type="button"
                        class="btn-text s-btn-sm"
                        (click)="loadBranches()"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (branchesLoading() && !branchesLoaded()) {
                    <p class="repo-note" data-testid="repo-branches-loading">
                      Loading branches…
                    </p>
                  } @else if (branches().length > 0) {
                    @if (branchesError(); as brErr) {
                      <div
                        class="s-banner error"
                        role="alert"
                        data-testid="repo-branches-error"
                      >
                        <span>{{ brErr }}</span>
                        <button
                          type="button"
                          class="btn-text s-btn-sm"
                          (click)="loadBranches()"
                        >
                          Retry
                        </button>
                      </div>
                    }
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Repository branches">
                        <thead>
                          <tr>
                            <th>Branch</th>
                            <th>HEAD</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (b of branches(); track b.name) {
                            <tr [attr.data-testid]="'branch-row-' + b.name">
                              <td class="tabular">{{ b.name }}</td>
                              <td class="tabular">
                                {{ (b.sha || b.head || "—").slice(0, 10) }}
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  } @else {
                    <div
                      class="repo-empty-box"
                      data-testid="repo-branches-empty"
                    >
                      No Grain-managed branches yet
                    </div>
                  }
                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="br-name"
                        >New branch name</label
                      >
                      <input
                        id="br-name"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-new-branch-name"
                        placeholder="release/v1.2"
                        [value]="newBranchName()"
                        [disabled]="
                          !can('POST /api/repos/{owner}/{name}/branches')
                        "
                        (input)="newBranchName.set($any($event.target).value)"
                      />
                    </div>
                    <div class="s-field">
                      <label class="s-label" for="br-from">From ref</label>
                      <input
                        id="br-from"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-new-branch-from"
                        placeholder="main"
                        [value]="newBranchFrom()"
                        [disabled]="
                          !can('POST /api/repos/{owner}/{name}/branches')
                        "
                        (input)="newBranchFrom.set($any($event.target).value)"
                      />
                    </div>
                  </div>
                  <div class="s-inline">
                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="create-branch-btn"
                      [disabled]="
                        !newBranchName().trim() ||
                        !can('POST /api/repos/{owner}/{name}/branches')
                      "
                      (click)="createBranch()"
                    >
                      Create branch
                    </button>
                  </div>
                </div>
              }

              @case ("releases") {
                <div
                  class="s-card"
                  data-testid="card-repo-work-ownership"
                  [attr.aria-busy]="
                    workOwnershipLoading() || workOwnershipSaving()
                      ? 'true'
                      : null
                  "
                >
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">Work ownership</h2>
                      <p class="s-card-desc">
                        Whether this deployment runs {{ repoSlug() }}&#39;s
                        standing work, or leaves it to another deployment
                        watching the same repository.
                      </p>
                    </div>
                    <div class="s-inline">
                      @if (workOwnershipData(); as wo) {
                        <span
                          [class]="
                            'status-pill ' +
                            (wo.defaultRuns ? 'healthy' : 'neutral')
                          "
                          data-testid="repo-work-ownership-state"
                        >
                          <g-status-icon
                            [tone]="wo.defaultRuns ? 'healthy' : 'neutral'"
                            [kind]="wo.defaultRuns ? 'healthy' : 'neutral'"
                          />
                          {{ wo.defaultRuns ? "Running" : "Stopped" }}
                        </span>
                      }
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="refresh-repo-work-ownership-btn"
                        [disabled]="
                          !access.can(
                            'GET /api/repos/{owner}/{name}/work-ownership',
                            repoSlug()
                          )
                        "
                        [gTip]="
                          access.deniedReason(
                            'GET /api/repos/{owner}/{name}/work-ownership',
                            repoSlug()
                          )
                        "
                        (click)="loadWorkOwnership()"
                      >
                        {{ workOwnershipLoading() ? "Refreshing…" : "Refresh" }}
                      </button>
                    </div>
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/work-ownership",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="repo-work-ownership-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/work-ownership",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (
                    workOwnershipError() && workOwnershipData() === null
                  ) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="repo-work-ownership-error"
                    >
                      <span>{{ workOwnershipError() }}</span>
                      <button
                        type="button"
                        class="btn-text s-btn-sm"
                        (click)="loadWorkOwnership()"
                      >
                        Retry
                      </button>
                    </div>
                  } @else if (workOwnershipData() === null) {
                    <p class="s-hint" data-testid="repo-work-ownership-loading">
                      Loading work ownership…
                    </p>
                  } @else {
                    @let wo = workOwnershipData()!;
                    @if (
                      !configRepoOnly() &&
                      !access.can(
                        "PUT /api/repos/{owner}/{name}/work-ownership",
                        repoSlug()
                      )
                    ) {
                      <div
                        id="repo-work-ownership-readonly"
                        class="s-banner readonly"
                        data-testid="repo-work-ownership-readonly"
                      >
                        {{ workOwnershipDeniedReason() }}
                      </div>
                    }

                    @if (workOwnershipError(); as woErr) {
                      <div
                        class="s-banner error"
                        role="alert"
                        data-testid="repo-work-ownership-error"
                      >
                        <span>{{ woErr }}</span>
                        <button
                          type="button"
                          class="btn-text s-btn-sm"
                          (click)="workOwnershipError.set(null)"
                        >
                          Dismiss
                        </button>
                      </div>
                    }

                    <div class="s-toggle-row">
                      <div class="s-toggle-copy">
                        <span
                          class="s-toggle-name"
                          data-testid="repo-work-ownership-switch-label"
                        >
                          Standing work on this deployment:
                          {{ wo.defaultRuns ? "on" : "off" }}
                        </span>
                        <span class="s-hint">
                          Covers: this repository&#39;s schedules (declared, set
                          up here, and workflow crons), its release, the
                          base-branch check, post-merge jobs, automatic ports,
                          and the triage and repair tasks grain files on its
                          own.
                        </span>
                        <span class="s-hint">
                          Does not cover: tasks people file by hand against this
                          repository, their pull requests&#39; CI, the merge
                          queue for them, and the repair of those pull requests
                          — those run either way.
                        </span>
                      </div>
                      <button
                        type="button"
                        class="g-switch"
                        role="switch"
                        data-testid="switch-repo-work-ownership"
                        [attr.aria-checked]="wo.defaultRuns"
                        aria-label="Standing work on this deployment"
                        [attr.aria-describedby]="workOwnershipDescribedBy()"
                        [disabled]="!canWriteWorkOwnership()"
                        [gTip]="workOwnershipDeniedReason()"
                        (click)="toggleStandingWork()"
                      ></button>
                    </div>

                    <p class="wo-explain">
                      Whether <em>this</em> deployment is the one running this
                      repository&#39;s standing work, as against another
                      deployment watching the same repository. The repository
                      declares that the work exists; this says who does it.
                      Saying nothing is its own answer, and a different one from
                      saying no: an item that says nothing follows the default
                      and moves with it, and one that says off stays off when
                      the default is turned back on — and one that says on runs
                      while the default is off.
                    </p>

                    <div
                      id="wo-default-row"
                      class="wo-default-row"
                      data-testid="wo-default-row"
                    >
                      <div class="wo-row-main">
                        <span class="wo-row-label">Repository default:</span>
                        <span
                          [class]="'status-pill ' + saidPillClass(wo.default)"
                          data-testid="wo-default-said"
                        >
                          <g-status-icon
                            [tone]="saidIconTone(wo.default)"
                            [kind]="saidIconKind(wo.default)"
                          />
                          {{ saidLabel(wo.default) }}
                        </span>
                        <span
                          [class]="
                            'status-pill wo-resolved ' +
                            (wo.defaultRuns ? 'healthy' : 'neutral')
                          "
                          data-testid="wo-default-resolved"
                        >
                          <g-status-icon
                            [tone]="wo.defaultRuns ? 'healthy' : 'neutral'"
                            [kind]="wo.defaultRuns ? 'healthy' : 'neutral'"
                          />
                          {{
                            wo.defaultRuns
                              ? "Runs this repository's work"
                              : "Does not run this repository's work"
                          }}
                        </span>
                      </div>
                      <div
                        class="segmented wo-seg"
                        role="group"
                        aria-label="the repository default"
                      >
                        @for (
                          st of ownershipStates;
                          track st.value || "unset"
                        ) {
                          <button
                            type="button"
                            [attr.data-testid]="
                              'wo-default-btn-' + (st.value || 'unset')
                            "
                            [attr.aria-label]="
                              'the repository default: ' +
                              (st.value || 'say nothing')
                            "
                            [attr.aria-pressed]="wo.default === st.value"
                            [attr.aria-describedby]="workOwnershipDescribedBy()"
                            [disabled]="!canWriteWorkOwnership()"
                            [gTip]="workOwnershipDeniedReason()"
                            (click)="saveWorkDefault(st.value)"
                          >
                            {{ st.label }}
                          </button>
                        }
                      </div>
                    </div>

                    @if (wo.items.length === 0) {
                      <p class="s-hint" data-testid="wo-empty-items">
                        No work items: this repository declares no schedules
                        here, none fires into it, and nothing has been said
                        about one.
                      </p>
                    } @else {
                      <div class="wo-items-list" data-testid="wo-items-list">
                        @for (item of wo.items; track item.item) {
                          @let label = item.title || item.item;
                          <div
                            class="wo-item-row"
                            [attr.data-testid]="'wo-item-row-' + item.item"
                          >
                            <div class="wo-item-info">
                              <div class="wo-item-head">
                                <span
                                  [class]="
                                    'status-pill wo-resolved ' +
                                    (item.runs ? 'healthy' : 'neutral')
                                  "
                                  [attr.data-testid]="
                                    'wo-item-resolved-' + item.item
                                  "
                                >
                                  <g-status-icon
                                    [tone]="item.runs ? 'healthy' : 'neutral'"
                                    [kind]="item.runs ? 'healthy' : 'neutral'"
                                  />
                                  {{ item.runs ? "Runs" : "Not run" }}
                                </span>
                                <span class="wo-item-title">{{ label }}</span>
                                <span
                                  [class]="
                                    'status-pill ' +
                                    saidPillClass(item.override)
                                  "
                                  [attr.data-testid]="
                                    'wo-item-said-' + item.item
                                  "
                                >
                                  <g-status-icon
                                    [tone]="saidIconTone(item.override)"
                                    [kind]="saidIconKind(item.override)"
                                  />
                                  {{ saidLabel(item.override) }}
                                </span>
                                @if (item.paused) {
                                  <span
                                    class="status-pill blast"
                                    [attr.data-testid]="
                                      'wo-item-paused-' + item.item
                                    "
                                  >
                                    <g-status-icon
                                      tone="blast"
                                      kind="warning"
                                    />
                                    Paused on its own row
                                  </span>
                                }
                              </div>
                              @if (
                                (item.title && item.title !== item.item) ||
                                item.declaration ||
                                item.kind === "unknown"
                              ) {
                                <div class="wo-item-meta">
                                  @if (item.title && item.title !== item.item) {
                                    <code class="tabular">{{ item.item }}</code>
                                  }
                                  @if (item.declaration) {
                                    <span
                                      >declared in
                                      <code class="tabular">{{
                                        item.declaration.path
                                      }}</code></span
                                    >
                                  }
                                  @if (item.kind === "unknown") {
                                    <span
                                      >nothing here has this id — a decision
                                      left behind by whatever it named</span
                                    >
                                  }
                                </div>
                              }
                            </div>
                            <div
                              class="segmented wo-seg"
                              role="group"
                              [attr.aria-label]="label"
                            >
                              @for (
                                st of ownershipStates;
                                track st.value || "unset"
                              ) {
                                <button
                                  type="button"
                                  [attr.data-testid]="
                                    'wo-item-btn-' +
                                    item.item +
                                    '-' +
                                    (st.value || 'unset')
                                  "
                                  [attr.aria-label]="
                                    label + ': ' + (st.value || 'say nothing')
                                  "
                                  [attr.aria-pressed]="
                                    item.override === st.value
                                  "
                                  [attr.aria-describedby]="
                                    workOwnershipDescribedBy()
                                  "
                                  [disabled]="!canWriteWorkOwnership()"
                                  [gTip]="workOwnershipDeniedReason()"
                                  (click)="saveWorkItem(item.item, st.value)"
                                >
                                  {{ st.label }}
                                </button>
                              }
                            </div>
                          </div>
                        }
                      </div>
                    }

                    <p class="wo-caption">
                      Grain resolves this before every piece of standing work it
                      starts here. A skipped schedule says so on its own status
                      and moves on to its next occurrence, so turning the work
                      back on does not release a backlog of catch-up firings.
                      The deployment&#39;s own configuration repository is
                      checked whatever this says.
                    </p>
                  }
                </div>

                <div class="s-card" data-testid="card-repo-release-settings">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Release workflow &amp; base-branch CI jobs
                      </h2>
                      <p class="s-card-desc">
                        Controls release publishing, base-branch judging jobs,
                        post-merge dispatch jobs, and release secrets.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-primary s-btn-sm"
                      data-testid="save-repo-release-btn"
                      [disabled]="
                        configRepoOnly() ||
                        !can('PUT /api/repos/{owner}/{name}/release')
                      "
                      (click)="saveReleaseSettings()"
                    >
                      Save release settings
                    </button>
                  </div>

                  <div class="s-toggle-row">
                    <div class="s-toggle-copy">
                      <span class="s-toggle-name">Enable release workflow</span>
                      <span class="s-hint"
                        >Run declared release workflows when base branches
                        advance.</span
                      >
                    </div>
                    <button
                      type="button"
                      class="g-switch"
                      role="switch"
                      data-testid="switch-repo-release-enabled"
                      [attr.aria-checked]="releaseEnabled()"
                      [disabled]="
                        configRepoOnly() ||
                        !can('PUT /api/repos/{owner}/{name}/release')
                      "
                      aria-label="Enable release workflow"
                      (click)="releaseEnabled.set(!releaseEnabled())"
                    ></button>
                  </div>

                  <div class="s-grid">
                    <div class="s-field">
                      <label class="s-label" for="rel-base-jobs"
                        >Base-branch CI jobs (comma-separated)</label
                      >
                      <input
                        id="rel-base-jobs"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-release-base-jobs"
                        placeholder="empty = all push jobs"
                        [value]="baseBranchJobsText()"
                        [disabled]="
                          configRepoOnly() ||
                          !can('PUT /api/repos/{owner}/{name}/release')
                        "
                        (input)="
                          baseBranchJobsText.set($any($event.target).value)
                        "
                      />
                    </div>
                    <div class="s-field">
                      <label class="s-label" for="rel-post-jobs"
                        >Post-merge dispatch jobs (comma-separated)</label
                      >
                      <input
                        id="rel-post-jobs"
                        class="s-input tabular"
                        type="text"
                        data-testid="input-release-post-merge-jobs"
                        placeholder="guest-cache (optional)"
                        [value]="postMergeJobsText()"
                        [disabled]="
                          configRepoOnly() ||
                          !can('PUT /api/repos/{owner}/{name}/release')
                        "
                        (input)="
                          postMergeJobsText.set($any($event.target).value)
                        "
                      />
                    </div>
                  </div>

                  @if (releaseSecrets().length > 0) {
                    <div class="s-inline" data-testid="repo-release-secrets">
                      <span class="s-label">Release secrets:</span>
                      @for (sec of releaseSecrets(); track sec.name) {
                        <span
                          [class]="
                            'status-pill tabular ' +
                            (sec.present !== false ? 'healthy' : 'warn')
                          "
                        >
                          {{ sec.name }}:
                          {{ sec.present !== false ? "present" : "missing" }}
                        </span>
                      }
                    </div>
                  }
                </div>

                @if (pendingReleases().length > 0) {
                  <div class="s-card" data-testid="card-pending-releases">
                    <h2 class="s-card-title">
                      Pending trunk releases awaiting approval
                    </h2>
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Pending releases">
                        <thead>
                          <tr>
                            <th>Version</th>
                            <th>Summary</th>
                            <th>Decision</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (pr of pendingReleases(); track pr.version) {
                            <tr
                              [attr.data-testid]="
                                'pending-release-row-' + pr.version
                              "
                            >
                              <td class="tabular">{{ pr.version }}</td>
                              <td>{{ pr.summary || "Staged for release" }}</td>
                              <td>
                                <div class="s-inline">
                                  <button
                                    type="button"
                                    class="btn-primary s-btn-sm"
                                    [attr.data-testid]="
                                      'approve-pending-release-' + pr.version
                                    "
                                    [disabled]="
                                      !can(
                                        'POST /api/repos/{owner}/{name}/pending-releases/{version}/approve'
                                      )
                                    "
                                    (click)="approvePendingRelease(pr.version)"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [attr.data-testid]="
                                      'reject-pending-release-' + pr.version
                                    "
                                    [disabled]="
                                      !can(
                                        'POST /api/repos/{owner}/{name}/pending-releases/{version}/reject'
                                      )
                                    "
                                    (click)="rejectPendingRelease(pr.version)"
                                  >
                                    Reject
                                  </button>
                                </div>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  </div>
                }

                <div class="s-card" data-testid="card-releases-list">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">
                        Release trains &amp; candidate qualification
                      </h2>
                      <p class="s-card-desc">
                        Cut release trains, qualify release candidates, and
                        promote verified builds.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn-tonal s-btn-sm"
                      data-testid="trigger-release-run-btn"
                      [disabled]="
                        !can('POST /api/repos/{owner}/{name}/release-runs')
                      "
                      (click)="triggerReleaseRun()"
                    >
                      Run release workflow
                    </button>
                  </div>

                  @if (releases().length > 0) {
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Releases">
                        <thead>
                          <tr>
                            <th>Release</th>
                            <th>Status</th>
                            <th>Candidates &amp; promotion</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (rel of releases(); track rel.name) {
                            <tr [attr.data-testid]="'release-row-' + rel.name">
                              <td class="tabular">{{ rel.name }}</td>
                              <td>
                                <span
                                  class="status-pill neutral"
                                  [attr.data-testid]="
                                    'release-status-' + rel.name
                                  "
                                  >{{ rel.status || "open" }}</span
                                >
                              </td>
                              <td>
                                <div class="s-inline">
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [attr.data-testid]="
                                      'inspect-rc-' + rel.name
                                    "
                                    [attr.aria-pressed]="
                                      selectedRelease() === rel.name
                                    "
                                    (click)="
                                      selectReleaseForCandidates(rel.name)
                                    "
                                  >
                                    Inspect RCs
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [attr.data-testid]="'cut-rc-' + rel.name"
                                    [disabled]="
                                      !can(
                                        'POST /api/repos/{owner}/{name}/releases/{release}/candidates'
                                      )
                                    "
                                    (click)="cutCandidate(rel.name)"
                                  >
                                    Cut RC
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-primary s-btn-sm"
                                    [attr.data-testid]="
                                      'promote-rc-' + rel.name
                                    "
                                    [disabled]="
                                      !can(
                                        'POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote'
                                      )
                                    "
                                    (click)="promoteCandidate(rel.name)"
                                  >
                                    Promote RC
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-tonal s-btn-sm"
                                    [disabled]="
                                      !can(
                                        'POST /api/repos/{owner}/{name}/releases/{release}/merge'
                                      )
                                    "
                                    (click)="mergeRelease(rel.name)"
                                  >
                                    Merge back
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-text s-btn-sm"
                                    [disabled]="
                                      !can(
                                        'DELETE /api/repos/{owner}/{name}/releases/{release}'
                                      )
                                    "
                                    (click)="deleteRelease(rel.name)"
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

                  @if (releases().length > 1) {
                    <div class="s-inline">
                      <span class="s-label">Inspecting candidates for:</span>
                      <g-pill-select
                        testid="select-inspect-release"
                        ariaLabel="Select release to inspect candidates"
                        align="left"
                        [options]="releaseOptions()"
                        [value]="selectedRelease()"
                        (valueChange)="selectReleaseForCandidates($event)"
                      />
                    </div>
                  }

                  @if (candidates().length > 0) {
                    <div class="s-table-wrap">
                      <table class="s-table" aria-label="Release candidates">
                        <thead>
                          <tr>
                            <th>Candidate</th>
                            <th>Branch</th>
                            <th>Status</th>
                            <th>Qualification</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (c of candidates(); track c.id) {
                            <tr [attr.data-testid]="'candidate-row-' + c.id">
                              <td class="tabular">
                                {{
                                  c.number !== undefined
                                    ? "rc#" + c.number
                                    : c.version || c.id
                                }}
                              </td>
                              <td class="tabular">
                                {{ c.branch || c.version || "—" }}
                              </td>
                              <td>
                                <span class="status-pill neutral">{{
                                  c.status || "active"
                                }}</span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  class="btn-tonal s-btn-sm"
                                  [attr.data-testid]="
                                    'approve-qualification-' + c.id
                                  "
                                  [disabled]="
                                    !can(
                                      'POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve'
                                    )
                                  "
                                  (click)="approveQualification('' + c.id)"
                                >
                                  Approve qualification
                                </button>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }

                  <div class="s-inline">
                    <input
                      class="s-input s-input-inline tabular"
                      type="text"
                      aria-label="New release name"
                      data-testid="input-new-release-name"
                      placeholder="v1.4.0"
                      [value]="newReleaseName()"
                      [disabled]="
                        !can('POST /api/repos/{owner}/{name}/releases')
                      "
                      (input)="newReleaseName.set($any($event.target).value)"
                    />
                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="create-release-btn"
                      [disabled]="
                        !newReleaseName().trim() ||
                        !can('POST /api/repos/{owner}/{name}/releases')
                      "
                      (click)="createRelease()"
                    >
                      Create release
                    </button>
                  </div>
                </div>
              }

              @case ("declarations") {
                <div class="s-card" data-testid="card-repo-declarations">
                  <div class="s-card-head">
                    <div>
                      <h2 class="s-card-title">Repository declarations</h2>
                      <p class="s-card-desc">
                        Read templates, suites, schedules, path triggers, and
                        merge rules declared in <code>.grain/</code> on the
                        default branch.
                      </p>
                    </div>
                    <div class="s-inline">
                      @if (declarationsData() !== null) {
                        <span
                          [class]="
                            'status-pill ' +
                            (declarationsEnabled() ? 'healthy' : 'neutral')
                          "
                          data-testid="repo-declarations-state"
                        >
                          {{ declarationsEnabled() ? "Enabled" : "Disabled" }}
                        </span>
                      }
                      <button
                        type="button"
                        class="btn-tonal s-btn-sm"
                        data-testid="refresh-repo-declarations-btn"
                        [disabled]="
                          !access.can(
                            'GET /api/repos/{owner}/{name}/declarations',
                            repoSlug()
                          ) || declarationsLoading()
                        "
                        [gTip]="
                          access.deniedReason(
                            'GET /api/repos/{owner}/{name}/declarations',
                            repoSlug()
                          )
                        "
                        (click)="loadDeclarations()"
                      >
                        {{ declarationsLoading() ? "Refreshing…" : "Refresh" }}
                      </button>
                    </div>
                  </div>

                  @if (
                    !access.can(
                      "GET /api/repos/{owner}/{name}/declarations",
                      repoSlug()
                    )
                  ) {
                    <div
                      class="s-banner readonly"
                      data-testid="repo-declarations-denied"
                    >
                      {{
                        access.deniedReason(
                          "GET /api/repos/{owner}/{name}/declarations",
                          repoSlug()
                        )
                      }}
                    </div>
                  } @else if (
                    declarationsError() && declarationsData() === null
                  ) {
                    <div
                      class="s-banner error"
                      role="alert"
                      data-testid="repo-declarations-error"
                    >
                      {{ declarationsError() }}
                    </div>
                  } @else if (declarationsData() === null) {
                    <p class="s-hint" data-testid="repo-declarations-loading">
                      Loading declarations…
                    </p>
                  } @else {
                    <div class="s-toggle-row">
                      <div class="s-toggle-copy">
                        <span class="s-toggle-name">
                          Read {{ repoSlug() }}&#39;s own declarations
                        </span>
                        <span class="s-hint">
                          Read the templates, suites, schedules and path
                          triggers {{ repoSlug() }} declares in its own
                          <code>.grain/templates</code>,
                          <code>.grain/suites</code>,
                          <code>.grain/schedules</code> and
                          <code>.grain/triggers</code>. Grain re-reads them
                          within a couple of minutes of every change, and they
                          cannot be edited here — the files are. A declaration
                          files work in {{ repoSlug() }} on a cadence; it can
                          never widen what that work reads, writes, or holds.
                        </span>
                      </div>
                      <button
                        type="button"
                        class="g-switch"
                        role="switch"
                        data-testid="switch-repo-declarations"
                        [attr.aria-checked]="declarationsEnabled()"
                        [attr.aria-label]="declarationsSwitchLabel()"
                        [disabled]="
                          configRepoOnly() ||
                          declarationsSaving() ||
                          !access.can(
                            'PUT /api/repos/{owner}/{name}/declarations',
                            repoSlug()
                          )
                        "
                        [gTip]="
                          configActionDeniedReason(
                            'PUT /api/repos/{owner}/{name}/declarations'
                          )
                        "
                        (click)="toggleDeclarations()"
                      ></button>
                    </div>

                    @if (declarationsError(); as declErr) {
                      <div
                        class="s-banner error"
                        role="alert"
                        data-testid="repo-declarations-error"
                      >
                        {{ declErr }}
                      </div>
                    }

                    @if (declarationsStatus(); as status) {
                      @if (
                        status.commit || status.checkedAt || status.syncedAt
                      ) {
                        <div class="decl-meta-row">
                          @if (status.commit) {
                            <span
                              >Commit:
                              <code class="tabular">{{
                                status.commit.slice(0, 12)
                              }}</code></span
                            >
                          }
                          @if (status.checkedAt) {
                            <span class="tabular"
                              >Checked: {{ status.checkedAt }}</span
                            >
                          }
                          @if (status.syncedAt) {
                            <span class="tabular"
                              >Synced: {{ status.syncedAt }}</span
                            >
                          }
                        </div>
                      }

                      @if (status.error) {
                        <div
                          class="s-banner error decl-preline"
                          role="alert"
                          data-testid="repo-declarations-sync-error"
                        >
                          Last read failed: {{ status.error
                          }}{{
                            status.commit
                              ? " — still running what " +
                                status.commit.slice(0, 12) +
                                " declared."
                              : ""
                          }}
                        </div>
                        @if (status.commit) {
                          <p
                            class="decl-still-running"
                            data-testid="repo-declarations-still-running"
                          >
                            Still running from
                            {{ status.commit.slice(0, 12) }}:
                            {{ declaredSummary() }}
                          </p>
                        }
                      } @else {
                        <p
                          class="decl-summary"
                          data-testid="repo-declarations-summary"
                        >
                          Read at
                          {{
                            (status.commit || "").slice(0, 12) || "no commit"
                          }}: {{ declaredSummary() }}
                        </p>
                      }

                      @if (hasDiscoveredDeclFiles()) {
                        <ul
                          class="decl-files-list"
                          data-testid="repo-declarations-files"
                        >
                          @for (p of status.templates ?? []; track p) {
                            <li class="decl-file-row">
                              <code class="tabular">{{ p }}</code>
                              <span class="decl-kind-tag">template</span>
                            </li>
                          }
                          @for (p of status.suites ?? []; track p) {
                            <li class="decl-file-row">
                              <code class="tabular">{{ p }}</code>
                              <span class="decl-kind-tag">suite</span>
                            </li>
                          }
                          @for (p of status.schedules ?? []; track p) {
                            <li class="decl-file-row">
                              <code class="tabular">{{ p }}</code>
                              <span class="decl-kind-tag">schedule</span>
                            </li>
                          }
                          @for (p of status.triggers ?? []; track p) {
                            <li class="decl-file-row">
                              <code class="tabular">{{ p }}</code>
                              <span class="decl-kind-tag">trigger</span>
                            </li>
                          }
                          @if (status.mergeRules) {
                            <li class="decl-file-row">
                              <code class="tabular">{{
                                status.mergeRules
                              }}</code>
                              <span class="decl-kind-tag">merge-rules</span>
                            </li>
                          }
                        </ul>
                      }

                      @for (p of status.pushes ?? []; track p.path) {
                        <p
                          class="decl-push-row"
                          data-testid="repo-declarations-push"
                        >
                          Tasks from <code>{{ p.path }}</code> may also push:
                          {{ formatPushRefs(p.refs) }}
                        </p>
                      }

                      @for (w of status.warnings ?? []; track w) {
                        <div
                          class="s-banner warn"
                          data-testid="repo-declarations-warning"
                        >
                          Warning: {{ w }}
                        </div>
                      }
                    } @else if (declarationsEnabled()) {
                      <p class="s-hint" data-testid="repo-declarations-pending">
                        Not read yet — grain picks this up on its next cycle.
                      </p>
                    } @else {
                      <p class="s-hint" data-testid="repo-declarations-off">
                        Declarations sync is off for {{ repoSlug() }}.
                      </p>
                    }
                  }
                </div>

                @if (hasPortsInfo()) {
                  <div class="s-card" data-testid="card-repo-ports">
                    <div>
                      <h2 class="s-card-title">Ports</h2>
                      <p class="s-card-desc">
                        {{
                          (declarationsData()?.pairedBranches?.length ?? 0) > 0
                            ? "Grain ports each merge between " +
                              (declarationsData()?.pairedBranches ?? []).join(
                                ", "
                              )
                            : "No branches are paired"
                        }}
                        — operator:
                        {{
                          (declarationsData()?.portBranches ?? []).join(", ") ||
                            "none"
                        }}; declared in .grain/settings.yml:
                        {{
                          (declarationsData()?.declaredPortBranches ?? []).join(
                            ", "
                          ) || "none"
                        }}. Set by the operator in grain/config and by
                        {{ repoSlug() }}&#39;s own port-types; not editable
                        here.
                      </p>
                    </div>
                    @if (
                      (declarationsData()?.portDirections?.length ?? 0) > 0
                    ) {
                      <div class="s-table-wrap">
                        <table class="s-table" aria-label="Port directions">
                          <thead>
                            <tr>
                              <th>Direction</th>
                              <th>Operator</th>
                              <th>Declared</th>
                              <th>Ports</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (
                              d of declarationsData()?.portDirections ?? [];
                              track d.from + "->" + d.to
                            ) {
                              <tr>
                                <td>
                                  <code class="tabular"
                                    >{{ d.from }}-&gt;{{ d.to }}</code
                                  >
                                </td>
                                <td>
                                  {{
                                    (d.operatorTypes ?? []).join(", ") || "—"
                                  }}
                                </td>
                                <td>
                                  {{
                                    (d.declaredTypes ?? []).join(", ") || "—"
                                  }}
                                </td>
                                <td>
                                  {{
                                    !d.paired
                                      ? "nothing (not a paired branch)"
                                      : (d.types?.length ?? 0) > 0
                                        ? (d.types ?? []).join(", ")
                                        : "every merge"
                                  }}
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    }
                    @for (w of declaredPortWarnings(); track w) {
                      <div
                        class="s-banner warn"
                        data-testid="repo-port-warning"
                      >
                        Warning: {{ w }}
                      </div>
                    }
                  </div>
                }
              }
            }
          }
        </div>
      </div>
      @if (confirmReq(); as req) {
        <g-confirm-dialog [request]="req" (done)="onConfirmDone($event)" />
      }
    </section>
  `,
})
export class RepoDetailPageComponent implements OnInit, OnDestroy {
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly api = inject(GrainApi);
  protected readonly access = inject(AccessService);
  private readonly snackbar = inject(SnackbarService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly host = input<string | undefined>(undefined);
  readonly owner = input<string | undefined>(undefined);
  readonly name = input<string | undefined>(undefined);
  readonly tab = input<string | undefined>(undefined);

  protected readonly tabs = REPO_TABS;
  // The three modes PUT .../ci-mode accepts (model.CIMode: grain,
  // github, none). The page used to offer "both" and "off", which the
  // server refuses with a 400, and had no option for "none", so a repo
  // on no CI read as the first option, Grain CI (2026-11-13 repository
  // walkthrough).
  protected readonly ciModeOptions: readonly PillOption[] = [
    { value: "grain", label: "Grain CI (.grain/workflows)" },
    { value: "github", label: "GitHub Actions checks" },
    { value: "none", label: "No CI (merge without waiting)" },
  ];

  private readonly routeHost = signal("");
  private readonly routeOwner = signal("");
  private readonly routeName = signal("");
  private readonly routeTab = signal<string | null>(null);

  protected readonly ready = signal(false);
  protected readonly configRepoOnly = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly baseBranch = signal("main");
  protected readonly cloneUrl = signal("");
  protected readonly gitCredential = signal("");
  protected readonly availableGitCreds = signal<string[]>([]);
  protected readonly lifecycleState = signal("active");
  protected readonly importEnabled = signal(false);
  protected readonly importLabel = signal("");
  protected readonly importSourceRepo = signal("");
  protected readonly importApproved = signal(false);

  protected readonly ciMode = signal("grain");
  protected readonly watchDefaultBranch = signal(false);
  protected readonly workflows = signal<RepoWorkflowRow[]>([]);
  protected readonly selectedWorkflowPath = signal(".grain/workflows/ci.yml");
  protected readonly workflowYaml = signal("");
  protected readonly newWorkflowPath = signal("");

  protected readonly configCiCatalog = signal<CapabilityOption[]>([]);
  protected readonly configTaskCatalog = signal<CapabilityOption[]>([]);
  protected readonly ciCapsData = signal<CiCapabilitiesData | null>(null);
  protected readonly ciCapsLoading = signal(false);
  protected readonly ciCapsSaving = signal(false);
  protected readonly ciCapsLoadError = signal<string | null>(null);
  protected readonly ciCapsError = signal<string | null>(null);
  private ciCapsLoadSeq = 0;
  private ciCapsMutationSeq = 0;

  protected readonly ciCapabilities = computed(
    () => this.ciCapsData()?.ciCapabilities ?? [],
  );
  protected readonly availableCICapabilities = computed(
    () => this.ciCapsData()?.availableCICapabilities ?? [],
  );
  protected readonly ciCatalog = computed(() =>
    this.configCiCatalog().length > 0
      ? this.configCiCatalog()
      : this.configTaskCatalog(),
  );
  protected readonly ciCapOptions = computed<CapabilityOption[]>(() => {
    const avail = this.availableCICapabilities();
    const held = this.ciCapabilities();
    const catalog = this.ciCatalog();
    const byId = new Map<string, CapabilityOption>(
      catalog.map((c) => [c.id, c]),
    );
    const out: CapabilityOption[] = [];
    const seen = new Set<string>();
    for (const id of avail) {
      if (seen.has(id)) continue;
      seen.add(id);
      const match = byId.get(id);
      out.push(
        match ?? {
          id,
          name: formatCiCapabilityLabel(id),
          ready: true,
        },
      );
    }
    for (const id of held) {
      if (seen.has(id) || id.startsWith("https://")) continue;
      seen.add(id);
      const match = byId.get(id);
      out.push(
        match ?? {
          id,
          name: id,
          description: "No longer offered -- untick to remove it",
          ready: true,
        },
      );
    }
    return out;
  });
  protected readonly visibleCiCapOptions = computed<CapabilityOption[]>(() => {
    const held = new Set(this.ciCapabilities());
    return this.ciCapOptions().filter(
      (c) => (c.ready !== false || held.has(c.id)) && !isApiCapability(c.id),
    );
  });
  protected readonly ciCapWarnings = computed<string[]>(() => {
    const held = new Set(this.ciCapabilities());
    if (held.size === 0) return [];
    const out: string[] = [];
    for (const opt of this.ciCapOptions()) {
      if (!held.has(opt.id)) continue;
      if (opt.ready === false) {
        const needs = Array.isArray(opt.needs)
          ? opt.needs
          : opt.needs
            ? [opt.needs]
            : [];
        const gap = needs.length
          ? ` — needs ${needs.join(", ")}`
          : " on this deployment";
        out.push(
          `${opt.name || opt.id}: Not ready${gap}. A CI job holding this cannot start until configured in Settings → Capabilities.`,
        );
      } else if (
        opt.description === "No longer offered -- untick to remove it"
      ) {
        out.push(
          `${opt.name || opt.id}: No longer offered — untick to remove.`,
        );
      }
    }
    return out;
  });
  protected readonly canWriteCiCaps = computed(() => {
    const repo = this.repoSlug();
    return (
      !this.configRepoOnly() &&
      !!repo &&
      this.access.can("PUT /api/repos/{owner}/{name}/ci-capabilities", repo)
    );
  });
  protected readonly ciCapsDeniedReason = computed(() =>
    this.configActionDeniedReason(
      "PUT /api/repos/{owner}/{name}/ci-capabilities",
    ),
  );
  protected readonly ciCapsDescribedBy = computed(() => {
    if (!this.ciCapsDeniedReason()) return null;
    return this.configRepoOnly()
      ? "repo-readonly-banner"
      : "repo-ci-caps-readonly";
  });

  protected readonly mergeOnGreen = signal(false);
  protected readonly requireUpToDate = signal(false);
  protected readonly bypassHumanGates = signal(false);
  protected readonly confirmReq = signal<ConfirmRequest | null>(null);

  protected readonly unfixableData = signal<UnfixableChecksData | null>(null);
  protected readonly unfixableLoading = signal(false);
  protected readonly unfixableSaving = signal(false);
  protected readonly unfixableLoadError = signal<string | null>(null);
  protected readonly unfixableError = signal<string | null>(null);
  protected readonly unfixableDraft = signal("");
  private unfixableLoadSeq = 0;
  private unfixableMutationSeq = 0;

  protected readonly unfixableChecks = computed(
    () => this.unfixableData()?.unfixableChecks ?? [],
  );
  protected readonly grainCICheckName = computed(
    () => this.unfixableData()?.grainCICheckName ?? "grain CI",
  );
  protected readonly canWriteUnfixableChecks = computed(() => {
    const repo = this.repoSlug();
    return (
      !this.configRepoOnly() &&
      !!repo &&
      this.access.can("PUT /api/repos/{owner}/{name}/unfixable-checks", repo)
    );
  });
  protected readonly unfixableDeniedReason = computed(() =>
    this.configActionDeniedReason(
      "PUT /api/repos/{owner}/{name}/unfixable-checks",
    ),
  );
  protected readonly unfixableDescribedBy = computed(() => {
    if (!this.unfixableDeniedReason()) return null;
    return this.configRepoOnly()
      ? "repo-readonly-banner"
      : "repo-unfixable-readonly";
  });
  protected readonly unfixableInputDescribedBy = computed(() => {
    const ids = [
      this.unfixableDescribedBy(),
      this.unfixableError() ? "unfixable-check-error" : null,
      "unfixable-check-helper",
    ].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : null;
  });

  protected readonly setupCommand = signal("");
  protected readonly promptExtension = signal("");
  protected readonly repoCaps = signal("");
  protected readonly agentsSaving = signal(false);
  protected readonly agentsError = signal<string | null>(null);
  protected readonly agentsOrderedErrors = signal<string[]>([]);
  protected readonly agentsFieldErrors = signal<
    Partial<Record<AgentFieldKey, string>>
  >({});

  protected readonly agentsActionDescribedBy = computed(() => {
    if (this.configRepoOnly()) return "repo-readonly-banner";
    if (!this.canSaveRepoAgents()) return "repo-agents-readonly";
    return null;
  });
  protected readonly agentsSetupDescribedBy = computed(() => {
    const repo = this.repoSlug();
    const denied =
      this.configRepoOnly() ||
      (!!repo &&
        !this.access.can("PUT /api/repos/{owner}/{name}/setup-command", repo));
    const ids = [
      denied ? this.agentsActionDescribedBy() : null,
      this.agentsFieldErrors().setup ? "rp-setup-error" : null,
    ].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : null;
  });
  protected readonly agentsPromptDescribedBy = computed(() => {
    const repo = this.repoSlug();
    const denied =
      this.configRepoOnly() ||
      (!!repo &&
        !this.access.can(
          "PUT /api/repos/{owner}/{name}/prompt-extension",
          repo,
        ));
    const ids = [
      denied ? this.agentsActionDescribedBy() : null,
      this.agentsFieldErrors().prompt ? "rp-prompt-error" : null,
    ].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : null;
  });
  protected readonly agentsCapsDescribedBy = computed(() => {
    const repo = this.repoSlug();
    const denied =
      this.configRepoOnly() ||
      (!!repo &&
        !this.access.can("PUT /api/repos/{owner}/{name}/capabilities", repo));
    const ids = [
      denied ? this.agentsActionDescribedBy() : null,
      this.agentsFieldErrors().caps ? "rp-caps-error" : null,
      "rp-caps-helper",
    ].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : null;
  });

  protected readonly branches = signal<BranchRow[]>([]);
  protected readonly branchesLoading = signal(false);
  protected readonly branchesLoaded = signal(false);
  protected readonly branchesError = signal<string | null>(null);
  private branchesLoadSeq = 0;
  protected readonly newBranchName = signal("");
  protected readonly newBranchFrom = signal("main");

  protected readonly releaseEnabled = signal(false);
  protected readonly baseBranchJobsText = signal("");
  protected readonly postMergeJobsText = signal("");
  protected readonly releaseSecrets = signal<RepoReleaseSecretRow[]>([]);
  protected readonly releases = signal<ReleaseRow[]>([]);
  protected readonly selectedRelease = signal("");
  protected readonly candidates = signal<CandidateRow[]>([]);
  protected readonly pendingReleases = signal<PendingReleaseRow[]>([]);
  protected readonly newReleaseName = signal("");

  protected readonly declarationsData = signal<RepoDeclarationsData | null>(
    null,
  );
  protected readonly declarationsLoading = signal(false);
  protected readonly declarationsSaving = signal(false);
  protected readonly declarationsError = signal<string | null>(null);

  protected readonly ownershipStates = OWNERSHIP_STATES;
  protected readonly workOwnershipData = signal<RepoWorkOwnershipData | null>(
    null,
  );
  protected readonly workOwnershipLoading = signal(false);
  protected readonly workOwnershipSaving = signal(false);
  protected readonly workOwnershipError = signal<string | null>(null);
  private workOwnershipLoadSeq = 0;
  private workOwnershipMutationSeq = 0;

  protected readonly canWriteWorkOwnership = computed(() => {
    const repo = this.repoSlug();
    return (
      !this.configRepoOnly() &&
      !!repo &&
      this.access.can("PUT /api/repos/{owner}/{name}/work-ownership", repo)
    );
  });
  protected readonly workOwnershipDeniedReason = computed(() =>
    this.configActionDeniedReason(
      "PUT /api/repos/{owner}/{name}/work-ownership",
    ),
  );
  protected readonly workOwnershipDescribedBy = computed(() => {
    if (!this.workOwnershipDeniedReason()) return null;
    return this.configRepoOnly()
      ? "repo-readonly-banner"
      : "repo-work-ownership-readonly";
  });

  protected readonly declarationsEnabled = computed(() =>
    Boolean(this.declarationsData()?.declarations),
  );
  protected readonly declarationsStatus = computed(
    () => this.declarationsData()?.declarationsStatus ?? null,
  );
  protected readonly declaredSummary = computed(() => {
    const status = this.declarationsStatus();
    return status ? declaredSummaryText(status) : "";
  });
  protected readonly declaredPortWarnings = computed(() => {
    const d = this.declarationsData();
    const statusWarnings = new Set(d?.declarationsStatus?.warnings ?? []);
    return (d?.portWarnings ?? []).filter((w) => !statusWarnings.has(w));
  });
  protected readonly hasPortsInfo = computed(() => {
    const d = this.declarationsData();
    return Boolean(
      (d?.pairedBranches?.length ?? 0) > 0 ||
      (d?.portDirections?.length ?? 0) > 0,
    );
  });
  protected readonly hasDiscoveredDeclFiles = computed(() => {
    const s = this.declarationsStatus();
    return Boolean(
      s?.templates?.length ||
      s?.suites?.length ||
      s?.schedules?.length ||
      s?.triggers?.length ||
      s?.mergeRules,
    );
  });

  private subs: Subscription[] = [];

  private readonly normalizedRouteParts = computed(() => {
    const rawHost = this.routeHost() || this.host() || "";
    const rawOwner = this.routeOwner() || this.owner() || "";
    const rawName = this.routeName() || this.name() || "";
    const rawTab = this.routeTab() ?? this.tab() ?? null;

    // Handle plain-path collisions when a 3-segment URL matches either
    // repos/:owner/:name/:tab or repos/:host/:owner/:name:
    if (!rawHost && /[.:]/.test(rawOwner) && rawTab && !isRepoTabId(rawTab)) {
      return {
        host: rawOwner,
        owner: rawName,
        name: rawTab,
        tab: null as string | null,
      };
    }
    if (rawHost && !/[.:]/.test(rawHost) && !rawTab && isRepoTabId(rawName)) {
      return {
        host: "",
        owner: rawHost,
        name: rawOwner,
        tab: rawName,
      };
    }
    return {
      host: rawHost,
      owner: rawOwner,
      name: rawName,
      tab: rawTab,
    };
  });

  protected readonly resolvedHost = computed(
    () => this.normalizedRouteParts().host,
  );
  protected readonly resolvedOwner = computed(
    () => this.normalizedRouteParts().owner,
  );
  protected readonly resolvedName = computed(
    () => this.normalizedRouteParts().name,
  );
  protected readonly repoSlug = computed(() => {
    const h = this.resolvedHost();
    const o = this.resolvedOwner();
    const n = this.resolvedName();
    if (!o || !n) return "";
    return h ? `${h}/${o}/${n}` : `${o}/${n}`;
  });

  protected readonly activeTab = computed<RepoTabId>(() => {
    const raw = (this.normalizedRouteParts().tab ?? "overview").toLowerCase();
    if (raw === "advanced") return "declarations";
    return isRepoTabId(raw) ? raw : "overview";
  });

  protected gitConnOptions(): PillOption[] {
    const creds = this.availableGitCreds();
    return [
      { value: "", label: "Deployment default" },
      ...creds.map((c) => ({ value: c, label: c })),
    ];
  }

  protected workflowOptions(): PillOption[] {
    return this.workflows().map((w) => ({
      value: w.path,
      label: w.name ? `${w.path} (${w.name})` : w.path,
    }));
  }

  protected releaseOptions(): PillOption[] {
    return this.releases().map((r) => ({ value: r.name, label: r.name }));
  }

  protected formatPushRefs(refs?: DeclaredPushRefRow[]): string {
    return (refs ?? []).map(formatDeclaredPushRef).filter(Boolean).join(", ");
  }

  protected declarationsSwitchLabel(): string {
    return `Read ${this.repoSlug()}'s own declarations`;
  }

  protected canWriteSettings(): boolean {
    const repo = this.repoSlug();
    if (this.configRepoOnly() || !repo) return false;
    return this.access.can("PUT /api/repos/{owner}/{name}/settings", repo);
  }

  protected canSaveRepoAgents(): boolean {
    const repo = this.repoSlug();
    if (this.configRepoOnly() || !repo) return false;
    return (
      this.access.can("PUT /api/repos/{owner}/{name}/setup-command", repo) ||
      this.access.can("PUT /api/repos/{owner}/{name}/prompt-extension", repo) ||
      this.access.can("PUT /api/repos/{owner}/{name}/capabilities", repo)
    );
  }

  protected configActionDeniedReason(route: RouteKey): string {
    if (this.configRepoOnly()) {
      return "Repository configuration is managed in the config repository.";
    }
    const repo = this.repoSlug();
    if (!repo) return "";
    return this.access.deniedReason(route, repo);
  }

  protected saveAgentsDeniedReason(): string {
    if (this.configRepoOnly()) {
      return "Repository configuration is managed in the config repository.";
    }
    if (this.canSaveRepoAgents()) return "";
    const repo = this.repoSlug();
    if (!repo) return "";
    return this.access.deniedReason(
      "PUT /api/repos/{owner}/{name}/setup-command",
      repo,
    );
  }

  ngOnInit(): void {
    this.subs.push(
      this.route.paramMap.subscribe((pm) => {
        const prevRepo = this.repoSlug();
        this.routeHost.set(pm.get("host") ?? "");
        this.routeOwner.set(pm.get("owner") ?? "");
        this.routeName.set(pm.get("name") ?? "");
        this.routeTab.set(pm.get("tab"));
        if (this.ready()) {
          if (this.repoSlug() !== prevRepo) {
            void this.reloadForRepoChange();
          } else {
            void this.loadTabData();
          }
        }
      }),
    );
    void this.initPage();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  protected can(route: RouteKey): boolean {
    const repo = this.repoSlug();
    if (!repo) return false;
    return this.access.can(route, repo);
  }

  private guardMutation(route: RouteKey, configSetting = false): boolean {
    const repo = this.repoSlug();
    if (!repo) return false;
    if (configSetting && this.configRepoOnly()) return false;
    return this.access.can(route, repo);
  }

  protected selectTab(tab: RepoTabId): void {
    this.routeTab.set(tab);
    const h = this.resolvedHost();
    const o = this.resolvedOwner();
    const n = this.resolvedName();
    const base = h ? ["/repos", h, o, n] : ["/repos", o, n];
    if (tab === "overview") {
      void this.router.navigate(base);
    } else {
      void this.router.navigate([...base, tab]);
    }
    void this.loadTabData(tab);
  }

  private params(): { owner: string; name: string } {
    return splitRepo(this.repoSlug());
  }

  private async initPage(): Promise<void> {
    try {
      const cfg = await this.api.config();
      if (cfg) {
        this.access.setConfig(cfg);
        this.configCiCatalog.set(
          Array.isArray(cfg.ciCapabilities) ? cfg.ciCapabilities : [],
        );
        this.configTaskCatalog.set(
          Array.isArray(cfg.capabilities) ? cfg.capabilities : [],
        );
        const rec = cfg as Record<string, unknown>;
        this.configRepoOnly.set(
          Boolean(
            rec["configRepoOnly"] ||
            rec["externalConfigRepo"] ||
            rec["settingsLocked"],
          ),
        );
      }
      await this.loadCoreRepo();
      await this.loadTabData();
      this.ready.set(true);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  private async reloadForRepoChange(): Promise<void> {
    this.error.set(null);
    this.cloneUrl.set("");
    this.gitCredential.set("");
    this.lifecycleState.set("active");
    this.importEnabled.set(false);
    this.importLabel.set("");
    this.importSourceRepo.set("");
    this.importApproved.set(false);
    this.ciMode.set("grain");
    this.watchDefaultBranch.set(false);
    this.workflows.set([]);
    this.selectedWorkflowPath.set(".grain/workflows/ci.yml");
    this.workflowYaml.set("");
    this.newWorkflowPath.set("");
    this.ciCapsLoadSeq++;
    this.ciCapsMutationSeq++;
    this.ciCapsData.set(null);
    this.ciCapsLoading.set(false);
    this.ciCapsSaving.set(false);
    this.ciCapsLoadError.set(null);
    this.ciCapsError.set(null);
    this.mergeOnGreen.set(false);
    this.requireUpToDate.set(false);
    this.bypassHumanGates.set(false);
    this.confirmReq.set(null);
    this.unfixableLoadSeq++;
    this.unfixableMutationSeq++;
    this.unfixableData.set(null);
    this.unfixableLoading.set(false);
    this.unfixableSaving.set(false);
    this.unfixableLoadError.set(null);
    this.unfixableError.set(null);
    this.unfixableDraft.set("");
    this.setupCommand.set("");
    this.promptExtension.set("");
    this.repoCaps.set("");
    this.agentsSaving.set(false);
    this.agentsError.set(null);
    this.agentsOrderedErrors.set([]);
    this.agentsFieldErrors.set({});
    this.branchesLoadSeq++;
    this.branches.set([]);
    this.branchesLoading.set(false);
    this.branchesLoaded.set(false);
    this.branchesError.set(null);
    this.newBranchName.set("");
    this.releaseEnabled.set(false);
    this.baseBranchJobsText.set("");
    this.postMergeJobsText.set("");
    this.releaseSecrets.set([]);
    this.releases.set([]);
    this.selectedRelease.set("");
    this.candidates.set([]);
    this.pendingReleases.set([]);
    this.newReleaseName.set("");
    this.declarationsData.set(null);
    this.declarationsError.set(null);
    this.workOwnershipLoadSeq++;
    this.workOwnershipMutationSeq++;
    this.workOwnershipData.set(null);
    this.workOwnershipLoading.set(false);
    this.workOwnershipSaving.set(false);
    this.workOwnershipError.set(null);
    await this.loadCoreRepo();
    await this.loadTabData();
  }

  private async loadCoreRepo(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return;
    if (
      this.access.can(
        "GET /api/deployment/repos/{owner}/{name}/config",
        targetRepo,
      )
    ) {
      try {
        const cfg = await this.api.get<Record<string, unknown>>(
          "GET /api/deployment/repos/{owner}/{name}/config",
          p,
        );
        if (this.repoSlug() !== targetRepo) return;
        const eff =
          (cfg?.["effective"] as Record<string, unknown> | undefined) ?? cfg;
        if (eff?.["cloneUrl"] !== undefined) {
          this.cloneUrl.set(String(eff["cloneUrl"] ?? ""));
        }
        if (eff?.["gitCredential"] !== undefined) {
          this.gitCredential.set(String(eff["gitCredential"] ?? ""));
        }
      } catch {
        // Non-fatal
      }
    }
    if (this.access.can("GET /api/repos/{owner}/{name}/settings", targetRepo)) {
      try {
        const st = await this.api.get<Record<string, unknown>>(
          "GET /api/repos/{owner}/{name}/settings",
          p,
        );
        if (this.repoSlug() !== targetRepo) return;
        if (st?.["ciMode"]) this.ciMode.set(String(st["ciMode"]));
        if (st?.["mergeOnGreen"] !== undefined) {
          this.mergeOnGreen.set(Boolean(st["mergeOnGreen"]));
        }
        if (st?.["requireBranchUpToDate"] !== undefined) {
          this.requireUpToDate.set(Boolean(st["requireBranchUpToDate"]));
        }
        if (st?.["baseRepairBypassesHumanGates"] !== undefined) {
          this.bypassHumanGates.set(
            Boolean(st["baseRepairBypassesHumanGates"]),
          );
        }
        if (st?.["watchDefaultBranch"] !== undefined) {
          this.watchDefaultBranch.set(Boolean(st["watchDefaultBranch"]));
        }
        if (st?.["setupCommand"] !== undefined) {
          this.setupCommand.set(String(st["setupCommand"] ?? ""));
        }
        if (st?.["promptExtension"] !== undefined) {
          this.promptExtension.set(String(st["promptExtension"] ?? ""));
        }
        const imp = st?.["issueImport"] as
          | {
              enabled?: boolean;
              label?: string;
              repo?: string;
              approved?: boolean;
            }
          | undefined;
        if (imp && typeof imp === "object") {
          this.importEnabled.set(Boolean(imp.enabled));
          this.importLabel.set(String(imp.label ?? ""));
          this.importSourceRepo.set(String(imp.repo ?? ""));
          this.importApproved.set(Boolean(imp.approved));
        }
      } catch {
        // Non-fatal
      }
    }
    if (this.access.can("GET /api/deployment/git-connections")) {
      try {
        const conns = await this.api.get<
          { credential?: string; id?: string }[] | { connections?: unknown[] }
        >("GET /api/deployment/git-connections");
        if (this.repoSlug() !== targetRepo) return;
        const arr = (
          Array.isArray(conns) ? conns : (conns?.connections ?? [])
        ) as { credential?: string; id?: string }[];
        this.availableGitCreds.set(
          arr.map((c) => c.credential ?? c.id ?? "").filter(Boolean),
        );
      } catch {
        // Non-fatal
      }
    }
    await this.loadDeclarations();
  }

  private normalizeDeclarations(
    res: RepoDeclarationsData | null | undefined,
  ): RepoDeclarationsData {
    return {
      declarations: Boolean(res?.declarations),
      declarationsStatus: res?.declarationsStatus ?? null,
      pairedBranches: res?.pairedBranches ?? [],
      portBranches: res?.portBranches ?? [],
      declaredPortBranches: res?.declaredPortBranches ?? [],
      portDirections: res?.portDirections ?? [],
      portWarnings: res?.portWarnings ?? [],
    };
  }

  protected async loadDeclarations(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (
      !targetRepo ||
      !p.owner ||
      !p.name ||
      !this.access.can("GET /api/repos/{owner}/{name}/declarations", targetRepo)
    ) {
      return;
    }
    this.declarationsLoading.set(true);
    this.declarationsError.set(null);
    try {
      const res = await this.api.get<RepoDeclarationsData>(
        "GET /api/repos/{owner}/{name}/declarations",
        p,
      );
      if (this.repoSlug() !== targetRepo) return;
      this.declarationsData.set(this.normalizeDeclarations(res));
    } catch (err) {
      if (this.repoSlug() !== targetRepo) return;
      this.declarationsError.set(errText(err));
    } finally {
      if (this.repoSlug() === targetRepo) {
        this.declarationsLoading.set(false);
      }
    }
  }

  protected async toggleDeclarations(): Promise<void> {
    if (
      !this.guardMutation("PUT /api/repos/{owner}/{name}/declarations", true) ||
      this.declarationsSaving() ||
      this.declarationsData() === null
    ) {
      return;
    }
    const targetRepo = this.repoSlug();
    const next = !this.declarationsEnabled();
    const p = this.params();
    this.declarationsSaving.set(true);
    this.declarationsError.set(null);
    try {
      const updated = await this.api.put<RepoDeclarationsData>(
        "PUT /api/repos/{owner}/{name}/declarations",
        p,
        { declarations: next },
      );
      if (this.repoSlug() !== targetRepo) return;
      const prev = this.declarationsData();
      if (updated && "declarations" in updated) {
        this.declarationsData.set(this.normalizeDeclarations(updated));
      } else {
        this.declarationsData.set({
          ...(prev ?? {}),
          declarations: next,
        });
      }
      this.snackbar.show(
        next
          ? `Enabled .grain/ declarations for ${targetRepo}`
          : `Disabled .grain/ declarations for ${targetRepo}`,
      );
    } catch (err) {
      if (this.repoSlug() !== targetRepo) return;
      const msg = errText(err);
      this.declarationsError.set(msg);
      this.error.set(msg);
    } finally {
      this.declarationsSaving.set(false);
    }
  }

  private async loadTabData(t: RepoTabId = this.activeTab()): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return;
    if (t === "overview") {
      if (
        this.access.can("GET /api/repos/{owner}/{name}/lifecycle", targetRepo)
      ) {
        void this.api
          .get<Record<string, unknown>>(
            "GET /api/repos/{owner}/{name}/lifecycle",
            p,
          )
          .then((l) => {
            if (this.repoSlug() !== targetRepo) return;
            const st = l?.["state"] ?? l?.["stage"];
            if (st) this.lifecycleState.set(String(st));
          })
          .catch(() => undefined);
      }
    } else if (t === "ci") {
      if (this.ciCapsData() === null && !this.ciCapsLoading()) {
        void this.loadCiCapabilities();
      }
      if (
        this.access.can("GET /api/repos/{owner}/{name}/workflows", targetRepo)
      ) {
        void this.api
          .get<{ workflows?: RepoWorkflowRow[] } | RepoWorkflowRow[]>(
            "GET /api/repos/{owner}/{name}/workflows",
            p,
          )
          .then((w) => {
            if (this.repoSlug() !== targetRepo) return;
            const list = (Array.isArray(w) ? w : (w?.workflows ?? [])).map(
              (item) => ({
                path: item.path,
                text: item.text ?? "",
                ...(item.name ? { name: item.name } : {}),
              }),
            );
            this.workflows.set(list);
            const cur = this.selectedWorkflowPath();
            const active = list.find((x) => x.path === cur) ?? list[0] ?? null;
            if (active) {
              this.selectedWorkflowPath.set(active.path);
              this.workflowYaml.set(active.text);
            } else {
              this.selectedWorkflowPath.set(".grain/workflows/ci.yml");
              this.workflowYaml.set("");
            }
          })
          .catch(() => undefined);
      }
    } else if (t === "merge-queue") {
      if (this.unfixableData() === null && !this.unfixableLoading()) {
        await this.loadUnfixableChecks();
      }
    } else if (t === "agents") {
      if (
        this.access.can(
          "GET /api/repos/{owner}/{name}/capabilities",
          targetRepo,
        )
      ) {
        void this.api
          .get<{ defaultCapabilities?: string[] }>(
            "GET /api/repos/{owner}/{name}/capabilities",
            p,
          )
          .then((c) => {
            if (this.repoSlug() !== targetRepo) return;
            if (Array.isArray(c?.defaultCapabilities)) {
              this.repoCaps.set(c.defaultCapabilities.join(", "));
            }
          })
          .catch(() => undefined);
      }
    } else if (t === "branches") {
      await this.loadBranches();
    } else if (t === "releases") {
      await this.loadReleasesTab();
    } else if (t === "declarations") {
      if (
        this.declarationsData() === null &&
        !this.declarationsLoading() &&
        !this.declarationsError()
      ) {
        await this.loadDeclarations();
      }
    }
  }

  private applyReleaseSettings(relCfg: Record<string, unknown> | null): void {
    if (!relCfg) return;
    if (relCfg["enabled"] !== undefined) {
      this.releaseEnabled.set(Boolean(relCfg["enabled"]));
    }
    if (Array.isArray(relCfg["baseBranchJobs"])) {
      this.baseBranchJobsText.set(
        (relCfg["baseBranchJobs"] as string[]).join(", "),
      );
    }
    if (Array.isArray(relCfg["postMergeDispatchJobs"])) {
      this.postMergeJobsText.set(
        (relCfg["postMergeDispatchJobs"] as string[]).join(", "),
      );
    }
    if (Array.isArray(relCfg["secrets"])) {
      this.releaseSecrets.set(relCfg["secrets"] as RepoReleaseSecretRow[]);
    }
    if (Array.isArray(relCfg["baseBranches"]) && relCfg["baseBranches"][0]) {
      this.baseBranch.set(String(relCfg["baseBranches"][0]));
    }
    if (Array.isArray(relCfg["pendingReleases"])) {
      this.pendingReleases.set(
        relCfg["pendingReleases"] as PendingReleaseRow[],
      );
    }
  }

  protected saidLabel(said: OwnershipState): string {
    if (said === "on") return "On, set here";
    if (said === "off") return "Off, set here";
    return "Nobody has said";
  }

  protected saidPillClass(said: OwnershipState): string {
    if (said === "on") return "healthy";
    if (said === "off") return "error";
    return "wo-said-unset";
  }

  protected saidIconTone(said: OwnershipState): string {
    if (said === "on") return "healthy";
    if (said === "off") return "error";
    return "neutral";
  }

  protected saidIconKind(said: OwnershipState): string {
    if (said === "on") return "healthy";
    if (said === "off") return "error";
    return "neutral";
  }

  private applyWorkOwnershipResponse(
    res: Partial<RepoWorkOwnershipData> | Record<string, unknown> | null,
    syncReleaseToggle: boolean,
  ): RepoWorkOwnershipData {
    const normalized = normalizeWorkOwnership(res);
    this.workOwnershipData.set(normalized);
    if (syncReleaseToggle) {
      const releaseItem = normalized.items.find((i) => i.item === "release");
      if (releaseItem) {
        this.releaseEnabled.set(Boolean(releaseItem.runs));
      }
    }
    return normalized;
  }

  protected async loadWorkOwnership(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (
      !targetRepo ||
      !p.owner ||
      !p.name ||
      !this.access.can(
        "GET /api/repos/{owner}/{name}/work-ownership",
        targetRepo,
      )
    ) {
      return;
    }
    const loadSeq = ++this.workOwnershipLoadSeq;
    const mutSeq = this.workOwnershipMutationSeq;
    this.workOwnershipLoading.set(true);
    this.workOwnershipError.set(null);
    try {
      const res = await this.api.get<Record<string, unknown>>(
        "GET /api/repos/{owner}/{name}/work-ownership",
        p,
      );
      if (
        this.repoSlug() !== targetRepo ||
        loadSeq !== this.workOwnershipLoadSeq ||
        mutSeq !== this.workOwnershipMutationSeq
      ) {
        return;
      }
      this.applyWorkOwnershipResponse(res, false);
    } catch (err) {
      if (
        this.repoSlug() !== targetRepo ||
        loadSeq !== this.workOwnershipLoadSeq ||
        mutSeq !== this.workOwnershipMutationSeq
      ) {
        return;
      }
      this.workOwnershipError.set(errText(err));
    } finally {
      if (
        this.repoSlug() === targetRepo &&
        loadSeq === this.workOwnershipLoadSeq
      ) {
        this.workOwnershipLoading.set(false);
      }
    }
  }

  protected async toggleStandingWork(): Promise<void> {
    const cur = this.workOwnershipData();
    if (!cur) return;
    await this.saveWorkDefault(cur.defaultRuns ? "off" : "on");
  }

  protected async saveWorkDefault(state: OwnershipState): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/work-ownership",
        true,
      ) ||
      this.workOwnershipSaving()
    ) {
      return;
    }
    if (!isValidOwnershipState(state)) {
      this.workOwnershipError.set(
        `Invalid ownership state "${String(state)}": expected "on", "off", or empty.`,
      );
      return;
    }
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return;
    const mutSeq = ++this.workOwnershipMutationSeq;
    this.workOwnershipSaving.set(true);
    this.workOwnershipError.set(null);
    try {
      const res = await this.api.put<Record<string, unknown>>(
        "PUT /api/repos/{owner}/{name}/work-ownership",
        p,
        { default: state },
      );
      if (
        this.repoSlug() !== targetRepo ||
        mutSeq !== this.workOwnershipMutationSeq
      ) {
        return;
      }
      this.applyWorkOwnershipResponse(res, true);
      this.snackbar.show(
        state
          ? `Repository work ownership default set to ${state}`
          : "Repository work ownership default cleared",
      );
    } catch (err) {
      if (
        this.repoSlug() !== targetRepo ||
        mutSeq !== this.workOwnershipMutationSeq
      ) {
        return;
      }
      this.workOwnershipError.set(errText(err));
    } finally {
      if (
        this.repoSlug() === targetRepo &&
        mutSeq === this.workOwnershipMutationSeq
      ) {
        this.workOwnershipSaving.set(false);
      }
    }
  }

  protected async saveWorkItem(
    item: string,
    state: OwnershipState,
  ): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/work-ownership",
        true,
      ) ||
      this.workOwnershipSaving()
    ) {
      return;
    }
    const itemErr = validateWorkItemId(item);
    if (itemErr) {
      this.workOwnershipError.set(itemErr);
      return;
    }
    if (!isValidOwnershipState(state)) {
      this.workOwnershipError.set(
        `Invalid ownership state "${String(state)}": expected "on", "off", or empty.`,
      );
      return;
    }
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return;
    const mutSeq = ++this.workOwnershipMutationSeq;
    this.workOwnershipSaving.set(true);
    this.workOwnershipError.set(null);
    try {
      const res = await this.api.put<Record<string, unknown>>(
        "PUT /api/repos/{owner}/{name}/work-ownership",
        p,
        { item, state },
      );
      if (
        this.repoSlug() !== targetRepo ||
        mutSeq !== this.workOwnershipMutationSeq
      ) {
        return;
      }
      const updated = this.applyWorkOwnershipResponse(res, true);
      const row = updated.items.find((i) => i.item === item);
      const label = row?.title || item;
      this.snackbar.show(
        state
          ? `Work ownership for ${label} set to ${state}`
          : `Work ownership override cleared for ${label}`,
      );
    } catch (err) {
      if (
        this.repoSlug() !== targetRepo ||
        mutSeq !== this.workOwnershipMutationSeq
      ) {
        return;
      }
      this.workOwnershipError.set(errText(err));
    } finally {
      if (
        this.repoSlug() === targetRepo &&
        mutSeq === this.workOwnershipMutationSeq
      ) {
        this.workOwnershipSaving.set(false);
      }
    }
  }

  private async loadReleasesTab(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return;
    const loadReleaseConfig = async () => {
      if (
        !this.access.can("GET /api/repos/{owner}/{name}/release", targetRepo)
      ) {
        return;
      }
      try {
        const relCfg = await this.api.get<Record<string, unknown>>(
          "GET /api/repos/{owner}/{name}/release",
          p,
        );
        if (this.repoSlug() !== targetRepo) return;
        this.applyReleaseSettings(relCfg);
      } catch {
        // Non-fatal
      }
    };
    const loadReleasesList = async () => {
      if (
        !this.access.can("GET /api/repos/{owner}/{name}/releases", targetRepo)
      ) {
        return;
      }
      try {
        const list = await this.api.get<
          ReleaseRow[] | { releases?: ReleaseRow[]; items?: ReleaseRow[] }
        >("GET /api/repos/{owner}/{name}/releases", p);
        if (this.repoSlug() !== targetRepo) return;
        const rows = Array.isArray(list)
          ? list
          : (list?.releases ?? list?.items ?? []);
        this.releases.set(rows);
        const current = this.selectedRelease();
        const target =
          rows.find((r) => r.name === current)?.name ?? rows[0]?.name ?? "";
        this.selectedRelease.set(target);
        if (target) {
          await this.loadCandidatesFor(target);
        } else {
          this.candidates.set([]);
        }
      } catch {
        // Non-fatal
      }
    };
    await Promise.all([
      this.loadWorkOwnership(),
      loadReleaseConfig(),
      loadReleasesList(),
    ]);
  }

  protected async selectReleaseForCandidates(release: string): Promise<void> {
    this.selectedRelease.set(release);
    await this.loadCandidatesFor(release);
  }

  private async loadCandidatesFor(release: string): Promise<void> {
    const targetRepo = this.repoSlug();
    if (
      !targetRepo ||
      !release ||
      !this.access.can(
        "GET /api/repos/{owner}/{name}/releases/{release}/candidates",
        targetRepo,
      )
    ) {
      return;
    }
    try {
      const cands = await this.api.get<
        CandidateRow[] | { candidates?: CandidateRow[]; items?: CandidateRow[] }
      >("GET /api/repos/{owner}/{name}/releases/{release}/candidates", {
        ...this.params(),
        release,
      });
      if (this.repoSlug() !== targetRepo) return;
      this.candidates.set(
        Array.isArray(cands)
          ? cands
          : (cands?.candidates ?? cands?.items ?? []),
      );
    } catch {
      // Non-fatal
    }
  }

  protected async saveRepoConfig(): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/deployment/repos/{owner}/{name}/config",
        true,
      )
    ) {
      return;
    }
    try {
      await this.api.put(
        "PUT /api/deployment/repos/{owner}/{name}/config",
        this.params(),
        {
          cloneUrl: this.cloneUrl().trim(),
          ...(this.gitCredential()
            ? { gitCredential: this.gitCredential() }
            : {}),
        },
      );
      this.snackbar.show("Repository configuration saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async pinGitConnection(credential: string): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/deployment/repos/{owner}/{name}/git-connection",
        true,
      )
    ) {
      return;
    }
    const previous = this.gitCredential();
    this.gitCredential.set(credential);
    try {
      await this.api.put(
        "PUT /api/deployment/repos/{owner}/{name}/git-connection",
        this.params(),
        { credential },
      );
      this.snackbar.show("Pinned Git connection");
    } catch (err) {
      this.gitCredential.set(previous);
      this.error.set(errText(err));
    }
  }

  protected async refreshLifecycle(): Promise<void> {
    if (
      !this.guardMutation("POST /api/repos/{owner}/{name}/lifecycle/refresh")
    ) {
      return;
    }
    try {
      const res = await this.api.post<{ state?: string; stage?: string }>(
        "POST /api/repos/{owner}/{name}/lifecycle/refresh",
        this.params(),
        {},
      );
      const st = res?.state ?? res?.stage;
      if (st) this.lifecycleState.set(st);
      this.snackbar.show("Lifecycle refreshed");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveIssueImportSettings(): Promise<void> {
    if (!this.guardMutation("PUT /api/repos/{owner}/{name}/settings", true)) {
      return;
    }
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/settings",
        this.params(),
        {
          issueImportEnabled: this.importEnabled(),
          issueImportLabel: this.importLabel().trim(),
          issueImportRepo: this.importSourceRepo().trim(),
          issueImportApproved: this.importApproved(),
        },
      );
      this.snackbar.show("Issue importer settings saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async importIssues(): Promise<void> {
    if (!this.guardMutation("POST /api/repos/{owner}/{name}/import-issues")) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/import-issues",
        this.params(),
        {},
      );
      this.snackbar.show("Issue import triggered");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveCiMode(ciMode: string): Promise<void> {
    if (!this.guardMutation("PUT /api/repos/{owner}/{name}/ci-mode", true)) {
      return;
    }
    const previous = this.ciMode();
    this.ciMode.set(ciMode);
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/ci-mode",
        this.params(),
        { ciMode },
      );
      this.snackbar.show(`CI mode set to ${ciMode}`);
    } catch (err) {
      // A refused mode is not the repo's mode: put the pill back on
      // what the server still has rather than leave it naming one it
      // refused.
      this.ciMode.set(previous);
      this.error.set(errText(err));
    }
  }

  protected async toggleWatchDefaultBranch(): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/watch-default-branch",
        true,
      )
    ) {
      return;
    }
    const next = !this.watchDefaultBranch();
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/watch-default-branch",
        this.params(),
        { watchDefaultBranch: next },
      );
      this.watchDefaultBranch.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async triggerBaseCiRun(): Promise<void> {
    if (
      !this.guardMutation("POST /api/repos/{owner}/{name}/base-branch-runs")
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/base-branch-runs",
        this.params(),
        { branch: this.baseBranch() || "main" },
      );
      this.snackbar.show("Triggered base-branch CI run");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected selectWorkflow(path: string): void {
    this.selectedWorkflowPath.set(path);
    const found = this.workflows().find((w) => w.path === path);
    this.workflowYaml.set(found?.text ?? "");
  }

  protected onEditWorkflowText(text: string): void {
    this.workflowYaml.set(text);
    const path = this.selectedWorkflowPath();
    this.workflows.update((list) => {
      const idx = list.findIndex((w) => w.path === path);
      if (idx < 0) return list;
      const copy = [...list];
      copy[idx] = { ...copy[idx], text };
      return copy;
    });
  }

  protected addWorkflowFile(): void {
    if (!this.guardMutation("PUT /api/repos/{owner}/{name}/workflows", true)) {
      return;
    }
    const path = normalizeWorkflowPath(this.newWorkflowPath());
    if (!path) return;
    this.newWorkflowPath.set("");
    const existing = this.workflows().find((w) => w.path === path);
    if (existing) {
      this.selectedWorkflowPath.set(existing.path);
      this.workflowYaml.set(existing.text);
      return;
    }
    const stub = `name: ${
      path
        .split("/")
        .pop()
        ?.replace(/\.ya?ml$/, "") || "ci"
    }\n`;
    this.workflows.update((list) => [...list, { path, text: stub }]);
    this.selectedWorkflowPath.set(path);
    this.workflowYaml.set(stub);
  }

  protected async deleteSelectedWorkflow(): Promise<void> {
    if (!this.guardMutation("PUT /api/repos/{owner}/{name}/workflows", true)) {
      return;
    }
    const target = this.selectedWorkflowPath();
    const remaining = this.workflows().filter((w) => w.path !== target);
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.params(),
        {
          workflows: remaining.map((w) => ({ path: w.path, text: w.text })),
        },
      );
      this.workflows.set(remaining);
      const next = remaining[0] ?? null;
      this.selectedWorkflowPath.set(next?.path ?? ".grain/workflows/ci.yml");
      this.workflowYaml.set(next?.text ?? "");
      this.snackbar.show(`Removed workflow ${target}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveWorkflows(): Promise<void> {
    if (!this.guardMutation("PUT /api/repos/{owner}/{name}/workflows", true)) {
      return;
    }
    const path =
      normalizeWorkflowPath(this.selectedWorkflowPath()) ||
      ".grain/workflows/ci.yml";
    const text = this.workflowYaml();
    const current = this.workflows();
    const idx = current.findIndex((w) => w.path === path);
    let next: RepoWorkflowRow[];
    if (text.trim()) {
      if (idx >= 0) {
        next = current.map((w, i) => (i === idx ? { ...w, path, text } : w));
      } else {
        next = [...current, { path, text }];
      }
    } else {
      next = current.filter((w) => w.path !== path);
    }
    try {
      const res = await this.api.put<{ workflows?: RepoWorkflowRow[] }>(
        "PUT /api/repos/{owner}/{name}/workflows",
        this.params(),
        {
          workflows: next.map((w) => ({ path: w.path, text: w.text })),
        },
      );
      if (Array.isArray(res?.workflows)) {
        this.workflows.set(res.workflows);
      } else {
        this.workflows.set(next);
      }
      this.snackbar.show("Workflows saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async saveReleaseSettings(): Promise<void> {
    if (!this.guardMutation("PUT /api/repos/{owner}/{name}/release", true)) {
      return;
    }
    const parseJobs = (raw: string): string[] =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    try {
      const res = await this.api.put<Record<string, unknown>>(
        "PUT /api/repos/{owner}/{name}/release",
        this.params(),
        {
          enabled: this.releaseEnabled(),
          baseBranchJobs: parseJobs(this.baseBranchJobsText()),
          postMergeDispatchJobs: parseJobs(this.postMergeJobsText()),
        },
      );
      if (res && typeof res === "object") {
        this.applyReleaseSettings(res);
      }
      await this.loadWorkOwnership();
      this.snackbar.show("Release settings saved");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async toggleMergeOnGreen(): Promise<void> {
    if (
      !this.guardMutation("PUT /api/repos/{owner}/{name}/merge-on-green", true)
    ) {
      return;
    }
    const next = !this.mergeOnGreen();
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/merge-on-green",
        this.params(),
        { mergeOnGreen: next },
      );
      this.mergeOnGreen.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async toggleRequireUpToDate(): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/require-branch-up-to-date",
        true,
      )
    ) {
      return;
    }
    const next = !this.requireUpToDate();
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/require-branch-up-to-date",
        this.params(),
        { requireBranchUpToDate: next },
      );
      this.requireUpToDate.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async onConfirmDone(accepted: boolean): Promise<void> {
    const req = this.confirmReq();
    this.confirmReq.set(null);
    if (!accepted || !req) return;
    await req.run();
  }

  protected toggleBypassHumanGates(): void {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates",
        true,
      )
    ) {
      return;
    }
    const next = !this.bypassHumanGates();
    if (next) {
      this.confirmReq.set(
        bypassConfirm(this.repoSlug(), () => this.saveBypassHumanGates(true)),
      );
      return;
    }
    void this.saveBypassHumanGates(false);
  }

  private async saveBypassHumanGates(next: boolean): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates",
        true,
      )
    ) {
      return;
    }
    try {
      await this.api.put(
        "PUT /api/repos/{owner}/{name}/base-repair-bypasses-human-gates",
        this.params(),
        { baseRepairBypassesHumanGates: next },
      );
      this.bypassHumanGates.set(next);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async loadUnfixableChecks(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (
      !targetRepo ||
      !p.owner ||
      !p.name ||
      !this.access.can(
        "GET /api/repos/{owner}/{name}/unfixable-checks",
        targetRepo,
      )
    ) {
      return;
    }
    const loadSeq = ++this.unfixableLoadSeq;
    const mutSeq = this.unfixableMutationSeq;
    this.unfixableLoading.set(true);
    this.unfixableLoadError.set(null);
    try {
      const res = await this.api.get<Record<string, unknown>>(
        "GET /api/repos/{owner}/{name}/unfixable-checks",
        p,
      );
      if (
        this.repoSlug() !== targetRepo ||
        loadSeq !== this.unfixableLoadSeq ||
        mutSeq !== this.unfixableMutationSeq
      ) {
        return;
      }
      this.unfixableData.set(normalizeUnfixableChecks(res));
    } catch (err) {
      if (
        this.repoSlug() !== targetRepo ||
        loadSeq !== this.unfixableLoadSeq ||
        mutSeq !== this.unfixableMutationSeq
      ) {
        return;
      }
      this.unfixableLoadError.set(errText(err));
    } finally {
      if (this.repoSlug() === targetRepo && loadSeq === this.unfixableLoadSeq) {
        this.unfixableLoading.set(false);
      }
    }
  }

  protected onUnfixableDraftInput(val: string): void {
    this.unfixableDraft.set(val);
    if (this.unfixableError()) {
      this.unfixableError.set(null);
    }
  }

  protected async addUnfixableCheck(event?: Event): Promise<void> {
    event?.preventDefault();
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/unfixable-checks",
        true,
      ) ||
      this.unfixableSaving() ||
      this.unfixableData() === null
    ) {
      return;
    }
    const name = this.unfixableDraft().trim();
    if (!name) return;
    const err = validateUnfixableCheckName(name, this.grainCICheckName());
    if (err) {
      this.unfixableError.set(err);
      return;
    }
    const existing = this.unfixableChecks();
    if (existing.some((c) => sameCheckName(c, name))) {
      this.unfixableError.set(
        `${this.repoSlug()} already declares ${name} unfixable — check names are matched without case.`,
      );
      return;
    }
    const ok = await this.saveUnfixableChecks([...existing, name]);
    if (ok) {
      this.unfixableDraft.set("");
    }
  }

  protected async removeUnfixableCheck(check: string): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/unfixable-checks",
        true,
      ) ||
      this.unfixableSaving() ||
      this.unfixableData() === null
    ) {
      return;
    }
    const next = this.unfixableChecks().filter(
      (other) => !sameCheckName(other, check),
    );
    const ok = await this.saveUnfixableChecks(next);
    if (ok) {
      queueMicrotask(() => {
        const input = this.doc.getElementById("unfixable-check-input");
        if (input instanceof HTMLInputElement && !input.disabled) {
          input.focus();
        }
      });
    }
  }

  protected async saveUnfixableChecks(checks: string[]): Promise<boolean> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/unfixable-checks",
        true,
      ) ||
      this.unfixableSaving()
    ) {
      return false;
    }
    const grainCI = this.grainCICheckName();
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of checks) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) continue;
      const err = validateUnfixableCheckName(name, grainCI);
      if (err) {
        this.unfixableError.set(err);
        return false;
      }
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        cleaned.push(name);
      }
    }
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return false;
    const mutSeq = ++this.unfixableMutationSeq;
    this.unfixableSaving.set(true);
    this.unfixableError.set(null);
    try {
      const res = await this.api.put<Record<string, unknown>>(
        "PUT /api/repos/{owner}/{name}/unfixable-checks",
        p,
        { unfixableChecks: cleaned },
      );
      if (
        this.repoSlug() !== targetRepo ||
        mutSeq !== this.unfixableMutationSeq
      ) {
        return false;
      }
      const hasChecks =
        res && typeof res === "object" && "unfixableChecks" in res;
      const prevCi = this.grainCICheckName();
      this.unfixableData.set(
        hasChecks
          ? normalizeUnfixableChecks(res)
          : { unfixableChecks: cleaned, grainCICheckName: prevCi },
      );
      this.snackbar.show("Unfixable checks updated");
      return true;
    } catch (err) {
      if (
        this.repoSlug() !== targetRepo ||
        mutSeq !== this.unfixableMutationSeq
      ) {
        return false;
      }
      this.unfixableError.set(errText(err));
      return false;
    } finally {
      if (
        this.repoSlug() === targetRepo &&
        mutSeq === this.unfixableMutationSeq
      ) {
        this.unfixableSaving.set(false);
      }
    }
  }

  protected async loadCiCapabilities(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (
      !targetRepo ||
      !p.owner ||
      !p.name ||
      !this.access.can(
        "GET /api/repos/{owner}/{name}/ci-capabilities",
        targetRepo,
      )
    ) {
      return;
    }
    const loadSeq = ++this.ciCapsLoadSeq;
    const mutSeq = this.ciCapsMutationSeq;
    this.ciCapsLoading.set(true);
    this.ciCapsLoadError.set(null);
    try {
      const res = await this.api.get<Partial<CiCapabilitiesData>>(
        "GET /api/repos/{owner}/{name}/ci-capabilities",
        p,
      );
      if (
        this.repoSlug() !== targetRepo ||
        loadSeq !== this.ciCapsLoadSeq ||
        mutSeq !== this.ciCapsMutationSeq
      ) {
        return;
      }
      this.ciCapsData.set(normalizeCiCapabilities(res));
    } catch (err) {
      if (
        this.repoSlug() !== targetRepo ||
        loadSeq !== this.ciCapsLoadSeq ||
        mutSeq !== this.ciCapsMutationSeq
      ) {
        return;
      }
      this.ciCapsLoadError.set(errText(err));
    } finally {
      if (this.repoSlug() === targetRepo && loadSeq === this.ciCapsLoadSeq) {
        this.ciCapsLoading.set(false);
      }
    }
  }

  protected async saveCiCapabilities(nextCaps: string[]): Promise<void> {
    if (
      !this.guardMutation(
        "PUT /api/repos/{owner}/{name}/ci-capabilities",
        true,
      ) ||
      this.ciCapsSaving() ||
      this.ciCapsData() === null
    ) {
      return;
    }
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of nextCaps) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (!id) continue;
      if (isApiCapability(id)) {
        this.ciCapsError.set("CI jobs cannot hold agent API grants.");
        return;
      }
      if (!seen.has(id)) {
        seen.add(id);
        cleaned.push(id);
      }
    }
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (!targetRepo || !p.owner || !p.name) return;
    const mutSeq = ++this.ciCapsMutationSeq;
    this.ciCapsSaving.set(true);
    this.ciCapsError.set(null);
    try {
      const res = await this.api.put<Partial<CiCapabilitiesData>>(
        "PUT /api/repos/{owner}/{name}/ci-capabilities",
        p,
        { ciCapabilities: cleaned },
      );
      if (this.repoSlug() !== targetRepo || mutSeq !== this.ciCapsMutationSeq) {
        return;
      }
      const prevAvail = this.availableCICapabilities();
      const hasCaps = res && typeof res === "object" && "ciCapabilities" in res;
      if (hasCaps) {
        const normalized = normalizeCiCapabilities(res);
        this.ciCapsData.set({
          ciCapabilities: normalized.ciCapabilities,
          availableCICapabilities: Array.isArray(res.availableCICapabilities)
            ? normalized.availableCICapabilities
            : prevAvail,
        });
      } else {
        this.ciCapsData.set({
          ciCapabilities: cleaned,
          availableCICapabilities: prevAvail,
        });
      }
      this.snackbar.show("CI capabilities updated");
    } catch (err) {
      if (this.repoSlug() !== targetRepo || mutSeq !== this.ciCapsMutationSeq) {
        return;
      }
      this.ciCapsError.set(errText(err));
    } finally {
      if (this.repoSlug() === targetRepo && mutSeq === this.ciCapsMutationSeq) {
        this.ciCapsSaving.set(false);
      }
    }
  }

  protected clearAgentsErrors(): void {
    this.agentsError.set(null);
    this.agentsOrderedErrors.set([]);
    this.agentsFieldErrors.set({});
  }

  private clearAgentFieldError(field: AgentFieldKey): void {
    const cur = this.agentsFieldErrors();
    if (!cur[field]) {
      if (Object.keys(cur).length === 0 && this.agentsError()) {
        this.agentsError.set(null);
        this.agentsOrderedErrors.set([]);
      }
      return;
    }
    const next = { ...cur };
    delete next[field];
    this.agentsFieldErrors.set(next);
    const remaining: { label: string; msg: string }[] = [];
    if (next.setup) {
      remaining.push({ label: "Sandbox setup command", msg: next.setup });
    }
    if (next.prompt) {
      remaining.push({ label: "Standing prompt extension", msg: next.prompt });
    }
    if (next.caps) {
      remaining.push({ label: "Default capabilities", msg: next.caps });
    }
    if (remaining.length === 0) {
      this.agentsError.set(null);
      this.agentsOrderedErrors.set([]);
    } else if (remaining.length === 1) {
      const msg = `${remaining[0].label}: ${remaining[0].msg}`;
      this.agentsOrderedErrors.set([msg]);
      this.agentsError.set(msg);
    } else {
      const msgs = remaining.map((r) => `${r.label}: ${r.msg}`);
      this.agentsOrderedErrors.set(msgs);
      this.agentsError.set(
        `Fix ${msgs.length} validation errors before saving:`,
      );
    }
  }

  protected onAgentSetupInput(val: string): void {
    this.setupCommand.set(val);
    this.clearAgentFieldError("setup");
  }

  protected onAgentPromptInput(val: string): void {
    this.promptExtension.set(val);
    this.clearAgentFieldError("prompt");
  }

  protected onAgentCapsInput(val: string): void {
    this.repoCaps.set(val);
    this.clearAgentFieldError("caps");
  }

  private focusAgentField(field: AgentFieldKey): void {
    const id =
      field === "setup"
        ? "rp-setup"
        : field === "prompt"
          ? "rp-prompt"
          : "rp-caps";
    afterNextRender(
      () => {
        const el = this.doc.getElementById(id);
        if (
          (el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement) &&
          !el.disabled
        ) {
          el.focus();
        }
      },
      { injector: this.injector },
    );
  }

  protected async saveAgentTabSettings(): Promise<void> {
    if (this.agentsSaving()) return;
    if (this.configRepoOnly() || !this.canSaveRepoAgents()) return;
    const repo = this.repoSlug();
    const p = this.params();
    if (!repo || !p.owner || !p.name) return;

    const canSetup = this.access.can(
      "PUT /api/repos/{owner}/{name}/setup-command",
      repo,
    );
    const canPrompt = this.access.can(
      "PUT /api/repos/{owner}/{name}/prompt-extension",
      repo,
    );
    const canCaps = this.access.can(
      "PUT /api/repos/{owner}/{name}/capabilities",
      repo,
    );

    const validation = validateAgentSettingsForm({
      setupCommand: this.setupCommand(),
      promptExtension: this.promptExtension(),
      repoCaps: this.repoCaps(),
      canSetup,
      canPrompt,
      canCaps,
    });

    if (!validation.valid) {
      this.agentsFieldErrors.set(validation.fieldErrors);
      const msgs = validation.orderedErrors.map(
        (e) => `${e.label}: ${e.message}`,
      );
      this.agentsOrderedErrors.set(msgs);
      this.agentsError.set(
        msgs.length === 1
          ? msgs[0]
          : `Fix ${msgs.length} validation errors before saving:`,
      );
      const first = validation.orderedErrors[0];
      if (first) {
        this.focusAgentField(first.field);
      }
      return;
    }

    this.clearAgentsErrors();
    this.agentsSaving.set(true);
    const completed: string[] = [];
    let focusOnFail: AgentFieldKey | null = null;

    const reportSequentialError = (
      field: AgentFieldKey,
      stepLabel: string,
      err: unknown,
    ): void => {
      if (this.repoSlug() !== repo) return;
      const reason = errText(err);
      const stepMsg = `${stepLabel} could not be saved: ${reason}`;
      this.agentsFieldErrors.set({ [field]: stepMsg });
      if (completed.length > 0) {
        this.agentsOrderedErrors.set([
          `Saved ${completed.join(", ")}.`,
          stepMsg,
        ]);
        this.agentsError.set(
          `Partially saved (${completed.join(", ")}), then stopped at ${stepLabel}:`,
        );
      } else {
        this.agentsOrderedErrors.set([stepMsg]);
        this.agentsError.set(stepMsg);
      }
      focusOnFail = field;
    };

    try {
      if (canSetup) {
        try {
          await this.api.put("PUT /api/repos/{owner}/{name}/setup-command", p, {
            setupCommand: validation.setupCommand,
          });
        } catch (err) {
          reportSequentialError("setup", "Sandbox setup command", err);
          return;
        }
        if (this.repoSlug() !== repo) return;
        this.setupCommand.set(validation.setupCommand);
        completed.push("Sandbox setup command");
      }

      if (canPrompt) {
        try {
          await this.api.put(
            "PUT /api/repos/{owner}/{name}/prompt-extension",
            p,
            { promptExtension: validation.promptExtension },
          );
        } catch (err) {
          reportSequentialError("prompt", "Standing prompt extension", err);
          return;
        }
        if (this.repoSlug() !== repo) return;
        this.promptExtension.set(validation.promptExtension);
        completed.push("Standing prompt extension");
      }

      if (canCaps) {
        let capsRes: { defaultCapabilities?: string[] } | undefined;
        try {
          capsRes = await this.api.put<{ defaultCapabilities?: string[] }>(
            "PUT /api/repos/{owner}/{name}/capabilities",
            p,
            { defaultCapabilities: validation.defaultCapabilities },
          );
        } catch (err) {
          reportSequentialError("caps", "Default capabilities", err);
          return;
        }
        if (this.repoSlug() !== repo) return;
        const savedCaps = Array.isArray(capsRes?.defaultCapabilities)
          ? capsRes.defaultCapabilities
          : validation.defaultCapabilities;
        this.repoCaps.set(savedCaps.join(", "));
        completed.push("Default capabilities");
      }

      if (completed.length > 0) {
        this.snackbar.show("Saved repository agent settings");
      } else {
        this.agentsError.set(
          "No editable agent settings were available to save.",
        );
      }
    } finally {
      if (this.repoSlug() === repo) {
        this.agentsSaving.set(false);
        if (focusOnFail) {
          this.focusAgentField(focusOnFail);
        }
      }
    }
  }

  protected async loadBranches(): Promise<void> {
    const targetRepo = this.repoSlug();
    const p = this.params();
    if (
      !targetRepo ||
      !p.owner ||
      !p.name ||
      !this.access.can("GET /api/repos/{owner}/{name}/branches", targetRepo)
    ) {
      return;
    }
    const loadSeq = ++this.branchesLoadSeq;
    this.branchesLoading.set(true);
    this.branchesError.set(null);
    try {
      const b = await this.api.get<BranchRow[] | { branches?: BranchRow[] }>(
        "GET /api/repos/{owner}/{name}/branches",
        p,
      );
      if (this.repoSlug() !== targetRepo || loadSeq !== this.branchesLoadSeq) {
        return;
      }
      const raw = Array.isArray(b) ? b : (b?.branches ?? []);
      const seen = new Set<string>();
      const deduped = raw.filter((row) => {
        if (!row?.name || seen.has(row.name)) return false;
        seen.add(row.name);
        return true;
      });
      this.branches.set(deduped);
      this.branchesLoaded.set(true);
    } catch (err) {
      if (this.repoSlug() !== targetRepo || loadSeq !== this.branchesLoadSeq) {
        return;
      }
      this.branchesError.set(errText(err));
    } finally {
      if (this.repoSlug() === targetRepo && loadSeq === this.branchesLoadSeq) {
        this.branchesLoading.set(false);
      }
    }
  }

  protected async createBranch(): Promise<void> {
    if (!this.guardMutation("POST /api/repos/{owner}/{name}/branches")) {
      return;
    }
    const name = this.newBranchName().trim();
    if (!name) return;
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/branches",
        this.params(),
        { name, from: this.newBranchFrom().trim() || "main" },
      );
      this.newBranchName.set("");
      await this.loadBranches();
      this.snackbar.show(`Created branch ${name}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async createRelease(): Promise<void> {
    if (!this.guardMutation("POST /api/repos/{owner}/{name}/releases")) {
      return;
    }
    const name = this.newReleaseName().trim();
    if (!name) return;
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases",
        this.params(),
        { name },
      );
      this.newReleaseName.set("");
      await this.loadReleasesTab();
      this.snackbar.show(`Created release ${name}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async cutCandidate(release: string): Promise<void> {
    if (
      !this.guardMutation(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates",
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates",
        { ...this.params(), release },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Cut candidate for ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async promoteCandidate(release: string): Promise<void> {
    if (
      !this.guardMutation(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote",
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases/{release}/candidates/promote",
        { ...this.params(), release },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Promoted candidate on ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async mergeRelease(release: string): Promise<void> {
    if (
      !this.guardMutation(
        "POST /api/repos/{owner}/{name}/releases/{release}/merge",
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/releases/{release}/merge",
        { ...this.params(), release },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Merged ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async deleteRelease(release: string): Promise<void> {
    if (
      !this.guardMutation("DELETE /api/repos/{owner}/{name}/releases/{release}")
    ) {
      return;
    }
    try {
      await this.api.delete(
        "DELETE /api/repos/{owner}/{name}/releases/{release}",
        { ...this.params(), release },
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Deleted release ${release}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async approveQualification(id: string): Promise<void> {
    if (
      !this.guardMutation(
        "POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve",
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/candidates/{id}/qualification/approve",
        { ...this.params(), id },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show("Approved candidate qualification");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async triggerReleaseRun(): Promise<void> {
    if (!this.guardMutation("POST /api/repos/{owner}/{name}/release-runs")) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/release-runs",
        this.params(),
        {},
      );
      this.snackbar.show("Started release workflow run");
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async approvePendingRelease(version: string): Promise<void> {
    if (
      !this.guardMutation(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/approve",
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/approve",
        { ...this.params(), version },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Approved release ${version}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }

  protected async rejectPendingRelease(version: string): Promise<void> {
    if (
      !this.guardMutation(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/reject",
      )
    ) {
      return;
    }
    try {
      await this.api.post(
        "POST /api/repos/{owner}/{name}/pending-releases/{version}/reject",
        { ...this.params(), version },
        {},
      );
      await this.loadReleasesTab();
      this.snackbar.show(`Rejected release ${version}`);
    } catch (err) {
      this.error.set(errText(err));
    }
  }
}
