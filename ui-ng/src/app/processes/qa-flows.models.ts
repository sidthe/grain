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

import type { QAFlowSpec } from "../api/models";

export const MAX_ACTIVE_PROMPT_BUDGET_BYTES = 8192;

export const BUILTIN_READABILITY_PACK_IDS = [
  "go",
  "ts-angular",
  "python",
  "cpp",
] as const;

export const BUILTIN_READABILITY_PACKS: Readonly<
  Record<
    string,
    { readonly label: string; readonly text: string; readonly globs: string[] }
  >
> = {
  go: {
    label: "Go Readability Pack",
    globs: ["**/*.go", "go.mod", "go.sum"],
    text: `Go readability rules (pack: go):
- Return errors with actionable context (fmt.Errorf("pkg: operation: %w", err)); never ignore returned errors silently.
- Accept interfaces at consumer boundaries and return concrete types; keep package names short, lowercase, single-word nouns without stutter.
- Thread context.Context as the first parameter on I/O and blocking calls; guard shared state with explicit synchronization and ensure goroutines exit on cancellation.
- Prefer table-driven subtests (t.Run) with deterministic assertions and zero time.Sleep synchronization.`,
  },
  "ts-angular": {
    label: "TypeScript & Angular Readability Pack",
    globs: ["**/*.ts", "**/*.html", "**/*.css"],
    text: `TypeScript & Angular readability rules (pack: ts-angular):
- Build standalone Angular components with ChangeDetectionStrategy.OnPush, signal()/computed() state, and native @if/@for template control flow.
- Keep templates declarative without side effects; enforce strict TypeScript types and avoid any or unsafe non-null assertions.
- Clean up subscriptions with takeUntilDestroyed(); keep component styles within budget and provide ARIA labels and keyboard navigation on interactive elements.`,
  },
  python: {
    label: "Python Readability Pack",
    globs: ["**/*.py"],
    text: `Python readability rules (pack: python):
- Annotate public functions, methods, and data structures (dataclass or TypedDict) with explicit PEP 484 type hints.
- Never use mutable default arguments (use None and initialize inside the function); catch specific exception subclasses rather than bare except.
- Manage files, locks, and network sessions with context managers (with); prefer pathlib.Path and clear generator/comprehension expressions.`,
  },
  cpp: {
    label: "C++ Readability Pack",
    globs: ["**/*.cc", "**/*.cpp", "**/*.h", "**/*.hpp"],
    text: `C++ readability rules (pack: cpp):
- Manage resource lifetime deterministically via RAII (std::unique_ptr, scoped locks/handles); avoid raw owning new and delete.
- Pass read-only non-primitive arguments by const reference, std::string_view, or std::span<const T>; mark single-argument constructors explicit.
- Validate container bounds and integer overflow/wraparound before indexing or arithmetic; keep headers self-contained with minimal transitive includes.`,
  },
};

export interface WorkflowStepView {
  id: string;
  label: string;
  kind: string;
  stageId: string;
  enabled: boolean;
  mode?: string;
  scope?: string;
  lockedFloor?: boolean;
  summary?: string;
  text?: string;
  bytes?: number;
}

export interface WorkflowStageView {
  id: string;
  index: number;
  label: string;
  boundary: string;
  enabled: boolean;
  mode: string;
  summary: string;
  steps: WorkflowStepView[];
}

export interface DecomposeDecl {
  enabled?: boolean;
  mode?: "off" | "slice_plan" | "propose_dag" | string;
  complexities?: string[];
  maxSubtasks?: number;
  "max-subtasks"?: number;
  targetDiffLines?: number;
  "target-diff-lines"?: number;
}

export interface ContextDiscoveryDecl {
  enabled?: boolean;
  includeCallers?: boolean;
  "include-callers"?: boolean;
  includeMemory?: boolean;
  "include-memory"?: boolean;
  maxTokens?: number;
  "max-tokens"?: number;
  extraPaths?: string[];
  "extra-paths"?: string[];
}

export interface ReadabilityPackDecl {
  id: string;
  enabled: boolean;
  activation?: "auto" | "always" | "glob" | string;
  globs?: string[];
  customText?: string;
  "custom-text"?: string;
}

export interface SkillStepDecl {
  id: string;
  label?: string;
  stage: "s0" | "s2" | "coding" | "pr" | "s4" | string;
  enabled: boolean;
  globs?: string[];
  maxBytes?: number;
  "max-bytes"?: number;
  text?: string;
}

