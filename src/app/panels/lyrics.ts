/**
 * The lyrics panel and the lane's lyrics line, in both modes (it judges
 * nothing). The panel lets the singer look the song up on LRCLIB, correct the
 * guessed title and artist, paste or drop an .lrc file or plain text, nudge
 * the timing by 0.1 s and show or hide the line. The line sits over the lane
 * and shows the current and next lines at the song's time, less the embed
 * offset a YouTube video's own audio path adds. It is off by default on a
 * karaoke track (the video usually shows lyrics already) and on elsewhere
 * once lines exist. The lyrics logic is in src/lyrics/controller.ts; this file
 * is DOM only.
 */
import { NUDGE_STEP_S, lyricsShown } from '../../lyrics/controller';
import type { LyricsController } from '../../lyrics/controller';
import { isKaraokeTrack } from '../learning';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** The most lyrics text taken, as a file size or a pasted length. */
export const LYRICS_MAX_BYTES = 1_000_000;
/** What the status says when a file or paste is over the cap. */
export const LYRICS_TOO_LARGE_LINE = 'That file is too large for lyrics.';

/** Whether `size` (bytes of a file, or characters pasted) is over the cap. */
export function lyricsTooLarge(size: number): boolean {
  return size > LYRICS_MAX_BYTES;
}

/** What the panel needs: the state, the controller, and the lane to write on. */
export interface LyricsPanelDeps {
  store: StateStore;
  controller: LyricsController;
  /** The element the current/next line is drawn into (over the lane). */
  lineHost: HTMLElement;
}

