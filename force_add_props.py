import re
with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'r') as f:
    text = f.read()

props = '''
  private readonly destroyRef = inject(DestroyRef);
  protected readonly tabs = TABS;

  private readonly repoTrigger =
    viewChild<ElementRef<HTMLButtonElement>>("repoTrigger");
  private readonly authorTrigger =
    viewChild<ElementRef<HTMLButtonElement>>("authorTrigger");
  private readonly repoListbox =
    viewChild<ElementRef<HTMLElement>>("repoListbox");
  private readonly authorListbox =
    viewChild<ElementRef<HTMLElement>>("authorListbox");

  protected readonly tab = signal<TelemetryTab>("overview");
'''

# Insert it right after the class declaration!
class_decl = 'export class TelemetryPageComponent implements OnInit {'
if class_decl in text and 'protected readonly tabs = TABS;' not in text:
    text = text.replace(class_decl, class_decl + '\n' + props)

with open('ui-ng/src/app/telemetry/telemetry-page.component.ts', 'w') as f:
    f.write(text)
