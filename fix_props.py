import re
with open('scratch/main_telemetry.ts', 'r') as f:
    main = f.read()

# Let's extract all properties from main_telemetry.ts that we need!
# These include showAllTemplates, showAllUsageNotices, showAllScopes, showAllDirections, showAllActors, actorsFilter
# and visibleTemplates, visibleScopes, visibleDirections, usageNotices, unfilteredActors, peopleActorCount, alphabeticalActors, visibleActors

props_to_extract = [
    r'protected readonly showAllTemplates = signal\(false\);',
    r'protected readonly showAllUsageNotices = signal\(false\);',
    r'protected readonly showAllScopes = signal\(false\);',
    r'protected readonly showAllDirections = signal\(false\);',
    r'protected readonly showAllActors = signal\(false\);',
    r'protected readonly actorsFilter = signal<"all" \| "people">\("all"\);',
    r'protected readonly unfilteredActors = computed\(\(\) => \{.*?\n  \}\);',
    r'protected readonly peopleActorCount = computed\(\(\) =>.*?\n  \);',
    r'protected readonly alphabeticalActors = computed\(\(\) => \{.*?\n  \}\);',
    r'protected readonly visibleActors = computed\(\(\) => \{.*?\n  \}\);',
    r'protected readonly visibleTemplates = computed\(\(\) => \{.*?\n  \}\);',
    r'protected readonly visibleScopes = computed\(\(\) => \{.*?\n  \}\);',
    r'protected readonly visibleDirections = computed\(\(\) => \{.*?\n  \}\);',
    r'protected readonly usageNotices = computed\(\(\) => \{.*?\n  \}\);',
]

extracted = []
for p in props_to_extract:
    m = re.search(p, main, re.DOTALL)
    if m:
        extracted.append(m.group(0))

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    head = f.read()

# Insert before the last `}` of the class
head = head.replace('\n}\n\nfunction parseTab', '\n\n  ' + '\n  '.join(extracted) + '\n}\n\nfunction parseTab')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(head)

