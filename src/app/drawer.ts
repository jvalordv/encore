/**
 * How a right-edge drawer (Progress) is dismissed: its × button, the Escape
 * key and a press anywhere outside it. The rules are two small pure functions
 * (tested in test/drawer.test.ts) and `attachDismiss` wires them to a document.
 * A drawer slides over the page and never reflows it, so this is all the
 * behaviour it shares; what is in it is the panel's own. Focus is the panel's
 * job too: it moves into the drawer on open and back to the button that
 * opened it on a close the singer asked for (a press elsewhere keeps focus
 * where they put it).
 */

/** Anything that can say whether a node is inside it (an Element, a test double). */
export interface Container {
  contains(node: unknown): boolean;
}

/** True when `target` is in none of `inside` (a null container is skipped). */
export function isOutside(target: unknown, inside: ReadonlyArray<Container | null>): boolean {
  if (target === null || target === undefined) return false;
  return !inside.some((c) => c !== null && c.contains(target));
}

/** True when this key press should close an open drawer. */
export function closesOnKey(key: string, open: boolean, handled: boolean): boolean {
  return open && !handled && key === 'Escape';
}

/** What `attachDismiss` is told about a drawer. */
export interface DismissOptions {
  isOpen(): boolean;
  /** Closes the drawer; `restoreFocus` is true when the singer asked by key or button. */
  close(restoreFocus: boolean): void;
  /** Where presses do not count as outside: the drawer, its button, any dialog over it. */
  inside(): ReadonlyArray<Container | null>;
}

/** Listens on `doc` for Escape and outside presses; returns the function that stops. */
export function attachDismiss(doc: Document, options: DismissOptions): () => void {
  const onKey = (ev: KeyboardEvent): void => {
    if (!closesOnKey(ev.key, options.isOpen(), ev.defaultPrevented)) return;
    ev.preventDefault();
    options.close(true);
  };
  const onPress = (ev: Event): void => {
    if (options.isOpen() && isOutside(ev.target, options.inside())) options.close(false);
  };
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onPress, true);
  return () => {
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('pointerdown', onPress, true);
  };
}
