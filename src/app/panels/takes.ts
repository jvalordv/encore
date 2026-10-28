/**
 * The takes list in the song panel: one row per saved take with Play (Stop
 * while it plays), Delete (two presses, since a take cannot be recovered) and,
 * in learning mode for a take that has a report, Report, which opens or closes
 * the take's card (panels/report.ts). A take timed against a YouTube video
 * says its timing is approximate. The list and its empty line are in
 * index.html; this fills them from `state.takes`.
 */
import type { Session } from '../session';
import { formatClock } from '../state';
import type { AppState, StateStore } from '../state';
import { takeClockOf } from '../takes';
import type { TakeSummary } from '../takes';
import type { MountPanel } from './panel';

/** A first Delete press waits this long for a confirming second press. */
const DELETE_ARM_MS = 3000;

/** The keys of the state the list is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = [
  'takes',
  'playingTakeId',
  'recording',
  'calibrating',
  'mode',
  'reportTakeId',
];

/** What the panel needs: the state to draw, and the intents it calls. */
export interface TakesPanelDeps {
  store: StateStore;
  session: Pick<Session, 'playTake' | 'stopTake' | 'deleteTake' | 'showReport'>;
}

/** Builds the list into `host`; the returned function takes it down. */
export const mountTakesPanel: MountPanel<TakesPanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const list = host.querySelector<HTMLElement>('#take-list');
  const empty = host.querySelector<HTMLElement>('#take-empty');
  if (!list || !empty) throw new Error('index.html is missing #take-list or #take-empty');
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function button(text: string, testid: string, onClick: () => void): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.dataset.testid = testid;
    b.addEventListener('click', onClick);
    return b;
  }

  function row(take: TakeSummary, number: number, state: AppState): HTMLLIElement {
    const active = take.id === state.playingTakeId;
    const busy = state.recording || state.calibrating;
    const item = doc.createElement('li');
    item.className = 'take-item';
    item.dataset.testid = 'take-item';
    item.dataset.takeId = take.id;
    item.dataset.active = String(active);

    const time = new Date(take.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const label = doc.createElement('span');
    label.className = 'take-label';
    label.textContent = `Take ${number} · ${formatClock(take.durationS)} · ${time}`;

    const play = button(active ? 'Stop' : 'Play', 'take-play', () => {
      if (active) session.stopTake();
      else void session.playTake(take.id);
    });
    play.disabled = busy;

    let armed: ReturnType<typeof setTimeout> | undefined;
    const del = button('Delete', 'take-delete', () => {
      if (armed === undefined) {
        // Takes cannot be recovered, so the first press only asks.
        del.textContent = 'Sure?';
        armed = setTimeout(() => {
          timers.delete(armed as ReturnType<typeof setTimeout>);
          armed = undefined;
          del.textContent = 'Delete';
        }, DELETE_ARM_MS);
        timers.add(armed);
        return;
      }
      clearTimeout(armed);
      timers.delete(armed);
      void session.deleteTake(take.id);
    });
    del.disabled = busy;

    item.append(label, play, del);
    // Karaoke mode shows nothing of the measurements, even on a take that has them.
    if (state.mode === 'learning' && take.report) {
      const open = state.reportTakeId === take.id;
      const report = button(open ? 'Hide report' : 'Report', 'take-report', () =>
        session.showReport(open ? null : take.id),
      );
      report.setAttribute('aria-pressed', String(open));
      item.append(report);
    }
    // A take timed against a YouTube video lines up only roughly: the embed's
    // clock is not sample-accurate and its sound path is not calibrated.
    if (takeClockOf(take) === 'embed') {
      item.dataset.clock = 'embed';
      const note = doc.createElement('span');
      note.className = 'take-note';
      note.dataset.testid = 'take-note';
      note.textContent = 'approximate timing';
      item.append(note);
    }
    return item;
  }

  function render(state: AppState): void {
    const { takes } = state;
    list!.replaceChildren(...takes.map((t, i) => row(t, takes.length - i, state)));
    empty!.hidden = takes.length > 0;
  }

  const unsubscribe = store.subscribe((state, changed) => {
    if (WATCHED.some((key) => changed.has(key))) render(state);
  });
  render(store.state);

  return () => {
    unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    list.replaceChildren();
  };
};
