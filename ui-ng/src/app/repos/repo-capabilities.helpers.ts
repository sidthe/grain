// Copyright 2026 The Grain Authors
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

import type { CapabilityOption } from "../api/models";

export const RETIRED_CAPABILITY_HINT =
  "No longer offered -- untick to remove it";
export const NO_CI_CAPABILITIES_HINT =
  "None offered -- grant access under Grants";

export interface RepoCiCapabilitiesState {
  ciCapabilities: string[];
  availableCICapabilities: string[];
}

export interface CICapabilityRow extends CapabilityOption {
  retired?: boolean;
}

export function isCapabilityRef(id: string): boolean {
  return typeof id === "string" && id.trim().startsWith("https://");
}

export function normalizeRepoCiCapabilitiesState(
  raw: unknown,
): RepoCiCapabilitiesState {
  const rec =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ciCapabilities: string[] = [];
  const seenCi = new Set<string>();
  const rawCi = Array.isArray(rec["ciCapabilities"])
    ? rec["ciCapabilities"]
    : [];
  for (const entry of rawCi) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seenCi.has(trimmed)) continue;
    seenCi.add(trimmed);
    ciCapabilities.push(trimmed);
  }

  const availableCICapabilities: string[] = [];
  const seenAvail = new Set<string>();
  const rawAvail = Array.isArray(rec["availableCICapabilities"])
    ? rec["availableCICapabilities"]
    : [];
  for (const entry of rawAvail) {
    const id =
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object"
          ? String((entry as { id?: unknown }).id ?? "").trim()
          : "";
    if (!id || seenAvail.has(id)) continue;
    seenAvail.add(id);
    availableCICapabilities.push(id);
  }

  return { ciCapabilities, availableCICapabilities };
}

export function capabilityUnavailableHint(
  c: CapabilityOption | null | undefined,
): string {
  if (!c || c.ready !== false) return "";
  const needs = Array.isArray(c.needs)
    ? c.needs
    : typeof c.needs === "string" && c.needs
      ? [c.needs]
      : [];
  const gap =
    needs.length > 0 ? ` -- needs ${needs.join(", ")}` : " on this deployment";
  return `Not ready${gap}. A task holding this will fail to dispatch until that is set (Settings > Capabilities).`;
}

export function capabilityRows(
  offered: readonly CapabilityOption[],
  selected: readonly string[],
): CICapabilityRow[] {
  const held = new Set(selected);
  const configured: CICapabilityRow[] = offered.filter(
    (c) => c.ready !== false || held.has(c.id),
  );
  const configuredIds = new Set(configured.map((c) => c.id));
  const retired: CICapabilityRow[] = [];
  for (const id of selected) {
    if (!configuredIds.has(id)) {
      configuredIds.add(id);
      retired.push({
        id,
        name: id,
        description: RETIRED_CAPABILITY_HINT,
        retired: true,
      });
    }
  }
  return [...configured, ...retired];
}

export function splitCiCapabilities(
  selected: readonly string[],
  availableCICapabilities: readonly string[],
): {
  pickerSet: Set<string>;
  legacySelected: string[];
  grantRefs: string[];
} {
  const pickerSet = new Set(availableCICapabilities);
  const inPicker = (id: string) => !isCapabilityRef(id) || pickerSet.has(id);
  return {
    pickerSet,
    legacySelected: selected.filter(inPicker),
    grantRefs: selected.filter((id) => !inPicker(id)),
  };
}

export type AgentFieldKey = "setupCommand" | "promptExtension" | "repoCaps";

export interface AgentFieldErrorItem {
  field: AgentFieldKey;
  label: string;
  message: string;
}

export interface AgentFormValidationResult {
  valid: boolean;
  fieldErrors: Partial<Record<AgentFieldKey, string>>;
  orderedErrors: AgentFieldErrorItem[];
  capabilities: string[];
}

// Disallow C0/DEL control bytes except tab (\x09), LF (\x0a), and CR (\x0d).
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function hasDisallowedControlChars(value: string): boolean {
  return DISALLOWED_CONTROL_RE.test(value);
}

const CI_ONLY_BARE_CAPABILITIES = new Set([
  "package-publish",
  "registry-push",
  "image-signing",
]);

function isCiOnlyCapabilityToken(
  token: string,
  parsedWith?: Record<string, unknown>,
): boolean {
  const lower = token.toLowerCase();
  if (CI_ONLY_BARE_CAPABILITIES.has(lower)) return true;
  if (lower.startsWith("repo-read:") || lower.startsWith("repo-write:")) {
    return true;
  }
  const ref = token.split("=", 1)[0].trim();
  if (
    ref.startsWith("release#") ||
    ref.startsWith("https://grain.dev/capabilities/release#")
  ) {
    return true;
  }
  if (
    ref === "repo#read" ||
    ref === "repo#target" ||
    ref === "https://grain.dev/capabilities/repo#read" ||
    ref === "https://grain.dev/capabilities/repo#target"
  ) {
    return true;
  }
  if (
    ref === "repo#write" ||
    ref === "https://grain.dev/capabilities/repo#write"
  ) {
    if (
      parsedWith &&
      "repo" in parsedWith &&
      !("refs" in parsedWith) &&
      !("force" in parsedWith)
    ) {
      return true;
    }
  }
  return false;
}

function isGrainCiCapability(token: string): boolean {
  const ref = token.split("=", 1)[0].trim().toLowerCase();
  return (
    ref === "grain-ci" ||
    ref === "grain#ci" ||
    ref === "https://grain.dev/capabilities/grain#ci"
  );
}

