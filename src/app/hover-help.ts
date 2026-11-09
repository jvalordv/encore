/**
 * Hover help: a small styled popup that explains a control. Any element opts
 * in with `data-help="..."`; this module listens once on the document, so
 * panels never wire anything. The popup appears after a short delay when the
 * mouse rests on the element (found by position, so a disabled control
 * explains itself too) or keyboard focus reaches it, goes away on leave,
 * blur, Escape, a press or a scroll, sits beside its element and stays inside
 * the viewport. Screen readers get the text through `aria-describedby`, set
 * as soon as the element is entered, so the delay does not hold it back. The
 * Settings switch "Hover help" (`state.hoverHelp`) turns all of it off; the
 * aria-labels on controls are not touched. Not the learning-mode "tips": this
 * says what a control does and never says anything about the singing.
 *
 * The timing and the placement are pure (`stepHelp`, `placeHelp`) and tested
 * in test/hover-help.test.ts; `mountHoverHelp` only wires them to the DOM.
 */
import type { StateStore } from './state';

/** How long the pointer or focus rests on an element before the popup shows. */
export const HELP_DELAY_MS = 400;

/** Gap between the element and the popup, and the margin kept to the edges. */
const GAP_PX = 8;
const EDGE_PX = 6;

/** Where the machine is: nothing, waiting out the delay, or showing. */
export type HelpPhase<T> =
  | { phase: 'idle' }
  | { phase: 'pending'; target: T }
  | { phase: 'shown'; target: T };

/** What can happen: an element entered or left, the delay ran out, and so on. */
export type HelpEvent<T> =
  | { type: 'enter'; target: T }
  | { type: 'leave'; target: T }
  | { type: 'timer' }
  | { type: 'dismiss' }
  | { type: 'off' };

/**
 * The next phase. Entering waits out the delay, except while a popup is already
 * showing (moving from one control to the next is immediate). Leaving only
 * counts for the element in play. The delay running out shows the popup, and
 * Escape, a press, a scroll or the switch going off hide it at once. With the
 * switch off nothing ever leaves idle.
 */
export function stepHelp<T>(state: HelpPhase<T>, event: HelpEvent<T>, enabled: boolean): HelpPhase<T> {
  if (!enabled || event.type === 'off' || event.type === 'dismiss') return { phase: 'idle' };
  switch (event.type) {
    case 'enter':
      if (state.phase === 'shown') return { phase: 'shown', target: event.target };
      return { phase: 'pending', target: event.target };
    case 'leave':
      return state.phase !== 'idle' && state.target === event.target ? { phase: 'idle' } : state;
    case 'timer':
      return state.phase === 'pending' ? { phase: 'shown', target: state.target } : state;
  }
}

/** A box in viewport pixels. */
export interface HelpRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the popup goes (its top-left) and on which side of the element. */
export interface HelpPlacement {
  x: number;
  y: number;
  side: 'below' | 'above';
}

/**
 * Puts a popup of `size` beside `target`: below it, centred, or above when
 * there is no room below and more above; then pulled inside the viewport so a
 * popup at an edge is never cut off (a popup larger than the viewport is
 * pinned to its top-left corner).
 */
export function placeHelp(
  target: HelpRect,
  size: { w: number; h: number },
  view: { w: number; h: number },
): HelpPlacement {
  const roomBelow = view.h - (target.y + target.h) - GAP_PX - EDGE_PX;
  const roomAbove = target.y - GAP_PX - EDGE_PX;
  const side = size.h > roomBelow && roomAbove > roomBelow ? 'above' : 'below';
  const rawY = side === 'below' ? target.y + target.h + GAP_PX : target.y - GAP_PX - size.h;
  const rawX = target.x + target.w / 2 - size.w / 2;
  const clamp = (v: number, span: number, room: number): number =>
    Math.max(EDGE_PX, Math.min(v, room - span - EDGE_PX));
  return { x: clamp(rawX, size.w, view.w), y: clamp(rawY, size.h, view.h), side };
}

/** Id of the popup, which each described element points at. */
const POPUP_ID = 'hover-help';

/** The text an element offers, or '' when it offers none. */
function helpOf(el: Element | null): string {
  return el instanceof HTMLElement ? (el.dataset.help ?? '').trim() : '';
}

/** The nearest element at or above `node` that has help text. */
function helpTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  let el: Element | null = node;
  while (el) {
    if (helpOf(el) !== '') return el as HTMLElement;
    el = el.parentElement;
  }
  return null;
}

