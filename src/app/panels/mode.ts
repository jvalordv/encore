/**
 * The mode toggle in the header: Karaoke (the default, never judges) or
 * Learning (opt-in: scores each take against the original singer). Two joined
 * buttons, the pressed one is the mode in use; the choice is the Session's
 * `setMode`, which remembers it and sets the search chip to match. Beside it,
 * only in learning mode, the Strict / Open selector (the Session's
 * `setScoring`, remembered too) and a one-line hint that Shift+click marks a
 * phrase free. Drawn from `state.mode` and `state.scoring` alone.
 */
import { FREE_PHRASE_HINT, MODE_CHOICES, SCORING_CHOICES } from '../learning';
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw and the one intent it calls. */
export interface ModePanelDeps {
  store: StateStore;
  session: Pick<Session, 'setMode' | 'setScoring'>;
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

  // Learning mode only: how it judges, and how to mark a phrase free.
  const styleLabel = doc.createElement('span');
  styleLabel.id = 'scoring-label';
  styleLabel.textContent = 'Scoring';
  const styleGroup = doc.createElement('div');
  styleGroup.className = 'segmented';
  styleGroup.dataset.testid = 'scoring-choices';
  styleGroup.setAttribute('role', 'group');
  styleGroup.setAttribute('aria-labelledby', styleLabel.id);
  const styleButtons = SCORING_CHOICES.map(({ style, label: text, title }) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.testid = `scoring-${style}`;
    button.textContent = text;
    button.title = title;
    const onClick = (): void => session.setScoring(style);
    button.addEventListener('click', onClick);
    cleanups.push(() => button.removeEventListener('click', onClick));
    styleGroup.append(button);
    return { style, button };
  });
  const hint = doc.createElement('span');
  hint.className = 'mode-hint';
  hint.dataset.testid = 'free-hint';
  hint.textContent = FREE_PHRASE_HINT;
  const learningOnly = [styleLabel, styleGroup, hint];
  host.append(label, group, ...learningOnly);

  const render = (): void => {
    for (const { mode, button } of buttons) {
      button.setAttribute('aria-pressed', String(store.state.mode === mode));
    }
    for (const { style, button } of styleButtons) {
      button.setAttribute('aria-pressed', String(store.state.scoring === style));
    }
    for (const node of learningOnly) node.hidden = store.state.mode !== 'learning';
  };
  cleanups.push(
    store.subscribe((_state, changed) => {
      if (changed.has('mode') || changed.has('scoring')) render();
    }),
  );
  render();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
