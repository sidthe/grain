with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

# The extra div is right before `} \n\n @if (clusterStats(); as cs) {`
text = text.replace('                }\n              </div>\n            }\n\n            @if (clusterStats(); as cs) {', '                }\n            }\n\n            @if (clusterStats(); as cs) {')

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