export interface PRContractDecl {
  enabled?: boolean;
  mode?: "off" | "warn" | "blocking" | string;
  maxSubjectChars?: number;
  "max-subject-chars"?: number;
  requiredSections?: string[];
  "required-sections"?: string[];
  auditLintSuppressions?: boolean;
  "audit-lint-suppressions"?: boolean;
  guidanceText?: string;
  "guidance-text"?: string;
}

export interface CustomCheckFixtureItem {
  readonly name?: string;
  readonly file?: string;
  readonly "added-lines"?: readonly string[];
  readonly addedLines?: readonly string[];
  readonly "changed-files"?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly content?: string;
}

export interface CustomCheckDeclarationV3 {
  readonly id?: string;
  readonly label?: string;
  readonly kind?: "pattern" | "diff-budget" | "companion" | "jsonschema";
  readonly engine?: "pattern" | "diff-budget" | "companion" | "jsonschema";
  readonly severity?: "blocking" | "warn" | "shadow";
  readonly message?: string;
  readonly paths?: readonly string[];
  readonly exclude?: readonly string[];
  readonly "forbid-added"?: string;
  readonly forbidAdded?: string;
  readonly "require-added"?: string;
  readonly requireAdded?: string;
  readonly "max-changed-lines"?: number;
  readonly maxChangedLines?: number;
  readonly "max-files"?: number;
  readonly maxFiles?: number;
  readonly "when-changed"?: readonly string[];
  readonly whenChanged?: readonly string[];
  readonly "require-changed"?: readonly string[];
  readonly requireChanged?: readonly string[];
  readonly "allow-waiver"?: boolean;
  readonly allowWaiver?: boolean;
  readonly "schema-json"?: Readonly<Record<string, unknown>>;
  readonly schemaJson?: Readonly<Record<string, unknown>>;
  readonly fixtures?: {
    readonly fail?: readonly unknown[];
    readonly pass?: readonly unknown[];
  };
}

export interface CustomStageDeclarationV3 {
  readonly id: string;
  readonly label?: string;
  readonly "insert-after"?: "s2" | "s3" | "s4";
  readonly insertAfter?: "s2" | "s3" | "s4";
  readonly kind?: string;
  readonly "when-paths"?: readonly string[];
  readonly whenPaths?: readonly string[];
  readonly "min-tier"?: string;
  readonly minTier?: string;
  readonly "timeout-seconds"?: number;
  readonly timeoutSeconds?: number;
  readonly "check-ids"?: readonly string[];
  readonly checkIds?: readonly string[];
}

export interface FlowDeclarationV3 {
  readonly schema: "grain.dev/qa-flow/v3";
  readonly key?: string;
  readonly extends?: string;
  readonly label?: string;
  readonly summary?: string;
  readonly skills?: Readonly<Record<string, unknown>>;
  readonly stages?: {
    readonly "s0-intent"?:
      | boolean
      | {
          readonly enabled?: boolean;
          readonly complexities?: readonly string[];
          readonly "max-seconds"?: number;
          readonly maxSeconds?: number;
          readonly "max-tokens"?: number;
          readonly maxTokens?: number;
          readonly "on-clarification"?: string;
          readonly onClarification?: string;
        };
    readonly "s1-risk"?: boolean | Readonly<Record<string, unknown>>;
    readonly "s2-plan-critic"?:
      | boolean
      | {
          readonly enabled?: boolean;
          readonly complexities?: readonly string[];
          readonly tiers?: readonly string[];
          readonly "max-seconds"?: number;
          readonly maxSeconds?: number;
          readonly "max-tokens"?: number;
          readonly maxTokens?: number;
          readonly "max-bounces"?: number;
          readonly maxBounces?: number;
        };
    readonly "s5-merge-triage"?:
      | "off"
      | "shadow"
      | "enforced"
      | {
          readonly mode?: "off" | "shadow" | "enforced";
          readonly "auto-merge-tiers"?: readonly string[];
          readonly autoMergeTiers?: readonly string[];
          readonly "require-human-tiers"?: readonly string[];
          readonly requireHumanTiers?: readonly string[];
        };
    readonly custom?: readonly CustomStageDeclarationV3[];
  };
  readonly checks?: Record<
    string,
    {
      enabled?: boolean;
      severity?: "blocking" | "warn" | "shadow";
      params?: Record<string, unknown>;
    }
  >;
  readonly customChecks?:
    | readonly CustomCheckDeclarationV3[]
    | Readonly<Record<string, CustomCheckDeclarationV3>>;
  readonly "custom-checks"?:
    | readonly CustomCheckDeclarationV3[]
    | Readonly<Record<string, CustomCheckDeclarationV3>>;
}

