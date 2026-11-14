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

import { ChangeDetectorRef } from "@angular/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { GrainConfig } from "../api/models";
import { AccessService } from "../services/access.service";
import { PHONE_QUERY } from "../shared/split";
import {
  FleetPageComponent,
  isPersistentActionAllowed,
  persistentSandboxState,
} from "./fleet-page.component";
import {
  type ActionsCacheState,
  type AgentPauseResponse,
  type HostEnrollmentCodeView,
  type HostTopResponse,
  type HostdView,
  type LogLinesResponse,
  type LogSourcesResponse,
  type PackageCacheState,
  type PendingHostJoinView,
  type PersistentAction,
  type PersistentSandboxStatus,
  type PipelinePauseStatus,
  type SandboxHealthResponse,
  extractTaskIdFromSandbox,
} from "./fleet.models";

interface RecordedCall {
  method: string;
  route: string;
  params?: unknown;
  query?: string;
  body?: unknown;
}

class FakeFleetApi {
  calls: RecordedCall[] = [];

  configBody: GrainConfig = {
    version: "v3.5.0-test",
    hostSandboxes: false,
    access: {
      role: "grain/operator",
      roles: ["grain/operator"],
      full: true,
      scopes: [],
    },
  };

  healthBody: SandboxHealthResponse = {
    enabled: true,
    checkedAt: "2026-11-12T00:00:00Z",
    daemon: {
      startedAt: "2026-11-11T12:00:00Z",
      starts: 2,
      restarting: false,
      startsScope: "last 24h",
      logCommand: "journalctl --user -u grain -f",
    },
    dispatchBlocked: [
      {
        name: "git-proxy",
        error: "listen tcp :7100: address already in use",
        since: "2026-11-11T23:55:00Z",
        remedy: "restart the daemon once :7100 is free",
        held: "5m0s",
      },
    ],
    host: {
      cpus: 16,
      loadAverage1: 3.25,
      loadAverage5: 2.8,
      loadAverage15: 2.1,
      cpuUtilization: 0.42,
      memoryTotalMB: 65536,
      memoryUsedMB: 24576,
      memoryAvailableMB: 40960,
      swapTotalMB: 8192,
      swapUsedMB: 0,
      disks: [
        {
          path: "/var/lib/grain",
          holds: ["sandboxes", "caches"],
          totalMB: 512000,
          usedMB: 128000,
          availableMB: 384000,
          floorMB: 20480,
        },
      ],
    },
    budget: {
      known: true,
      budgetCPUs: 14,
      committedCPUs: 6,
      committedCount: 2,
      withinCap: true,
    },
    sandboxes: [
      {
        sandbox: "42-1",
        name: "42-1",
        kind: "agent",
        backend: "granule",
        ready: true,
        cpus: 4,
        memoryMB: 8192,
        memoryUsedMB: 2048,
        loadAverage: "0.85",
        startedAt: "2026-11-11T23:45:00Z",
        networkAccess: "isolated",
      },
      {
        sandbox: "idle-77",
        name: "idle-77",
        kind: "idle session",
        backend: "granule",
        ready: true,
        cpus: 2,
        memoryMB: 4096,
        startedAt: "2026-11-11T23:50:00Z",
      },
    ],
  };

  persistentBody: PersistentSandboxStatus[] = [
    {
      name: "staging-web",
      repo: "acme/web",
      ref: "main",
      command: "npm run preview",
      uiSubpath: "/staging/web",
      hostPort: 4173,
      enabled: true,
      state: "running",
      restarts: 0,
    },
  ];

  hostdsBody: HostdView[] = [
    {
      name: "local",
      state: "connected",
      hostname: "controller-01",
      os: "linux",
      arch: "amd64",
      version: "v3.5.0",
      clis: ["claude", "gemini"],
    },
    {
      name: "workstation-1",
      owner: "alice@example.com",
      state: "connected",
      hostname: "workstation.example.com",
      os: "linux",
      arch: "amd64",
      token_prefix: "ghd_99ab",
      clis: ["gemini"],
      logins: ["gcloud"],
    },
  ];

  enrollmentCodesBody: HostEnrollmentCodeView[] = [
    {
      name: "default",
      prefix: "ghe_112233",
      code: "ghe_112233445566",
      uses: 1,
      max_uses: 10,
      created_by: "alice@example.com",
    },
  ];

  pendingBody: PendingHostJoinView[] = [
    {
      id: "hjr_1",
      hostname: "carol-devbox.internal",
      suggested_name: "carol-devbox",
      os: "linux",
      arch: "amd64",
      enrolled_by: "carol@example.com",
      enrollment_code: "default",
      key_fingerprint: "SHA256:testKeyFingerprintValueForWrapChecks123456",
      local_user: "carol",
      default_labels: { gpu: "none" },
      default_capacity: 2,
    },
  ];

  pipelinePauseState: PipelinePauseStatus = { paused: false };
  agentPauseBody: AgentPauseResponse = {
    enabled: true,
    pause: {
      paused: true,
      pauses: [
        {
          connection: "claude-main",
          connectionName: "Claude Main",
          reason: "5h rate window",
          secondsRemaining: 900,
          canLift: true,
        },
      ],
    },
  };
  pkgCacheBody: PackageCacheState = {
    enabled: true,
    cache: [{ kind: "npm", entries: 142, bytes: 52_428_800 }],
  };
  actCacheBody: ActionsCacheState = {
    enabled: true,
    entries: 18,
    bytes: 104_857_600,
    maxBytes: 1_073_741_824,
  };
  logSourcesBody: LogSourcesResponse = {
    enabled: true,
    sources: ["daemon", "caddy"],
  };
  logLinesBySource: Record<string, LogLinesResponse> = {
    daemon: {
      source: "daemon",
      lines: [
        "2026-11-12T00:01:00Z INFO dispatcher: picked up task #42",
        "2026-11-12T00:01:05Z WARN merge-queue: waiting on CI check",
      ],
    },
    caddy: {
      source: "caddy",
      lines: ["2026-11-12T00:02:00Z INFO tls: certificate renewed"],
    },
  };
  hostTopBody: HostTopResponse = {
    enabled: true,
    lines: ["PID USER %CPU %MEM COMMAND", "1042 grain 18.2 2.1 grain serve"],
  };

  config = () => Promise.resolve(this.configBody);
  getIfChanged = () => Promise.resolve({ body: [], changed: false });

  getText = (
    route: string,
    params?: Record<string, string>,
    query?: string,
  ) => {
    this.calls.push({ method: "GET_TEXT", route, params, query });
    if (route === "GET /api/persistent-sandboxes/{name}/logs") {
      return Promise.resolve(`[${params?.["name"]}] listening on :4173`);
    }
    return Promise.resolve("");
  };

