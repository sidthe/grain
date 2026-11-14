import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

# Remove TABS definition
text = re.sub(r'const TABS: readonly \{ id: TelemetryTab; label: string \}.*?\];\n\n', '', text, flags=re.DOTALL)

# Replace tabs = TABS; with the actual array
text = text.replace('protected readonly tabs = TABS;', 'protected readonly tabs: readonly { id: TelemetryTab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "quality", label: "Quality checks" }];')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