export interface FlowDeclarationV4 {
  schema: "grain.dev/qa-flow/v4";
  key: string;
  extends?: string;
  label?: string;
  summary?: string;
  stopNudge?: boolean;
  "stop-nudge"?: boolean;
  stagingIsolation?: boolean;
  "staging-isolation"?: boolean;
  decompose?: DecomposeDecl;
  context?: ContextDiscoveryDecl;
  skills?: Readonly<Record<string, unknown>>;
  readabilityPacks?: ReadabilityPackDecl[];
  "readability-packs"?: ReadabilityPackDecl[];
  skillSteps?: SkillStepDecl[];
  "skill-steps"?: SkillStepDecl[];
  stages?: FlowDeclarationV3["stages"];
  prContract?: PRContractDecl;
  "pr-contract"?: PRContractDecl;
  checks?: Record<
    string,
    {
      enabled?: boolean;
      severity?: "blocking" | "warn" | "shadow";
      params?: Record<string, unknown>;
    }
  >;
  customChecks?:
    | readonly CustomCheckDeclarationV3[]
    | Readonly<Record<string, CustomCheckDeclarationV3>>;
  "custom-checks"?:
    | readonly CustomCheckDeclarationV3[]
    | Readonly<Record<string, CustomCheckDeclarationV3>>;
  verifier?: {
    enabled?: boolean;
    tiers?: string[];
    maxRepairRounds?: number;
    "max-repair-rounds"?: number;
    maxSeconds?: number;
    "max-seconds"?: number;
    maxTokens?: number;
    "max-tokens"?: number;
    checklist?: string;
  };
}

export interface FlowDeclarationV2 {
  schema:
    "grain.dev/qa-flow/v2" | "grain.dev/qa-flow/v3" | "grain.dev/qa-flow/v4";
  key: string;
  extends?: string;
  label: string;
  summary?: string;
  declarationV3?: FlowDeclarationV3;
  declarationV4?: FlowDeclarationV4;
  skill: {
    mode: "inherit" | "append" | "replace";
    text: string;
    maxBytes: number;
  };
  stopNudge: boolean;
  stagingIsolation: boolean;
  checks: Record<
    string,
    {
      enabled?: boolean;
      severity?: "blocking" | "warn" | "shadow";
      params?: Record<string, unknown>;
    }
  >;
  verifier: {
    enabled: boolean;
    tiers: string[];
    maxRepairRounds: number;
    maxSeconds: number;
    maxTokens: number;
    checklist: string;
  };
}

export interface QAFlowVersionItem {
  hash: string;
  key: string;
  version: number;
  parentHash?: string;
  label: string;
  summary: string;
  builtIn?: boolean;
  qaEngineRev: number;
  createdBy?: string;
  createdAt?: string;
  retiredAt?: string | null;
  sourceYaml?: string;
  declaration?: FlowDeclarationV2;
  declarationV3?: FlowDeclarationV3;
  declarationV4?: FlowDeclarationV4;
  stagesView?: WorkflowStageView[];
  schemaVer?: string;
  sourceKind?: string;
  sourceRepo?: string;
  sourcePath?: string;
  sourceCommit?: string;
  resolved?: QAFlowSpec;
}

export interface QAFlowVersionDetail extends QAFlowVersionItem {
  lineage?: QAFlowVersionItem[];
}

export interface QAFlowVersionsResponse {
  versions: QAFlowVersionItem[];
}

export interface QADryRunResponse {
  dryRun: true;
  valid: boolean;
  hash: string;
  sampledPRs: number;
  wouldBlockPRs: number;
  byCheck: Array<{
    ruleId: string;
    wouldBlock: number;
    warnCount: number;
    findings?: Array<{
      filePath?: string;
      line?: number;
      summary: string;
    }>;
  }>;
}

export interface QAFlowPublishResponse {
  version: QAFlowVersionItem;
  hash?: string;
}

export type QAFlowPublishRequest =
  | { declaration: FlowDeclarationV2 | FlowDeclarationV3 | FlowDeclarationV4 }
  | { yaml: string }
  | { action: "retire"; hash: string };

export interface QAAdoptResponse {
  dryRun?: boolean;
  valid?: boolean;
  hash: string;
  version?: QAFlowVersionItem;
  sampledPRs?: number;
  wouldBlockPRs?: number;
}

export interface QAProbeResponse {
  complexity: {
    tier: "low" | "medium" | "high";
    score: number;
    signals: string[];
    hasDesignItem: boolean;
  };
  risk: {
    tier: "T0" | "T1" | "T2" | "T3";
    score: number;
    signals: string[];
    testTampered: boolean;
    trustBoundary: boolean;
  };
  stagesFired: string[];
  triage: {
    decision: "auto_merge" | "require_human";
    enforced: boolean;
    mode: "off" | "shadow" | "enforced";
    tier: string;
    blastScore: number;
    reasons: string[];
    blockedByFloor: boolean;
  };
}

