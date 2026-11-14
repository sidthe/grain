import re

with open('scratch/head_telemetry.ts', 'r') as f:
    head = f.read()
with open('scratch/main_telemetry.ts', 'r') as f:
    main = f.read()

# 1. Chart 3 tel-swatch and fmtPct
head = re.sub(r'class="tel-legend-item tabular".*?\{\{ o\.count \}\}<\/strong>\n\s*<\/span>',
'''class="tel-swatch tabular"
                        [class.is-active]="outcomeHover() === o.key"
                        [class.is-dim]="outcomeHover() && outcomeHover() !== o.key"
                        style="cursor: pointer"
                        (mouseenter)="outcomeHover.set(o.key)"
                        (mouseleave)="outcomeHover.set(null)"
                        [style.background]="o.color"
                      ></span>
                      {{ o.key }}: <strong>{{ o.count }}</strong> ({{
                        fmtPct(o.share)
                      }})
                    </span>''', head, flags=re.DOTALL)

# 2. Template pagination
match_templates = re.search(r'(@if \(\(report\(\)\?\.agents\?\.templates\?\.length \?\? 0\) > 8\) \{.*?<\/div>\n\s*\})', main, re.DOTALL)
head = re.sub(r'(<\/tbody>\n\s*<\/table>\n\s*<\/div>)(?=\n\s*<\/article>)', r'\1\n                ' + match_templates.group(1), head)

# 3. Chart 4 Top Tools & CI Queue Wait Causes
match_tools = re.search(r'(<!-- Chart 4: Top Tools.*?<\/article>)', main, re.DOTALL)
head = re.sub(r'(<\/article>)(?=\n\s*<!-- Token Usage & Budget Caps)', r'\1\n\n            ' + match_tools.group(1), head)

# 4. Token usage Notices, pagination
match_usage = re.search(r'(@if \(usage\(\); as u\) \{.*?)(?=\n\s*<div>\n\s*<div class="tel-section-head">)', main, re.DOTALL)
head = re.sub(r'@if \(usage\(\); as u\) \{.*?(?=\n\s*<\/article>)', match_usage.group(1), head, flags=re.DOTALL)
head = head.replace('                }\n              </div>\n            }\n\n            @if (clusterStats(); as cs) {', '                }\n            }\n\n            @if (clusterStats(); as cs) {')

# 5. Add Contributors & Actors
match_actors = re.search(r'(<div>\n\s*<div class="tel-section-head">\n\s*<h3 class="section-title">\n\s*Contributors.*?<\/div>\n\s*<\/div>)', main, re.DOTALL)
head = re.sub(r'(?=\n\s*<\/article>\n\s*<\/div>\n\s*<\/div>\n\s*\} @else if \(tab\(\) === "quality"\))', '\n\n            ' + match_actors.group(1), head)

# 6. Add the SPECIFIC missing properties to the class safely!
# We need: showAllTemplates, showAllUsageNotices, showAllScopes, showAllDirections, showAllActors, actorsFilter,
# unfilteredActors, peopleActorCount, usageNotices, visibleTemplates, visibleScopes, visibleDirections, visibleActors

# Replace alphabeticalActors to use unfilteredActors!
new_alpha = '''  protected readonly unfilteredActors = computed(() =>
    buildAlphabeticalContributors(this.clusterStats(), this.feed.tasks()),
  );

  protected readonly peopleActorCount = computed(
    () =>
      this.unfilteredActors().filter(
        (a) => normalizeActorKind(a.kind, a.label) === "human",
      ).length,
  );

  protected readonly alphabeticalActors = computed(() => {
    const q = this.viewFilter.query().trim().toLowerCase();
    const onlyPeople = this.actorsFilter() === "people";
    const base = onlyPeople
      ? this.unfilteredActors().filter(
          (a) => normalizeActorKind(a.kind, a.label) === "human",
        )
      : this.unfilteredActors();
    if (!q) return base;
    return base.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.repos.some((r) => r.toLowerCase().includes(q)),
    );
  });'''
head = re.sub(r'  protected readonly alphabeticalActors = computed\(\(\) => \{.*?\n  \}\);', new_alpha, head, flags=re.DOTALL)

props = '''
  protected readonly showAllTemplates = signal(false);
  protected readonly showAllUsageNotices = signal(false);
  protected readonly showAllScopes = signal(false);
  protected readonly showAllDirections = signal(false);
  protected readonly showAllActors = signal(false);
  protected readonly actorsFilter = signal<"all" | "people">("all");

  protected readonly visibleActors = computed(() => {
    const list = this.alphabeticalActors();
    return this.showAllActors() ? list : list.slice(0, 12);
  });

  protected readonly visibleTemplates = computed(() => {
    const list = this.report()?.agents?.templates ?? [];
    return this.showAllTemplates() ? list : list.slice(0, 8);
  });

  protected readonly visibleScopes = computed(() => {
    const list = this.usage()?.scopes ?? [];
    return this.showAllScopes() ? list : list.slice(0, 8);
  });

  protected readonly visibleDirections = computed(() => {
    const list = this.clusterStats()?.directions ?? [];
    return this.showAllDirections() ? list : list.slice(0, 8);
  });

  protected readonly usageNotices = computed(() => {
    const u = this.usage();
    if (!u) return { total: 0, hasError: false, items: [] };
    const tz = effectiveDisplayTimeZone(this.access.rawConfig()?.timeZone);
    const nowMs = this.access.clockNow();
    const seen = new Set<string>();
    const items: { text: string; level: "error" | "warn" }[] = [];
    for (const raw of u.warnings ?? []) {
      const text = formatNoticeText(raw, nowMs, tz).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push({ text, level: "error" });
    }
    for (const raw of u.advisories ?? []) {
      const text = formatNoticeText(raw, nowMs, tz).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push({ text, level: "warn" });
    }
    const hasError = items.some((i) => i.level === "error");
    return { total: items.length, hasError, items };
  });
'''
head = head.replace('protected readonly qaDigest = computed(() => {', props + '\n  protected readonly qaDigest = computed(() => {')

# Add imports
head = head.replace('} from "../shared/dispatch-status";', '  effectiveDisplayTimeZone,\n  formatNoticeText,\n} from "../shared/dispatch-status";')

# Remove TABS definition and usage
head = re.sub(r'const TABS: readonly \{ id: TelemetryTab; label: string \}.*?\];\n\n', '', head, flags=re.DOTALL)
head = head.replace('protected readonly tabs = TABS;', 'protected readonly tabs: readonly { id: TelemetryTab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "quality", label: "Quality checks" }];')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(head)
