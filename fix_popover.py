with open('ui-ng/src/app/shell/next-up-popover.component.ts', 'r') as f:
    text = f.read()

# Add DispatchStatusBanner import
if 'DispatchStatusBanner' not in text:
    text = text.replace('import type { Task } from "../api/models";', 'import type { Task } from "../api/models";\nimport type { DispatchStatusBanner } from "../shared/dispatch-status";')

# Add dispatchPaused input
if 'readonly dispatchPaused' not in text:
    text = text.replace('readonly closed = output<void>();', 'readonly dispatchPaused = input<DispatchStatusBanner | null>(null);\n  readonly closed = output<void>();')

# Add the banner in template
banner_html = '''
      @if (dispatchPaused(); as dp) {
        <p
          class="banner banner-info next-up-note"
          data-testid="next-up-paused-note"
        >
          {{ dp.headline }}
          @if (dp.resetText) {
            · {{ dp.resetText }}
          }
        </p>
      }
'''
if 'next-up-paused-note' not in text:
    text = text.replace('      </div>\n      @if (backlog().length === 0) {', '      </div>\n' + banner_html + '      @if (backlog().length === 0) {')

with open('ui-ng/src/app/shell/next-up-popover.component.ts', 'w') as f:
    f.write(text)
