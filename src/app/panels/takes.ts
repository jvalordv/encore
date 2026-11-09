/**
 * The takes list in the song panel: one row per saved take with Play (Stop
 * while it plays), Delete (two presses, since a take cannot be recovered) and,
 * in learning mode for a take that has a report, Report, which opens or closes
 * the take's card (panels/report.ts). A take timed against a YouTube video
 * says its timing is approximate. The list, its filter and its empty line are
 * in index.html; this fills them from `state.takes`. The list shows the
 * active singer's takes (those they sang, as singer A or B), with an "All
 * singers" choice that also names who sang each take, and lists the takes kept
 * after their singer was deleted as sung by "No singer".
 */
import { downloadBlob } from '../download';
import { activeProfile, involvesProfile, ownerName } from '../profiles';
import type { Session } from '../session';
import { formatClock } from '../state';
import type { AppState, StateStore } from '../state';
import type { TakeFileKind } from '../take-export';
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
  'profiles',
  'ui',
];

/** What the panel needs: the state to draw, and the intents it calls. */
export interface TakesPanelDeps {
  store: StateStore;
  session: Pick<Session, 'playTake' | 'stopTake' | 'deleteTake' | 'showReport' | 'exportTake' | 'setUiChoices'>;
}

/** Builds the list into `host`; the returned function takes it down. */
export const mountTakesPanel: MountPanel<TakesPanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const list = host.querySelector<HTMLElement>('#take-list');
  const empty = host.querySelector<HTMLElement>('#take-empty');
  const scopePick = host.querySelector<HTMLSelectElement>('#take-owner');
  if (!list || !empty || !scopePick) throw new Error('index.html is missing #take-list, #take-empty or #take-owner');
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function button(text: string, testid: string, onClick: () => void): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.dataset.testid = testid;
    b.addEventListener('click', onClick);
    return b;
  }

  function row(take: TakeSummary, number: number, state: AppState, byName: boolean): HTMLLIElement {
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
    label.dataset.testid = 'take-label';
    const owner = byName ? ownerName(take, state.profiles) : undefined;
    label.textContent = `Take ${number} · ${owner ? `${owner} · ` : ''}${formatClock(take.durationS)} · ${time}`;

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

    // Two buttons rather than one, so the browser does not ask to allow
    // several downloads at once.
    const save = (kind: TakeFileKind): (() => void) => () => {
      void session.exportTake(take.id, kind).then((file) => {
        if (file) downloadBlob(doc, file.blob, file.name);
      });
    };
    const saveWav = button('Save WAV', 'take-save-wav', save('wav'));
    saveWav.dataset.help = 'Download this take\'s audio';
    const saveJson = button('Save JSON', 'take-save-json', save('json'));
    saveJson.dataset.help = 'Download this take\'s pitch frames and mic settings';

    item.append(label, play, del, saveWav, saveJson);
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
    const { profiles } = state;
    const me = activeProfile(profiles);
    // Whose takes the list shows ('mine' is the active singer's); remembered.
    const scope = state.ui.takesScope;
    // A Mic check take is the mic's, not a singer's, so every list keeps it.
    const takes =
      scope === 'all'
        ? state.takes
        : state.takes.filter((t) => t.kind === 'mic-check' || involvesProfile(t, me.id, profiles.legacyId));
    // The first label names the singer, so it is redrawn when a name changes.
    if (scopePick!.dataset.shownName !== me.name) {
      scopePick!.dataset.shownName = me.name;
      scopePick!.replaceChildren(
        ...(
          [
            ['mine', `${me.name}'s takes`],
            ['all', 'All singers'],
          ] as const
        ).map(([value, text]) => {
          const o = doc.createElement('option');
          o.value = value;
          o.textContent = text;
          return o;
        }),
      );
    }
    scopePick!.value = scope;
    list!.replaceChildren(...takes.map((t, i) => row(t, takes.length - i, state, scope === 'all')));
    empty!.hidden = takes.length > 0;
    empty!.textContent =
      scope === 'all' || state.takes.length === 0
        ? 'No takes yet. Press Record and sing.'
        : `No takes by ${me.name} for this song yet. Press Record and sing.`;
  }
  const onScope = (): void => {
    session.setUiChoices({ takesScope: scopePick.value === 'all' ? 'all' : 'mine' });
  };
  scopePick.addEventListener('change', onScope);

  const unsubscribe = store.subscribe((state, changed) => {
    if (WATCHED.some((key) => changed.has(key))) render(state);
  });
  render(store.state);

  return () => {
    unsubscribe();
    scopePick.removeEventListener('change', onScope);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    list.replaceChildren();
  };
};
