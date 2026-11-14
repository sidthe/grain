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

import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { NEVER } from "rxjs";
import { GrainApi, routeScope } from "../api/grain-api.service";
import { GrainEvents } from "../api/grain-events.service";
import type { GrainConfig } from "../api/models";
import { AccessService } from "../services/access.service";
import { PHONE_QUERY } from "../shared/split";
import { FleetPageComponent } from "./fleet-page.component";
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
  type PersistentSandboxStatus,
  type PipelinePauseStatus,
  type SandboxHealthResponse,
  effectivePersistentState,
  extractTaskIdFromSandbox,
  isPersistentActionAllowed,
  parseHostdLabels,
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

  enrollmentCodesBody: HostEnrollmentCodeView[] = [];
  pendingHostdsBody: PendingHostJoinView[] = [];

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
        return Promise.resolve(structuredClone(this.pendingHostdsBody));
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
      const name = (body as { name?: string })?.name ?? "default";
      const created: HostEnrollmentCodeView = {
        name,
        code: `ghe_secret_${name}`,
        uses: 0,
        max_uses: 10,
        install: {
          command: `curl -fsSL https://grain.example.com/hostd/install | sh -s -- --join ghe_secret_${name}`,
        },
      };
      this.enrollmentCodesBody = [...this.enrollmentCodesBody, created];
      return Promise.resolve(structuredClone(created));
    }
    if (route === "POST /api/hostds/enrollment-codes/{name}/rotate") {
      const name = params?.["name"] ?? "default";
      const rotated: HostEnrollmentCodeView = {
        name,
        code: `ghe_rotated_${name}`,
        uses: 1,
        max_uses: 10,
        install: {
          command: `curl -fsSL https://grain.example.com/hostd/install | sh -s -- --join ghe_rotated_${name}`,
        },
      };
      this.enrollmentCodesBody = this.enrollmentCodesBody.map((c) =>
        c.name === name ? rotated : c,
      );
      return Promise.resolve(structuredClone(rotated));
    }
    if (route === "POST /api/hostds/enrollment-codes/{name}/revoke") {
      const name = params?.["name"] ?? "default";
      this.enrollmentCodesBody = this.enrollmentCodesBody.map((c) =>
        c.name === name ? { ...c, revoked_at: "2026-11-14T00:00:00Z" } : c,
      );
      return Promise.resolve({ name, revoked_at: "2026-11-14T00:00:00Z" });
    }
    if (route === "POST /api/hostds/pending/{id}/accept") {
      const id = params?.["id"] ?? "";
      this.pendingHostdsBody = this.pendingHostdsBody.filter(
        (p) => p.id !== id,
      );
      const req = body as { name?: string; labels?: Record<string, string> };
      this.hostdsBody = [
        ...this.hostdsBody,
        {
          name: req?.name || id,
          state: "connected",
          labels: req?.labels,
        },
      ];
      return Promise.resolve({ name: req?.name || id, state: "connected" });
    }
    if (route === "POST /api/hostds/pending/{id}/reject") {
      const id = params?.["id"] ?? "";
      this.pendingHostdsBody = this.pendingHostdsBody.filter(
        (p) => p.id !== id,
      );
      return Promise.resolve({ ok: true });
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
  afterEach(() => {
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

    // Recreate task sandbox requires confirmation outside [attr.inert].
    root
      .querySelector<HTMLButtonElement>('[data-testid="sandbox-recreate-42"]')!
      .click();
    await settle(fixture);
    const recreateDialog = root.querySelector(
      '[data-testid="confirm-dialog"]',
    )!;
    expect(recreateDialog).not.toBeNull();
    expect(recreateDialog.closest("[inert]")).toBeNull();
    expect(recreateDialog.textContent).toContain(
      "Recreate sandbox for task #42?",
    );
    expect(
      api.calls.some(
        (c) => c.route === "POST /api/tasks/{id}/sandbox/recreate",
      ),
    ).toBe(false);

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      api.calls.some(
        (c) => c.route === "POST /api/tasks/{id}/sandbox/recreate",
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

    // Persistent sandbox restart confirms via g-confirm-dialog + ?format=text logs viewer.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-restart-staging-web"]',
      )!
      .click();
    await settle(fixture);
    const restartPersistentDialog = root.querySelector(
      '[data-testid="confirm-dialog"]',
    )!;
    expect(restartPersistentDialog).not.toBeNull();
    expect(restartPersistentDialog.textContent).toContain(
      "Restart persistent sandbox staging-web?",
    );
    expect(
      api.calls.some(
        (c) => c.route === "POST /api/persistent-sandboxes/{name}/{action}",
      ),
    ).toBe(false);
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

    // Rotate token requires confirmation outside [attr.inert] and shows one-time token banner on accept.
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
    expect(
      api.calls.some((c) => c.route === "POST /api/hostds/{name}/rotate"),
    ).toBe(false);

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
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

    // Revoke requires ConfirmDialogComponent acceptance OUTSIDE [attr.inert] and clears issued token.
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
    expect(root.querySelector('[data-testid="hostd-issued-token"]')).toBeNull();
  });

  it("toggles pipeline pause, flushes caches with confirmation, and confirms daemon restart", async () => {
    const { fixture, root, api } = await setup();

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-controls"]')!
      .click();
    await settle(fixture);

    // Pause pipeline with reason via confirmation dialog, then resume via confirmation dialog.
    const reasonInput = root.querySelector<HTMLInputElement>(
      '[data-testid="pipeline-pause-reason"]',
    )!;
    reasonInput.value = "Deploying M12";
    reasonInput.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>('[data-testid="pipeline-pause-btn"]')!
      .click();
    await settle(fixture);
    const pauseDialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(pauseDialog).not.toBeNull();
    expect(pauseDialog.textContent).toContain("Pause the pipeline?");
    expect(pauseDialog.textContent).toContain("Deploying M12");
    expect(api.calls.some((c) => c.route === "POST /api/pipeline-pause")).toBe(
      false,
    );

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
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
      root.querySelector('[data-testid="confirm-dialog"]')?.textContent,
    ).toContain("Resume the pipeline?");
    expect(
      api.calls.some((c) => c.route === "DELETE /api/pipeline-pause"),
    ).toBe(false);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
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

  it("gates persistent sandbox lifecycle actions based on current ps.state, busy state, and RBAC", async () => {
    const api = new FakeFleetApi();
    api.persistentBody = [
      {
        name: "sb-running",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
      {
        name: "sb-stopped",
        repo: "acme/web",
        command: "npm start",
        enabled: false,
        state: "stopped",
        restarts: 0,
      },
      {
        name: "sb-idle",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "idle",
        restarts: 0,
      },
      {
        name: "sb-empty-idle",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "",
        restarts: 0,
      },
      {
        name: "sb-empty-stopped",
        repo: "acme/web",
        command: "npm start",
        enabled: false,
        state: "",
        restarts: 0,
      },
      {
        name: "sb-starting",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "starting",
        restarts: 0,
      },
      {
        name: "sb-restarting",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "restarting",
        restarts: 2,
      },
      {
        name: "sb-unknown",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "stopping",
        restarts: 0,
      },
    ];

    const { fixture, root } = await setup(api);

    const btn = (name: string, action: string): HTMLButtonElement => {
      const el = root.querySelector<HTMLButtonElement>(
        `[data-testid="persistent-${action}-${name}"]`,
      );
      expect(el).not.toBeNull();
      return el!;
    };

    const expectDisabled = (
      name: string,
      expected: Record<"start" | "restart" | "rebuild" | "stop", boolean>,
    ) => {
      for (const action of ["start", "restart", "rebuild", "stop"] as const) {
        expect(btn(name, action).disabled, `${name} ${action} disabled`).toBe(
          expected[action],
        );
      }
    };

    expectDisabled("sb-running", {
      start: true,
      restart: false,
      rebuild: false,
      stop: false,
    });
    expectDisabled("sb-stopped", {
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expectDisabled("sb-idle", {
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expectDisabled("sb-empty-idle", {
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expectDisabled("sb-empty-stopped", {
      start: false,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expectDisabled("sb-starting", {
      start: true,
      restart: true,
      rebuild: true,
      stop: false,
    });
    expectDisabled("sb-restarting", {
      start: true,
      restart: false,
      rebuild: false,
      stop: false,
    });
    expectDisabled("sb-unknown", {
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });

    // Disabled actions do not fire API calls when clicked or invoked directly.
    btn("sb-idle", "stop").click();
    btn("sb-stopped", "restart").click();
    btn("sb-stopped", "rebuild").click();
    btn("sb-running", "start").click();
    btn("sb-starting", "restart").click();
    await (
      fixture.componentInstance as unknown as {
        controlPersistent: (
          ps: PersistentSandboxStatus,
          action: "start" | "stop" | "restart" | "rebuild",
        ) => Promise<void>;
      }
    ).controlPersistent(api.persistentBody[2], "stop");
    await settle(fixture);
    expect(
      api.calls.filter(
        (c) => c.route === "POST /api/persistent-sandboxes/{name}/{action}",
      ),
    ).toEqual([]);

    // Valid actions fire POST requests and disable all actions on that sandbox while in flight.
    let resolveStart!: (value: unknown) => void;
    const origPost = api.post;
    api.post = (route, params, body, query) => {
      if (
        route === "POST /api/persistent-sandboxes/{name}/{action}" &&
        params?.["name"] === "sb-stopped"
      ) {
        api.calls.push({ method: "POST", route, params, body, query });
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return origPost(route, params, body, query);
    };

    btn("sb-stopped", "start").click();
    await settle(fixture);
    expectDisabled("sb-stopped", {
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expectDisabled("sb-running", {
      start: true,
      restart: false,
      rebuild: false,
      stop: false,
    });

    resolveStart({ ok: true });
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
          (c.params as { name: string; action: string }).name ===
            "sb-stopped" &&
          (c.params as { name: string; action: string }).action === "start",
      ),
    ).toBe(true);

    // RBAC still disables otherwise state-valid actions when deployment:restart is missing.
    TestBed.inject(AccessService).setConfig({
      access: {
        role: "sandbox-viewer",
        roles: ["sandbox-viewer"],
        full: false,
        scopes: ["sandboxes:read", "deployment:read"],
      },
    });
    fixture.detectChanges();
    await settle(fixture);
    expectDisabled("sb-running", {
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });
    expectDisabled("sb-stopped", {
      start: true,
      restart: true,
      rebuild: true,
      stop: true,
    });

    // Helper edge cases: whitespace/casing normalization and busy prefix isolation.
    expect(
      effectivePersistentState({ state: " Running ", enabled: true }),
    ).toBe("running");
    expect(
      isPersistentActionAllowed({ state: " IDLE ", enabled: true }, "start"),
    ).toBe(true);
    expect(
      isPersistentActionAllowed({ state: " IDLE ", enabled: true }, "stop"),
    ).toBe(false);

    const comp = fixture.componentInstance as unknown as {
      busyPersistent: { set: (v: string | null) => void };
      isPersistentBusy: (ps: PersistentSandboxStatus) => boolean;
      persistentActionTip: (
        ps: PersistentSandboxStatus,
        action: "start" | "stop" | "restart" | "rebuild",
        label: string,
      ) => string;
    };
    comp.busyPersistent.set("sb-stopped-2:start");
    expect(comp.isPersistentBusy(api.persistentBody[1])).toBe(false);
    comp.busyPersistent.set(null);

    TestBed.inject(AccessService).setConfig(api.configBody);
    fixture.detectChanges();
    await settle(fixture);
    expect(
      comp.persistentActionTip(api.persistentBody[2], "stop", "Stop"),
    ).toBe("Stop is unavailable while sb-idle is idle.");
    expect(
      comp.persistentActionTip(api.persistentBody[0], "start", "Start"),
    ).toBe("Start is unavailable while sb-running is running.");
    expect(
      comp.persistentActionTip(api.persistentBody[0], "stop", "Stop"),
    ).toBe("Stop persistent sandbox sb-running");
  });

  it("enforces deployment:read scope context before fetching persistent sandbox logs and handles canReadPersistentLogs failures", async () => {
    const api = new FakeFleetApi();
    api.configBody = {
      version: "v3.5.0-test",
      hostSandboxes: false,
      access: {
        role: "api-viewer",
        roles: ["api-viewer"],
        full: false,
        scopes: ["sandboxes:read", "deployment:read"],
        repoLimits: { "deployment:read": ["acme/api"] },
      },
    };
    api.persistentBody = [
      {
        name: "sb-allowed",
        repo: "acme/api",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
      {
        name: "sb-padded",
        repo: " acme/api ",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
      {
        name: "sb-other",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
      {
        name: "sb-norepo",
        repo: "",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
      {
        name: "sb-blankrepo",
        repo: "   ",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
    ];

    const { fixture, root } = await setup(api);
    const comp = fixture.componentInstance as unknown as {
      canReadPersistentLogs: (ps: PersistentSandboxStatus) => boolean;
      persistentLogsTip: (ps: PersistentSandboxStatus) => string;
      togglePersistentLogs: (ps: PersistentSandboxStatus) => Promise<void>;
      openPersistentLogName: () => string | null;
    };
    const [sbAllowed, sbPadded, sbOther, sbNoRepo, sbBlankRepo] =
      api.persistentBody;

    const logsBtn = (name: string) =>
      root.querySelector<HTMLButtonElement>(
        `[data-testid="persistent-logs-btn-${name}"]`,
      )!;

    expect(comp.canReadPersistentLogs(sbAllowed)).toBe(true);
    expect(comp.canReadPersistentLogs(sbPadded)).toBe(true);
    expect(comp.canReadPersistentLogs(sbOther)).toBe(false);
    expect(comp.canReadPersistentLogs(sbNoRepo)).toBe(false);
    expect(comp.canReadPersistentLogs(sbBlankRepo)).toBe(false);

    expect(logsBtn("sb-allowed").disabled).toBe(false);
    expect(logsBtn("sb-padded").disabled).toBe(false);
    expect(logsBtn("sb-other").disabled).toBe(true);
    expect(logsBtn("sb-norepo").disabled).toBe(true);
    expect(logsBtn("sb-blankrepo").disabled).toBe(true);

    expect(comp.persistentLogsTip(sbAllowed)).toBe("View logs for sb-allowed");
    expect(comp.persistentLogsTip(sbOther)).toContain("deployment:read");
    expect(comp.persistentLogsTip(sbOther)).toContain("on this repository");
    expect(comp.persistentLogsTip(sbNoRepo)).toContain("deployment:read");
    expect(comp.persistentLogsTip(sbNoRepo)).toContain("repository-limited");
    expect(comp.persistentLogsTip(sbBlankRepo)).toContain("deployment:read");
    expect(comp.persistentLogsTip(sbBlankRepo)).toContain("repository-limited");

    // Direct calls to togglePersistentLogs for unauthorized sandboxes must not fetch.
    await comp.togglePersistentLogs(sbOther);
    await comp.togglePersistentLogs(sbNoRepo);
    await comp.togglePersistentLogs(sbBlankRepo);
    await settle(fixture);
    expect(
      api.calls.filter(
        (c) => c.route === "GET /api/persistent-sandboxes/{name}/logs",
      ),
    ).toEqual([]);
    expect(comp.openPersistentLogName()).toBeNull();

    // Permitted sandbox fetches ?format=text and renders logs.
    logsBtn("sb-allowed").click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET_TEXT" &&
          c.route === "GET /api/persistent-sandboxes/{name}/logs" &&
          (c.params as { name: string }).name === "sb-allowed" &&
          c.query === "format=text",
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-allowed"]')
        ?.textContent,
    ).toContain("[sb-allowed] listening on :4173");

    // Revoking deployment:read hides open logs and blocks further fetches.
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "sandboxes-only",
        roles: ["sandboxes-only"],
        full: false,
        scopes: ["sandboxes:read"],
      },
    });
    fixture.detectChanges();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-allowed"]'),
    ).toBeNull();
    expect(logsBtn("sb-allowed").disabled).toBe(true);
    expect(comp.persistentLogsTip(sbAllowed)).toContain("deployment:read");

    api.calls = [];
    await comp.togglePersistentLogs(sbAllowed);
    await settle(fixture);
    expect(
      api.calls.filter(
        (c) => c.route === "GET /api/persistent-sandboxes/{name}/logs",
      ),
    ).toEqual([]);
    expect(comp.openPersistentLogName()).toBeNull();

    // In-flight revocation does not expose logs after response arrives.
    access.setConfig(api.configBody);
    fixture.detectChanges();
    await settle(fixture);
    let resolveLogs!: (v: string) => void;
    const origGetText = api.getText;
    api.getText = (route, params, query) => {
      if (route === "GET /api/persistent-sandboxes/{name}/logs") {
        api.calls.push({ method: "GET_TEXT", route, params, query });
        return new Promise<string>((resolve) => {
          resolveLogs = resolve;
        });
      }
      return origGetText(route, params, query);
    };
    logsBtn("sb-padded").click();
    await settle(fixture);
    access.setConfig({
      access: {
        role: "sandboxes-only",
        roles: ["sandboxes-only"],
        full: false,
        scopes: ["sandboxes:read"],
      },
    });
    resolveLogs("sensitive secret line");
    await settle(fixture);
    expect(comp.openPersistentLogName()).toBeNull();
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-padded"]'),
    ).toBeNull();

    // Global deployment:read (no repoLimits) allows reading repo-less persistent sandbox logs.
    api.getText = origGetText;
    access.setConfig({
      access: {
        role: "deployment-reader",
        roles: ["deployment-reader"],
        full: false,
        scopes: ["sandboxes:read", "deployment:read"],
      },
    });
    fixture.detectChanges();
    await settle(fixture);
    expect(comp.canReadPersistentLogs(sbNoRepo)).toBe(true);
    expect(comp.canReadPersistentLogs(sbOther)).toBe(true);
    logsBtn("sb-norepo").click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="persistent-logs-sb-norepo"]')
        ?.textContent,
    ).toContain("[sb-norepo] listening on :4173");
  });

  it("fails closed on canReadPersistentLogs before access config is loaded", async () => {
    const api = new FakeFleetApi();
    let resolveCfg!: (cfg: GrainConfig) => void;
    api.config = () =>
      new Promise<GrainConfig>((resolve) => {
        resolveCfg = resolve;
      });

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
    const fixture = TestBed.createComponent(FleetPageComponent);
    fixture.detectChanges();

    const comp = fixture.componentInstance as unknown as {
      canReadPersistentLogs: (ps: PersistentSandboxStatus) => boolean;
      persistentLogsTip: (ps: PersistentSandboxStatus) => string;
      togglePersistentLogs: (ps: PersistentSandboxStatus) => Promise<void>;
    };
    const sandbox = api.persistentBody[0];

    expect(access.configLoaded()).toBe(false);
    expect(comp.canReadPersistentLogs(sandbox)).toBe(false);
    expect(comp.persistentLogsTip(sandbox)).toContain("deployment:read");

    await comp.togglePersistentLogs(sandbox);
    expect(
      api.calls.filter(
        (c) => c.route === "GET /api/persistent-sandboxes/{name}/logs",
      ),
    ).toEqual([]);

    resolveCfg(api.configBody);
    await settle(fixture);

    expect(access.configLoaded()).toBe(true);
    expect(comp.canReadPersistentLogs(sandbox)).toBe(true);
  });

  it("requires scope: null operator gating after api.config() for host enrollment codes and pending approvals", async () => {
    const operatorRoutes = [
      "GET /api/hostds/enrollment-codes",
      "POST /api/hostds/enrollment-codes",
      "POST /api/hostds/enrollment-codes/{name}/rotate",
      "POST /api/hostds/enrollment-codes/{name}/revoke",
      "GET /api/hostds/pending",
      "POST /api/hostds/pending/{id}/accept",
      "POST /api/hostds/pending/{id}/reject",
    ] as const;
    for (const r of operatorRoutes) {
      expect(routeScope(r), `${r} routeScope`).toBeNull();
    }

    const api = new FakeFleetApi();
    api.enrollmentCodesBody = [
      {
        name: "team-code",
        uses: 1,
        max_uses: 5,
        created_by: "alice@example.com",
      },
      {
        name: "old-code",
        uses: 2,
        max_uses: 2,
        revoked_at: "2026-11-10T00:00:00Z",
      },
    ];
    api.pendingHostdsBody = [
      {
        id: "hjr_1",
        hostname: "dev-box.example.com",
        suggested_name: "dev-box",
        enrolled_by: "carol@example.com",
        os: "linux",
        arch: "amd64",
        key_fingerprint: "SHA256:abcdef1234567890",
        default_labels: { team: "infra" },
        default_capacity: 4,
      },
      {
        id: "hjr_2",
        hostname: "rogue-box.example.com",
        suggested_name: "rogue-box",
        enrolled_by: "mallory@example.com",
        os: "darwin",
        arch: "arm64",
        key_fingerprint: "SHA256:999999",
      },
    ];

    let resolveCfg!: (cfg: GrainConfig) => void;
    api.config = () =>
      new Promise<GrainConfig>((resolve) => {
        resolveCfg = resolve;
      });

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
    const fixture = TestBed.createComponent(FleetPageComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    const comp = fixture.componentInstance as unknown as {
      canReadEnrollmentCodes: () => boolean;
      canCreateEnrollmentCode: () => boolean;
      canRotateEnrollmentCode: () => boolean;
      canRevokeEnrollmentCode: () => boolean;
      canReadPendingHostds: () => boolean;
      canAcceptPendingHostd: () => boolean;
      canRejectPendingHostd: () => boolean;
      newEnrollmentCodeName: { set: (v: string) => void };
      loadHostds: () => Promise<void>;
      loadHostEnrollmentCodes: () => Promise<void>;
      loadPendingHostds: () => Promise<void>;
      createEnrollmentCode: () => Promise<void>;
      confirmRotateEnrollmentCode: (name: string) => void;
      confirmRevokeEnrollmentCode: (name: string) => void;
      acceptPendingHostd: (p: PendingHostJoinView) => Promise<void>;
      confirmRejectPendingHostd: (p: PendingHostJoinView) => void;
      confirmReq: () => unknown;
    };

    // Switch to Hosts tab before api.config() resolves: everything must fail closed.
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    fixture.detectChanges();

    expect(access.configLoaded()).toBe(false);
    expect(comp.canReadEnrollmentCodes()).toBe(false);
    expect(comp.canCreateEnrollmentCode()).toBe(false);
    expect(comp.canRotateEnrollmentCode()).toBe(false);
    expect(comp.canRevokeEnrollmentCode()).toBe(false);
    expect(comp.canReadPendingHostds()).toBe(false);
    expect(comp.canAcceptPendingHostd()).toBe(false);
    expect(comp.canRejectPendingHostd()).toBe(false);

    expect(
      root.querySelector('[data-testid="fleet-enrollment-restricted"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-pending-restricted"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-enrollment-name-input"]'),
    ).toBeNull();
    expect(root.querySelector('[data-testid="fleet-pending-list"]')).toBeNull();

    // Direct invocation of loaders or mutations before api.config() must send zero API calls.
    comp.newEnrollmentCodeName.set("early-code");
    await comp.loadHostEnrollmentCodes();
    await comp.loadPendingHostds();
    await comp.createEnrollmentCode();
    comp.confirmRotateEnrollmentCode("team-code");
    comp.confirmRevokeEnrollmentCode("team-code");
    await comp.acceptPendingHostd(api.pendingHostdsBody[0]);
    comp.confirmRejectPendingHostd(api.pendingHostdsBody[1]);
    expect(comp.confirmReq()).toBeNull();
    expect(
      api.calls.filter(
        (c) =>
          c.route.includes("/enrollment-codes") ||
          c.route.includes("/hostds/pending"),
      ),
    ).toEqual([]);

    // Resolve api.config() as a non-operator role that holds capabilities:read/admin and settings:write.
    resolveCfg({
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
        ],
      },
    });
    await settle(fixture);

    expect(access.configLoaded()).toBe(true);
    // Registered hosts (capabilities:read/admin) still work for non-operator admin.
    expect(api.calls.some((c) => c.route === "GET /api/hostds")).toBe(true);
    expect(
      root.querySelector('[data-testid="hostd-row-workstation-1"]'),
    ).not.toBeNull();

    // Enrollment codes & pending approvals (scope: null) remain gated without 403 calls.
    expect(comp.canReadEnrollmentCodes()).toBe(false);
    expect(comp.canCreateEnrollmentCode()).toBe(false);
    expect(comp.canRotateEnrollmentCode()).toBe(false);
    expect(comp.canRevokeEnrollmentCode()).toBe(false);
    expect(comp.canReadPendingHostds()).toBe(false);
    expect(comp.canAcceptPendingHostd()).toBe(false);
    expect(comp.canRejectPendingHostd()).toBe(false);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-restricted"]')
        ?.textContent,
    ).toContain("grain/operator");
    expect(
      root.querySelector('[data-testid="fleet-pending-restricted"]')
        ?.textContent,
    ).toContain("grain/operator");

    await comp.loadHostds();
    await comp.createEnrollmentCode();
    comp.confirmRotateEnrollmentCode("team-code");
    comp.confirmRevokeEnrollmentCode("team-code");
    await comp.acceptPendingHostd(api.pendingHostdsBody[0]);
    comp.confirmRejectPendingHostd(api.pendingHostdsBody[1]);
    expect(comp.confirmReq()).toBeNull();
    expect(
      api.calls.filter(
        (c) =>
          c.route.includes("/enrollment-codes") ||
          c.route.includes("/hostds/pending"),
      ),
    ).toEqual([]);
  });

  it("allows operator enrollment codes and pending approval workflows, enforces confirmation, and revokes dynamically", async () => {
    const api = new FakeFleetApi();
    api.enrollmentCodesBody = [
      {
        name: "team-code",
        uses: 1,
        max_uses: 5,
        created_by: "alice@example.com",
      },
      {
        name: "old-code",
        uses: 2,
        max_uses: 2,
        revoked_at: "2026-11-10T00:00:00Z",
      },
    ];
    api.pendingHostdsBody = [
      {
        id: "hjr_1",
        hostname: "dev-box.example.com",
        suggested_name: "dev-box",
        enrolled_by: "carol@example.com",
        os: "linux",
        arch: "amd64",
        key_fingerprint: "SHA256:abcdef1234567890",
        default_labels: { team: "infra" },
        default_capacity: 4,
      },
      {
        id: "hjr_2",
        hostname: "rogue-box.example.com",
        suggested_name: "rogue-box",
        enrolled_by: "mallory@example.com",
        os: "darwin",
        arch: "arm64",
        key_fingerprint: "SHA256:999999",
      },
    ];

    const { fixture, root } = await setup(api);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="fleet-enrollment-row-team-code"]')
        ?.textContent,
    ).toContain("active");
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-rotate-old-code"]',
      )!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-revoke-old-code"]',
      )!.disabled,
    ).toBe(true);

    expect(
      root.querySelector('[data-testid="fleet-pending-count"]')?.textContent,
    ).toContain("2 pending");
    expect(
      root.querySelector('[data-testid="fleet-pending-fingerprint-hjr_1"]')
        ?.textContent,
    ).toContain("SHA256:abcdef1234567890");
    expect(
      root.querySelector('[data-testid="fleet-pending-row-hjr_1"]')
        ?.textContent,
    ).toContain("carol@example.com");

    // Create enrollment code -> displays one-time issued secret banner.
    const nameInput = root.querySelector<HTMLInputElement>(
      '[data-testid="fleet-enrollment-name-input"]',
    )!;
    nameInput.value = "ml-hosts";
    nameInput.dispatchEvent(new Event("input"));
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-create-btn"]',
      )!
      .click();
    await settle(fixture);

    expect(
      root.querySelector('[data-testid="fleet-enrollment-issued"]')
        ?.textContent,
    ).toContain("ghe_secret_ml-hosts");
    expect(
      root.querySelector('[data-testid="fleet-enrollment-row-ml-hosts"]'),
    ).not.toBeNull();

    // Rotate enrollment code requires confirmation outside [inert].
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-rotate-team-code"]',
      )!
      .click();
    await settle(fixture);
    const rotateDialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(rotateDialog.textContent).toContain(
      "Rotate enrollment code team-code?",
    );
    expect(rotateDialog.closest("[inert]")).toBeNull();
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-issued"]')
        ?.textContent,
    ).toContain("ghe_rotated_team-code");

    // Revoke enrollment code requires confirmation.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-enrollment-revoke-team-code"]',
      )!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-row-team-code"]')
        ?.textContent,
    ).toContain("revoked");
    // Issued banner for the revoked code is cleared.
    expect(
      root.querySelector('[data-testid="fleet-enrollment-issued"]'),
    ).toBeNull();

    // Invalid pending label draft aborts accept without posting.
    const labelsInput = root.querySelector<HTMLInputElement>(
      '[data-testid="fleet-pending-labels-hjr_1"]',
    )!;
    labelsInput.value = "badlabel";
    labelsInput.dispatchEvent(new Event("input"));
    await settle(fixture);
    expect(parseHostdLabels("badlabel").error).toContain("key=value");
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-pending-accept-hjr_1"]',
      )!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "POST /api/hostds/pending/{id}/accept"),
    ).toBe(false);

    // Valid labels accept pending host and add it to hostds list.
    labelsInput.value = "gpu=l4,zone=us-central1";
    labelsInput.dispatchEvent(new Event("input"));
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-pending-accept-hjr_1"]',
      )!
      .click();
    await settle(fixture);
    const acceptCall = api.calls.find(
      (c) => c.route === "POST /api/hostds/pending/{id}/accept",
    );
    expect(acceptCall?.body).toEqual({
      name: "dev-box",
      labels: { gpu: "l4", zone: "us-central1" },
      capacity: 4,
    });
    expect(
      root.querySelector('[data-testid="hostd-row-dev-box"]'),
    ).not.toBeNull();

    // Reject pending host requires confirmation, and guards mid-dialog revocation.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-pending-reject-hjr_2"]',
      )!
      .click();
    await settle(fixture);
    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "grain/admin",
        roles: ["grain/admin"],
        full: false,
        scopes: ["capabilities:admin", "capabilities:read"],
      },
    });
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "POST /api/hostds/pending/{id}/reject"),
    ).toBe(false);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-restricted"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-pending-restricted"]'),
    ).not.toBeNull();

    // Legacy non-RBAC operator config (access: null) after configLoaded is allowed.
    access.setConfig({ access: null });
    fixture.detectChanges();
    await settle(fixture);
    const comp = fixture.componentInstance as unknown as {
      canReadEnrollmentCodes: () => boolean;
      canReadPendingHostds: () => boolean;
      loadHostds: () => Promise<void>;
    };
    expect(comp.canReadEnrollmentCodes()).toBe(true);
    expect(comp.canReadPendingHostds()).toBe(true);
    await comp.loadHostds();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="fleet-pending-reject-hjr_2"]',
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
          c.route === "POST /api/hostds/pending/{id}/reject" &&
          (c.params as { id: string }).id === "hjr_2",
      ),
    ).toBe(true);
    expect(
      root.querySelector('[data-testid="fleet-pending-empty"]'),
    ).not.toBeNull();
  });

  it("discards in-flight enrollment and pending responses if operator access is revoked mid-request", async () => {
    const api = new FakeFleetApi();
    let resolveCodes!: (v: HostEnrollmentCodeView[]) => void;
    let resolvePending!: (v: PendingHostJoinView[]) => void;
    const origGet = api.get;
    api.get = (route, params, query) => {
      if (route === "GET /api/hostds/enrollment-codes") {
        api.calls.push({ method: "GET", route, params, query });
        return new Promise<HostEnrollmentCodeView[]>((resolve) => {
          resolveCodes = resolve;
        });
      }
      if (route === "GET /api/hostds/pending") {
        api.calls.push({ method: "GET", route, params, query });
        return new Promise<PendingHostJoinView[]>((resolve) => {
          resolvePending = resolve;
        });
      }
      return origGet(route, params, query);
    };

    const { fixture, root } = await setup(api);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-hostds"]')!
      .click();
    await settle(fixture);

    const access = TestBed.inject(AccessService);
    access.setConfig({
      access: {
        role: "grain/viewer",
        roles: ["grain/viewer"],
        full: false,
        scopes: ["capabilities:read"],
      },
    });
    resolveCodes([{ name: "secret-code", uses: 0 }]);
    resolvePending([
      {
        id: "hjr_secret",
        hostname: "secret-host",
        key_fingerprint: "SHA256:secret",
        enrolled_by: "alice@example.com",
      },
    ]);
    await settle(fixture);

    const comp = fixture.componentInstance as unknown as {
      enrollmentCodes: () => HostEnrollmentCodeView[];
      pendingHostds: () => PendingHostJoinView[];
    };
    expect(comp.enrollmentCodes()).toEqual([]);
    expect(comp.pendingHostds()).toEqual([]);
    expect(
      root.querySelector('[data-testid="fleet-enrollment-restricted"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="fleet-pending-restricted"]'),
    ).not.toBeNull();
  });

  it("keeps enrollment and pending approvals locked when api.config() fails or access.can() denies", async () => {
    const api = new FakeFleetApi();
    api.config = () => Promise.reject(new Error("config unavailable"));

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
    const fixture = TestBed.createComponent(FleetPageComponent);
    fixture.detectChanges();
    await settle(fixture);

    const comp = fixture.componentInstance as unknown as {
      canReadEnrollmentCodes: () => boolean;
      canCreateEnrollmentCode: () => boolean;
      canReadPendingHostds: () => boolean;
      canAcceptPendingHostd: () => boolean;
      loadHostds: () => Promise<void>;
    };
    expect(access.configLoaded()).toBe(false);
    expect(comp.canReadEnrollmentCodes()).toBe(false);
    expect(comp.canCreateEnrollmentCode()).toBe(false);
    expect(comp.canReadPendingHostds()).toBe(false);
    expect(comp.canAcceptPendingHostd()).toBe(false);
    expect(
      api.calls.filter(
        (c) =>
          c.route.includes("/enrollment-codes") ||
          c.route.includes("/hostds/pending"),
      ),
    ).toEqual([]);

    // Even once configLoaded is true as operator, an explicit access.can() denial blocks calls.
    access.setConfig(api.configBody);
    const canSpy = vi.spyOn(access, "can").mockImplementation((route) => {
      if (
        route.includes("/enrollment-codes") ||
        route.includes("/hostds/pending")
      ) {
        return false;
      }
      return true;
    });
    fixture.detectChanges();
    expect(comp.canReadEnrollmentCodes()).toBe(false);
    expect(comp.canCreateEnrollmentCode()).toBe(false);
    expect(comp.canReadPendingHostds()).toBe(false);
    expect(comp.canAcceptPendingHostd()).toBe(false);
    await comp.loadHostds();
    expect(
      api.calls.filter(
        (c) =>
          c.route.includes("/enrollment-codes") ||
          c.route.includes("/hostds/pending"),
      ),
    ).toEqual([]);
    canSpy.mockRestore();
  });

  it("requires g-confirm-dialog confirmation for destructive persistent sandbox actions while running start immediately", async () => {
    const api = new FakeFleetApi();
    api.persistentBody = [
      {
        name: "sb-live",
        repo: "acme/web",
        command: "npm start",
        enabled: true,
        state: "running",
        restarts: 0,
      },
      {
        name: "sb-down",
        repo: "acme/web",
        command: "npm start",
        enabled: false,
        state: "stopped",
        restarts: 0,
      },
    ];
    const { fixture, root } = await setup(api);

    // Non-destructive start executes directly with no confirmation dialog.
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-start-sb-down"]',
      )!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(
      api.calls.some(
        (c) =>
          c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
          (c.params as { name: string; action: string }).name === "sb-down" &&
          (c.params as { name: string; action: string }).action === "start",
      ),
    ).toBe(true);

    // stop, restart, rebuild each require confirmation; Escape/Cancel sends zero requests.
    for (const [action, expectedTitle] of [
      ["stop", "Stop persistent sandbox sb-live?"],
      ["restart", "Restart persistent sandbox sb-live?"],
      ["rebuild", "Rebuild persistent sandbox sb-live?"],
    ] as const) {
      const btn = root.querySelector<HTMLButtonElement>(
        `[data-testid="persistent-${action}-sb-live"]`,
      )!;
      btn.click();
      await settle(fixture);
      const dialog = root.querySelector('[data-testid="confirm-dialog"]')!;
      expect(dialog, `${action} dialog`).not.toBeNull();
      expect(dialog.closest("[inert]")).toBeNull();
      expect(dialog.textContent).toContain(expectedTitle);
      expect(root.querySelector("[inert]")).not.toBeNull();

      // Dismissing via Escape cancels without sending POST.
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await settle(fixture);
      expect(root.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
      expect(root.querySelector("[inert]")).toBeNull();
      expect(
        api.calls.some(
          (c) =>
            c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
            (c.params as { action: string }).action === action,
        ),
      ).toBe(false);

      // Re-open and accept.
      btn.click();
      await settle(fixture);
      root
        .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
        .click();
      await settle(fixture);
      expect(
        api.calls.some(
          (c) =>
            c.route === "POST /api/persistent-sandboxes/{name}/{action}" &&
            (c.params as { name: string; action: string }).name === "sb-live" &&
            (c.params as { name: string; action: string }).action === action,
        ),
      ).toBe(true);
    }

    // Mid-dialog permission revocation aborts persistent action on accept.
    const callsBeforeRevoke = api.calls.length;
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="persistent-stop-sb-live"]',
      )!
      .click();
    await settle(fixture);
    TestBed.inject(AccessService).setConfig({
      access: {
        role: "viewer",
        roles: ["viewer"],
        full: false,
        scopes: ["sandboxes:read"],
      },
    });
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls
        .slice(callsBeforeRevoke)
        .some(
          (c) => c.route === "POST /api/persistent-sandboxes/{name}/{action}",
        ),
    ).toBe(false);
  });

  it("confirms scheduled upgrade cancellation on pipeline resume and guards mid-dialog RBAC revocation", async () => {
    const api = new FakeFleetApi();
    api.pipelinePauseState = {
      paused: true,
      byKind: "automation",
      byId: "upgrade-schedule",
      reason: "waiting to upgrade to v3.6.0",
    };
    const { fixture, root } = await setup(api);

    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-controls"]')!
      .click();
    await settle(fixture);

    // Scheduled upgrade hold warns destructively; Cancel leaves paused.
    root
      .querySelector<HTMLButtonElement>('[data-testid="pipeline-resume-btn"]')!
      .click();
    await settle(fixture);
    const upgradeDialog = root.querySelector('[data-testid="confirm-dialog"]')!;
    expect(upgradeDialog).not.toBeNull();
    expect(upgradeDialog.closest("[inert]")).toBeNull();
    expect(upgradeDialog.textContent).toContain(
      "Cancel scheduled upgrade and resume pipeline?",
    );
    expect(upgradeDialog.textContent).toContain("waiting to upgrade to v3.6.0");
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
        .classList.contains("is-destructive"),
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "DELETE /api/pipeline-pause"),
    ).toBe(false);

    // Accepting sends DELETE /api/pipeline-pause.
    root
      .querySelector<HTMLButtonElement>('[data-testid="pipeline-resume-btn"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "DELETE /api/pipeline-pause"),
    ).toBe(true);

    // Mid-dialog revocation prevents pausePipeline, recreateTaskSandbox, rotateHostd, flush caches, and restartDaemon.
    const access = TestBed.inject(AccessService);

    root
      .querySelector<HTMLButtonElement>('[data-testid="pipeline-pause-btn"]')!
      .click();
    await settle(fixture);
    access.setConfig({
      access: {
        role: "reader",
        roles: ["reader"],
        full: false,
        scopes: [
          "deployment:read",
          "dispatch:read",
          "caches:read",
          "capabilities:read",
        ],
      },
    });
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(api.calls.some((c) => c.route === "POST /api/pipeline-pause")).toBe(
      false,
    );

    // Restore full operator access and verify mid-dialog revocation on recreateTaskSandbox and rotateHostd.
    access.setConfig(api.configBody);
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-sandboxes"]')!
      .click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>('[data-testid="sandbox-recreate-42"]')!
      .click();
    await settle(fixture);
    access.setConfig({
      access: {
        role: "reader",
        roles: ["reader"],
        full: false,
        scopes: ["deployment:read"],
      },
    });
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some(
        (c) => c.route === "POST /api/tasks/{id}/sandbox/recreate",
      ),
    ).toBe(false);

    access.setConfig(api.configBody);
    await settle(fixture);
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
    access.setConfig({
      access: {
        role: "reader",
        roles: ["reader"],
        full: false,
        scopes: ["capabilities:read"],
      },
    });
    root
      .querySelector<HTMLButtonElement>('[data-testid="confirm-accept"]')!
      .click();
    await settle(fixture);
    expect(
      api.calls.some((c) => c.route === "POST /api/hostds/{name}/rotate"),
    ).toBe(false);
  });

  it("toggles is-mobile across MediaQueryList and resize 600px boundaries for 390px mobile clearance and cleans up on destroy", async () => {
    const origWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const origMatchMedia = Object.getOwnPropertyDescriptor(
      window,
      "matchMedia",
    );
    const setWidth = (w: number) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: w,
      });
    };
    const listeners = new Set<(ev: MediaQueryListEvent) => void>();
    const removeSpy = vi.fn(
      (type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === "change" && typeof cb === "function") {
          listeners.delete(cb as (ev: MediaQueryListEvent) => void);
        }
      },
    );
    let mqlMatches = false;

    try {
      setWidth(1024);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (q: string) => ({
          matches: q === PHONE_QUERY ? mqlMatches : false,
          media: q,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: (
            type: string,
            cb: EventListenerOrEventListenerObject,
          ) => {
            if (type === "change" && typeof cb === "function") {
              listeners.add(cb as (ev: MediaQueryListEvent) => void);
            }
          },
          removeEventListener: removeSpy,
          dispatchEvent: () => false,
        }),
      });

      const { fixture, root } = await setup();
      const host = fixture.nativeElement as HTMLElement;
      const page = () =>
        root.querySelector<HTMLElement>('[data-testid="fleet-page"]')!;
      const scroll = () =>
        root.querySelector<HTMLElement>('[data-testid="fleet-scroll"]')!;

      expect(host.classList.contains("is-mobile")).toBe(false);
      expect(page().classList.contains("is-mobile")).toBe(false);
      expect(scroll().classList.contains("is-mobile")).toBe(false);

      // MediaQueryList change -> true applies is-mobile across host, section, and ops-scroll.
      mqlMatches = true;
      for (const cb of listeners) {
        cb({ matches: true, media: PHONE_QUERY } as MediaQueryListEvent);
      }
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(page().classList.contains("is-mobile")).toBe(true);
      expect(scroll().classList.contains("is-mobile")).toBe(true);

      // MediaQueryList change -> false clears is-mobile at desktop width.
      mqlMatches = false;
      for (const cb of listeners) {
        cb({ matches: false, media: PHONE_QUERY } as MediaQueryListEvent);
      }
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(false);
      expect(page().classList.contains("is-mobile")).toBe(false);
      expect(scroll().classList.contains("is-mobile")).toBe(false);

      // Window resize transitions across 600px boundary (599 -> 600 -> 390).
      setWidth(599);
      window.dispatchEvent(new Event("resize"));
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(page().classList.contains("is-mobile")).toBe(true);
      expect(scroll().classList.contains("is-mobile")).toBe(true);

      setWidth(600);
      window.dispatchEvent(new Event("resize"));
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(false);
      expect(page().classList.contains("is-mobile")).toBe(false);
      expect(scroll().classList.contains("is-mobile")).toBe(false);

      setWidth(390);
      window.dispatchEvent(new Event("resize"));
      fixture.detectChanges();
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(page().classList.contains("is-mobile")).toBe(true);
      expect(scroll().classList.contains("is-mobile")).toBe(true);

      // Switching tabs keeps is-mobile on the shared scroll container.
      root
        .querySelector<HTMLButtonElement>('[data-testid="fleet-tab-controls"]')!
        .click();
      await settle(fixture);
      expect(scroll().classList.contains("is-mobile")).toBe(true);

      fixture.destroy();
      expect(removeSpy).toHaveBeenCalledWith("change", expect.any(Function));
      expect(listeners.size).toBe(0);
    } finally {
      if (origWidth) {
        Object.defineProperty(window, "innerWidth", origWidth);
      } else {
        setWidth(1024);
      }
      if (origMatchMedia) {
        Object.defineProperty(window, "matchMedia", origMatchMedia);
      } else {
        delete (window as { matchMedia?: unknown }).matchMedia;
      }
    }
  });

  it("applies is-mobile on initial mount when viewport starts at 390px without matchMedia", async () => {
    const origWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const origMatchMedia = Object.getOwnPropertyDescriptor(
      window,
      "matchMedia",
    );
    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 390,
      });
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: undefined,
      });

      const { fixture, root } = await setup();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.classList.contains("is-mobile")).toBe(true);
      expect(
        root
          .querySelector<HTMLElement>('[data-testid="fleet-page"]')!
          .classList.contains("is-mobile"),
      ).toBe(true);
      expect(
        root
          .querySelector<HTMLElement>('[data-testid="fleet-scroll"]')!
          .classList.contains("is-mobile"),
      ).toBe(true);
    } finally {
      if (origWidth) {
        Object.defineProperty(window, "innerWidth", origWidth);
      }
      if (origMatchMedia) {
        Object.defineProperty(window, "matchMedia", origMatchMedia);
      } else {
        delete (window as { matchMedia?: unknown }).matchMedia;
      }
    }
  });
});
