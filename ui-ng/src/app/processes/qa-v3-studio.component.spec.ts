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

import { ComponentFixture, TestBed } from "@angular/core/testing";
import { vi } from "vitest";
import { GrainApi } from "../api/grain-api.service";
import { SnackbarService } from "../services/snackbar.service";
import type { FlowDeclarationV3 } from "./qa-flows.models";
import { QaV3StudioComponent } from "./qa-v3-studio.component";

const ROUTE_RESPONSES: Readonly<Record<string, unknown>> = {
  "POST /api/qa/flow-versions": {
    dryRun: true,
    valid: true,
    hash: "sha256:v3preview",
    sampledPRs: 12,
    wouldBlockPRs: 2,
    byCheck: [],
  },
  "POST /api/qa/flow-versions/adopt": {
    hash: "sha256:adopted123",
  },
  "POST /api/qa/probe": {
    complexity: {
      tier: "high",
      score: 80,
      signals: ["cross-subsystem"],
      hasDesignItem: false,
    },
    risk: {
      tier: "T3",
      score: 85,
      signals: ["schema-migration"],
      testTampered: false,
      trustBoundary: true,
    },
    stagesFired: ["s0-intent", "s1-risk", "s2-plan-critic", "s3", "s4"],
    triage: {
      decision: "require_human",
      enforced: true,
      mode: "enforced",
      tier: "T3",
      blastScore: 85,
      reasons: ["trust-boundary"],
      blockedByFloor: true,
    },
  },
};

describe("QaV3StudioComponent", () => {
  let fixture: ComponentFixture<QaV3StudioComponent>;
  let postSpy: ReturnType<
    typeof vi.fn<
      (
        route: string,
        params?: unknown,
        body?: unknown,
        query?: string,
      ) => Promise<unknown>
    >
  >;
  let showSpy: ReturnType<typeof vi.fn<(msg: string) => void>>;

  beforeEach(async () => {
    postSpy = vi.fn(async (route: string) => ROUTE_RESPONSES[route] ?? {});
    showSpy = vi.fn();

    await TestBed.configureTestingModule({
      imports: [QaV3StudioComponent],
      providers: [
        { provide: GrainApi, useValue: { post: postSpy } },
        { provide: SnackbarService, useValue: { show: showSpy } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QaV3StudioComponent);
    fixture.detectChanges();
  });

  it("hydrates stages and custom checks from a V3 flow declaration", () => {
    const decl: FlowDeclarationV3 = {
      schema: "grain.dev/qa-flow/v3",
      stages: {
        "s0-intent": { enabled: true },
        "s2-plan-critic": { enabled: true },
        "s5-merge-triage": { mode: "enforced" },
        custom: [
          {
            id: "custom:s3b",
            label: "Companion gate",
            "insert-after": "s3",
            "timeout-seconds": 30,
          },
        ],
      },
      "custom-checks": [
        {
          id: "custom:schema-migration",
          kind: "companion",
          fixtures: {
            fail: [{ name: "missing migration" }],
            pass: [{ name: "with migration" }],
          },
        },
      ],
    };

    fixture.componentRef.setInput("decl", decl);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector<HTMLInputElement>("#s0Intent")!.checked).toBe(
      true,
    );
    expect(root.querySelector<HTMLInputElement>("#s2PlanCritic")!.checked).toBe(
      true,
    );
    expect(
      root.querySelectorAll('[data-testid="qa-v3-custom-stage-row"]').length,
    ).toBe(1);
    expect(
      root.querySelectorAll('[data-testid="qa-v3-custom-check-row"]').length,
    ).toBe(1);
    expect(root.textContent).toContain("companion");
  });

  it("verifies inline fixtures via dryRun=1 with strict kebab-case YAML keys", async () => {
    const root = fixture.nativeElement as HTMLElement;

    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-add-stage"]')!
      .click();
    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-add-pattern"]')!
      .click();
    fixture.detectChanges();

    expect(
      root.querySelectorAll('[data-testid="qa-v3-custom-stage-row"]').length,
    ).toBe(1);
    expect(
      root.querySelectorAll('[data-testid="qa-v3-custom-check-row"]').length,
    ).toBe(1);

    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-verify-dry-run"]')!
      .click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0]).toBe("POST /api/qa/flow-versions");
    expect(postSpy.mock.calls[0][3]).toBe("dryRun=1");
    const yamlBody = (postSpy.mock.calls[0][2] as { yaml: string }).yaml;
    expect(yamlBody).toContain("insert-after: s3");
    expect(yamlBody).toContain("timeout-seconds: 30");
    expect(root.textContent).toContain("sha256:v3preview");
  });

  it("runs what-if probe and adopts repo-committed flow declarations", async () => {
    const root = fixture.nativeElement as HTMLElement;

    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-open-probe"]')!
      .click();
    fixture.detectChanges();

    expect(
      root.querySelector('[data-testid="qa-v3-probe-dialog"]'),
    ).toBeTruthy();

    const probeTitleInput =
      root.querySelector<HTMLInputElement>("#probeTitle")!;
    probeTitleInput.value = "Migrate schema 149";
    probeTitleInput.dispatchEvent(new Event("input"));
    const probeFilesInput =
      root.querySelector<HTMLTextAreaElement>("#probeFiles")!;
    probeFilesInput.value = "pkg/model/schema.go, pkg/model/migrations.go";
    probeFilesInput.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-submit-probe"]')!
      .click();
    await fixture.whenStable();
    fixture.detectChanges();

    const probeResultEl = root.querySelector(
      '[data-testid="qa-v3-probe-result"]',
    );
    expect(probeResultEl?.textContent).toContain("Score: 85/100");
    expect(probeResultEl?.textContent).toContain("require_human (enforced)");

    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-open-adopt"]')!
      .click();
    fixture.detectChanges();

    expect(
      root.querySelector('[data-testid="qa-v3-adopt-dialog"]'),
    ).toBeTruthy();

    const repoInput = root.querySelector<HTMLInputElement>("#adoptRepo")!;
    repoInput.value = "sidthe/grain";
    repoInput.dispatchEvent(new Event("input"));
    const commitInput = root.querySelector<HTMLInputElement>("#adoptCommit")!;
    commitInput.value = "0123456789abcdef0123456789abcdef01234567";
    commitInput.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-submit-adopt"]')!
      .click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(showSpy).toHaveBeenCalledWith("Adopted flow sha256:adopted123");
    expect(root.querySelector('[data-testid="qa-v3-adopt-dialog"]')).toBeNull();
  });
});