/** True when keyboard focus (not a click) put focus on `el`. */
function focusedByKeyboard(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Wires hover help into `doc`; the returned function takes it down. */
export function mountHoverHelp(doc: Document, store: StateStore): () => void {
  const win = doc.defaultView;
  if (!win) return () => undefined;
  const popup = doc.createElement('div');
  popup.id = POPUP_ID;
  popup.className = 'hover-help';
  popup.setAttribute('role', 'tooltip');
  popup.dataset.testid = 'hover-help';
  popup.hidden = true;
  doc.body.append(popup);

  let phase: HelpPhase<HTMLElement> = { phase: 'idle' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The element that points at the popup, and what its own description was. */
  let described: { el: HTMLElement; was: string | null } | null = null;

  const undescribe = (): void => {
    if (!described) return;
    const { el, was } = described;
    if (was === null) el.removeAttribute('aria-describedby');
    else el.setAttribute('aria-describedby', was);
    described = null;
  };

  const describe = (el: HTMLElement): void => {
    popup.textContent = helpOf(el);
    if (described?.el === el) return;
    undescribe();
    const was = el.getAttribute('aria-describedby');
    described = { el, was };
    el.setAttribute('aria-describedby', was ? `${was} ${POPUP_ID}` : POPUP_ID);
  };

  const place = (el: HTMLElement): void => {
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.hidden = false;
    const r = el.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const at = placeHelp(
      { x: r.left, y: r.top, w: r.width, h: r.height },
      { w: box.width, h: box.height },
      { w: doc.documentElement.clientWidth, h: doc.documentElement.clientHeight },
    );
    popup.style.left = `${Math.round(at.x)}px`;
    popup.style.top = `${Math.round(at.y)}px`;
    popup.dataset.side = at.side;
  };

  const apply = (next: HelpPhase<HTMLElement>): void => {
    phase = next;
    clearTimeout(timer);
    timer = undefined;
    if (next.phase === 'idle' || !next.target.isConnected || helpOf(next.target) === '') {
      phase = { phase: 'idle' };
      popup.hidden = true;
      undescribe();
      return;
    }
    // The text is attached on entering, so a screen reader hears it on focus.
    describe(next.target);
    if (next.phase === 'pending') {
      popup.hidden = true;
      timer = setTimeout(() => apply(stepHelp(phase, { type: 'timer' }, store.state.hoverHelp)), HELP_DELAY_MS);
    } else {
      place(next.target);
    }
  };

  const send = (event: HelpEvent<HTMLElement>): void => apply(stepHelp(phase, event, store.state.hoverHelp));

  const enter = (node: EventTarget | null): void => {
    const target = helpTarget(node);
    if (target) send({ type: 'enter', target });
  };
  // Focus leaves one control before it reaches the next. While a popup shows,
  // going to another control with help hands the popup over at once.
  const leave = (node: EventTarget | null, to: EventTarget | null): void => {
    const target = helpTarget(node);
    if (!target) return;
    const next = helpTarget(to);
    if (next === target) return;
    if (next && phase.phase === 'shown') send({ type: 'enter', target: next });
    else send({ type: 'leave', target });
  };

  // The element under the mouse is found by position, not by pointerover:
  // browsers send no pointer events to a disabled control, and those are the
  // ones whose help says why they are unavailable. Touch has no hover (a tap
  // would leave the popup stuck), so only a mouse or pen hovers; keyboard
  // focus works for everyone.
  let hovered: HTMLElement | null = null;
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerType === 'touch') return;
    const target = helpTarget(doc.elementFromPoint(ev.clientX, ev.clientY));
    if (target === hovered) return;
    const was = hovered;
    hovered = target;
    if (target) send({ type: 'enter', target });
    else if (was) send({ type: 'leave', target: was });
  };
  // Leaving the window sends no more moves.
  const onOut = (ev: PointerEvent): void => {
    if (ev.relatedTarget !== null || ev.pointerType === 'touch' || !hovered) return;
    const was = hovered;
    hovered = null;
    send({ type: 'leave', target: was });
  };
  const onFocusIn = (ev: FocusEvent): void => {
    const target = helpTarget(ev.target);
    if (target && focusedByKeyboard(target)) enter(target);
  };
  const onFocusOut = (ev: FocusEvent): void => leave(ev.target, ev.relatedTarget);
  const dismiss = (): void => {
    if (phase.phase !== 'idle') send({ type: 'dismiss' });
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') dismiss();
  };

  doc.addEventListener('pointermove', onMove, true);
  doc.addEventListener('pointerout', onOut, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', dismiss, true);
  doc.addEventListener('scroll', dismiss, true);
  win.addEventListener('resize', dismiss);
  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('hoverHelp') && !state.hoverHelp) send({ type: 'off' });
  });

  return () => {
    unsubscribe();
    clearTimeout(timer);
    undescribe();
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerout', onOut, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', dismiss, true);
    doc.removeEventListener('scroll', dismiss, true);
    win.removeEventListener('resize', dismiss);
    popup.remove();
  };
}
