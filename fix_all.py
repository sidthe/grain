import re
import os

# 1. next-up.component.ts
file_next_up = 'ui-ng/src/app/shell/next-up.component.ts'
with open(file_next_up, 'r') as f: text = f.read()
text = text.replace('import type { Task } from "../api/models";\n', '')
with open(file_next_up, 'w') as f: f.write(text)

# 2. task-page.component.spec.ts
file_task = 'ui-ng/src/app/task/task-page.component.spec.ts'
with open(file_task, 'r') as f: text = f.read()
# Replace the conflict
match = re.search(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n', text, re.DOTALL)
if match:
    # HEAD has the first test, MAIN has the second test.
    # HEAD is missing '  });\n' at the end!
    h = match.group(1)
    if not h.strip().endswith('});'):
        h += '\n  });\n'
    m = match.group(2)
    new_text = text[:match.start()] + h + '\n' + m + text[match.end():]
    with open(file_task, 'w') as f: f.write(new_text)

# 3. telemetry-page.component.spec.ts
file_tel_spec = 'ui-ng/src/app/telemetry/telemetry-page.component.spec.ts'
with open(file_tel_spec, 'r') as f: text = f.read()
# If there is a missing '}', let's just append it. Wait, maybe the describe block is not closed?
# Let's count '{' and '}'
open_braces = text.count('{')
close_braces = text.count('}')
if open_braces > close_braces:
    text += '\n}' * (open_braces - close_braces)
    with open(file_tel_spec, 'w') as f: f.write(text)

# 4. telemetry-page.component.ts
file_tel = 'ui-ng/src/app/telemetry/telemetry-page.component.ts'
with open(file_tel, 'r') as f: text = f.read()
text = text.replace('  type ReleaseNote,\n', '')
with open(file_tel, 'w') as f: f.write(text)

