import re

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
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
if match_templates:
    head = re.sub(r'(<\/tbody>\n\s*<\/table>\n\s*<\/div>)(?=\n\s*<\/article>)', r'\1\n                ' + match_templates.group(1), head)

# 3. Chart 4 Top Tools & CI Queue Wait Causes
match_tools = re.search(r'(<!-- Chart 4: Top Tools.*?<\/article>)', main, re.DOTALL)
if match_tools:
    head = re.sub(r'(<\/article>)(?=\n\s*<!-- Token Usage & Budget Caps)', r'\1\n\n            ' + match_tools.group(1), head)

# 4. Token usage Notices, pagination
match_usage = re.search(r'(@if \(usage\(\); as u\) \{.*?)(?=\n\s*<div>\n\s*<div class="tel-section-head">)', main, re.DOTALL)
if match_usage:
    head = re.sub(r'@if \(usage\(\); as u\) \{.*?(?=\n\s*<\/article>)', match_usage.group(1), head, flags=re.DOTALL)

# Remove extra </div> that main introduced!
head = head.replace('                }\n              </div>\n            }\n\n            @if (clusterStats(); as cs) {', '                }\n            }\n\n            @if (clusterStats(); as cs) {')


# 5. Add Contributors & Actors
match_actors = re.search(r'(<div>\n\s*<div class="tel-section-head">\n\s*<h3 class="section-title">\n\s*Contributors.*?<\/div>\n\s*<\/div>)', main, re.DOTALL)
if match_actors:
    head = re.sub(r'(?=\n\s*<\/article>\n\s*<\/div>\n\s*<\/div>\n\s*\} @else if \(tab\(\) === "quality"\))', '\n\n            ' + match_actors.group(1), head)

# 6. Add properties to class
# We extract ALL new properties and append them exactly at the end of the class.
props_to_extract = [
    r'protected readonly showAllTemplates = signal\(false\);',
    r'protected readonly showAllUsageNotices = signal\(false\);',
    r'protected readonly showAllScopes = signal\(false\);',
    r'protected readonly showAllDirections = signal\(false\);',
    r'protected readonly showAllActors = signal\(false\);',
    r'protected readonly actorsFilter = signal<"all" \| "people">\("all"\);',
    r'protected readonly unfilteredActors = computed\(\(\) =>.*?this\.feed\.tasks\(\)\),\n  \);',
    r'protected readonly peopleActorCount = computed\(\n    \(\) =>\n.*?\}\);', # Wait, regex might be tricky
]

# Since properties are just sequential in main, let's just grab the whole block!
match_all_props = re.search(r'(protected readonly showAllTemplates = signal\(false\);.*?protected readonly usageNotices = computed\(\(\) => \{.*?\n  \}\);)', main, re.DOTALL)

if match_all_props:
    # insert before the final `}`
    head = head.replace('\n}\n\nfunction parseTab', '\n\n  ' + match_all_props.group(1) + '\n}\n\nfunction parseTab')

# Also need formatNoticeText and effectiveDisplayTimeZone imports
head = head.replace('} from "../shared/dispatch-status";', '  effectiveDisplayTimeZone,\n  formatNoticeText,\n} from "../shared/dispatch-status";')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(head)

