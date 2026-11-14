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

export type FleetTab = "sandboxes" | "hostds" | "controls" | "logs";

export interface SandboxSnapshot {
  sandbox: string;
  kind: string;
  backend: string;
  name: string;
  cpus?: number;
  memoryMB?: number;
  diskGB?: number;
  networkAccess?: string;
  ready: boolean;
  error?: string;
  terminationReason?: string;
  loadAverage?: string;
  memoryUsedMB?: number;
  memoryTotalMB?: number;
  swapUsedMB?: number;
  swapTotalMB?: number;
  diskUsedMB?: number;
  diskTotalMB?: number;
  probeMS?: number;
  probeAgeMS?: number;
  nestedVirt?: string;
  startedAt?: string;
}

export interface DiskUsage {
  holds: string[];
  path: string;
  usedMB: number;
  totalMB: number;
  availableMB?: number;
  floorMB?: number;
  reclaimMB?: number;
  error?: string;
}

export interface HostPressure {
  loadAverage1: number;
  loadAverage5: number;
  loadAverage15: number;
  cpus?: number;
  cpuUtilization: number;
  memoryUsedMB: number;
  memoryTotalMB: number;
  memoryAvailableMB?: number;
  swapUsedMB: number;
  swapTotalMB: number;
  disks?: DiskUsage[];
  nestedVirt?: string;
  nestedVirtDetail?: string;
}

export interface SandboxBudgetPool {
  pool: string;
  count: number;
  cpus: number;
  memoryMB: number;
}

export interface SandboxBudgetReport {
  known?: boolean;
  mode?: string;
  hostCPUs?: number;
  hostMemoryMB?: number;
  budgetCPUs?: number;
  budgetMemoryMB?: number;
  committedCPUs: number;
  committedMemoryMB?: number;
  committedCount: number;
  withinCap: boolean;
  summary?: string;
  pools?: SandboxBudgetPool[];
}

export interface DaemonHealth {
  startedAt: string;
  starts?: number;
  requestedStarts?: number;
  restarting?: boolean;
  startsScope?: string;
  windowMinutes?: number;
  error?: string;
  unknownFlags?: string[];
  logCommand?: string;
}

export interface DispatchCondition {
  name?: string;
  error?: string;
  since?: string;
  remedy?: string;
  held?: boolean | string;
  check?: boolean | string;
}

export interface PersistentSandboxEvent {
  at: string;
  kind: string;
  message: string;
}

export interface PersistentSandboxStatus {
  name: string;
  repo: string;
  ref?: string;
  command: string;
  state: string;
  enabled: boolean;
  sandbox?: string;
  startedAt?: string;
  restarts: number;
  lastError?: string;
  packageCache?: string;
  sandboxPort?: number;
  hostPort?: number;
  uiSubpath?: string;
  cpus?: number;
  memoryMB?: number;
  diskGB?: number;
  events?: PersistentSandboxEvent[];
  refresh?: string;
  commit?: string;
}

export interface StandingSandboxStatus {
  name: string;
  image?: string;
  state?: string;
  ready?: boolean;
  lastError?: string;
  startedAt?: string;
}

export interface PackageCacheStats {
  kind: string;
  entries: number;
  bytes: number;
}

export interface SandboxHealthResponse {
  enabled: boolean;
  checkedAt?: string;
  sandboxes?: SandboxSnapshot[];
  host?: HostPressure;
  budget?: SandboxBudgetReport;
  daemon?: DaemonHealth;
  dispatchBlocked?: DispatchCondition[];
  standingSandboxes?: StandingSandboxStatus[];
  persistentSandboxes?: PersistentSandboxStatus[];
  packageCache?: PackageCacheStats[];
  hostError?: string;
}

export interface HostTopResponse {
  enabled: boolean;
  lines?: string[];
}

export interface SandboxProbeRequest {
  id: string;
  access?: string;
  argv: string[];
}

