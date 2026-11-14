with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    main = f.read()

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

# insert after selectedRepo
main = main.replace('protected readonly selectedRepo = signal<string>("");', 'protected readonly selectedRepo = signal<string>("");\n' + class_props_2)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(main)
