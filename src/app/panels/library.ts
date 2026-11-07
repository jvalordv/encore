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
 */
import { downloadBlob } from '../download';
import { FAVORITES_FILE_NAME } from '../library-share';
import { entriesFor, lengthLabel, playlistPosition, rowOf } from '../library-state';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** A first Remove press waits this long for a confirming second press. */
const REMOVE_ARM_MS = 3000;
/** The keys of the state the panel is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = ['library', 'song', 'karaoke', 'reference'];

/** What the panel needs: the state, the intents and the buttons it works with. */
export interface LibraryPanelDeps {
  store: StateStore;
  session: Pick<
    Session,
    | 'setLibraryOpen'
    | 'setLibraryView'
    | 'loadLibraryEntry'
    | 'loadServiceSong'
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
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let armedId: string | null = null;

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
  host.append(head, tabs, tools, notice, empty, list, serviceTitle, serviceList);

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

  function row(entryId: string, state: AppState, favoritesView: boolean, index: number, count: number): HTMLLIElement {
    const { library } = state;
    const entry = library.entries.find((e) => e.id === entryId);
    const item = make('li', 'library-item', 'library-item');
    if (!entry) return item;
    const view = rowOf(entry, library.takeCounts[entry.id] ?? 0, Date.now());
    item.dataset.id = entry.id;
    item.dataset.source = entry.source;
    item.dataset.current = String(state.song?.hash === entry.id);
    const starButton = button(entry.favorite ? '★' : '☆', 'library-star', () => void session.toggleFavorite(entry.id), 'star');
    starButton.setAttribute('aria-pressed', String(entry.favorite));
    starButton.setAttribute('aria-label', entry.favorite ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`);
    starButton.dataset.focus = `${entry.id}:star`;
    const load = make('button', 'library-load', 'library-load');
    load.type = 'button';
    load.title = `Load: ${entry.title}`;
    const name = make('span', 'library-title', 'library-title');
    name.textContent = view.title;
    const meta = make('span', 'library-meta', 'song-meta');
    meta.textContent = view.meta.join(' · ');
    load.append(name, meta);
    if (view.prepared !== '') {
      const badge = make('span', 'library-prepared', 'search-badge');
      badge.textContent = view.prepared;
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
        armedId = entry.id;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (armedId === entry.id) {
            armedId = null;
            render(store.state);
          }
        }, REMOVE_ARM_MS);
        timers.add(timer);
        render(store.state);
        return;
      }
      armedId = null;
      void session.removeLibraryEntry(entry.id);
    });
    remove.dataset.focus = `${entry.id}:remove`;
    remove.title = 'Takes of this song are kept';
    actions.append(remove);
    item.append(starButton, load, actions);
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

    const shown = entriesFor(library);
    const focused = doc.activeElement instanceof HTMLElement ? doc.activeElement.dataset.focus : undefined;
    list.replaceChildren(...shown.map((entry, i) => row(entry.id, state, favoritesView, i, shown.length)));
    if (focused) host.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus();
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
    for (const timer of timers) clearTimeout(timer);
    host.replaceChildren();
    bar.replaceChildren();
  };
};
