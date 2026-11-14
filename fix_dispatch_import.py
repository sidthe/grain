with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

import_str = 'import { effectiveDisplayTimeZone, formatNoticeText } from "../shared/dispatch-status";\n'
text = text.replace('from "@angular/router";\n', 'from "@angular/router";\n' + import_str)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
