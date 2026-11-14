import re

with open('scratch/main_telemetry.ts', 'r') as f:
    main = f.read()

# Extract loadMetrics from main
match = re.search(r'(async loadMetrics\(\): Promise<void> \{.*?\n  \})', main, re.DOTALL)
if match:
    load_metrics_main = match.group(1)
else:
    print("loadMetrics not found in main")
    exit(1)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    ts = f.read()

# Replace loadMetrics in ts
ts = re.sub(r'async loadMetrics\(\): Promise<void> \{.*?\n  \}', load_metrics_main, ts, flags=re.DOTALL)

# But wait, did origin/main change anything else in methods?
# Like `ngOnInit`, `load` etc?
# Let's extract `load()` as well just in case.
match_load = re.search(r'(protected async load\(\): Promise<void> \{.*?\n  \})', main, re.DOTALL)
if match_load:
    ts = re.sub(r'protected async load\(\): Promise<void> \{.*?\n  \}', match_load.group(1), ts, flags=re.DOTALL)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(ts)
