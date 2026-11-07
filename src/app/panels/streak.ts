/**
 * The header's small "N days in a row" chip, in both modes. It counts days on
 * which a take of real singing was saved and judges nothing, so karaoke mode
 * keeps it. Drawn from `state.library.daysSung` (the Library session keeps it
 * as takes change) in the active skin's words; hidden until there is a streak.
 */
import { localDay } from '../../analysis/streak';
import { SKIN_EVENT } from '../../skins';
import { activeSkin, streakChipText } from '../fun';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the chip needs: the state to draw. */
export interface StreakPanelDeps {
  store: StateStore;
}

/** Builds the chip into `host`; the returned function takes it down. */
export const mountStreakPanel: MountPanel<StreakPanelDeps> = (host, { store }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];

  function render(): void {
    const text = streakChipText(store.state.library.daysSung, localDay(Date.now()), activeSkin(doc));
    host.hidden = text === '';
    host.textContent = text;
  }

  cleanups.push(
    store.subscribe((_state, changed) => {
      if (changed.has('library')) render();
    }),
  );
  // The words change with the skin; the event only exists in a real page.
  if (typeof window !== 'undefined') {
    window.addEventListener(SKIN_EVENT, render);
    cleanups.push(() => window.removeEventListener(SKIN_EVENT, render));
  }
  // The count is as of today, so redraw at the next local midnight and rearm.
  let midnight: ReturnType<typeof setTimeout> | undefined;
  function arm(): void {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    midnight = setTimeout(() => {
      render();
      arm();
    }, Math.max(1000, next - now.getTime()));
  }
  cleanups.push(() => clearTimeout(midnight));
  arm();
  render();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.textContent = '';
  };
};
