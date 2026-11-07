/**
 * The Key control beside the transport: a minus and a plus button around the
 * shift in force, "Use suggested (+2)" when the singer's range and the
 * melody's say a move would help, and Reset. It shows in both modes (a key
 * judges nothing). When the song's sound cannot be moved (YouTube's own
 * player) the buttons are off, the suggestion shows as text and one plain
 * line says why. The data attributes (`data-shift`, `data-first-note`) give
 * the end-to-end run something to read that is not pixels: the shift in force
 * and the first note of the melody the lane is given, shift included.
 */
import { offeredSuggestion, shiftLabel, whyNoShift } from '../key-shift';
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** Said while there are too few learning takes to read a range from. */
const NEEDS_TAKES = 'Sing a few takes first, and the app can suggest a key.';

/** What the panel needs: the state to draw and the intents it calls. */
export interface KeyShiftPanelDeps {
  store: StateStore;
  session: Pick<Session, 'stepKey' | 'useSuggestedKey' | 'resetKey' | 'melodyForExport'>;
}

/** Builds the control into `host`. */
export const mountKeyShiftPanel: MountPanel<KeyShiftPanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, text = ''): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);
    el.dataset.testid = testid;
    el.textContent = text;
    return el;
  };
  host.dataset.testid = 'key-shift';
  const label = doc.createElement('span');
  label.className = 'key-label';
  label.textContent = 'Key';
  const down = make('button', 'key-down', '−');
  const readout = make('span', 'key-readout', '0');
  readout.className = 'key-readout';
  readout.setAttribute('aria-live', 'polite');
  const up = make('button', 'key-up', '+');
  const suggest = make('button', 'key-suggested');
  const reset = make('button', 'key-reset', 'Reset');
  const hint = make('span', 'key-hint');
  hint.className = 'song-meta key-hint';
  for (const b of [down, up, suggest, reset]) b.type = 'button';
  down.classList.add('compact');
  up.classList.add('compact');
  down.title = 'Sing it a semitone lower';
  up.title = 'Sing it a semitone higher';
  down.setAttribute('aria-label', 'Key down one semitone');
  up.setAttribute('aria-label', 'Key up one semitone');
  host.append(label, down, readout, up, suggest, reset, hint);

  const onDown = (): void => session.stepKey(-1);
  const onUp = (): void => session.stepKey(1);
  const onSuggest = (): void => session.useSuggestedKey();
  const onReset = (): void => session.resetKey();
  down.addEventListener('click', onDown);
  up.addEventListener('click', onUp);
  suggest.addEventListener('click', onSuggest);
  reset.addEventListener('click', onReset);

  const draw = (): void => {
    const { keyShift, song } = store.state;
    const offered = offeredSuggestion(keyShift);
    const movable = song !== null && keyShift.canShift;
    // Not while recording: the key cannot change under a take.
    const locked = store.state.recording;
    down.disabled = !movable || locked || keyShift.shift <= -6;
    up.disabled = !movable || locked || keyShift.shift >= 6;
    suggest.disabled = locked;
    reset.disabled = locked;
    readout.textContent = shiftLabel(keyShift.shift);
    host.dataset.shift = String(keyShift.shift);
    const notes = session.melodyForExport()?.notes;
    host.dataset.firstNote = notes && notes.length > 0 ? String(notes[0].midi) : '';
    reset.hidden = keyShift.shift === 0;
    suggest.hidden = offered === null || !movable;
    if (offered !== null) suggest.textContent = `Use suggested (${shiftLabel(offered)})`;
    // Without a way to move the song the suggestion is only information.
    const why = song !== null ? whyNoShift(keyShift.canShift) : '';
    const hasMelody = notes !== undefined && notes.length > 0;
    if (why) hint.textContent = offered !== null ? `Suggested ${shiftLabel(offered)}. ${why}` : why;
    else if (movable && hasMelody && keyShift.band === null) hint.textContent = NEEDS_TAKES;
    else hint.textContent = '';
    hint.hidden = hint.textContent === '';
  };

  const unsubscribe = store.subscribe((_state, changed) => {
    if (changed.has('keyShift') || changed.has('recording') || changed.has('song') || changed.has('reference')) draw();
  });
  draw();

  return () => {
    unsubscribe();
    down.removeEventListener('click', onDown);
    up.removeEventListener('click', onUp);
    suggest.removeEventListener('click', onSuggest);
    reset.removeEventListener('click', onReset);
    host.replaceChildren();
  };
};
