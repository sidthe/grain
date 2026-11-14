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

export interface FlowDeclarationV2 {
  schema: "grain.dev/qa-flow/v2";
  key: string;
  extends?: string;
  label: string;
  summary?: string;
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

export interface FlowDeclarationV3 {
  schema: "grain.dev/qa-flow/v3";
  skills?: Record<string, unknown>;
  stages?: {
    "s0-intent"?: boolean;
    "s1-risk"?: boolean;
    "s2-plan-critic"?: boolean;
    "s5-merge-triage"?: "off" | "shadow" | "enforced";
    custom?: unknown[];
  };
  customChecks?: Record<
    string,
    {
      engine: "pattern" | "diff-budget" | "companion" | "jsonschema";
      fixtures: { fail: unknown[]; pass: unknown[] };
    }
  >;
  "custom-checks"?: Record<
    string,
    {
      engine: "pattern" | "diff-budget" | "companion" | "jsonschema";
      fixtures: { fail: unknown[]; pass: unknown[] };
    }
  >;
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
}

export type QAFlowPublishRequest =
  | { declaration: FlowDeclarationV2 }
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
