import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

def replacer(match):
    h = match.group(1)
    m = match.group(2)
    
    if 'class="tel-legend-item tabular"' in h:
        # Conflict 1
        return m.replace('class="tel-swatch"', 'class="tel-swatch tabular"\n                        [class.is-active]="outcomeHover() === o.key"\n                        [class.is-dim]="outcomeHover() && outcomeHover() !== o.key"\n                        style="cursor: pointer"\n                        (mouseenter)="outcomeHover.set(o.key)"\n                        (mouseleave)="outcomeHover.set(null)"')
        
    elif 'data-testid="telemetry-usage"' in h:
        # Conflict 2
        # h has WAI-ARIA tablist? No, the tablist must be elsewhere. 
        # Wait, if h has something else, let's see. I'll just print if there's any 'g-telemetry' in h.
        return m
        
    elif 'class="ops-table-wrap"' in h:
        # Conflict 3
        return m
        
    elif '</ul>' in h and '</tbody>' in m:
        # Conflict 4
        return m
        
    elif '</article>' in h and 'clusterStats' in m:
        # Conflict 5
        # h closes the article and the container.
        # But wait, HEAD has quality panel! Where is it?
        pass

print("Looking for quality panel...")
print(text.find('g-telemetry-quality-panel'))
print(text.find('?tab=overview|quality&exp='))
