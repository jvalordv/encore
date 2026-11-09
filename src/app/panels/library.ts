/**
 * The Library panel: a drawer listing every song that has been loaded
 * (newest first, or the favorites in playlist order), reached from the
 * header's Library button. A row has a star, the title (click to load), a grey
 * line of source, length, last played, prepared badge and takes, and Remove
 * (two presses, since the entry cannot be recovered; its takes are kept), and
 * Use as original on a song with a melody while the song in use has none. The
 * Favorites view adds up and down, Play from here, Play from top, the
 * auto-advance box and export and import of the list as a JSON file. Uploads
 * only the service holds appear under "On the service". Two small pieces sit
 * in the song panel: a star for the song in use and, while the playlist runs,
 * Previous, Next and Stop. Everything drawn is a function of `state.library`
 * and the song; the controls call Session intents and hold no logic.
 *
 * A song with takes says "3 takes · last sung yesterday" in a button that
 * opens the song's takes: date, time and length of each, who sang it under the
 * drawer's "All singers" switch (otherwise the active singer's takes are the
 * ones counted), and, in learning mode only, the in-tune share and stars of a
 * take that has a report. Each take has Replay (over its song; another song
 * is opened first, the drawer staying up, and the take plays once it is
 * ready), Open (loads the song and, in learning mode, the take's report card)
 * and Delete (two presses). Karaoke mode shows no figures. The All singers
 * switch, the open rows and the list shown are remembered (state.ui).
 */
import { downloadBlob } from '../download';
import { STAR_MEASURE_SHORT } from '../../analysis/stars';
import { activeSkin, starGlyphs, starsText } from '../fun';
import { FAVORITES_FILE_NAME } from '../library-share';
import { entriesFor, lengthLabel, playlistPosition, rowOf } from '../library-state';
import { ownerName } from '../profiles';
import type { Session } from '../session';
import { dayLabel, scoreOfTake, takesBySong, takesLine } from '../song-takes';
import type { TakeScope } from '../song-takes';
import { formatClock } from '../state';
import type { AppState, StateStore } from '../state';
import type { TakeSummary } from '../takes';
import { toggledId } from '../ui-choices';
import type { MountPanel } from './panel';

/** A first Remove press waits this long for a confirming second press. */
const REMOVE_ARM_MS = 3000;
/** The keys of the state the panel is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = [
  'library',
  'song',
  'karaoke',
  'reference',
  'mode',
  'profiles',
  'playingTakeId',
  'recording',
  'calibrating',
  'ui',
];

/** What the panel needs: the state, the intents and the buttons it works with. */
export interface LibraryPanelDeps {
  store: StateStore;
  session: Pick<
    Session,
    | 'setLibraryOpen'
    | 'setLibraryView'
    | 'loadLibraryEntry'
    | 'loadServiceSong'
    | 'openLibraryTake'
    | 'replayLibraryTake'
    | 'deleteLibraryTake'
    | 'stopTake'
    | 'setUiChoices'
    | 'useAsOriginal'
    | 'toggleFavorite'
    | 'moveFavorite'
    | 'removeLibraryEntry'
    | 'playFavorites'
    | 'nextFavorite'
    | 'previousFavorite'
    | 'stopFavorites'
    | 'setAutoAdvance'
    | 'exportFavorites'
    | 'importFavorites'
  >;
  /** The header button that opens the drawer. */
  toggle: HTMLButtonElement;
  /** The song panel's star for the song in use. */
  star: HTMLButtonElement;
  /** The song panel's Previous, Next and Stop while the playlist runs. */
  bar: HTMLElement;
}

/** True when the song in use lacks a melody of its own and `id` is another song. */
function offersOriginal(state: AppState, id: string): boolean {
  if (state.song === null || state.song.hash === id || state.karaoke.phase !== 'ready') return false;
  return state.reference.phase !== 'ready' || Boolean(state.reference.alignedFrom);
}