/** Builds the panel into `host` and the line into `lineHost`. */
export const mountLyricsPanel: MountPanel<LyricsPanelDeps> = (host, { store, controller, lineHost }) => {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    testid?: string,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (testid) node.dataset.testid = testid;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, testid: string, title: string): HTMLButtonElement => {
    const b = el('button', testid);
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    return b;
  };
  const cleanups: Array<() => void> = [];
  const listen = (target: HTMLElement, type: string, fn: (ev: Event) => void): void => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  const title = el('h3', undefined, 'group-title');
  title.textContent = 'Lyrics';
  const titleInput = el('input', 'lyrics-title');
  titleInput.type = 'text';
  titleInput.placeholder = 'Title';
  titleInput.setAttribute('aria-label', 'Song title for the lyrics lookup');
  const artistInput = el('input', 'lyrics-artist');
  artistInput.type = 'text';
  artistInput.placeholder = 'Artist';
  artistInput.setAttribute('aria-label', 'Artist for the lyrics lookup');
  const findButton = button('Find lyrics', 'lyrics-find', 'Look the song up on LRCLIB');
  const queryRow = el('div', undefined, 'lyrics-row');
  queryRow.append(titleInput, artistInput, findButton);

  const paste = el('textarea', 'lyrics-paste');
  paste.rows = 3;
  paste.placeholder = 'Or paste lyrics here (LRC with [mm:ss.xx] stamps, or plain text), or drop a .lrc file';
  paste.setAttribute('aria-label', 'Paste lyrics');
  const useButton = button('Use pasted text', 'lyrics-use', 'Read the pasted text as this song’s lyrics');
  const fileInput = el('input', 'lyrics-file');
  fileInput.type = 'file';
  fileInput.accept = '.lrc,.txt,text/plain';
  fileInput.setAttribute('aria-label', 'Choose an .lrc file');
  const pasteRow = el('div', undefined, 'lyrics-row');
  pasteRow.append(useButton, fileInput);

  const status = el('p', 'lyrics-status', 'song-meta');
  status.setAttribute('role', 'status');
  const shownBox = el('input', 'lyrics-shown');
  shownBox.type = 'checkbox';
  const shownLabel = el('label', undefined, 'check');
  shownLabel.append(shownBox, doc.createTextNode(' Show the lyrics line over the lane'));
  const earlier = button('Earlier', 'lyrics-earlier', 'Lines come 0.1 s sooner');
  const later = button('Later', 'lyrics-later', 'Lines come 0.1 s later');
  const nudgeReadout = el('span', 'lyrics-nudge', 'song-meta');
  const clearButton = button('Remove', 'lyrics-clear', 'Forget this song’s lyrics');
  const tuneRow = el('div', 'lyrics-tune', 'lyrics-row');
  tuneRow.append(earlier, later, nudgeReadout, clearButton);
  const plain = el('pre', 'lyrics-plain', 'lyrics-plain');
  host.append(title, queryRow, paste, pasteRow, status, shownLabel, tuneRow, plain);

  const lineNow = el('div', 'lyrics-now', 'lyrics-now');
  const lineNext = el('div', 'lyrics-next', 'lyrics-next');
  lineHost.append(lineNow, lineNext);

  const setText = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text;
  };
  const songOf = (): { hash: string; name: string; durationS: number } | null => {
    const song = store.state.song;
    return song ? { hash: song.hash, name: song.name, durationS: song.durationS } : null;
  };

  function drawLine(): void {
    const state = store.state;
    const lyrics = controller.state;
    const show = lyricsShown(lyrics.record, isKaraokeTrack(state));
    lineHost.hidden = !show;
    if (!show) return;
    // The lane draws at the raw position, so the line does too; the per-song
    // nudge covers any remaining offset.
    const view = controller.viewAt(state.positionS);
    setText(lineNow, view.current);
    setText(lineNext, view.next);
  }

  function drawPanel(): void {
    const lyrics = controller.state;
    const record = lyrics.record;
    host.hidden = lyrics.song === null;
    if (doc.activeElement !== titleInput && titleInput.value !== lyrics.query.title) {
      titleInput.value = lyrics.query.title;
    }
    if (doc.activeElement !== artistInput && artistInput.value !== lyrics.query.artist) {
      artistInput.value = lyrics.query.artist;
    }
    findButton.disabled = lyrics.phase === 'searching';
    let line = lyrics.message;
    if (line === '' && record) {
      const from = record.source === 'lrclib' ? 'LRCLIB' : 'pasted text';
      line = record.synced ? `Synced lyrics from ${from}.` : `Plain lyrics from ${from}, shown without timing.`;
    }
    setText(status, line);
    const synced = record?.synced === true;
    shownLabel.hidden = !synced;
    tuneRow.hidden = record === null;
    earlier.disabled = later.disabled = !synced;
    shownBox.checked = lyricsShown(record, isKaraokeTrack(store.state));
    const nudge = record?.nudgeS ?? 0;
    setText(nudgeReadout, synced ? `${nudge > 0 ? '+' : ''}${nudge.toFixed(1)} s` : '');
    const text = controller.plainLines().join('\n');
    plain.hidden = text === '';
    setText(plain, text);
  }

  const readFile = (file: File | undefined): void => {
    if (!file) return;
    if (lyricsTooLarge(file.size)) {
      controller.reject(LYRICS_TOO_LARGE_LINE);
      return;
    }
    void file.text().then((text) => controller.importText(text));
  };
  const importChecked = (text: string): Promise<void> => {
    if (lyricsTooLarge(text.length)) {
      controller.reject(LYRICS_TOO_LARGE_LINE);
      return Promise.resolve();
    }
    return controller.importText(text);
  };
  listen(findButton, 'click', () => {
    controller.setQuery({ title: titleInput.value, artist: artistInput.value });
    void controller.find();
  });
  listen(useButton, 'click', () => {
    controller.setQuery({ title: titleInput.value, artist: artistInput.value });
    void importChecked(paste.value).then(() => {
      if (controller.state.record) paste.value = '';
    });
  });
  listen(fileInput, 'change', () => readFile(fileInput.files?.[0]));
  listen(shownBox, 'change', () => void controller.setShown(shownBox.checked));
  listen(earlier, 'click', () => void controller.nudge(NUDGE_STEP_S));
  listen(later, 'click', () => void controller.nudge(-NUDGE_STEP_S));
  listen(clearButton, 'click', () => void controller.clear());
  // The page also takes dropped audio and links; a lyrics file dropped here
  // is this panel's alone, so the page-wide handler never sees it.
  listen(host, 'dragover', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  listen(host, 'drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const data = (ev as DragEvent).dataTransfer;
    const file = data?.files?.[0];
    if (file) readFile(file);
    else {
      const text = data?.getData('text/plain') ?? '';
      if (text.trim() !== '') void importChecked(text);
    }
  });

  const unsubscribeStore = store.subscribe((_state, changed) => {
    if (changed.has('song')) void controller.select(songOf());
    drawLine();
    if (changed.has('song') || changed.has('pickedResult') || changed.has('reference')) drawPanel();
  });
  const unsubscribeController = controller.onChange(() => {
    drawPanel();
    drawLine();
  });
  void controller.select(songOf());
  drawPanel();
  drawLine();

  return () => {
    unsubscribeStore();
    unsubscribeController();
    for (const fn of cleanups) fn();
    host.replaceChildren();
    lineHost.replaceChildren();
  };
};
