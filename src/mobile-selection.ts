import type { Source } from './model';
import type { ExplanationAnchor } from './ui';

export interface MobileReadingSelection { source: Source; anchor: ExplanationAnchor }

/** A manual touch action. Observing a selection never performs a lookup. */
export class MobileSelectionAction {
  readonly element: HTMLButtonElement;
  private current: MobileReadingSelection | null = null;
  private pressed: MobileReadingSelection | null = null;
  private timer: number | undefined;
  private disposed = false;
  private disposers: (() => void)[] = [];

  constructor(private doc: Document, private capture: () => MobileReadingSelection | null, private explain: (selection: MobileReadingSelection) => void) {
    this.element = doc.createElement('button');
    this.element.type = 'button';
    this.element.className = 'ef-mobile-selection-action';
    this.element.textContent = '讲解选文';
    this.element.setAttribute('aria-label', '讲解选中的英语');
    this.element.hidden = true;
    doc.body.append(this.element);
    const prepare = () => { this.pressed = this.current; this.cancelTimer(); };
    this.listen(this.element, 'pointerdown', prepare);
    this.listen(this.element, 'touchstart', prepare, { passive: true });
    this.listen(this.element, 'focus', prepare);
    this.listen(this.element, 'click', () => {
      // iOS may collapse the native selection between touchstart and click.
      const selection = this.pressed ?? this.current;
      this.clear();
      if (selection) this.explain(selection);
    });
    this.listen(this.element, 'blur', () => { this.pressed = null; this.schedule(); });
    const cancel = () => { this.pressed = null; this.schedule(); };
    this.listen(this.element, 'pointercancel', cancel);
    this.listen(this.element, 'touchcancel', cancel);
    this.listen(doc, 'selectionchange', () => this.schedule());
    this.listen(doc, 'pointerup', () => this.schedule());
    this.listen(doc, 'touchend', () => this.schedule(), { passive: true });
    const outside = (event: Event) => { if (event.target !== this.element) this.clear(); };
    this.listen(doc, 'pointerdown', outside);
    this.listen(doc, 'touchstart', outside, { passive: true });
    this.listen(doc, 'focusin', event => {
      const target = event.target as Element | null;
      if (target?.closest('input, textarea, .modal, .modal-container')) this.clear();
    });
    this.listen(doc, 'scroll', () => { if (!this.pressed) this.clear(); }, true);
    this.listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') this.clear(); });
    this.listen(doc, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape') this.clear(); });
    const win = doc.defaultView;
    if (win) this.listen(win, 'resize', () => this.position());
    if (win?.visualViewport) {
      this.listen(win.visualViewport, 'resize', () => this.position());
      this.listen(win.visualViewport, 'scroll', () => this.position());
    }
  }
  private listen(target: EventTarget, name: string, callback: (event: Event) => void, options?: AddEventListenerOptions | boolean): void {
    target.addEventListener(name, callback, options);
    this.disposers.push(() => target.removeEventListener(name, callback, options));
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) this.doc.defaultView?.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    if (this.disposed || this.pressed) return;
    this.cancelTimer();
    this.timer = this.doc.defaultView?.setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.pressed) return;
      const selection = this.capture();
      if (!selection) { this.clear(); return; }
      this.current = selection;
      this.element.hidden = false;
      this.position();
    }, 120);
  }
  private position(): void {
    const viewportTop = Math.max(0, this.doc.defaultView?.visualViewport?.offsetTop ?? 0);
    this.element.style.setProperty('--ef-mobile-viewport-top', `${viewportTop}px`);
  }
  clear(): void {
    this.current = null; this.pressed = null; this.element.hidden = true;
    if (this.doc.activeElement === this.element) this.element.blur();
    this.cancelTimer();
  }
  destroy(): void {
    this.disposed = true; this.clear();
    for (const dispose of this.disposers) dispose();
    this.disposers = []; this.element.remove();
  }
}
