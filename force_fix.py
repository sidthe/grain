import re
with open('ui-ng/src/app/task/task-page.component.spec.ts', 'r') as f:
    text = f.read()

# remove the conflict markers
text = text.replace('<<<<<<< HEAD\n', '')
text = text.replace('=======\n', '')
text = text.replace('>>>>>>> origin/main\n', '')

# For telemetry-page.component.spec.ts, it was missing `});` at the end
with open('ui-ng/src/app/telemetry/telemetry-page.component.spec.ts', 'r') as f:
    tel_text = f.read()
if tel_text.strip().endswith('}'):
    tel_text = tel_text.strip()[:-1] # remove the extra } I added
    if not tel_text.strip().endswith('});'):
        tel_text += '\n});\n'

with open('ui-ng/src/app/task/task-page.component.spec.ts', 'w') as f:
    f.write(text)

with open('ui-ng/src/app/telemetry/telemetry-page.component.spec.ts', 'w') as f:
    f.write(tel_text)
