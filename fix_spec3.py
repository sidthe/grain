with open('ui-ng/src/app/telemetry/telemetry-page.component.spec.ts', 'r') as f:
    text = f.read()

text = text.replace('    expect(root.querySelector(\'[data-testid="card-qa-rollout"]\')).toBeNull();\n    it("groups usage notices in configured TZ, progressively discloses', '    expect(root.querySelector(\'[data-testid="card-qa-rollout"]\')).toBeNull();\n  });\n\n  it("groups usage notices in configured TZ, progressively discloses')

with open('ui-ng/src/app/telemetry/telemetry-page.component.spec.ts', 'w') as f:
    f.write(text)