  get = (route: string, params?: Record<string, string>, query?: string) => {
    this.calls.push({ method: "GET", route, params, query });
    switch (route) {
      case "GET /api/sandboxes":
        return Promise.resolve(structuredClone(this.healthBody));
      case "GET /api/persistent-sandboxes":
        return Promise.resolve(structuredClone(this.persistentBody));
      case "GET /api/host/top":
        return Promise.resolve(structuredClone(this.hostTopBody));
      case "GET /api/hostds":
        return Promise.resolve(structuredClone(this.hostdsBody));
      case "GET /api/hostds/enrollment-codes":
        return Promise.resolve(structuredClone(this.enrollmentCodesBody));
      case "GET /api/hostds/pending":
        return Promise.resolve(structuredClone(this.pendingBody));
      case "GET /api/pipeline-pause":
        return Promise.resolve({
          pause: structuredClone(this.pipelinePauseState),
        });
      case "GET /api/pause":
        return Promise.resolve(structuredClone(this.agentPauseBody));
      case "GET /api/package-cache":
        return Promise.resolve(structuredClone(this.pkgCacheBody));
      case "GET /api/actions-cache":
        return Promise.resolve(structuredClone(this.actCacheBody));
      case "GET /api/logs":
        return Promise.resolve(structuredClone(this.logSourcesBody));
      case "GET /api/logs/{source}": {
        const src = params?.["source"] ?? "daemon";
        return Promise.resolve(
          structuredClone(
            this.logLinesBySource[src] ?? { source: src, lines: [] },
          ),
        );
      }
      case "GET /api/restart-watch":
        return Promise.resolve({ restarting: false });
      default:
        return Promise.resolve({});
    }
  };

  post = (
    route: string,
    params?: Record<string, string>,
    body?: unknown,
    query?: string,
  ) => {
    this.calls.push({ method: "POST", route, params, body, query });
    if (route === "POST /api/sandbox-probe") {
      return Promise.resolve({
        id: "probe-1",
        sandbox: "sb-probe-1",
        pod: "local",
        exitCode: 0,
        stdout: "Linux granule 6.8.0 x86_64\n",
        stderr: "",
      });
    }
    if (route === "POST /api/hostds/{name}/rotate") {
      const name = params?.["name"] ?? "host";
      return Promise.resolve({
        hostd: { name, state: "connected" },
        token: "ghd_secret_rotated_token",
      });
    }
    if (route === "POST /api/hostds/enrollment-codes") {
      const name = (body as { name?: string })?.name ?? "code";
      const created: HostEnrollmentCodeView = {
        name,
        prefix: "ghe_new99",
        code: `ghe_new99_${name}`,
        uses: 0,
      };
      this.enrollmentCodesBody = [...this.enrollmentCodesBody, created];
      return Promise.resolve(structuredClone(created));
    }
    if (route === "POST /api/hostds/enrollment-codes/{name}/rotate") {
      const name = params?.["name"] ?? "default";
      const rotated: HostEnrollmentCodeView = {
        name,
        prefix: "ghe_rot88",
        code: `ghe_rot88_${name}`,
        uses: 1,
      };
      this.enrollmentCodesBody = this.enrollmentCodesBody.map((c) =>
        c.name === name ? rotated : c,
      );
      return Promise.resolve(structuredClone(rotated));
    }
    if (route === "POST /api/hostds/enrollment-codes/{name}/revoke") {
      const name = params?.["name"] ?? "default";
      this.enrollmentCodesBody = this.enrollmentCodesBody.map((c) =>
        c.name === name
          ? { ...c, code: undefined, revoked_at: "2026-11-14T00:00:00Z" }
          : c,
      );
      return Promise.resolve({ name, revoked_at: "2026-11-14T00:00:00Z" });
    }
    if (route === "POST /api/hostds/pending/{id}/accept") {
      const id = params?.["id"] ?? "";
      this.pendingBody = this.pendingBody.filter((p) => p.id !== id);
      const name = (body as { name?: string })?.name || "accepted-host";
      this.hostdsBody = [
        ...this.hostdsBody,
        { name, state: "connected", hostname: name },
      ];
      return Promise.resolve({ name, state: "connected" });
    }
    if (route === "POST /api/hostds/pending/{id}/reject") {
      const id = params?.["id"] ?? "";
      this.pendingBody = this.pendingBody.filter((p) => p.id !== id);
      return Promise.resolve({ rejected: id });
    }
    if (route === "POST /api/pipeline-pause") {
      const reason = (body as { reason?: string })?.reason || "maintenance";
      this.pipelinePauseState = {
        paused: true,
        reason,
        byLabel: "Alice Example",
        byKind: "human",
      };
      return Promise.resolve({
        pause: structuredClone(this.pipelinePauseState),
      });
    }
    if (route === "POST /api/package-cache/flush") {
      this.pkgCacheBody = { enabled: true, cache: [] };
      return Promise.resolve({ entries: 142, bytes: 52_428_800, cache: [] });
    }
    if (route === "POST /api/actions-cache/flush") {
      this.actCacheBody = {
        enabled: true,
        entries: 0,
        bytes: 0,
        maxBytes: 1_073_741_824,
      };
      return Promise.resolve({
        entries: 18,
        bytes: 104_857_600,
        cache: structuredClone(this.actCacheBody),
      });
    }
    return Promise.resolve({ ok: true });
  };

  delete = (route: string, params?: Record<string, string>, query?: string) => {
    this.calls.push({ method: "DELETE", route, params, query });
    if (route === "DELETE /api/pipeline-pause") {
      this.pipelinePauseState = { paused: false };
      return Promise.resolve({ pause: { paused: false } });
    }
    if (route === "DELETE /api/pause") {
      this.agentPauseBody = { pause: { paused: false, pauses: [] } };
      return Promise.resolve(structuredClone(this.agentPauseBody));
    }
    return Promise.resolve({ ok: true });
  };
}

async function settle(f: ComponentFixture<unknown>): Promise<void> {
  await f.whenStable();
  await new Promise((r) => setTimeout(r, 10));
  f.detectChanges();
  await f.whenStable();
}