export interface FixtureSelfTestResult {
  readonly valid: boolean;
  readonly failTrapCaught: boolean;
  readonly cleanPassGreen: boolean;
  readonly failCount: number;
  readonly passCount: number;
  readonly summary: string;
}

export function evaluateInlineCheckFixtures(
  check: CustomCheckDeclarationV3,
): FixtureSelfTestResult {
  const failList = Array.isArray(check.fixtures?.fail)
    ? (check.fixtures!.fail as CustomCheckFixtureItem[])
    : [];
  const passList = Array.isArray(check.fixtures?.pass)
    ? (check.fixtures!.pass as CustomCheckFixtureItem[])
    : [];
  if (failList.length === 0 || passList.length === 0) {
    return {
      valid: false,
      failTrapCaught: failList.length > 0,
      cleanPassGreen: passList.length > 0,
      failCount: failList.length,
      passCount: passList.length,
      summary:
        "Requires at least 1 Fail trap fixture and 1 Clean pass fixture.",
    };
  }
  const engine = check.kind ?? check.engine ?? "pattern";
  let failTrapCaught = true;
  let cleanPassGreen = true;

  if (engine === "pattern") {
    const rawForbid = check["forbid-added"] ?? check.forbidAdded ?? "";
    if (rawForbid) {
      try {
        const re = new RegExp(rawForbid);
        for (const f of failList) {
          const lines = f["added-lines"] ?? f.addedLines ?? [];
          if (lines.length > 0 && !lines.some((l) => re.test(l))) {
            failTrapCaught = false;
          }
        }
        for (const p of passList) {
          const lines = p["added-lines"] ?? p.addedLines ?? [];
          const file = p.file ?? "";
          const excluded = (check.exclude ?? []).some((ex) =>
            file.endsWith(ex.replace(/^\*\*\/\*/, "")),
          );
          if (!excluded && lines.some((l) => re.test(l))) {
            cleanPassGreen = false;
          }
        }
      } catch {
        return {
          valid: false,
          failTrapCaught: false,
          cleanPassGreen: false,
          failCount: failList.length,
          passCount: passList.length,
          summary: "Invalid forbid-added regular expression.",
        };
      }
    }
  } else if (engine === "companion") {
    const reqChanged = check["require-changed"] ?? check.requireChanged ?? [];
    if (reqChanged.length > 0) {
      for (const f of failList) {
        const changed = f["changed-files"] ?? f.changedFiles ?? [];
        if (
          changed.length > 0 &&
          reqChanged.every((r) => changed.includes(r))
        ) {
          failTrapCaught = false;
        }
      }
      for (const p of passList) {
        const changed = p["changed-files"] ?? p.changedFiles ?? [];
        if (
          changed.length > 0 &&
          !reqChanged.some((r) => changed.includes(r))
        ) {
          cleanPassGreen = false;
        }
      }
    }
  }

  const valid = failTrapCaught && cleanPassGreen;
  return {
    valid,
    failTrapCaught,
    cleanPassGreen,
    failCount: failList.length,
    passCount: passList.length,
    summary: valid
      ? `All ${failList.length} fail trap(s) caught and ${passList.length} clean pass fixture(s) verified.`
      : "Fixture self-test failed: check fail trap or clean pass expectations.",
  };
}

const DEFAULT_BUILTIN_CHECKS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly severity: string;
  readonly summary: string;
  readonly floor?: boolean;
}> = [
  {
    id: "golden:test-integrity-guard",
    label: "Test Assertion & Integrity Floor",
    severity: "blocking",
    summary: "Rejects assertion-free tests and weakened existing assertions.",
    floor: true,
  },
  {
    id: "golden:strict-config-decoder",
    label: "Strict Config & Declaration Decoder Floor",
    severity: "blocking",
    summary: "Requires KnownFields(true) / DisallowUnknownFields on decoders.",
    floor: true,
  },
  {
    id: "golden:sibling-export-hazard",
    label: "Sibling Export & Caller Hazard Gate",
    severity: "warn",
    summary: "Verifies sibling callers by import path when exports change.",
  },
  {
    id: "golden:ui-budget-and-spec-floor",
    label: "UI Style Budget & Component Spec Floor",
    severity: "blocking",
    summary: "Enforces component CSS budgets and unit spec coverage.",
  },
  {
    id: "golden:exported-surface-delta",
    label: "Exported API Surface Delta Gate",
    severity: "warn",
    summary: "Tracks unrequested exported symbol expansions.",
  },
  {
    id: "golden:test-hygiene",
    label: "Test Determinism & Hygiene Gate",
    severity: "warn",
    summary:
      "Flags sleeps, network calls, and non-deterministic test patterns.",
  },
  {
    id: "golden:mutation-hardening",
    label: "Differential Mutation Hardening",
    severity: "warn",
    summary: "Verifies tests catch targeted AST mutations on changed lines.",
  },
  {
    id: "golden:boundary-fuzz",
    label: "Boundary & Overflow Fuzz Gate",
    severity: "warn",
    summary: "Checks arithmetic wraparound and slice bounds on sizes/offsets.",
  },
];

