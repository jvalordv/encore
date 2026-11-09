/**
 * A just-enough fake document for panel tests, which run in Node: elements
 * that hold children, listeners, a dataset and plain properties, and a
 * document that makes them. It supports what the small panels touch, no more.
 */

/** A fake element; unknown properties (hidden, checked, ...) are plain fields. */
export class FakeElement {
  [key: string]: unknown;
  readonly dataset: Record<string, string> = {};
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  hidden = false;
  disabled = false;
  checked = false;
  className = '';
  textContent = '';

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** Moves the document's focus here, as the browser's focus() does. */
  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  /** A click from code, as HTMLElement.click(). */
  click(): void {
    this.fire('click');
  }

  /** True for this element or any descendant. */
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((c) => c instanceof FakeElement && c.contains(node));
  }

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  /** Fires the listeners of `type`, as a user's click or change would. */
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /** The descendant (any depth) with this data-testid, or undefined. */
  byTestId(id: string): FakeElement | undefined {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.dataset.testid === id) return child;
      const deeper = child.byTestId(id);
      if (deeper) return deeper;
    }
    return undefined;
  }
}

/** A fake document: makes elements and text nodes. */
export class FakeDocument {
  activeElement: unknown = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  /** Delivers an event to the document's listeners, as a bubbled key or press. */
  dispatch(type: string, event: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  querySelectorAll(): unknown[] {
    return [];
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): { text: string } {
    return { text };
  }
}

/** A host element in a new fake document, typed as the real one. */
export function fakeHost(): HTMLElement & FakeElement {
  return new FakeDocument().createElement('div') as unknown as HTMLElement & FakeElement;
}

/** Looks up a descendant by data-testid, failing the test if absent. */
export function byTestId(host: FakeElement, id: string): FakeElement {
  const el = host.byTestId(id);
  if (!el) throw new Error(`no element with data-testid ${id}`);
  return el;
}
