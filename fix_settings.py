import re
with open('ui-ng/src/app/settings/settings-work.component.ts', 'r') as f:
    text = f.read()

new_text = re.sub(r'<<<<<<< HEAD\n\s*ngOnChanges\(\): void \{\n\s*this\.loadForSection\(\);\n\s*this\.loadRunningExp\(\);\n=======\n\s*ngOnChanges\(changes: SimpleChanges\): void \{\n\s*if \(changes\["section"\] && !changes\["section"\]\.firstChange\) \{\n\s*this\.loadForSection\(\);\n\s*\}\n>>>>>>> origin/main\n', 
'  ngOnChanges(changes: SimpleChanges): void {\n    if (changes["section"] && !changes["section"].firstChange) {\n      this.loadForSection();\n      this.loadRunningExp();\n    }\n', text, flags=re.DOTALL)

with open('ui-ng/src/app/settings/settings-work.component.ts', 'w') as f:
    f.write(new_text)