export function buildFallbackStagesView(
  item?: QAFlowVersionItem | QAFlowVersionDetail | null,
): WorkflowStageView[] {
  if (item?.stagesView && item.stagesView.length === 8) {
    return item.stagesView;
  }
  const v4 = item?.declarationV4 ?? item?.declaration?.declarationV4;
  const v3 = item?.declarationV3 ?? item?.declaration?.declarationV3 ?? v4;
  const v2 = item?.declaration;
  const res = item?.resolved;

  const s0Raw = v3?.stages?.["s0-intent"];
  const s0IntentOn =
    typeof s0Raw === "boolean"
      ? s0Raw
      : Boolean(
          s0Raw?.enabled ??
          v4?.decompose?.enabled ??
          item?.schemaVer?.endsWith("v3") ??
          item?.schemaVer?.endsWith("v4"),
        );
  const decompOn = Boolean(v4?.decompose?.enabled);
  const decompMode = decompOn ? (v4?.decompose?.mode ?? "slice_plan") : "off";

  const s0Steps: WorkflowStepView[] = [
    {
      id: "s0:intent",
      label: "Intent & Acceptance Criteria Extraction",
      kind: "llm_gate",
      stageId: "s0-decompose",
      enabled: s0IntentOn,
      mode: s0IntentOn ? "warn" : "off",
      scope: "medium, high",
      summary:
        "Extracts testable WHEN/SHALL acceptance criteria and explicit non-goals before planning.",
    },
    {
      id: "s0:decompose",
      label: "Subtask & Slice Decomposition",
      kind: "decomposition",
      stageId: "s0-decompose",
      enabled: decompOn,
      mode: decompMode,
      scope: (v4?.decompose?.complexities ?? ["high"]).join(", "),
      summary: `Breaks high-complexity work into bounded slices (maxSubtasks=${v4?.decompose?.maxSubtasks ?? v4?.decompose?.["max-subtasks"] ?? 5}, targetDiffLines=${v4?.decompose?.targetDiffLines ?? v4?.decompose?.["target-diff-lines"] ?? 400}).`,
    },
  ];

  const ctxOn = Boolean(v4?.context?.enabled);
  const s1Steps: WorkflowStepView[] = [
    {
      id: "s1:blast-radius",
      label: "0..100 Blast-Radius Classifier (T0–T3)",
      kind: "classifier",
      stageId: "s1-context",
      enabled: true,
      mode: "enforced",
      lockedFloor: true,
      summary:
        "Classifies diff blast radius across T0–T3 from touched packages, sibling caller fan-in, and trust boundaries.",
    },
    {
      id: "s1:context-discovery",
      label: "Caller & Memory Context Discovery",
      kind: "context_discovery",
      stageId: "s1-context",
      enabled: ctxOn,
      mode: ctxOn ? "auto" : "off",
      scope: (
        v4?.context?.extraPaths ??
        v4?.context?.["extra-paths"] ??
        []
      ).join(", "),
      summary: `Pre-populates sibling callers and repository memory up to ${v4?.context?.maxTokens ?? v4?.context?.["max-tokens"] ?? 12000} tokens.`,
    },
  ];

  const s2Raw = v3?.stages?.["s2-plan-critic"];
  const s2PlanOn =
    typeof s2Raw === "boolean"
      ? s2Raw
      : Boolean(
          s2Raw?.enabled ??
          item?.schemaVer?.endsWith("v3") ??
          item?.schemaVer?.endsWith("v4"),
        );
  const s2PlanSteps: WorkflowStepView[] = [
    {
      id: "s2:plan-critic",
      label: "Fresh-Context Plan Critic",
      kind: "llm_critic",
      stageId: "s2-plan",
      enabled: s2PlanOn,
      mode: s2PlanOn ? "enforced" : "off",
      scope: "medium, high · T2, T3",
      summary:
        "Critiques the proposed file plan and sibling caller coverage in an isolated context before coding.",
    },
  ];

  const skillText = v2?.skill?.text || item?.sourceYaml || item?.summary || "";
  const injectSkill = res ? res.injectSkill : true;
  const s2CodingSteps: WorkflowStepView[] = [
    {
      id: "coding:base-skill",
      label: "Core Coding Contract",
      kind: "skill",
      stageId: "s2-coding",
      enabled: injectSkill,
      mode: injectSkill ? (v2?.skill?.mode ?? "replace") : "off",
      summary:
        "Primary coding-time engineering contract injected into the sandbox session.",
      text: skillText,
      bytes: res?.skillBytes ?? new TextEncoder().encode(skillText).length,
    },
  ];

  const rawPacks: readonly ReadabilityPackDecl[] =
    v4?.readabilityPacks ??
    v4?.["readability-packs"] ??
    BUILTIN_READABILITY_PACK_IDS.map((id) => ({
      id,
      enabled: Boolean(v4),
      activation: "auto",
    }));
  for (const rp of rawPacks) {
    const meta = BUILTIN_READABILITY_PACKS[rp.id] ?? {
      label: `Readability Pack (${rp.id})`,
      text: rp.customText ?? rp["custom-text"] ?? "",
      globs: rp.globs ?? [],
    };
    const act = rp.activation || "auto";
    const txt = [meta.text, rp.customText ?? rp["custom-text"] ?? ""]
      .filter(Boolean)
      .join("\n");
    s2CodingSteps.push({
      id: `readability:${rp.id}`,
      label: meta.label,
      kind: "readability_pack",
      stageId: "s2-coding",
      enabled: rp.enabled,
      mode: act,
      scope: (rp.globs ?? meta.globs).join(", "),
      summary: `Portable ${rp.id} readability guidance (${act} activation).`,
      text: txt,
      bytes: new TextEncoder().encode(txt).length,
    });
  }

  const rawSkillSteps = v4?.skillSteps ?? v4?.["skill-steps"] ?? [];
  for (const st of rawSkillSteps) {
    const stepView: WorkflowStepView = {
      id: st.id,
      label: st.label || st.id,
      kind: "skill_step",
      stageId:
        st.stage === "s0"
          ? "s0-decompose"
          : st.stage === "s2"
            ? "s2-plan"
            : st.stage === "pr"
              ? "s3-pr"
              : st.stage === "s4"
                ? "s4-verify"
                : "s2-coding",
      enabled: st.enabled,
      mode: st.stage || "coding",
      scope: (st.globs ?? []).join(", "),
      summary: `Stage-scoped skill step (${st.stage}).`,
      text: st.text ?? "",
      bytes: new TextEncoder().encode(st.text ?? "").length,
    };
    if (st.stage === "s0") s0Steps.push(stepView);
    else if (st.stage === "s2") s2PlanSteps.push(stepView);
    else if (st.stage === "coding") s2CodingSteps.push(stepView);
  }

  const s3CheckSteps: WorkflowStepView[] = [];
  if (res?.rules && res.rules.length > 0) {
    for (const r of res.rules) {
      if (
        r.id === "golden:s4-orthogonal-verifier" ||
        r.id === "golden:pr-description-contract"
      ) {
        continue;
      }
      const isFloor =
        r.id === "golden:test-integrity-guard" ||
        r.id === "golden:strict-config-decoder" ||
        r.id === "go-test-assertion-floor";
      s3CheckSteps.push({
        id: r.id,
        label: r.label || r.id,
        kind: "deterministic_check",
        stageId: "s3-checks",
        enabled: r.enabled ?? true,
        mode: r.severity || "blocking",
        scope: (r.targetPaths ?? []).join(", "),
        lockedFloor: isFloor,
        summary: r.summary,
      });
    }
  } else {
    for (const def of DEFAULT_BUILTIN_CHECKS) {
      const cfg = v2?.checks?.[def.id] ?? v4?.checks?.[def.id];
      s3CheckSteps.push({
        id: def.id,
        label: def.label,
        kind: "deterministic_check",
        stageId: "s3-checks",
        enabled: def.floor ? true : (cfg?.enabled ?? true),
        mode: def.floor ? "blocking" : (cfg?.severity ?? def.severity),
        lockedFloor: Boolean(def.floor),
        summary: def.summary,
      });
    }
  }

  const rawCustomChecks = v3?.["custom-checks"] ?? v3?.customChecks;
  const customCheckList: readonly CustomCheckDeclarationV3[] = Array.isArray(
    rawCustomChecks,
  )
    ? rawCustomChecks
    : rawCustomChecks
      ? Object.values(rawCustomChecks)
      : [];
  for (let i = 0; i < customCheckList.length; i++) {
    const cc = customCheckList[i];
    const kind = cc.kind ?? cc.engine ?? "pattern";
    const id = cc.id || `custom:check-${i}`;
    s3CheckSteps.push({
      id,
      label: cc.label || id,
      kind: `custom_check:${kind}`,
      stageId: "s3-checks",
      enabled: true,
      mode: cc.severity || "blocking",
      scope: [
        ...(cc.paths ?? []),
        ...(cc["when-changed"] ?? cc.whenChanged ?? []),
      ].join(", "),
      summary: cc.message || `Custom ${kind} check with inline fixtures.`,
    });
  }

  for (const cs of v3?.stages?.custom ?? []) {
    const after = cs["insert-after"] ?? cs.insertAfter ?? "s3";
    const stageId =
      after === "s2" ? "s2-plan" : after === "s4" ? "s4-verify" : "s3-checks";
    const step: WorkflowStepView = {
      id: cs.id,
      label: cs.label || cs.id,
      kind: "custom_stage",
      stageId,
      enabled: true,
      mode: cs.kind || "deterministic_batch",
      scope: (cs["when-paths"] ?? cs.whenPaths ?? []).join(", "),
      summary: `Custom stage (insert-after=${after}, timeout=${cs["timeout-seconds"] ?? cs.timeoutSeconds ?? 30}s).`,
    };
    if (after === "s2") s2PlanSteps.push(step);
    else if (after === "s3") s3CheckSteps.push(step);
  }

  const prc = v4?.prContract ?? v4?.["pr-contract"];
  const prcOn = Boolean(prc?.enabled);
  const prcMode = prcOn ? prc?.mode || "warn" : "off";
  const reqSecs = prc?.requiredSections ??
    prc?.["required-sections"] ?? ["Summary", "Verification"];
  const prGuidance = prc?.guidanceText ?? prc?.["guidance-text"] ?? "";
  const stopNudgeOn = v2?.stopNudge ?? v4?.stopNudge ?? res?.stopNudge ?? true;
  const s3PRSteps: WorkflowStepView[] = [
    {
      id: "pr:stop-nudge",
      label: "Pre-PR Self-Review Stop Nudge",
      kind: "nudge",
      stageId: "s3-pr",
      enabled: stopNudgeOn,
      mode: stopNudgeOn ? "enforced" : "off",
      summary:
        "Prompts the agent to verify build, vet, and tests on final HEAD before opening a pull request.",
    },
    {
      id: "pr:contract",
      label: "PR Subject, Sections & Lint-Suppression Contract",
      kind: "pr_contract",
      stageId: "s3-pr",
      enabled: prcOn,
      mode: prcMode,
      scope: reqSecs.join(", "),
      summary: `Subject <= ${prc?.maxSubjectChars ?? prc?.["max-subject-chars"] ?? 72} chars, required sections (${reqSecs.join(", ")}), auditLintSuppressions=${prc?.auditLintSuppressions ?? prc?.["audit-lint-suppressions"] ?? true}.`,
      text: prGuidance,
      bytes: new TextEncoder().encode(prGuidance).length,
    },
  ];
  for (const st of rawSkillSteps) {
    if (st.stage === "pr") {
      s3PRSteps.push({
        id: st.id,
        label: st.label || st.id,
        kind: "skill_step",
        stageId: "s3-pr",
        enabled: st.enabled,
        mode: "pr",
        scope: (st.globs ?? []).join(", "),
        text: st.text ?? "",
        bytes: new TextEncoder().encode(st.text ?? "").length,
      });
    }
  }

  const s4Enabled =
    v2?.verifier?.enabled ?? v4?.verifier?.enabled ?? res?.enableS4 ?? true;
  const s4Tiers = v2?.verifier?.tiers ?? v4?.verifier?.tiers ?? ["T2", "T3"];
  const s4Rounds =
    v2?.verifier?.maxRepairRounds ??
    v4?.verifier?.maxRepairRounds ??
    res?.maxS4RepairRounds ??
    1;
  const s4Steps: WorkflowStepView[] = [
    {
      id: "golden:s4-orthogonal-verifier",
      label: "Fresh-Context Orthogonal Verifier + 6-Filter Inquisitor",
      kind: "llm_verifier",
      stageId: "s4-verify",
      enabled: s4Enabled,
      mode: s4Enabled ? "blocking" : "off",
      scope: s4Tiers.join(", "),
      summary: s4Enabled
        ? `${s4Tiers.join("/")} diffs (max ${s4Rounds} round)`
        : "disabled",
    },
  ];
  for (const st of rawSkillSteps) {
    if (st.stage === "s4") {
      s4Steps.push({
        id: st.id,
        label: st.label || st.id,
        kind: "skill_step",
        stageId: "s4-verify",
        enabled: st.enabled,
        mode: "s4",
        scope: (st.globs ?? []).join(", "),
        text: st.text ?? "",
        bytes: new TextEncoder().encode(st.text ?? "").length,
      });
    }
  }
  for (const cs of v3?.stages?.custom ?? []) {
    const after = cs["insert-after"] ?? cs.insertAfter ?? "s3";
    if (after === "s4") {
      s4Steps.push({
        id: cs.id,
        label: cs.label || cs.id,
        kind: "custom_stage",
        stageId: "s4-verify",
        enabled: true,
        mode: cs.kind || "isolated_critic",
        summary: `Custom stage after s4 (${cs.id}).`,
      });
    }
  }

  const s5Raw = v3?.stages?.["s5-merge-triage"];
  const triageMode = typeof s5Raw === "string" ? s5Raw : (s5Raw?.mode ?? "off");
  const triageOn = triageMode !== "off";
  const s5Steps: WorkflowStepView[] = [
    {
      id: "s5:merge-triage",
      label: "ComposeTightenOnly S5 Merge Triage",
      kind: "merge_triage",
      stageId: "s5-triage",
      enabled: triageOn,
      mode: triageMode,
      scope: "autoMerge=[T0,T1] humanReview=[T2,T3]",
      summary:
        "Combines blast-radius score, check verdicts, and tighten-only tier routing to decide auto-merge vs human review.",
    },
  ];

  const stagingIso =
    v2?.stagingIsolation ??
    v4?.stagingIsolation ??
    res?.stagingIsolation ??
    true;

  return [
    {
      id: "s0-decompose",
      index: 1,
      label: "1 · Goal & Subtask Breakdown",
      boundary: "Pre-Dispatch",
      enabled: s0IntentOn || decompOn,
      mode: decompOn ? decompMode : s0IntentOn ? "warn" : "off",
      summary:
        "Extracts testable acceptance criteria and decomposes high-complexity work before coding starts.",
      steps: s0Steps,
    },
    {
      id: "s1-context",
      index: 2,
      label: "2 · Context & Blast Radius",
      boundary: "Pre-Dispatch / Diff Risk",
      enabled: true,
      mode: ctxOn ? "context+blast" : "blast_radius",
      summary:
        "Discovers sibling callers and repository memory while scoring 0..100 diff blast radius (T0–T3).",
      steps: s1Steps,
    },
    {
      id: "s2-plan",
      index: 3,
      label: "3 · Plan & Fresh Critique",
      boundary: "Pre-Coding",
      enabled: s2PlanOn,
      mode: s2PlanOn ? "enforced" : "off",
      summary:
        "Reviews the proposed file plan and caller sweep in an isolated critic context.",
      steps: s2PlanSteps,
    },
    {
      id: "s2-coding",
      index: 4,
      label: "4 · Coding & Readability Rules",
      boundary: "In-Sandbox Authoring",
      enabled: s2CodingSteps.some((s) => s.enabled),
      mode: s2CodingSteps.some((s) => s.enabled) ? "active" : "off",
      summary:
        "Injects core coding contract, portable language readability packs, and stage skill steps.",
      steps: s2CodingSteps,
    },
    {
      id: "s3-checks",
      index: 5,
      label: "5 · Pre-PR Deterministic Gates",
      boundary: "Pre-PR Staging Ref",
      enabled: true,
      mode: stagingIso ? "staging_isolated" : "direct",
      summary:
        "Runs sub-second AST/diff integrity floors, sibling caller checks, mutation/fuzz gates, and custom checks.",
      steps: s3CheckSteps,
    },
    {
      id: "s3-pr",
      index: 6,
      label: "6 · PR Authoring & Self-Review",
      boundary: "Pull Request Open",
      enabled: stopNudgeOn || prcOn,
      mode: prcOn ? prcMode : stopNudgeOn ? "warn" : "off",
      summary:
        "Enforces pull request subject/section contract, lint-suppression audit, and pre-PR self-review.",
      steps: s3PRSteps,
    },
    {
      id: "s4-verify",
      index: 7,
      label: "7 · Adversarial Verification",
      boundary: "Fresh-Context Verifier",
      enabled: s4Enabled,
      mode: s4Enabled ? "blocking" : "off",
      summary:
        "Executes fresh-context orthogonal diff verification with 6-filter Inquisitor grounding.",
      steps: s4Steps,
    },
    {
      id: "s5-triage",
      index: 8,
      label: "8 · Scorecard & Merge Triage",
      boundary: "Post-Checks Merge Routing",
      enabled: triageOn,
      mode: triageMode,
      summary:
        "Routes green low-blast changes to auto-merge and high-blast T2/T3 changes to human review.",
      steps: s5Steps,
    },
  ];
}
