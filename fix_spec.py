import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.spec.ts', 'r') as f:
    text = f.read()
new_text = re.sub(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n', r'\1\n\2\n', text, flags=re.DOTALL)
with open('ui-ng/src/app/telemetry/telemetry-page.component.spec.ts', 'w') as f:
    f.write(new_text)
