import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    content = f.read()
conflicts = re.findall(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n', content, re.DOTALL)
for i, (head, main) in enumerate(conflicts):
    with open(f'scratch/head_{i}.txt', 'w') as f: f.write(head)
    with open(f'scratch/main_{i}.txt', 'w') as f: f.write(main)
