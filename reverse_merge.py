import re
with open('scratch/main_telemetry.ts', 'r') as f:
    main = f.read()

# 1. Imports
main = main.replace('type MetricsWindow,\n', 'type MetricsWindow,\n  type QASummary,\n  type ReleaseNote,\n')
main = main.replace('} from "../shared/dispatch-status";', '} from "../shared/dispatch-status";\nimport { TelemetryQualityComponent } from "./quality-checks.component";\nimport {\n  armVerdict,\n  experimentPeriodLabel,\n  experimentScope,\n} from "./quality-verdict";')
main = main.replace('const BUDGET_WINDOWS', 'export type TelemetryTab = "overview" | "quality";\n\nconst TABS: readonly { id: TelemetryTab; label: string }[] = [\n  { id: "overview", label: "Overview" },\n  { id: "quality", label: "Quality checks" },\n];\n\nconst BUDGET_WINDOWS')
main = main.replace('imports: [\n    RouterLink,\n    TipDirective,\n    StatusIconComponent,\n    ActorChipComponent,\n  ],', 'imports: [\n    RouterLink,\n    TipDirective,\n    StatusIconComponent,\n    ActorChipComponent,\n    TelemetryQualityComponent,\n  ],')

# 2. Template tabs
tab_html = '''        <div
          class="tab-strip"
          role="tablist"
          aria-label="Telemetry views"
          data-testid="telemetry-tabs"
        >
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              class="tab-link tel-tab-btn"
              [id]="'telemetry-tab-' + t.id"
              [attr.aria-selected]="tab() === t.id"
              [attr.aria-controls]="
                tab() === t.id ? 'telemetry-panel-' + t.id : null
              "
              [attr.tabindex]="tab() === t.id ? 0 : -1"
              [attr.data-testid]="'telemetry-tab-' + t.id"
              (click)="pickTab(t.id)"
              (keydown)="onTabKeydown($event, t.id)"
            >
              @if (t.id === "quality" && qaDigest()?.state === "halted") {
                <g-status-icon tone="error" kind="error" />
              }
              {{ t.label }}
            </button>
          }
        </div>

        <div class="tab-panels">
          @if (tab() === "overview") {
'''
main = main.replace('      <div class="ops-scroll" data-testid="telemetry-scroll">\n', '      <div class="ops-scroll" data-testid="telemetry-scroll">\n' + tab_html)

# End of overview tab, add quality tab
quality_html = '''          } @else if (tab() === "quality") {
            <div
              id="telemetry-panel-quality"
              role="tabpanel"
              aria-labelledby="telemetry-tab-quality"
              tabindex="0"
            >
              <g-telemetry-quality
                [summary]="qaSummary()"
                [error]="qaError()"
                [deniedReason]="qaDeniedReason()"
                [windowId]="window()"
                [repo]="selectedRepo()"
                (retry)="loadQaSummary()"
              />
            </div>
          }
        </div>
'''
main = main.replace('        </div>\n      }\n    </section>', '        </div>\n' + quality_html + '      }\n    </section>')

# 3. Class properties
class_props = '''
  protected readonly tabs = TABS;

  private readonly repoTrigger =
    viewChild<ElementRef<HTMLButtonElement>>("repoTrigger");
  private readonly authorTrigger =
    viewChild<ElementRef<HTMLButtonElement>>("authorTrigger");
  private readonly repoListbox =
    viewChild<ElementRef<HTMLElement>>("repoListbox");
  private readonly authorListbox =
    viewChild<ElementRef<HTMLElement>>("authorListbox");

  protected readonly tab = signal<TelemetryTab>("overview");
'''
main = main.replace('  private readonly destroyRef = inject(DestroyRef);\n', '  private readonly destroyRef = inject(DestroyRef);\n' + class_props)