/** Builds the drawer into `host`; the returned function takes it down. */
export const mountLibraryPanel: MountPanel<LibraryPanelDeps> = (host, { store, session, toggle, star, bar }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];
  /** One confirm timer per kind, so re-arming never leaves a stale one running. */
  const armTimers: Record<'entry' | 'take', ReturnType<typeof setTimeout> | null> = { entry: null, take: null };
  let armedId: string | null = null;
  let armedTakeId: string | null = null;
  /** Where focus goes when the control it sits on (`from`) is removed by a render. */
  let pendingFocus: { from: string; to: string[] } | null = null;
  // The "All singers" switch and the songs whose takes are listed open are
  // remembered choices (state.ui), so they survive a reload and the export.

  function make<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, className = ''): HTMLElementTagNameMap[K] {
    const el = doc.createElement(tag);
    el.dataset.testid = testid;
    if (className) el.className = className;
    return el;
  }
  function button(text: string, testid: string, onClick: () => void, className = 'compact'): HTMLButtonElement {
    const b = make('button', testid, className);
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }
  /** Arms `id` for a second press; the arm lapses after REMOVE_ARM_MS. */
  function arm(kind: 'entry' | 'take', id: string): void {
    const stale = armTimers[kind];
    if (stale !== null) clearTimeout(stale);
    if (kind === 'entry') armedId = id;
    else armedTakeId = id;
    armTimers[kind] = setTimeout(() => {
      armTimers[kind] = null;
      if (kind === 'entry') armedId = null;
      else armedTakeId = null;
      render(store.state);
    }, REMOVE_ARM_MS);
    render(store.state);
  }
  /** Drops the arm and its timer once the confirming press has been made. */
  function disarm(kind: 'entry' | 'take'): void {
    const timer = armTimers[kind];
    if (timer !== null) clearTimeout(timer);
    armTimers[kind] = null;
    if (kind === 'entry') armedId = null;
    else armedTakeId = null;
  }
  const listen = (target: HTMLElement, type: 'click' | 'change', handler: () => void): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  const head = make('div', 'library-head', 'library-head');
  const title = doc.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Library';
  const close = button('Close', 'library-close', () => session.setLibraryOpen(false));
  head.append(title, close);

  const tabs = make('div', 'library-tabs', 'segmented');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Show');
  const allTab = button('All songs', 'library-tab-all', () => session.setLibraryView('all'), '');
  const favTab = button('Favorites', 'library-tab-favorites', () => session.setLibraryView('favorites'), '');
  tabs.append(allTab, favTab);

  const singersLabel = doc.createElement('label');
  singersLabel.className = 'check';
  const singers = make('input', 'library-all-singers');
  singers.type = 'checkbox';
  singersLabel.dataset.help = "Count and list every singer's takes, not only the active singer's";
  singersLabel.append(singers, doc.createTextNode(' All singers'));

  const tools = make('div', 'library-tools', 'library-tools');
  const playTop = button('Play from top', 'library-play-top', () => void session.playFavorites());
  const autoLabel = doc.createElement('label');
  autoLabel.className = 'check';
  const auto = make('input', 'library-auto-advance');
  auto.type = 'checkbox';
  autoLabel.append(auto, doc.createTextNode(' Next song when one ends'));
  const exportButton = button('Export', 'library-export', () => {
    const text = session.exportFavorites();
    if (text !== null) downloadBlob(doc, new Blob([text], { type: 'application/json' }), FAVORITES_FILE_NAME);
  });
  const importFile = make('input', 'library-import-file');
  importFile.type = 'file';
  importFile.accept = 'application/json,.json';
  importFile.hidden = true;
  const importButton = button('Import', 'library-import', () => importFile.click());
  tools.append(playTop, autoLabel, exportButton, importButton, importFile);
  listen(auto, 'change', () => session.setAutoAdvance(auto.checked));
  listen(singers, 'change', () => session.setUiChoices({ libraryAllSingers: singers.checked }));
  listen(importFile, 'change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (file) void file
        .text()
        .then((text) => session.importFavorites(text))
        .catch(() => {
          notice.textContent = 'That file could not be read.';
        });
  });

  const notice = make('p', 'library-notice', 'song-meta');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const list = make('ul', 'library-list', 'library-list');
  const empty = make('p', 'library-empty', 'song-meta');
  const serviceTitle = doc.createElement('h3');
  serviceTitle.className = 'group-title';
  serviceTitle.textContent = 'On the service';
  const serviceList = make('ul', 'library-service-list', 'library-list');
  host.append(head, tabs, singersLabel, tools, notice, empty, list, serviceTitle, serviceList);

  listen(toggle, 'click', () => session.setLibraryOpen(host.hidden));
  listen(star, 'click', () => {
    const id = store.state.song?.hash;
    if (id) void session.toggleFavorite(id);
  });
  const previous = button('Previous', 'playlist-previous', () => void session.previousFavorite());
  const next = button('Next', 'playlist-next', () => void session.nextFavorite());
  const stop = button('Stop list', 'playlist-stop', () => session.stopFavorites());
  const position = make('span', 'playlist-position', 'song-meta');
  const barTitle = doc.createElement('span');
  barTitle.textContent = 'Favorites';
  bar.append(barTitle, position, previous, next, stop);

  function takeRow(take: TakeSummary, siblings: TakeSummary[], state: AppState, scope: TakeScope): HTMLLIElement {
    const item = make('li', 'library-take', 'library-take');
    item.dataset.takeId = take.id;
    const day = dayLabel(take.createdAt, Date.now());
    const time = new Date(take.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const parts = [`${day.charAt(0).toUpperCase()}${day.slice(1)} ${time}`, formatClock(take.durationS)];
    const owner = scope.allSingers ? ownerName(take, state.profiles) : undefined;
    if (owner) parts.push(owner);
    const label = make('span', 'library-take-label', 'library-take-label');
    const text = parts.join(' · ');
    label.textContent = text;
    item.append(label);
    // Karaoke mode shows no figures of any kind, even for a take that has them.
    const score = state.mode === 'learning' ? scoreOfTake(take, scope) : null;
    if (score) {
      const figures = make('span', 'library-take-score', 'song-meta');
      figures.textContent = `${score.percent}% ${STAR_MEASURE_SHORT[score.measure]} ${starGlyphs(score.stars)}`;
      item.append(figures);
    }
    const busy = state.recording || state.calibrating;
    const playing = state.playingTakeId === take.id;
    const replay = button(playing ? 'Stop' : 'Replay', 'library-take-replay', () => {
      if (playing) session.stopTake();
      else void session.replayLibraryTake(take.id);
    });
    replay.setAttribute('aria-label', `${playing ? 'Stop' : 'Replay'} ${text}`);
    replay.disabled = busy;
    replay.dataset.focus = `${take.id}:replay`;
    replay.dataset.help = 'Play this take over its song';
    const open = button('Open', 'library-take-open', () => void session.openLibraryTake(take.songHash, take.id));
    open.dataset.focus = `${take.id}:open`;
    open.setAttribute('aria-label', `Open ${text}`);
    open.dataset.help = 'Load this song and select this take';
    const del = button(armedTakeId === take.id ? 'Sure?' : 'Delete', 'library-take-delete', () => {
      // A take cannot be recovered, so the first press only asks.
      if (armedTakeId !== take.id) {
        arm('take', take.id);
        return;
      }
      disarm('take');
      // The row is about to vanish with this button; line up where focus lands.
      const at = siblings.findIndex((t) => t.id === take.id);
      const near = [siblings[at + 1], siblings[at - 1]].filter((t): t is TakeSummary => t !== undefined);
      pendingFocus = {
        from: `${take.id}:delete`,
        to: [...near.map((t) => `${t.id}:delete`), `${take.songHash}:takes`, `${take.songHash}:load`],
      };
      void session.deleteLibraryTake(take.id);
    });
    del.setAttribute('aria-label', `${armedTakeId === take.id ? 'Confirm delete' : 'Delete'} ${text}`);
    del.disabled = busy;
    del.dataset.focus = `${take.id}:delete`;
    del.dataset.help = 'Remove this take only; it cannot be recovered';
    item.append(replay, open, del);
    return item;
  }

  function row(
    entryId: string,
    state: AppState,
    favoritesView: boolean,
    index: number,
    count: number,
    taken: Record<string, TakeSummary[]>,
    scope: TakeScope,
  ): HTMLLIElement {
    const { library } = state;
    const entry = library.entries.find((e) => e.id === entryId);
    const item = make('li', 'library-item', 'library-item');
    if (!entry) return item;
    const view = rowOf(entry, Date.now());
    item.dataset.id = entry.id;
    item.dataset.source = entry.source;
    item.dataset.current = String(state.song?.hash === entry.id);
    const starButton = button(entry.favorite ? '★' : '☆', 'library-star', () => void session.toggleFavorite(entry.id), 'star');
    starButton.setAttribute('aria-pressed', String(entry.favorite));
    starButton.setAttribute('aria-label', entry.favorite ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`);
    starButton.dataset.focus = `${entry.id}:star`;
    const load = make('button', 'library-load', 'library-load');
    load.type = 'button';
    load.dataset.focus = `${entry.id}:load`;
    load.dataset.help = `Load: ${entry.title}`;
    const name = make('span', 'library-title', 'library-title');
    name.textContent = view.title;
    const meta = make('span', 'library-meta', 'song-meta');
    meta.textContent = view.meta.join(' · ');
    load.append(name, meta);
    // Stars are learning mode's: karaoke mode shows the song and nothing about it.
    const stars = state.mode === 'learning' ? (library.songStars[entry.id] ?? 0) : 0;
    if (stars > 0) {
      const badge = make('span', 'library-stars', 'song-meta');
      const measure = library.songStarMeasure[entry.id];
      const label = measure === undefined ? '' : ` (${STAR_MEASURE_SHORT[measure]})`;
      badge.textContent = `${starGlyphs(stars)} ${starsText(stars, activeSkin(doc))}${label}`;
      load.append(badge);
    }
    if (view.badge !== null) {
      const badge = make('span', 'library-reference', 'search-badge');
      badge.textContent = view.badge.label;
      badge.dataset.help = view.badge.title;
      badge.setAttribute('aria-label', `${view.badge.label}: ${view.badge.title}`);
      badge.dataset.badge = view.badge.label.toLowerCase();
      load.append(badge);
    }
    load.addEventListener('click', () => void session.loadLibraryEntry(entry.id));
    const actions = doc.createElement('span');
    actions.className = 'library-actions';
    if (favoritesView) {
      const up = button('Up', 'library-up', () => void session.moveFavorite(entry.id, -1));
      up.disabled = index === 0;
      up.dataset.focus = `${entry.id}:up`;
      const down = button('Down', 'library-down', () => void session.moveFavorite(entry.id, 1));
      down.disabled = index === count - 1;
      down.dataset.focus = `${entry.id}:down`;
      actions.append(up, down, button('Play from here', 'library-play-from', () => void session.playFavorites(entry.id)));
    }
    // A prepared song with a melody can stand in as the original of a
    // karaoke track that has none of its own.
    if (entry.melody && offersOriginal(state, entry.id)) {
      actions.append(
        button('Use as original', 'library-use-original', () => void session.useAsOriginal(entry.id)),
      );
    }
    const armed = armedId === entry.id;
    const remove = button(armed ? 'Sure?' : 'Remove', 'library-remove', () => {
      if (armedId !== entry.id) {
        arm('entry', entry.id);
        return;
      }
      disarm('entry');
      void session.removeLibraryEntry(entry.id);
    });
    remove.dataset.focus = `${entry.id}:remove`;
    remove.dataset.help = 'Takes of this song are kept';
    actions.append(remove);
    item.append(starButton, load, actions);
    const songTakes = taken[entry.id] ?? [];
    if (songTakes.length > 0) {
      const listed = state.ui.libraryExpanded.includes(entry.id);
      const toggleTakes = button(
        takesLine(songTakes, Date.now()),
        'library-takes-toggle',
        () => {
          session.setUiChoices({ libraryExpanded: toggledId(store.state.ui.libraryExpanded, entry.id) });
        },
        'takes-toggle',
      );
      const takesId = `library-takes-${entry.id}`;
      toggleTakes.setAttribute('aria-expanded', String(listed));
      toggleTakes.setAttribute('aria-controls', takesId);
      toggleTakes.dataset.focus = `${entry.id}:takes`;
      toggleTakes.dataset.help = listed ? "Hide this song's takes" : "Show this song's takes";
      item.append(toggleTakes);
      if (listed) {
        const takeList = make('ul', 'library-takes', 'library-takes');
        takeList.id = takesId;
        takeList.append(...songTakes.map((take) => takeRow(take, songTakes, state, scope)));
        item.append(takeList);
      }
    }
    return item;
  }

  function serviceRow(song: AppState['library']['onService'][number]): HTMLLIElement {
    const item = make('li', 'library-service-item', 'library-item');
    item.dataset.id = song.id;
    const load = make('button', 'library-load', 'library-load');
    load.type = 'button';
    const name = make('span', 'library-title', 'library-title');
    name.textContent = song.name;
    const meta = make('span', 'library-meta', 'song-meta');
    meta.textContent = ['Upload', lengthLabel(song.durationS), song.stems ? 'Prepared' : ''].filter((s) => s !== '').join(' · ');
    load.append(name, meta);
    load.addEventListener('click', () => void session.loadServiceSong(song.id));
    item.append(load);
    return item;
  }

  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

  function render(state: AppState): void {
    const { library } = state;
    host.hidden = !library.open;
    toggle.setAttribute('aria-expanded', String(library.open));
    const favoritesView = library.view === 'favorites';
    allTab.setAttribute('aria-pressed', String(!favoritesView));
    favTab.setAttribute('aria-pressed', String(favoritesView));
    tools.hidden = !favoritesView;
    auto.checked = library.autoAdvance;
    setText(notice, library.notice);
    notice.hidden = library.notice === '';

    const allSingers = state.ui.libraryAllSingers;
    singers.checked = allSingers;
    const scope: TakeScope = { allSingers, activeId: state.profiles.activeId, legacyId: state.profiles.legacyId };
    const taken = takesBySong(library.takes, scope);
    const shown = entriesFor(library);
    const focused = doc.activeElement instanceof HTMLElement ? doc.activeElement.dataset.focus : undefined;
    const hadFocus = host.contains(doc.activeElement);
    list.replaceChildren(...shown.map((entry, i) => row(entry.id, state, favoritesView, i, shown.length, taken, scope)));
    const restored = focused ? host.querySelector<HTMLElement>(`[data-focus="${focused}"]`) : null;
    if (restored) restored.focus();
    else if (hadFocus && pendingFocus !== null && pendingFocus.from === focused) {
      // The focused element is gone (a take was deleted): hand focus to its
      // nearest neighbour so a keyboard user stays inside the drawer.
      const target = pendingFocus.to
        .map((key) => host.querySelector<HTMLElement>(`[data-focus="${key}"]`))
        .find((el) => el !== null);
      (target ?? close).focus();
      pendingFocus = null;
    }
    empty.hidden = shown.length > 0;
    setText(
      empty,
      favoritesView ? 'No favorites yet. Star a song to add it.' : 'Nothing here yet. Load a song and it is kept.',
    );
    playTop.disabled = !shown.some((e) => e.favorite);
    exportButton.disabled = playTop.disabled;

    const others = favoritesView ? [] : library.onService;
    serviceTitle.hidden = others.length === 0;
    serviceList.hidden = others.length === 0;
    serviceList.replaceChildren(...others.map(serviceRow));

    const id = state.song?.hash ?? null;
    const current = id === null ? undefined : library.entries.find((e) => e.id === id);
    star.hidden = !current;
    star.textContent = current?.favorite ? '★ Favorite' : '☆ Favorite';
    star.setAttribute('aria-pressed', String(current?.favorite === true));
    bar.hidden = !library.playlist.active;
    setText(position, playlistPosition(library.entries, library.playlist.currentId));
  }

  render(store.state);
  cleanups.push(
    store.subscribe((state, changed) => {
      if (WATCHED.some((key) => changed.has(key))) render(state);
    }),
  );

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const kind of ['entry', 'take'] as const) {
      const timer = armTimers[kind];
      if (timer !== null) clearTimeout(timer);
    }
    host.replaceChildren();
    bar.replaceChildren();
  };
};
