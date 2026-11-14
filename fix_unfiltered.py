with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

# Insert before peopleActorCount
text = text.replace('  protected readonly peopleActorCount = computed(', 
'''  protected readonly unfilteredActors = computed(() =>
    buildAlphabeticalContributors(this.clusterStats(), this.feed.tasks()),
  );

  protected readonly peopleActorCount = computed(''')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
