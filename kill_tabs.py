import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

# Replace tabs = TABS;
text = text.replace('protected readonly tabs = TABS;', 'protected readonly tabs: readonly { id: TelemetryTab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "quality", label: "Quality checks" }];')

# Delete const TABS
text = re.sub(r'const TABS: readonly \{ id: TelemetryTab; label: string \}.*?\];\n\n', '', text, flags=re.DOTALL)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
