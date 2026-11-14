import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

match = re.search(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n', text, re.DOTALL)
if match:
    h = match.group(1)
    m = match.group(2)
    # the conflict is exactly what we need to merge:
    # m contains the clusterStats and Actors logic, closing the telemetry-usage article and ops-grid
    # h has just the closing of the telemetry-usage article and ops-grid.
    # We should just keep `m`, but wait... where is `} @else if (tab() === "quality") {`?
    # It must be AFTER `>>>>>>> origin/main` !
    # Let's check:
    print(text[match.end():match.end()+200])

    # We will replace the conflict with `m`.
    new_text = text[:match.start()] + m + text[match.end():]
    with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
        f.write(new_text)
    print("Replaced!")
else:
    print("No conflict found!")
