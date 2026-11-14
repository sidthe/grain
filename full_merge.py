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
if match_templates:
    head = re.sub(r'(<\/tbody>\n\s*<\/table>\n\s*<\/div>)(?=\n\s*<\/article>)', r'\1\n                ' + match_templates.group(1), head)

# 3. Chart 4 Top Tools & CI Queue Wait Causes
match_tools = re.search(r'(<!-- Chart 4: Top Tools.*?<\/article>)', main, re.DOTALL)
if match_tools:
    head = re.sub(r'(<\/article>)(?=\n\s*<!-- Token Usage & Budget Caps)', r'\1\n\n            ' + match_tools.group(1), head)

# 4. Token usage Notices, pagination
match_usage = re.search(r'(@if \(usage\(\); as u\) \{.*?)(?=\n\s*<div>\n\s*<div class="tel-section-head">)', main, re.DOTALL)
if match_usage:
    # replace everything from @if (usage(); as u) { to the end of the article in HEAD
    head = re.sub(r'@if \(usage\(\); as u\) \{.*?(?=\n\s*<\/article>)', match_usage.group(1), head, flags=re.DOTALL)

# 5. Add Contributors & Actors
match_actors = re.search(r'(<div>\n\s*<div class="tel-section-head">\n\s*<h3 class="section-title">\n\s*Contributors.*?<\/div>\n\s*<\/div>)', main, re.DOTALL)
if match_actors:
    # Insert it right before the closing </article> of telemetry-usage, which is followed by </div> </div> } @else if (tab() === "quality") {
    # Actually, in HEAD, telemetry-usage was closed by </article>, then we had </div> (ops-grid) </div> (ops-scroll) } (tab)
    # Wait, HEAD has:
    # </article>
    # </div>
    # </div>
    # } @else if (tab() === "quality") {
    # So we insert before </article>
    # Wait! match_usage insertion removed </article> ?
    # In step 4: re.sub(r'...(?=\n\s*<\/article>)', match_usage.group(1), head)
    # So </article> IS STILL THERE.
    head = re.sub(r'(?=\n\s*<\/article>\n\s*<\/div>\n\s*<\/div>\n\s*\} @else if \(tab\(\) === "quality"\))', '\n\n            ' + match_actors.group(1), head)

# 6. Add properties to class
match_props = re.search(r'(protected readonly showAllTemplates = signal\(false\);.*?protected readonly peopleActorCount = computed\(\(\) =>.*?\}\);)', main, re.DOTALL)
if match_props:
    # insert into HEAD class AFTER qaDigest (which is in HEAD!)
    head = re.sub(r'(protected readonly qaDigest = computed\(\(\) => \{.*?\n  \}\);)', r'\1\n\n' + match_props.group(1), head, flags=re.DOTALL)

# 7. usageNotices is missing from match_props because it is further down in MAIN
match_usageNotices = re.search(r'(protected readonly usageNotices = computed\(\(\) => \{.*?\n  \}\);)', main, re.DOTALL)
if match_usageNotices:
    head = re.sub(r'(protected readonly peopleActorCount = computed\(\(\) =>.*?\}\);)', r'\1\n\n  ' + match_usageNotices.group(1), head, flags=re.DOTALL)

# Also need formatNoticeText and effectiveDisplayTimeZone imports
head = head.replace('} from "../shared/dispatch-status";', '  effectiveDisplayTimeZone,\n  formatNoticeText,\n} from "../shared/dispatch-status";')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(head)
