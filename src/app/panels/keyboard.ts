/**
 * The lane's keyboard toggle: a checkbox in the header, shown in both modes,
 * on by default. It turns the piano keyboard view of the lane (the melody's
 * lit key and the voice marker) on or off; the Session remembers the choice
 * and tells the lane. It judges nothing, so karaoke mode keeps it.
 */
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw and the one intent it calls. */
export interface KeyboardPanelDeps {
  store: StateStore;
  session: Pick<Session, 'setKeyboard'>;
}

/** Builds the toggle into `host`. */
export const mountKeyboardPanel: MountPanel<KeyboardPanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const label = doc.createElement('label');
  label.className = 'keyboard-toggle';
  label.dataset.help = 'Show the piano keys beside the lane: the melody lights its key and your voice is a marker.';
  const box = doc.createElement('input');
  box.type = 'checkbox';
  box.dataset.testid = 'keyboard-toggle';
  const onChange = (): void => session.setKeyboard(box.checked);
  box.addEventListener('change', onChange);
  label.append(box, doc.createTextNode(' Keyboard'));
  host.append(label);

  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('keyboard')) box.checked = state.keyboard;
  });
  box.checked = store.state.keyboard;

  return () => {
    unsubscribe();
    box.removeEventListener('change', onChange);
    host.replaceChildren();
  };
};