export function parseCapabilityListInput(raw: string): {
  capabilities: string[];
  error: string | null;
} {
  if (hasDisallowedControlChars(raw)) {
    return {
      capabilities: [],
      error: "Default capabilities contains invalid control characters.",
    };
  }
  if (raw.trim() === "") {
    return { capabilities: [], error: null };
  }

  const segments: string[] = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      current += ch;
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
      current += ch;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      current += ch;
      continue;
    }
    if (ch === "}") {
      if (braceDepth === 0) {
        return {
          capabilities: [],
          error: "Default capabilities has an unexpected '}' brace.",
        };
      }
      braceDepth--;
      current += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth++;
      current += ch;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth === 0) {
        return {
          capabilities: [],
          error: "Default capabilities has an unexpected ']' bracket.",
        };
      }
      bracketDepth--;
      current += ch;
      continue;
    }
    if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  if (inString || braceDepth !== 0 || bracketDepth !== 0) {
    return {
      capabilities: [],
      error: "Default capabilities has unclosed JSON braces or quotes.",
    };
  }
  segments.push(current);

  const capabilities: string[] = [];
  for (const seg of segments) {
    const token = seg.trim();
    if (!token) {
      return {
        capabilities: [],
        error:
          "Default capabilities contains an empty entry between commas; remove extra commas.",
      };
    }

    const eq = token.indexOf("=");
    if (eq >= 0) {
      const ref = token.slice(0, eq);
      const rawArgs = token.slice(eq + 1);
      if (!ref || /\s/.test(ref) || !ref.includes("#")) {
        return {
          capabilities: [],
          error: `Capability "${token}" must use <server>#<method>=<json> syntax.`,
        };
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        return {
          capabilities: [],
          error: `Capability "${ref}" has invalid JSON arguments (expected a JSON object).`,
        };
      }
      if (
        !parsedArgs ||
        typeof parsedArgs !== "object" ||
        Array.isArray(parsedArgs)
      ) {
        return {
          capabilities: [],
          error: `Capability "${ref}" arguments must be a JSON object.`,
        };
      }
      if (isGrainCiCapability(ref)) {
        return {
          capabilities: [],
          error:
            "grain#ci is managed by Repository CI mode and cannot be added to default capabilities.",
        };
      }
      if (isCiOnlyCapabilityToken(ref, parsedArgs as Record<string, unknown>)) {
        return {
          capabilities: [],
          error: `"${ref}" is a CI-only capability; configure it under CI & Workflows → CI capabilities instead.`,
        };
      }
      capabilities.push(token);
      continue;
    }

    if (/\s/.test(token)) {
      return {
        capabilities: [],
        error: `Capability "${token}" cannot contain spaces; separate capabilities with commas.`,
      };
    }
    if (isGrainCiCapability(token)) {
      return {
        capabilities: [],
        error:
          "grain#ci is managed by Repository CI mode and cannot be added to default capabilities.",
      };
    }
    if (isCiOnlyCapabilityToken(token)) {
      return {
        capabilities: [],
        error: `"${token}" is a CI-only capability; configure it under CI & Workflows → CI capabilities instead.`,
      };
    }
    if (token.startsWith("api:")) {
      const rest = token.slice(4);
      const at = rest.indexOf("@");
      if (!rest || at === 0 || (at >= 0 && !rest.slice(at + 1))) {
        return {
          capabilities: [],
          error: `API scope grant "${token}" must follow api:<scope> or api:<scope>@<owner/name>.`,
        };
      }
    }
    capabilities.push(token);
  }

  return { capabilities, error: null };
}

export function validateAgentSettingsForm(input: {
  canWriteSetup: boolean;
  setupCommand: string;
  canWritePrompt: boolean;
  promptExtension: string;
  canWriteCaps: boolean;
  repoCaps: string;
  agentsCapsLoadFailed: boolean;
  agentsCapsDirty: boolean;
}): AgentFormValidationResult {
  const fieldErrors: Partial<Record<AgentFieldKey, string>> = {};
  const orderedErrors: AgentFieldErrorItem[] = [];

  if (input.canWriteSetup && hasDisallowedControlChars(input.setupCommand)) {
    const message =
      "Sandbox setup command contains invalid control characters.";
    fieldErrors.setupCommand = message;
    orderedErrors.push({
      field: "setupCommand",
      label: "Sandbox setup command",
      message,
    });
  }

  if (
    input.canWritePrompt &&
    hasDisallowedControlChars(input.promptExtension)
  ) {
    const message =
      "Standing prompt extension contains invalid control characters.";
    fieldErrors.promptExtension = message;
    orderedErrors.push({
      field: "promptExtension",
      label: "Standing prompt extension",
      message,
    });
  }

  let capabilities: string[] = [];
  if (input.canWriteCaps) {
    if (input.agentsCapsLoadFailed && !input.agentsCapsDirty) {
      const message =
        "Default capabilities failed to load; retry loading before saving so existing capabilities are not overwritten.";
      fieldErrors.repoCaps = message;
      orderedErrors.push({
        field: "repoCaps",
        label: "Default capabilities",
        message,
      });
    } else {
      const parsed = parseCapabilityListInput(input.repoCaps);
      if (parsed.error) {
        fieldErrors.repoCaps = parsed.error;
        orderedErrors.push({
          field: "repoCaps",
          label: "Default capabilities",
          message: parsed.error,
        });
      } else {
        capabilities = parsed.capabilities;
      }
    }
  }

  return {
    valid: orderedErrors.length === 0,
    fieldErrors,
    orderedErrors,
    capabilities,
  };
}
