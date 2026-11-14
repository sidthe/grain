with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

# Replace any occurrence of GET /api/release-notes with GET /api/release-notes/stats
# Wait, main's test expects redundant GET /api/release-notes to NEVER be called.
# And main changed it to /api/release-notes/stats in load(), but removed it in loadMetrics().
text = text.replace('"GET /api/release-notes"', '"GET /api/release-notes/stats"')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