export interface SandboxProbeResult {
  id?: string;
  sandbox: string;
  pod: string;
  access?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HostdConnection {
  connected: boolean;
  principal?: string;
  since?: string;
  lastError?: string;
}

export interface HostdView {
  name: string;
  owner?: string;
  labels?: Record<string, string>;
  created_by?: string;
  created_at?: string;
  revoked_at?: string;
  key_fingerprint?: string;
  capacity?: number;
  hostname?: string;
  os?: string;
  arch?: string;
  clis?: string[];
  version?: string;
  local_user?: string;
  last_seen_at?: string;
  token_prefix?: string;
  token_expires_at?: string;
  state: "connected" | "offline" | "revoked" | string;
  connection?: HostdConnection;
  shared?: boolean;
  logins?: string[];
  loginsKnown?: boolean;
  features?: string[];
}

export interface IssuedHostdToken {
  hostd: HostdView;
  token: string;
}

export interface DeleteRevokedHostdsResult {
  deleted: { name: string; clearedPauses?: string[] }[];
  skipped: { name: string; reason: string }[];
}

export interface HostdInstallSnippet {
  release?: string;
  image?: string;
  lines?: string[];
  note?: string;
  command?: string;
}

export interface HostEnrollmentCodeView {
  name: string;
  prefix?: string;
  code?: string;
  install?: HostdInstallSnippet | string;
  default_labels?: Record<string, string> | null;
  default_capacity?: number;
  allowed_principals?: string[];
  max_uses?: number;
  uses?: number;
  expires_at?: string | null;
  created_by?: string;
  created_at?: string;
  rotated_at?: string | null;
  revoked_at?: string | null;
}

export interface PendingHostJoinView {
  id: string;
  enrollment_code?: string;
  rekey_hostd?: string;
  hostname?: string;
  suggested_name?: string;
  os?: string;
  arch?: string;
  clis?: string[];
  version?: string;
  local_user?: string;
  key_fingerprint?: string;
  enrolled_by?: string;
  default_labels?: Record<string, string> | null;
  default_capacity?: number;
  created_at?: string;
  expires_at?: string;
}

export interface PipelinePauseStatus {
  paused: boolean;
  since?: string;
  reason?: string;
  byKind?: string;
  byId?: string;
  bySource?: string;
  byLabel?: string;
  untilTask?: string;
  runNowPasses?: boolean;
  cancelledUpgrade?: string;
}

export interface PipelinePauseResponse {
  pause: PipelinePauseStatus;
  pausedNow?: boolean;
  resumed?: boolean;
}

export interface AgentPauseEntry {
  connection?: string;
  connectionName?: string;
  model?: string;
  labels?: string[];
  escalated?: string;
  team?: string;
  framework?: string;
  until?: string;
  reason?: string;
  secondsRemaining: number;
  canLift: boolean;
}

export interface AgentPauseStatus {
  paused: boolean;
  until?: string;
  reason?: string;
  secondsRemaining?: number;
  pauses?: AgentPauseEntry[];
}

export interface AgentPauseResponse {
  enabled?: boolean;
  pause?: AgentPauseStatus;
  lifted?: boolean;
}

export interface PackageCacheState {
  enabled: boolean;
  cache?: PackageCacheStats[];
}

export interface PackageCacheFlush {
  kind?: string;
  entries: number;
  bytes: number;
  cache?: PackageCacheStats[];
}

export interface ActionsCacheState {
  enabled: boolean;
  entries: number;
  bytes: number;
  maxBytes: number;
  repos?: { repo: string; bytes: number }[];
  usedByJobs?: boolean;
}

export interface ActionsCacheFlush {
  repo?: string;
  entries: number;
  bytes: number;
  cache: ActionsCacheState;
}

export interface LogSourcesResponse {
  enabled: boolean;
  sources?: string[];
}

export interface LogUnit {
  unit: string;
  scope: string;
  running?: boolean;
}

export interface LogLinesResponse {
  source?: string;
  lines: string[];
  unit?: LogUnit;
  units?: LogUnit[];
}

export type PersistentAction = "start" | "stop" | "restart" | "rebuild";

export function formatBytes(bytes: number | undefined | null): string {
  const b = Number(bytes ?? 0);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatMB(mb: number | undefined | null): string {
  const v = Number(mb ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "0 MB";
  if (v >= 1024) return `${(v / 1024).toFixed(1)} GB`;
  return `${Math.round(v)} MB`;
}

export function formatRelativeAge(
  iso: string | undefined | null,
  now = Date.now(),
): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// Matches real pkg/dispatch RunID ("<taskId>-<attempt>" for kind === "agent")
// and idle session sandboxes ("idle-<taskId>" for kind === "idle session"),
// falling back to "task-<taskId>".
export function extractTaskIdFromSandbox(sb: SandboxSnapshot): string | null {
  const sbId = (sb.sandbox || "").trim();
  if (!sb.kind || sb.kind === "agent") {
    const mAgent = /^(\d+)-\d+$/.exec(sbId);
    if (mAgent) return mAgent[1];
  }
  if (sb.kind === "idle session") {
    const mIdle = /^idle-(\d+)$/.exec(sbId);
    if (mIdle) return mIdle[1];
  }
  for (const raw of [sbId, (sb.name || "").trim()]) {
    if (!raw) continue;
    const mTask = /(?:^|-)task-(\d+)(?:-|$)/i.exec(raw);
    if (mTask) return mTask[1];
  }
  return null;
}

export function parseArgv(cmd: string): string[] {
  const trimmed = cmd.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

const ALLOWED_PERSISTENT_ACTIONS = new Map<
  string,
  ReadonlySet<PersistentAction>
>([
  ["stopped", new Set<PersistentAction>(["start"])],
  ["idle", new Set<PersistentAction>(["start"])],
  ["starting", new Set<PersistentAction>(["stop"])],
  ["running", new Set<PersistentAction>(["restart", "rebuild", "stop"])],
  ["restarting", new Set<PersistentAction>(["restart", "rebuild", "stop"])],
]);

/** Returns the normalized lifecycle state used for display and action gating. */
export function effectivePersistentState(
  ps: Pick<PersistentSandboxStatus, "state" | "enabled">,
): string {
  const raw = (ps.state ?? "").trim().toLowerCase();
  return raw || (ps.enabled ? "idle" : "stopped");
}

/** Reports whether `action` is valid for a persistent sandbox in its current state. */
export function isPersistentActionAllowed(
  ps: Pick<PersistentSandboxStatus, "state" | "enabled">,
  action: PersistentAction,
): boolean {
  return (
    ALLOWED_PERSISTENT_ACTIONS.get(effectivePersistentState(ps))?.has(action) ??
    false
  );
}

/** Parses whitespace- or comma-separated `key=value` hostd labels. */
export function parseHostdLabels(raw: string): {
  labels: Record<string, string>;
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { labels: {} };
  const out: Record<string, string> = {};
  for (const part of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0 || eq === part.length - 1) {
      return {
        labels: {},
        error: `Host label "${part}" must be key=value (no spaces or commas).`,
      };
    }
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || !v || v.includes("=")) {
      return {
        labels: {},
        error: `Host label "${part}" must be key=value.`,
      };
    }
    out[k] = v;
  }
  return { labels: out };
}

/** Formats a hostd label map as comma-separated `key=value` pairs. */
export function formatHostdLabels(
  labels?: Record<string, string> | null,
): string {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return "";
  }
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** Formats a newly minted or rotated enrollment secret and install command. */
export function formatIssuedHostdSecret(
  label: string,
  res?: {
    code?: string;
    token?: string;
    install?: HostdInstallSnippet | string;
  } | null,
): string | null {
  if (!res) return null;
  const parts: string[] = [];
  const secret = res.code ?? res.token;
  if (typeof secret === "string" && secret) {
    parts.push(`${label} (shown once): ${secret}`);
  }
  if (typeof res.install === "string" && res.install.trim()) {
    parts.push(res.install.trim());
  } else if (res.install && typeof res.install === "object") {
    if (typeof res.install.command === "string" && res.install.command) {
      parts.push(res.install.command);
    } else if (Array.isArray(res.install.lines) && res.install.lines.length) {
      parts.push(res.install.lines.join("\n"));
    }
    if (typeof res.install.note === "string" && res.install.note) {
      parts.push(`# ${res.install.note}`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