class_props_2 = '''
  protected readonly qaSummary = signal<QASummary | null>(null);
  protected readonly qaError = signal<string | null>(null);
  protected readonly qaDeniedReason = signal<string | null>(null);

  protected readonly qaPeriodLabel = computed(() => {
    if (this.tab() !== "quality") return null;
    const e = experimentScope(this.qaSummary());
    return e ? experimentPeriodLabel(e) : "Enrollment-scoped (unwindowed)";
  });

  /** One-line Overview digest; reuses the Quality tab's verdict wording. */
  protected readonly qaDigest = computed(() => {
    const qa = this.qaSummary();
    if (!qa) return null;
    const assigned =
      (qa.treatment?.assignedOrigins ?? 0) + (qa.control?.assignedOrigins ?? 0);
    if (assigned === 0) return { state: "idle" as const, verdict: "No data" };
    return armVerdict(qa.treatment, qa.control, true);
  });
'''
main = main.replace('  protected readonly selectedRepo = signal<string | null>(null);\n', '  protected readonly selectedRepo = signal<string | null>(null);\n' + class_props_2)

# Methods
methods = '''
  ngOnInit(): void {
    const initialTab = parseTab(this.route.snapshot.queryParamMap.get("tab"));
    this.tab.set(initialTab);
    const exp = this.route.snapshot.queryParamMap.get("exp");

    if (initialTab === "quality" || exp) {
      this.loadQaSummary(exp || undefined);
    }
'''
main = main.replace('  ngOnInit(): void {\n', methods)

# pickTab, onTabKeydown, loadQaSummary
methods_2 = '''
  protected pickTab(id: TelemetryTab): void {
    if (this.tab() === id) return;
    this.tab.set(id);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: id },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
    if (id === "quality" && !this.qaSummary()) {
      this.loadQaSummary();
    }
  }

  protected onTabKeydown(ev: KeyboardEvent, currentId: TelemetryTab): void {
    const currentIndex = this.tabs.findIndex((t) => t.id === currentId);
    let nextIndex = currentIndex;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % this.tabs.length;
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + this.tabs.length) % this.tabs.length;
    } else if (ev.key === "Home") {
      nextIndex = 0;
    } else if (ev.key === "End") {
      nextIndex = this.tabs.length - 1;
    }
    if (nextIndex !== currentIndex) {
      ev.preventDefault();
      this.pickTab(this.tabs[nextIndex].id);
      const nextId = this.tabs[nextIndex].id;
      setTimeout(() => {
        document.getElementById(`telemetry-tab-${nextId}`)?.focus();
      }, 0);
    }
  }

  protected async loadQaSummary(forceExpId?: string): Promise<void> {
    this.qaError.set(null);
    this.qaDeniedReason.set(null);
    try {
      const q = forceExpId
        ? `exp=${encodeURIComponent(forceExpId)}`
        : `window=${encodeURIComponent(this.window())}${this.selectedRepo() ? `&repo=${encodeURIComponent(this.selectedRepo()!)}` : ""}`;
      const sum = await this.api.get<QASummary>(`/api/qa/summary?${q}`);
      this.qaSummary.set(sum);
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 403) {
        this.qaDeniedReason.set(
          (err as { message?: string }).message || "Access denied.",
        );
      } else {
        this.qaError.set(
          (err as { message?: string }).message || "Failed to load summary.",
        );
      }
    }
  }
'''
main = main.replace('  protected async load(): Promise<void> {\n', methods_2 + '\n  protected async load(): Promise<void> {\n')

main += '\nfunction parseTab(v: string | null): TelemetryTab {\n  return v === "quality" ? "quality" : "overview";\n}\n'

# Oh wait, `origin/main` had `parseTab`? No, `HEAD` added `parseTab`. So it's already there if I appended it, but let's make sure I don't append it twice!
main = main.replace('\nfunction parseTab(v: string | null): TelemetryTab {\n  return v === "quality" ? "quality" : "overview";\n}\n\nfunction parseTab(v: string | null): TelemetryTab {\n  return v === "quality" ? "quality" : "overview";\n}\n', '\nfunction parseTab(v: string | null): TelemetryTab {\n  return v === "quality" ? "quality" : "overview";\n}\n')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(main)