describe("FleetPageComponent", () => {
  const origMatchMedia = window.matchMedia;
  const origInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: origMatchMedia,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: origInnerWidth,
    });
    TestBed.resetTestingModule();
  });

  async function setup(api = new FakeFleetApi()) {
    TestBed.configureTestingModule({
      imports: [FleetPageComponent],
      providers: [
        provideRouter([
          { path: "task/:id", children: [] },
          { path: "settings/hostds", children: [] },
        ]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    TestBed.inject(AccessService).setConfig(api.configBody);
    const fixture = TestBed.createComponent(FleetPageComponent);
    fixture.autoDetectChanges();
    await settle(fixture);
    return { fixture, api, root: fixture.nativeElement as HTMLElement };
  }

  it("renders DispatchCondition error/remedy, capacity meters, <taskId>-<attempt> & idle-<taskId> task links, probe, and persistent ?format=text logs", async () => {
    const { fixture, root, api } = await setup();

    expect(root.querySelectorAll("select").length).toBe(0);
    expect(
      root.querySelector('[data-testid="fleet-backend-pill"]')?.textContent,
    ).toContain("Backend: granule");

    // DispatchCondition renders error + remedy + since.
    const blockedBanner = root.querySelector(
      '[data-testid="fleet-dispatch-blocked"]',
    )!;
    expect(blockedBanner.textContent).toContain(
      "listen tcp :7100: address already in use",
    );
    expect(blockedBanner.textContent).toContain(
      "Remedy: restart the daemon once :7100 is free",
    );

    expect(
      root.querySelector('[data-testid="meter-cpu"]')?.textContent,
    ).toContain("42%");
    expect(
      root.querySelector('[data-testid="meter-vcpu"]')?.textContent,
    ).toContain("6 / 14 vCPU");

    // Live agent sandbox "42-1" links to singular /task/42; idle session "idle-77" links to /task/77.
    const sbRow = root.querySelector('[data-testid="sandbox-row-42-1"]')!;
    expect(sbRow.querySelector("a")?.getAttribute("href")).toBe("/task/42");
    const idleRow = root.querySelector('[data-testid="sandbox-row-idle-77"]')!;
    expect(idleRow.querySelector("a")?.getAttribute("href")).toBe("/task/77");

    expect(
      extractTaskIdFromSandbox({
        sandbox: "task-9",
        name: "task-9",
        kind: "task",
        backend: "granule",
        ready: true,
      }),
    ).toBe("9");
    expect(
      extractTaskIdFromSandbox({
        sandbox: "10-2",
        name: "10-2",
        kind: "persistent",
        backend: "granule",
        ready: true,
      }),
    ).toBeNull();

    root
      .querySelector<HTMLButtonElement>('[data-testid="sandbox-recreate-42"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("Recreate sandbox for task #42?");
    expect(
      root.querySelector('[data-testid="confirm-dialog"]')?.closest("[inert]"),
    ).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "POST /api/tasks/{id}/sandbox/recreate",
      ),
    ).toBe(false);

    root
      .querySelector<HTMLButtonElement>('[data-testid="sandbox-recreate-42"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "POST /api/tasks/{id}/sandbox/recreate",
      ),
    ).toBe(true);

    // Toggle Host top process snapshot.
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-top-toggle"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-host-top"]')?.textContent,
    ).toContain("grain serve");

    // Run diagnostic sandbox probe.
    root
      .querySelector<HTMLButtonElement>('[data-testid="probe-run-btn"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="probe-output"]')?.textContent,
    ).toContain("Linux granule 6.8.0");

    // Persistent sandbox restart requires confirmation + ?format=text logs viewer.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-restart-staging-web"]',
      )!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("Restart persistent sandbox staging-web?");
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
          (c.params as { name: string; action: string }).name ===
            "staging-web" &&
          (c.params as { name: string; action: string }).action === "restart",
      ),
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-logs-btn-staging-web"]',
      )!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET_TEXT" &&
          c.route === "GET /api/persistent-sandboxes/{name}/logs" &&
          c.query === "format=text",
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="persistent-logs-staging-web"]')
        ?.textContent,
    ).toContain("listening on :4173");
  });

  it("disables sandbox probe when hostSandboxes=true and gates persistent Logs + Fleet tabs on RBAC scopes", async () => {
    const api = new FakeFleetApi();
    api.configBody = {
      version: "v3.5.0-test",
      hostSandboxes: true,
      access: {
        role: "sandbox-viewer",
        roles: ["sandbox-viewer"],
        full: false,
        scopes: ["sandboxes:read", "deployment:restart"],
      },
    };
    const { fixture, root } = await setup(api);

    expect(
      root.querySelector('[data-testid="fleet-backend-pill"]')?.textContent,
    ).toContain("Backend: host");
    // Probe disabled when hostSandboxes is true even with deployment:restart.
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="probe-run-btn"]')!
        .disabled,
    ).toBe(true);
    // Live sandboxes card shows access.deniedReason("GET /api/sandboxes").
    expect(
      root.querySelector('[data-testid="fleet-sandboxes-denied"]')?.textContent,
    ).toContain("deployment:read");
    // Persistent sandbox Logs button disabled because deployment:read is missing.
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="persistent-logs-btn-staging-web"]',
      )!.disabled,
    ).toBe(true);

    // Controls tab shows deniedReason when dispatch:read & caches:read are missing, except restart is held;
    // test missing all controls read scopes when deployment:restart is also absent:
    TestBed.inject(AccessService).setConfig({
      access: {
        role: "minimal",
        roles: ["minimal"],
        full: false,
        scopes: [],
      },
    });
    fixture.detectChanges();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-sandboxes-denied"]')?.textContent,
    ).toContain("deployment:read");

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-controls"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-controls-denied"]')?.textContent,
    ).toContain("dispatch:read");

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-logs"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-logs-denied"]')?.textContent,
    ).toContain("deployment:read");
  });

  it("manages hostds, preserves routerLink='/settings/hostds', and mounts confirm dialog outside [attr.inert]", async () => {
    const { fixture, root, api } = await setup();

    const sbTab = root.querySelector<HTMLButtonElement>(
      '[data-testid="fleet-tab-sandboxes"]',
    )!;
    expect(sbTab.getAttribute("aria-controls")).toBe("fleet-panel-sandboxes");
    expect(root.querySelector('[role="tabpanel"]')?.id).toBe(
      "fleet-panel-sandboxes",
    );

    // ArrowRight navigates from Sandboxes to Host Daemons tab.
    sbTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await settle(fixture);
    expect(root.querySelector('[role="tabpanel"]')?.id).toBe(
      "fleet-panel-hostds",
    );

    expect(
      root.querySelector('a[href="/settings/hostds"]')?.textContent,
    ).toContain("Enrollment & settings");
    expect(
      root.querySelector('[data-testid="hostd-row-local"]')?.textContent,
    ).toContain("co-located");
    expect(
      root.querySelector('[data-testid="hostd-row-workstation-1"]')
        ?.textContent,
    ).toContain("alice@example.com");

    // Rotate token requires ConfirmDialogComponent acceptance and shows one-time token banner.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="hostd-rotate-workstation-1"]',
      )!
      .click();
    await settle(fixture);
    const rotateDialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(rotateDialog).not.toBeNull();
    expect(rotateDialog.closest("[inert]")).toBeNull();
    expect(rotateDialog.textContent).toContain(
      "Rotate host workstation-1's token?",
    );
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="hostd-issued-token"]')).toBeNull();
    expect(
      api.calls.some((c) => c.route === "POST /api/hostds/{name}/rotate"),
    ).toBe(false);

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="hostd-rotate-workstation-1"]',
      )!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="hostd-issued-token"]')?.textContent,
    ).toContain("ghd_secret_rotated_token");

    // Revoke requires ConfirmDialogComponent acceptance OUTSIDE [attr.inert].
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="hostd-revoke-workstation-1"]',
      )!
      .click();
    await settle(fixture);
    const dialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "POST /api/hostds/{name}/revoke" &&
          (c.params as { name: string }).name === "workstation-1",
      ),
    ).toBe(true);
  });

  it("toggles pipeline pause, flushes caches with confirmation, and confirms daemon restart", async () => {
    const { fixture, root, api } = await setup();

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-controls"]')!
      .click();
    await settle(fixture);

    // Pause pipeline with reason, then resume.
    const reasonInput = root.querySelector<HTMLInputElement>(
      '[data-testid="pipeline-pause-reason"]',
    )!;
    reasonInput.value = "Deploying M12";
    reasonInput.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>('[data-testid="pipeline-pause-btn"]')!
      .click();
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="pipeline-pause-state"]')?.textContent,
    ).toContain("Paused");
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "POST /api/pipeline-pause" &&
          (c.body as { reason: string }).reason === "Deploying M12",
      ),
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>('[data-testid="pipeline-resume-btn"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="pipeline-pause-state"]')?.textContent,
    ).toContain("Dispatching");

    // Flush package cache via confirmation dialog.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="flush-package-cache-btn"]',
      )!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "POST /api/package-cache/flush"),
    ).toBe(true);

    // Restart daemon requires confirmation dialog.
    root
      .querySelector<HTMLButtonElement>('[data-testid="daemon-restart-btn"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("Restart grain daemon?");
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(api.calls.some((c) => c.route === "POST /api/host/restart")).toBe(
      true,
    );
  });

  it("streams daemon logs, switches log sources, and filters lines in the dark viewer", async () => {
    const { fixture, root } = await setup();

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-logs"]')!
      .click();
    await settle(fixture);

    const viewer = root.querySelector('[data-testid="logs-viewer"]')!;
    expect(viewer.textContent).toContain("picked up task #42");
    expect(
      root.querySelector('[data-testid="logs-line-count"]')?.textContent,
    ).toContain("2 / 2 lines");

    // Filter lines locally.
    const search = root.querySelector<HTMLInputElement>(
      '[data-testid="logs-search-input"]',
    )!;
    search.value = "merge-queue";
    search.dispatchEvent(new Event("input"));
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="logs-line-count"]')?.textContent,
    ).toContain("1 / 2 lines");

    // Clear filter and switch source to caddy.
    search.value = "";
    search.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>('[data-testid="log-source-caddy"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="logs-viewer"]')?.textContent,
    ).toContain("certificate renewed");
  });

  it("gates persistent sandbox start, restart, rebuild, and stop actions by ps.state, busy state, and RBAC", async () => {
    const base: Omit<PersistentSandboxStatus, "name" | "state" | "enabled"> = {
      repo: "acme/web",
      ref: "main",
      command: "npm run preview",
      restarts: 0,
    };
    const api = new FakeFleetApi();
    api.persistentBody = [
      { ...base, name: "sb-running", state: "running", enabled: true },
      { ...base, name: "sb-restarting", state: "restarting", enabled: true },
      { ...base, name: "sb-starting", state: "starting", enabled: true },
      { ...base, name: "sb-stopping", state: "stopping", enabled: true },
      { ...base, name: "sb-stopped", state: "stopped", enabled: false },
      { ...base, name: "sb-idle", state: "idle", enabled: true },
      { ...base, name: "sb-empty-enabled", state: "", enabled: true },
      { ...base, name: "sb-empty-disabled", state: "", enabled: false },
    ];

    let resolveStop: (() => void) | null = null;
    const origPost = api.post;
    api.post = (route, params, body, query) => {
      if (
        route === "POST /api/persistent-sandboxes/{name}/{action}" &&
        (params as { name: string; action: string }).name === "sb-running" &&
        (params as { name: string; action: string }).action === "stop"
      ) {
        api.calls.push({ method: "POST", route, params, body, query });
        return new Promise((resolve) => {
          resolveStop = () => {
            const target = api.persistentBody.find(
              (s) => s.name === "sb-running",
            );
            if (target) target.state = "stopped";
            resolve({ ok: true });
          };
        });
      }
      return origPost(route, params, body, query);
    };

    const { fixture, root } = await setup(api);

    const btn = (name: string, action: PersistentAction) =>
      root.querySelector<HTMLButtonElement>(
        `[data-testid="persistent-${action}-${name}"]`,
      )!;
    const disabledMap = (name: string) => ({
      start: btn(name, "start").disabled,
      restart: btn(name, "restart").disabled,
      rebuild: btn(name, "rebuild").disabled,
      stop: btn(name, "stop").disabled,
    });

    expect(disabledMap("sb-running")).toEqual({
      start: true,
      restart: false,
      rebuild: false,
      stop: false,
    });
    expect(disabledMap("sb-restarting")).toEqual({
      start: true,
      restart: false,
      rebuild: false,
      stop: false,
    });
    expect(disabledMap("sb-starting")).toEqual({
      start: true,
      restart: true,
      rebuild: true,
      stop: false,
    });
    expect(disabledMap("sb-stopping")).toEqual({
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expect(disabledMap("sb-stopped")).toEqual({
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expect(disabledMap("sb-idle")).toEqual({
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expect(disabledMap("sb-empty-enabled")).toEqual({
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expect(disabledMap("sb-empty-disabled")).toEqual({
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });

    // Helper checks for case-insensitivity and fallback.
    expect(persistentSandboxState({ state: " Running ", enabled: false })).toBe(
      "running",
    );
    expect(persistentSandboxState({ state: "", enabled: true })).toBe("idle");
    expect(
      isPersistentActionAllowed({ state: "failed", enabled: true }, "stop"),
    ).toBe(false);
    expect(
      isPersistentActionAllowed({ state: "failed", enabled: true }, "start"),
    ).toBe(true);

    // Clicking disabled invalid actions triggers no POST.
    btn("sb-stopped", "stop").click();
    btn("sb-idle", "stop").click();
    btn("sb-stopped", "restart").click();
    btn("sb-stopped", "rebuild").click();
    btn("sb-running", "start").click();
    btn("sb-starting", "restart").click();
    await settle(fixture);
    expect(
      api.calls.filter(
        (c) => c.route === "POST /api/persistent-sandboxes/{name}/{action}",
      ),
    ).toHaveLength(0);

    // Clicking valid Stop on sb-running opens confirm dialog, then disables all actions
    // on sb-running while in flight, and updates button gating when refreshed state becomes stopped.
    btn("sb-running", "stop").click();
    fixture.detectChanges();
    expect(
      root.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("Stop persistent sandbox sb-running?");
    expect(
      api.calls.filter(
        (c) => c.route === "POST /api/persistent-sandboxes/{name}/{action}",
      ),
    ).toHaveLength(0);

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    fixture.detectChanges();
    expect(disabledMap("sb-running")).toEqual({
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expect(disabledMap("sb-stopped")).toEqual({
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });

    resolveStop!();
    await settle(fixture);
    expect(
      api.calls.filter(
        (c) =>
          c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
          (c.params as { name: string; action: string }).name ===
            "sb-running" &&
          (c.params as { name: string; action: string }).action === "stop",
      ),
    ).toHaveLength(1);
    expect(disabledMap("sb-running")).toEqual({
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });

    // Missing deployment:restart RBAC disables even state-valid actions.
    TestBed.inject(AccessService).setConfig({
      access: {
        role: "viewer",
        roles: ["viewer"],
        full: false,
        scopes: ["sandboxes:read"],
      },
    });
    fixture.detectChanges();
    await settle(fixture);
    expect(disabledMap("sb-stopped")).toEqual({
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expect(disabledMap("sb-restarting")).toEqual({
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });
  });

  it("enforces deployment:read scope context before fetching persistent sandbox logs and covers canReadPersistentLogs failures", async () => {
    const base: Omit<PersistentSandboxStatus, "name" | "repo"> = {
      ref: "main",
      command: "npm run preview",
      state: "running",
      enabled: true,
      restarts: 0,
    };
    const sbAllowed: PersistentSandboxStatus = {
      ...base,
      name: "sb-allowed",
      repo: "acme/allowed",
    };
    const sbPadded: PersistentSandboxStatus = {
      ...base,
      name: "sb-padded",
      repo: " acme/allowed ",
    };
    const sbOtherRepo: PersistentSandboxStatus = {
      ...base,
      name: "sb-other",
      repo: "acme/other",
    };
    const sbEmptyRepo: PersistentSandboxStatus = {
      ...base,
      name: "sb-empty",
      repo: "",
    };
    const sbBlankRepo: PersistentSandboxStatus = {
      ...base,
      name: "sb-blank",
      repo: "   ",
    };

    const api = new FakeFleetApi();
    api.configBody = {
      version: "v3.5.0-test",
      hostSandboxes: false,
      access: {
        role: "repo-reader",
        roles: ["repo-reader"],
        full: false,
        scopes: ["sandboxes:read", "deployment:read"],
        repoLimits: { "deployment:read": ["acme/allowed"] },
      },
    };
    api.persistentBody = [
      sbAllowed,
      sbPadded,
      sbOtherRepo,
      sbEmptyRepo,
      sbBlankRepo,
    ];

    const { fixture, root } = await setup(api);
    const cmp = fixture.componentInstance as unknown as {
      canReadPersistentLogs: (ps: PersistentSandboxStatus) => boolean;
      persistentLogsTip: (ps: PersistentSandboxStatus) => string;
      togglePersistentLogs: (ps: PersistentSandboxStatus) => Promise<void>;
    };

    const logsBtn = (name: string) =>
      root.querySelector<HTMLButtonElement>(
        `[data-testid="persistent-logs-btn-${name}"]`,
      )!;
    const logCalls = () =>
      api.calls.filter(
        (c) => c.route === "GET /api/persistent-sandboxes/{name}/logs",
      );

    expect(cmp.canReadPersistentLogs(sbAllowed)).toBe(true);
    expect(cmp.canReadPersistentLogs(sbPadded)).toBe(true);
    expect(cmp.canReadPersistentLogs(sbOtherRepo)).toBe(false);
    expect(cmp.canReadPersistentLogs(sbEmptyRepo)).toBe(false);
    expect(cmp.canReadPersistentLogs(sbBlankRepo)).toBe(false);

    expect(logsBtn("sb-allowed").disabled).toBe(false);
    expect(logsBtn("sb-padded").disabled).toBe(false);
    expect(logsBtn("sb-other").disabled).toBe(true);
    expect(logsBtn("sb-empty").disabled).toBe(true);
    expect(logsBtn("sb-blank").disabled).toBe(true);

    expect(cmp.persistentLogsTip(sbOtherRepo)).toContain("deployment:read");
    expect(cmp.persistentLogsTip(sbEmptyRepo)).toContain("deployment:read");
    expect(cmp.persistentLogsTip(sbBlankRepo)).toContain("deployment:read");

    // Direct togglePersistentLogs calls must not fetch when canReadPersistentLogs fails.
    await cmp.togglePersistentLogs(sbOtherRepo);
    await cmp.togglePersistentLogs(sbEmptyRepo);
    await cmp.togglePersistentLogs(sbBlankRepo);
    await settle(fixture);
    expect(logCalls()).toHaveLength(0);

    // Permitted repository fetches ?format=text logs.
    logsBtn("sb-allowed").click();
    await settle(fixture);
    expect(logCalls()).toHaveLength(1);
    expect(logCalls()[0]).toEqual({
      method: "GET_TEXT",
      route: "GET /api/persistent-sandboxes/{name}/logs",
      params: { name: "sb-allowed" },
      query: "format=text",
    });
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-allowed"]')
        ?.textContent,
    ).toContain("[sb-allowed] listening on :4173");

    // Revoking deployment:read hides open logs, disables button, and blocks further fetches.
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "sandbox-viewer",
        roles: ["sandbox-viewer"],
        full: false,
        scopes: ["sandboxes:read"],
      },
    });
    fixture.detectChanges();
    await settle(fixture);
    expect(cmp.canReadPersistentLogs(sbAllowed)).toBe(false);
    expect(logsBtn("sb-allowed").disabled).toBe(true);
    expect(cmp.persistentLogsTip(sbAllowed)).toContain("deployment:read");
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-allowed"]'),
    ).toBeNull();

    await cmp.togglePersistentLogs(sbAllowed);
    await settle(fixture);
    expect(logCalls()).toHaveLength(1);

    // In-flight revocation does not expose resolved log text.
    access.setConfig(api.configBody);
    fixture.detectChanges();
    await settle(fixture);
    let resolveDeferred!: (txt: string) => void;
    api.getText = (route, params, query) => {
      api.calls.push({ method: "GET_TEXT", route, params, query });
      return new Promise<string>((resolve) => {
        resolveDeferred = resolve;
      });
    };
    const pending = cmp.togglePersistentLogs(sbAllowed);
    access.setConfig({
      access: {
        role: "sandbox-viewer",
        roles: ["sandbox-viewer"],
        full: false,
        scopes: ["sandboxes:read"],
      },
    });
    resolveDeferred("secret log line");
    await pending;
    fixture.detectChanges();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-allowed"]'),
    ).toBeNull();
  });

  it("fails closed for host enrollment codes and pending approvals before api.config() resolves or when api.config() fails", async () => {
    const api = new FakeFleetApi();
    let resolveCfg!: (c: GrainConfig | null) => void;
    api.config = () =>
      new Promise<GrainConfig | null>((resolve) => {
        resolveCfg = resolve;
      }) as Promise<GrainConfig>;

    TestBed.configureTestingModule({
      imports: [FleetPageComponent],
      providers: [
        provideRouter([
          { path: "task/:id", children: [] },
          { path: "settings/hostds", children: [] },
        ]),
        { provide: GrainApi, useValue: api },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });

    const access = TestBed.inject(AccessService);
    expect(access.configLoaded()).toBe(false);

    const fixture = TestBed.createComponent(FleetPageComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const cmp = fixture.componentInstance as unknown as {
      canAccessEnrollment: () => boolean;
      canReadEnrollmentCodes: () => boolean;
      canCreateEnrollmentCode: () => boolean;
      canRotateEnrollmentCode: () => boolean;
      canRevokeEnrollmentCode: () => boolean;
      canReadPendingHostds: () => boolean;
      canAcceptPendingHostd: () => boolean;
      canRejectPendingHostd: () => boolean;
      newEnrollmentCodeName: { set: (v: string) => void };
      loadEnrollmentCodes: () => Promise<void>;
      loadPendingHostds: () => Promise<void>;
      createEnrollmentCode: () => Promise<void>;
      confirmRotateEnrollmentCode: (name: string) => void;
      confirmRevokeEnrollmentCode: (name: string) => void;
      acceptPendingHostd: (p: PendingHostJoinView) => Promise<void>;
      confirmRejectPendingHostd: (p: PendingHostJoinView) => void;
    };

    // Switch to Hosts tab before api.config() resolves.
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    fixture.detectChanges();

    expect(cmp.canAccessEnrollment()).toBe(false);
    expect(cmp.canReadEnrollmentCodes()).toBe(false);
    expect(cmp.canCreateEnrollmentCode()).toBe(false);
    expect(cmp.canRotateEnrollmentCode()).toBe(false);
    expect(cmp.canRevokeEnrollmentCode()).toBe(false);
    expect(cmp.canReadPendingHostds()).toBe(false);
    expect(cmp.canAcceptPendingHostd()).toBe(false);
    expect(cmp.canRejectPendingHostd()).toBe(false);
    expect(root.querySelector('a[href="/settings/hostds"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-enrollment-denied"]')
        ?.textContent,
    ).toContain("grain/operator");
    expect(
      root.querySelector('[data-testid="fleet-pending-denied"]')?.textContent,
    ).toContain("grain/operator");

    // Direct calls before api.config() resolves must emit zero API requests.
    cmp.newEnrollmentCodeName.set("team-pre");
    await cmp.loadEnrollmentCodes();
    await cmp.loadPendingHostds();
    await cmp.createEnrollmentCode();
    cmp.confirmRotateEnrollmentCode("default");
    cmp.confirmRevokeEnrollmentCode("default");
    await cmp.acceptPendingHostd(api.pendingBody[0]);
    cmp.confirmRejectPendingHostd(api.pendingBody[0]);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      api.calls.filter(
        (c) =>
          c.route.startsWith("GET /api/hostds/enrollment-codes") ||
          c.route.startsWith("POST /api/hostds/enrollment-codes") ||
          c.route.startsWith("GET /api/hostds/pending") ||
          c.route.startsWith("POST /api/hostds/pending"),
      ),
    ).toHaveLength(0);

    // Null config keeps operator-only enrollment and pending approvals closed.
    resolveCfg(null);
    await settle(fixture);
    expect(cmp.canReadEnrollmentCodes()).toBe(false);
    expect(cmp.canReadPendingHostds()).toBe(false);
    expect(
      api.calls.filter(
        (c) =>
          c.route === "GET /api/hostds/enrollment-codes" ||
          c.route === "GET /api/hostds/pending",
      ),
    ).toHaveLength(0);

    // Rejected api.config() also remains fail-closed.
    TestBed.resetTestingModule();
    const failApi = new FakeFleetApi();
    failApi.config = () => Promise.reject(new Error("config unavailable"));
    TestBed.configureTestingModule({
      imports: [FleetPageComponent],
      providers: [
        provideRouter([
          { path: "task/:id", children: [] },
          { path: "settings/hostds", children: [] },
        ]),
        { provide: GrainApi, useValue: failApi },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const failFixture = TestBed.createComponent(FleetPageComponent);
    failFixture.autoDetectChanges();
    await settle(failFixture);
    const failRoot = failFixture.nativeElement as HTMLElement;
    failRoot
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(failFixture);
    expect(
      failRoot.querySelector('[data-testid="fleet-enrollment-denied"]'),
    ).not.toBeNull();
    expect(
      failRoot.querySelector('[data-testid="fleet-pending-denied"]'),
    ).not.toBeNull();
    expect(
      failApi.calls.some(
        (c) =>
          c.route === "GET /api/hostds/enrollment-codes" ||
          c.route === "GET /api/hostds/pending",
      ),
    ).toBe(false);

    // Unauthenticated config with access: null must still stay fail-closed.
    TestBed.resetTestingModule();
    const unauthApi = new FakeFleetApi();
    unauthApi.configBody = {
      version: "v3.5.0-test",
      authenticated: false,
      allowed: false,
      access: null,
    };
    TestBed.configureTestingModule({
      imports: [FleetPageComponent],
      providers: [
        provideRouter([
          { path: "task/:id", children: [] },
          { path: "settings/hostds", children: [] },
        ]),
        { provide: GrainApi, useValue: unauthApi },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const unauthFixture = TestBed.createComponent(FleetPageComponent);
    unauthFixture.autoDetectChanges();
    await settle(unauthFixture);
    const unauthRoot = unauthFixture.nativeElement as HTMLElement;
    unauthRoot
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(unauthFixture);
    expect(
      unauthRoot.querySelector('[data-testid="fleet-enrollment-denied"]'),
    ).not.toBeNull();
    expect(
      unauthRoot.querySelector('[data-testid="fleet-pending-denied"]'),
    ).not.toBeNull();
    expect(
      unauthApi.calls.some(
        (c) =>
          c.route === "GET /api/hostds/enrollment-codes" ||
          c.route === "GET /api/hostds/pending",
      ),
    ).toBe(false);

    // Single-tenant trusted / access-code operator (authenticated: false,
    // authMethod: "trusted", access: null) IS admitted, while singleTenantRefusal
    // stays fail-closed.
    TestBed.resetTestingModule();
    const refusedApi = new FakeFleetApi();
    refusedApi.configBody = {
      version: "v3.5.0-test",
      authenticated: false,
      allowed: true,
      singleTenantRefusal: "access code required",
      access: null,
    };
    TestBed.configureTestingModule({
      imports: [FleetPageComponent],
      providers: [
        provideRouter([
          { path: "task/:id", children: [] },
          { path: "settings/hostds", children: [] },
        ]),
        { provide: GrainApi, useValue: refusedApi },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const refusedFixture = TestBed.createComponent(FleetPageComponent);
    refusedFixture.autoDetectChanges();
    await settle(refusedFixture);
    const refusedRoot = refusedFixture.nativeElement as HTMLElement;
    refusedRoot
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(refusedFixture);
    expect(
      refusedRoot.querySelector('[data-testid="fleet-enrollment-denied"]'),
    ).not.toBeNull();
    expect(
      refusedApi.calls.some(
        (c) =>
          c.route === "GET /api/hostds/enrollment-codes" ||
          c.route === "GET /api/hostds/pending",
      ),
    ).toBe(false);

    TestBed.resetTestingModule();
    const trustedApi = new FakeFleetApi();
    trustedApi.configBody = {
      version: "v3.5.0-test",
      authenticated: false,
      authMethod: "trusted",
      allowed: true,
      access: null,
    };
    TestBed.configureTestingModule({
      imports: [FleetPageComponent],
      providers: [
        provideRouter([
          { path: "task/:id", children: [] },
          { path: "settings/hostds", children: [] },
        ]),
        { provide: GrainApi, useValue: trustedApi },
        { provide: GrainEvents, useValue: { events: () => NEVER } },
      ],
    });
    const trustedFixture = TestBed.createComponent(FleetPageComponent);
    trustedFixture.autoDetectChanges();
    await settle(trustedFixture);
    const trustedRoot = trustedFixture.nativeElement as HTMLElement;
    trustedRoot
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(trustedFixture);
    expect(
      trustedRoot.querySelector('[data-testid="fleet-enrollment-denied"]'),
    ).toBeNull();
    expect(
      trustedRoot.querySelector('[data-testid="fleet-enrollment-row-default"]'),
    ).not.toBeNull();
  });

  it("gates host enrollment codes and pending approvals on scope: null after api.config() for non-operators, enforces access.can(), and handles operator flows & revocation", async () => {
    const api = new FakeFleetApi();
    api.configBody = {
      version: "v3.5.0-test",
      hostSandboxes: false,
      access: {
        role: "grain/admin",
        roles: ["grain/admin"],
        full: false,
        scopes: [
          "capabilities:read",
          "capabilities:admin",
          "settings:read",
          "settings:write",
          "deployment:read",
          "deployment:restart",
        ],
      },
    };

    const { fixture, root } = await setup(api);
    const access = TestBed.inject(AccessService);
    const cmp = fixture.componentInstance as unknown as {
      canReadHostds: () => boolean;
      canAdminHostds: () => boolean;
      canAccessEnrollment: () => boolean;
      canReadEnrollmentCodes: () => boolean;
      canCreateEnrollmentCode: () => boolean;
      canRotateEnrollmentCode: () => boolean;
      canRevokeEnrollmentCode: () => boolean;
      canReadPendingHostds: () => boolean;
      canAcceptPendingHostd: () => boolean;
      canRejectPendingHostd: () => boolean;
      newEnrollmentCodeName: { set: (v: string) => void };
      loadEnrollmentCodes: () => Promise<void>;
      loadPendingHostds: () => Promise<void>;
      createEnrollmentCode: () => Promise<void>;
      confirmRotateEnrollmentCode: (name: string) => void;
      confirmRevokeEnrollmentCode: (name: string) => void;
      acceptPendingHostd: (p: PendingHostJoinView) => Promise<void>;
      confirmRejectPendingHostd: (p: PendingHostJoinView) => void;
    };

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(fixture);

    // Non-operator holding capabilities:read + capabilities:admin still sees Hosts,
    // but all scope: null enrollment & pending approval routes are blocked.
    expect(cmp.canReadHostds()).toBe(true);
    expect(cmp.canAdminHostds()).toBe(true);
    expect(cmp.canAccessEnrollment()).toBe(false);
    expect(cmp.canReadEnrollmentCodes()).toBe(false);
    expect(cmp.canCreateEnrollmentCode()).toBe(false);
    expect(cmp.canRotateEnrollmentCode()).toBe(false);
    expect(cmp.canRevokeEnrollmentCode()).toBe(false);
    expect(cmp.canReadPendingHostds()).toBe(false);
    expect(cmp.canAcceptPendingHostd()).toBe(false);
    expect(cmp.canRejectPendingHostd()).toBe(false);
    expect(
      root.querySelector('[data-testid="hostd-row-workstation-1"]'),
    ).not.toBeNull();
    expect(root.querySelector('a[href="/settings/hostds"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-enrollment-denied"]')
        ?.textContent,
    ).toContain("grain/operator");
    expect(
      root.querySelector('[data-testid="fleet-pending-denied"]')?.textContent,
    ).toContain("grain/operator");
    expect(
      root.querySelector('[data-testid="fleet-enrollment-row-default"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-pending-row-hjr_1"]'),
    ).toBeNull();

    // Direct invocation of enrollment/pending methods does not emit any API calls.
    cmp.newEnrollmentCodeName.set("blocked-code");
    await cmp.loadEnrollmentCodes();
    await cmp.loadPendingHostds();
    await cmp.createEnrollmentCode();
    cmp.confirmRotateEnrollmentCode("default");
    cmp.confirmRevokeEnrollmentCode("default");
    await cmp.acceptPendingHostd(api.pendingBody[0]);
    cmp.confirmRejectPendingHostd(api.pendingBody[0]);
    expect(
      api.calls.filter(
        (c) =>
          c.route.includes("/enrollment-codes") || c.route.includes("/pending"),
      ),
    ).toHaveLength(0);

    // Grant grain/operator after config update and refresh.
    access.setConfig({
      access: {
        role: "grain/operator",
        roles: ["grain/operator"],
        full: true,
        scopes: [],
      },
    });
    await cmp.loadEnrollmentCodes();
    await cmp.loadPendingHostds();
    await settle(fixture);

    expect(cmp.canAccessEnrollment()).toBe(true);
    expect(
      root.querySelector('a[href="/settings/hostds"]')?.textContent,
    ).toContain("Enrollment & settings");
    expect(
      root.querySelector('[data-testid="fleet-enrollment-row-default"]')
        ?.textContent,
    ).toContain("Uses: 1 / 10");
    const pendingRow = root.querySelector(
      '[data-testid="fleet-pending-row-hjr_1"]',
    )!;
    expect(pendingRow.textContent).toContain("carol@example.com");
    expect(pendingRow.textContent).toContain(
      "SHA256:testKeyFingerprintValueForWrapChecks123456",
    );
    expect(pendingRow.textContent).not.toMatch(/pairing code/i);

    // Strict per-route access.can() check disables & blocks targeted mutation even for operator.
    const canSpy = vi.spyOn(access, "can").mockImplementation((route) => {
      if (route === "POST /api/hostds/enrollment-codes/{name}/rotate") {
        return false;
      }
      return true;
    });
    fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-rotate-default"]',
      )!.disabled,
    ).toBe(true);
    cmp.confirmRotateEnrollmentCode("default");
    expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    canSpy.mockRestore();
    fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();

    // Operator creates, rotates (via confirm dialog outside [attr.inert]), and revokes enrollment code.
    const codeInput = root.querySelector<HTMLInputElement>(
      '[data-testid="fleet-enrollment-name-input"]',
    )!;
    codeInput.value = "team-linux";
    codeInput.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-create-btn"]',
      )!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "POST /api/hostds/enrollment-codes" &&
          (c.body as { name: string }).name === "team-linux",
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-secret"]')
        ?.textContent,
    ).toContain("ghe_new99_team-linux");

    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-rotate-default"]',
      )!
      .click();
    await settle(fixture);
    const rotateDialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(rotateDialog.closest("[inert]")).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/hostds/enrollment-codes/{name}/rotate" &&
          (c.params as { name: string }).name === "default",
      ),
    ).toBe(true);

    // Operator approves pending host with custom labels.
    const labelsInput = root.querySelector<HTMLInputElement>(
      '[data-testid="fleet-pending-labels-hjr_1"]',
    )!;
    labelsInput.value = "gpu=l4,zone=west";
    labelsInput.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-pending-accept-hjr_1"]',
      )!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/hostds/pending/{id}/accept" &&
          (c.params as { id: string }).id === "hjr_1" &&
          (c.body as { name: string; labels?: Record<string, string> }).name ===
            "carol-devbox" &&
          (c.body as { labels?: Record<string, string> }).labels?.["gpu"] ===
            "l4",
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="hostd-row-carol-devbox"]'),
    ).not.toBeNull();

    // Operator rejects a second pending host via confirm dialog outside [attr.inert].
    api.pendingBody = [
      ...api.pendingBody,
      {
        id: "hjr_2",
        hostname: "bob-laptop.internal",
        suggested_name: "bob-laptop",
        os: "darwin",
        arch: "arm64",
        enrolled_by: "bob@example.com",
        key_fingerprint: "SHA256:bobFingerprint",
      },
    ];
    await cmp.loadPendingHostds();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-pending-reject-hjr_2"]',
      )!
      .click();
    await settle(fixture);
    const rejectDialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(rejectDialog.textContent).toContain(
      "Reject join request from bob-laptop?",
    );
    expect(rejectDialog.closest("[inert]")).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/hostds/pending/{id}/reject" &&
          (c.params as { id: string }).id === "hjr_2",
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="fleet-pending-row-hjr_2"]'),
    ).toBeNull();

    // Confirm dialog opened before revocation must no-op if operator role is revoked before Accept.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-revoke-team-linux"]',
      )!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    access.setConfig({
      access: {
        role: "grain/admin",
        roles: ["grain/admin"],
        full: false,
        scopes: ["capabilities:read", "capabilities:admin"],
      },
    });
    fixture.detectChanges();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) => c.route === "POST /api/hostds/enrollment-codes/{name}/revoke",
      ),
    ).toBe(false);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-secret"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-enrollment-denied"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-pending-denied"]'),
    ).not.toBeNull();

    // In-flight revocation during GET /api/hostds/enrollment-codes and GET /api/hostds/pending discards results.
    access.setConfig({ access: null });
    fixture.detectChanges();
    let resolveCodes!: (v: HostEnrollmentCodeView[]) => void;
    let resolvePending!: (v: PendingHostJoinView[]) => void;
    const origGet = api.get;
    api.get = (route, params, query) => {
      api.calls.push({ method: "GET", route, params, query });
      if (route === "GET /api/hostds/enrollment-codes") {
        return new Promise((r) => {
          resolveCodes = r;
        });
      }
      if (route === "GET /api/hostds/pending") {
        return new Promise((r) => {
          resolvePending = r;
        });
      }
      return origGet(route, params, query);
    };
    const pendingFetch = Promise.all([
      cmp.loadEnrollmentCodes(),
      cmp.loadPendingHostds(),
    ]);
    access.setConfig({
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["capabilities:read"],
      },
    });
    resolveCodes([
      { name: "leaked", prefix: "ghe_leak", code: "ghe_leak_secret" },
    ]);
    resolvePending([
      { id: "hjr_leak", hostname: "leak-host", key_fingerprint: "SHA256:leak" },
    ]);
    await pendingFetch;
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-row-leaked"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-pending-row-hjr_leak"]'),
    ).toBeNull();
  });

  it("confirms destructive sandbox, persistent lifecycle, and hostd rotate actions via g-confirm-dialog and no-ops if permissions or state change before Accept", async () => {
    const api = new FakeFleetApi();
    api.persistentBody = [
      {
        name: "staging-running",
        repo: "acme/web",
        ref: "main",
        command: "npm run preview",
        state: "running",
        enabled: true,
        restarts: 0,
      },
      {
        name: "staging-stopped",
        repo: "acme/web",
        ref: "main",
        command: "npm run preview",
        state: "stopped",
        enabled: false,
        restarts: 0,
      },
    ];
    const { fixture, root } = await setup(api);
    const access = TestBed.inject(AccessService);

    // Non-destructive Start executes directly without opening confirm dialog.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-start-staging-stopped"]',
      )!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
          (c.params as { name: string; action: string }).name ===
            "staging-stopped" &&
          (c.params as { name: string; action: string }).action === "start",
      ),
    ).toBe(true);

    // Rebuild, Restart, and Stop all open destructive confirm dialogs and honor Cancel vs Accept.
    for (const [action, expectedTitle] of [
      ["rebuild", "Rebuild persistent sandbox staging-running?"],
      ["stop", "Stop persistent sandbox staging-running?"],
      ["restart", "Restart persistent sandbox staging-running?"],
    ] as const) {
      const prevCalls = api.calls.length;
      root
        .querySelector<HTMLButtonElement>(
          `[data-testid="persistent-${action}-staging-running"]`,
        )!
        .click();
      await settle(fixture);
      const dlg = root.querySelector('[data-testid="confirm-dialog"]')!;
      expect(dlg).not.toBeNull();
      expect(dlg.closest("[inert]")).toBeNull();
      expect(dlg.textContent).toContain(expectedTitle);
      expect(
        dlg
          .querySelector('[data-testid="confirm-accept"]')
          ?.classList.contains("is-destructive"),
      ).toBe(true);

      dlg
        .querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!
        .click();
      await settle(fixture);
      expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
      expect(api.calls.slice(prevCalls)).toHaveLength(0);
    }

    // Accepting Rebuild sends POST /api/persistent-sandboxes/{name}/rebuild.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-rebuild-staging-running"]',
      )!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
          (c.params as { name: string; action: string }).name ===
            "staging-running" &&
          (c.params as { name: string; action: string }).action === "rebuild",
      ),
    ).toBe(true);

    // State transition before Accept (e.g. staging-running becomes stopped) blocks stale Stop.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-stop-staging-running"]',
      )!
      .click();
    await settle(fixture);
    api.persistentBody[0] = { ...api.persistentBody[0], state: "stopped" };
    const cmp = fixture.componentInstance as unknown as {
      loadPersistentSandboxes: () => Promise<void>;
    };
    await cmp.loadPersistentSandboxes();
    fixture.detectChanges();
    const callsBeforeStaleAccept = api.calls.length;
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls
        .slice(callsBeforeStaleAccept)
        .some(
          (c) => c.route === "POST /api/persistent-sandboxes/{name}/{action}",
        ),
    ).toBe(false);

    // Permission revocation while sandbox-recreate confirm dialog is open blocks POST.
    root
      .querySelector<HTMLButtonElement>('[data-testid="sandbox-recreate-42"]')!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    access.setConfig({
      access: {
        role: "viewer",
        roles: ["viewer"],
        full: false,
        scopes: ["deployment:read", "capabilities:read", "capabilities:admin"],
      },
    });
    fixture.detectChanges();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) => c.route === "POST /api/tasks/{id}/sandbox/recreate",
      ),
    ).toBe(false);

    // Permission revocation while hostd-rotate confirm dialog is open blocks POST.
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="hostd-rotate-workstation-1"]',
      )!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    access.setConfig({
      access: {
        role: "viewer",
        roles: ["viewer"],
        full: false,
        scopes: ["capabilities:read"],
      },
    });
    fixture.detectChanges();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "POST /api/hostds/{name}/rotate"),
    ).toBe(false);
  });

  it("applies is-mobile class below 600px, updates on media query change and resize, and cleans up listener", async () => {
    let matches = false;
    const listeners = new Set<(ev: MediaQueryListEvent) => void>();
    const addEventListener = vi.fn(
      (type: string, cb: (ev: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.add(cb);
      },
    );
    const removeEventListener = vi.fn(
      (type: string, cb: (ev: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.delete(cb);
      },
    );
    const matchMediaSpy = vi.fn((query: string) => ({
      matches: query === PHONE_QUERY ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener,
      removeEventListener,
      dispatchEvent: () => false,
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: matchMediaSpy,
    });

    const { fixture, root } = await setup();
    const pageEl = () =>
      root.querySelector<HTMLElement>('[data-testid="fleet-page"]');

    expect(matchMediaSpy).toHaveBeenCalledWith(PHONE_QUERY);
    expect(pageEl()?.classList.contains("is-mobile")).toBe(false);
    expect(addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );

    // Entering and exiting < 600px mobile viewport updates is-mobile.
    for (const cb of listeners) {
      cb({ matches: true, media: PHONE_QUERY } as MediaQueryListEvent);
    }
    fixture.detectChanges();
    expect(pageEl()?.classList.contains("is-mobile")).toBe(true);

    for (const cb of listeners) {
      cb({ matches: false, media: PHONE_QUERY } as MediaQueryListEvent);
    }
    fixture.detectChanges();
    expect(pageEl()?.classList.contains("is-mobile")).toBe(false);

    // Window resize re-queries PHONE_QUERY.
    matches = true;
    window.dispatchEvent(new Event("resize"));
    fixture.detectChanges();
    expect(pageEl()?.classList.contains("is-mobile")).toBe(true);

    fixture.destroy();
    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(listeners.size).toBe(0);
  });

  it("falls back to innerWidth and legacy MediaQueryList addListener/removeListener when needed", async () => {
    let legacyCb: ((ev: MediaQueryListEvent) => void) | null = null;
    const addListener = vi.fn((cb: (ev: MediaQueryListEvent) => void) => {
      legacyCb = cb;
    });
    const removeListener = vi.fn((cb: (ev: MediaQueryListEvent) => void) => {
      if (legacyCb === cb) legacyCb = null;
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () =>
        ({
          matches: false,
          addListener,
          removeListener,
        }) as unknown as MediaQueryList,
    });

    const legacyMount = await setup();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(
      legacyMount.root
        .querySelector('[data-testid="fleet-page"]')
        ?.classList.contains("is-mobile"),
    ).toBe(false);
    legacyCb!({ matches: true } as MediaQueryListEvent);
    legacyMount.fixture.detectChanges();
    expect(
      legacyMount.root
        .querySelector('[data-testid="fleet-page"]')
        ?.classList.contains("is-mobile"),
    ).toBe(true);
    legacyMount.fixture.destroy();
    expect(removeListener).toHaveBeenCalledTimes(1);
    TestBed.resetTestingModule();

    // Fallback to window.innerWidth < 600 (390px) when matchMedia is absent.
    Reflect.deleteProperty(window, "matchMedia");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    const fallbackMount = await setup();
    expect(
      fallbackMount.root
        .querySelector('[data-testid="fleet-page"]')
        ?.classList.contains("is-mobile"),
    ).toBe(true);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    window.dispatchEvent(new Event("resize"));
    fallbackMount.fixture.detectChanges();
    expect(
      fallbackMount.root
        .querySelector('[data-testid="fleet-page"]')
        ?.classList.contains("is-mobile"),
    ).toBe(false);
  });
});
