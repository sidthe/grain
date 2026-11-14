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
import { GrainApi } from "../api/grain-api.service";
import { SnackbarService } from "../services/snackbar.service";
import type { FlowDeclarationV3 } from "./qa-flows.models";
import { QaV3StudioComponent } from "./qa-v3-studio.component";

class FakeV3StudioApi {
  readonly calls: Array<{
    route: string;
    body: unknown;
    query?: string;
  }> = [];

  async post(
    route: string,
    _params?: unknown,
    body?: unknown,
    query?: string,
  ): Promise<unknown> {
    this.calls.push({ route, body, query });
    if (route === "POST /api/qa/flow-versions") {
      return {
        dryRun: true,
        valid: true,
        hash: "sha256:v3preview",
        sampledPRs: 12,
        wouldBlockPRs: 2,
        byCheck: [],
      };
    }
    if (route === "POST /api/qa/flow-versions/adopt") {
      return { hash: "sha256:adopted123" };
    }
    if (route === "POST /api/qa/probe") {
      return {
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
      };
    }
    return {};
  }
}

describe("QaV3StudioComponent", () => {
  let fixture: ComponentFixture<QaV3StudioComponent>;
  let component: QaV3StudioComponent;
  let api: FakeV3StudioApi;
  let messages: string[];

  beforeEach(async () => {
    api = new FakeV3StudioApi();
    messages = [];
    await TestBed.configureTestingModule({
      imports: [QaV3StudioComponent],
      providers: [
        { provide: GrainApi, useValue: api },
        {
          provide: SnackbarService,
          useValue: { show: (msg: string) => messages.push(msg) },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QaV3StudioComponent);
    component = fixture.componentInstance;
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

    expect(component.s0Intent()).toBe(true);
    expect(component.s2PlanCritic()).toBe(true);
    expect(component.s5Triage()).toBe("enforced");
    expect(component.customStages().length).toBe(1);
    expect(component.customChecks().length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain("companion");
  });

  it("verifies inline fixtures via dryRun=1 with strict kebab-case YAML keys", async () => {
    component.addCustomStage();
    component.addCheck("pattern");
    fixture.detectChanges();

    await component.verifyDryRun();
    fixture.detectChanges();

    expect(api.calls.length).toBe(1);
    expect(api.calls[0].route).toBe("POST /api/qa/flow-versions");
    expect(api.calls[0].query).toBe("dryRun=1");
    const yamlBody = (api.calls[0].body as { yaml: string }).yaml;
    expect(yamlBody).toContain("insert-after: s3");
    expect(yamlBody).toContain("timeout-seconds: 30");
    expect(fixture.nativeElement.textContent).toContain("sha256:v3preview");
  });

  it("runs what-if probe and adopts repo-committed flow declarations", async () => {
    const root = fixture.nativeElement as HTMLElement;
    root
      .querySelector<HTMLButtonElement>('[data-testid="qa-v3-open-probe"]')!
      .click();
    fixture.detectChanges();

    component.probeTitle.set("Migrate schema 149");
    component.probeFiles.set("pkg/model/schema.go, pkg/model/migrations.go");
    await component.doProbe();
    fixture.detectChanges();

    expect(
      root.querySelector('[data-testid="qa-v3-probe-result"]')?.textContent,
    ).toContain("Score: 85/100");
    expect(
      root.querySelector('[data-testid="qa-v3-probe-result"]')?.textContent,
    ).toContain("require_human (enforced)");

    component.showProbe.set(false);
    component.showAdopt.set(true);
    component.adoptRepo.set("sidthe/grain");
    component.adoptCommit.set("0123456789abcdef0123456789abcdef01234567");
    await component.doAdopt();
    fixture.detectChanges();

    expect(messages).toContain("Adopted flow sha256:adopted123");
    expect(component.showAdopt()).toBe(false);
  });
});
