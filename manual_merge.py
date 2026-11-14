import re

with open('scratch/head_telemetry.ts', 'r') as f:
    head = f.read()

with open('scratch/main_telemetry.ts', 'r') as f:
    main = f.read()

# I will modify head by applying the specific changes from main.

# 1. Chart 3 tel-swatch and fmtPct
# main has:
# class="tel-swatch"
# [style.background]="o.color"
# ></span>
# {{ o.key }}: <strong>{{ o.count }}</strong> ({{ fmtPct(o.share) }})
#
# head has:
# class="tel-legend-item tabular"
# [class.is-active]="outcomeHover() === o.key"
# [class.is-dim]="outcomeHover() && outcomeHover() !== o.key"
# style="cursor: pointer"
# (mouseenter)="outcomeHover.set(o.key)"
# (mouseleave)="outcomeHover.set(null)"
# >
# <span class="swatch" [style.background]="o.color"></span>
# {{ o.key }}: <strong>{{ o.count }}</strong>
# </span>

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
# main has: @if ((report()?.agents?.templates?.length ?? 0) > 8) { <div class="tel-more-row"> <button ... (click)="showAllTemplates.set(!showAllTemplates())" ...
# Let's extract from main:
match_templates = re.search(r'(@if \(\(report\(\)\?\.agents\?\.templates\?\.length \?\? 0\) > 8\) \{.*?<\/div>\n\s*\})', main, re.DOTALL)
if match_templates:
    # insert after </tbody></table></div> in the templates table
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
    # Insert it right before the closing </article> of telemetry-usage
    head = re.sub(r'(?=\n\s*<\/article>\n\s*<\/div>\n\s*\} @else if \(tab\(\) === "quality"\))', '\n\n            ' + match_actors.group(1), head)


# Also add `showAllTemplates`, `showAllUsageNotices`, `showAllScopes`, `showAllDirections`, `showAllActors`, `actorsFilter` to the component class!
# Let's extract properties from main class
match_props = re.search(r'(protected readonly showAllTemplates = signal\(false\);.*?protected readonly peopleActorCount = computed\(\(\) =>.*?\}\);)', main, re.DOTALL)
if match_props:
    # insert into HEAD class
    head = re.sub(r'(protected readonly qaDigest = computed\(\(\) => \{.*?\n  \}\);)', r'\1\n\n' + match_props.group(1), head, flags=re.DOTALL)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(head)

