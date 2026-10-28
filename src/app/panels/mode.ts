/**
 * The mode toggle in the header: Karaoke (the default, never judges) or
 * Learning (opt-in: scores each take against the original singer). Two joined
 * buttons, the pressed one is the mode in use; the choice is the Session's
 * `setMode`, which remembers it and sets the search chip to match. Drawn from
 * `state.mode` alone.
 */
import { MODE_CHOICES } from '../learning';
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw and the one intent it calls. */
export interface ModePanelDeps {
  store: StateStore;
  session: Pick<Session, 'setMode'>;
}

/** Builds the toggle into `host`; the returned function takes it down. */
export const mountModePanel: MountPanel<ModePanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];

  const label = doc.createElement('span');
  label.id = 'mode-label';
  label.textContent = 'Mode';
  const group = doc.createElement('div');
  group.className = 'segmented';
  group.dataset.testid = 'mode-choices';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', label.id);

  const buttons = MODE_CHOICES.map(({ mode, label: text, title }) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.testid = `mode-${mode}`;
    button.textContent = text;
    button.title = title;
    const onClick = (): void => session.setMode(mode);
    button.addEventListener('click', onClick);
    cleanups.push(() => button.removeEventListener('click', onClick));
    group.append(button);
    return { mode, button };
  });
  host.append(label, group);

  const render = (): void => {
    for (const { mode, button } of buttons) {
      button.setAttribute('aria-pressed', String(store.state.mode === mode));
    }
  };
  cleanups.push(
    store.subscribe((_state, changed) => {
      if (changed.has('mode')) render();
    }),
  );
  render();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
