/**
 * The song panel's "Capture for learning" control: a button that records the
 * linked video's sound from this tab, a Stop button while it records, a
 * status line and one line on what it does. Everything shown comes from
 * `describeCapture` (src/app/capture.ts); the panel only draws it and calls
 * the Session's two intents. Shown for a YouTube video that is not prepared,
 * and opt-in: it does nothing until the button is pressed.
 */
import { describeCapture } from '../capture';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw and the intents it calls. */
export interface CapturePanelDeps {
  store: StateStore;
  session: Pick<Session, 'startCapture' | 'stopCapture' | 'captureSupported'>;
}

/** Builds the control into `host`. */
export const mountCapturePanel: MountPanel<CapturePanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const start = doc.createElement('button');
  start.type = 'button';
  start.dataset.testid = 'capture-button';
  const stop = doc.createElement('button');
  stop.type = 'button';
  stop.dataset.testid = 'capture-stop';
  stop.textContent = 'Stop capture';
  const line = doc.createElement('p');
  line.className = 'song-meta';
  line.dataset.testid = 'capture-line';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  const note = doc.createElement('p');
  note.className = 'song-meta';
  note.dataset.testid = 'capture-note';
  host.append(start, stop, line, note);

  const onStart = (): void => void session.startCapture();
  const onStop = (): void => void session.stopCapture();
  start.addEventListener('click', onStart);
  stop.addEventListener('click', onStop);

  const draw = (state: AppState): void => {
    const view = describeCapture(state.capture, {
      prepare: state.prepare.phase,
      supported: session.captureSupported,
    });
    host.hidden = !view.visible;
    host.dataset.phase = state.capture.phase;
    start.textContent = view.label;
    start.disabled = view.disabled;
    start.dataset.help = view.title;
    stop.hidden = !view.showStop;
    stop.disabled = view.stopDisabled;
    line.textContent = view.line;
    line.hidden = view.line === '';
    note.textContent = view.note;
    note.hidden = view.note === '';
  };
  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('capture') || changed.has('prepare')) draw(state);
  });
  draw(store.state);

  return () => {
    unsubscribe();
    start.removeEventListener('click', onStart);
    stop.removeEventListener('click', onStop);
    host.replaceChildren();
  };
};
