import re

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

# I will replace each conflict block using re.sub with a function
def replacer(match):
    h = match.group(1)
    m = match.group(2)
    
    if 'class="tel-legend-item tabular"' in h:
        # Conflict 0 (Chart 3 legend & Chart 4 Tools)
        # Keep origin/main's chart 4 and template paginations.
        # But merge the tel-legend-item hover state into tel-swatch.
        # Let's just do a manual merge:
        merged = m.replace('class="tel-swatch"', 
                           'class="tel-swatch tabular"\n                        [class.is-active]="outcomeHover() === o.key"\n                        [class.is-dim]="outcomeHover() && outcomeHover() !== o.key"\n                        style="cursor: pointer"\n                        (mouseenter)="outcomeHover.set(o.key)"\n                        (mouseleave)="outcomeHover.set(null)"')
        return merged

    elif 'data-testid="telemetry-usage"' in h:
        # Conflict 1 (Token Usage section start)
        # origin/main adds UsageNotices banner, then Token usage.
        # HEAD just has Token Usage.
        # Let's keep origin/main entirely, but ensure HEAD's WAI-ARIA tablist? 
        # Wait, the WAI-ARIA tablist is NOT in this block.
        # Let's just return main.
        return m
        
    elif 'class="ops-table-wrap"' in h:
        # Conflict 2 (Token Usage pagination/caps)
        # MAIN added pagination to usage.
        # Let's keep MAIN.
        return m

    elif '</ul>' in h and '</tbody>' in m:
        # Conflict 3 (Usage table end)
        # Keep MAIN.
        return m

    elif '</article>' in h and 'clusterStats' in m:
        # Conflict 4 (End of article)
        # origin/main added Chart 4 tools? No, origin/main added Contributors (actors) pagination and workstreams.
        # And HEAD added `<g-telemetry-quality-panel>` on the `Quality checks` tab.
        # Wait, let's look at HEAD.
        if 'quality-panel' in h:
            pass # We need to inject HEAD's quality panel into MAIN.
        # Let's just return the combined text for now and we'll refine.
        return '<<<<<<< HEAD\n' + h + '\n=======\n' + m + '\n>>>>>>> origin/main\n'
    else:
        return '<<<<<<< HEAD\n' + h + '\n=======\n' + m + '\n>>>>>>> origin/main\n'

new_text = re.sub(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n', replacer, text, flags=re.DOTALL)
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(new_text)

