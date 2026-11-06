/**
 * Karaoke mode's note guide: a checkbox in the header, shown only in karaoke
 * mode and off by default, and, when it is on and the mic is open, a steady
 * readout over the lane such as "A4 · 12 c sharp" (or "in tune"). It is a
 * neutral readout: no colour, no grade, nothing stored with a take. The
 * Session measures (`state.guideReading`); this only draws it.
 */
import { formatGuide } from '../../analysis/note-guide';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw and the one intent it calls. */
export interface NoteGuidePanelDeps {
  store: StateStore;
  session: Pick<Session, 'setNoteGuide'>;
  /** The element the readout is placed in, over the lane. */
  readoutHost: HTMLElement;
}

/** Builds the toggle into `host` and the readout into `readoutHost`. */
export const mountNoteGuidePanel: MountPanel<NoteGuidePanelDeps> = (host, { store, session, readoutHost }) => {
  const doc = host.ownerDocument;
  const label = doc.createElement('label');
  label.className = 'note-guide-toggle';
  label.title = 'Show the nearest note and how far off you are. Nothing is scored or stored.';
  const box = doc.createElement('input');
  box.type = 'checkbox';
  box.dataset.testid = 'note-guide-toggle';
  const onChange = (): void => session.setNoteGuide(box.checked);
  box.addEventListener('change', onChange);
  label.append(box, doc.createTextNode(' Note guide'));
  host.append(label);

  const readout = doc.createElement('div');
  readout.className = 'guide-readout';
  readout.dataset.testid = 'note-guide-readout';
  readout.hidden = true;
  readoutHost.append(readout);

  const render = (state: AppState): void => {
    const karaoke = state.mode === 'karaoke';
    host.hidden = !karaoke;
    box.checked = state.noteGuide;
    const reading = state.guideReading;
    const show = karaoke && state.noteGuide && state.input.open && reading !== null;
    readout.hidden = !show;
    readout.textContent = show ? formatGuide(reading) : '';
  };
  const unsubscribe = store.subscribe((state, changed) => {
    if (['mode', 'noteGuide', 'guideReading', 'input'].some((key) => changed.has(key as keyof AppState))) {
      render(state);
    }
  });
  render(store.state);

  return () => {
    unsubscribe();
    box.removeEventListener('change', onChange);
    readout.remove();
    host.replaceChildren();
  };
};
