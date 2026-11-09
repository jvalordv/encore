/**
 * The song panel's Song reference card, for a YouTube song: what Encore has
 * for the song (the melody and the key, and where each came from), what that
 * means for learning mode, and the one way to get more. The one button is
 * "Get the melody"; in learning mode, for a song with no melody, the card
 * opens with a prompt in its place ("Get the melody so learning mode can
 * score you?", Not now, and "Do this for every song", which is the Settings
 * switch, applied when Get the melody is pressed with it ticked). Getting the
 * melody arms the recording of the song's sound for the first take. Everything
 * drawn comes from `describeSongReference` (src/app/song-reference.ts); the
 * panel only draws it and calls the Session's intents.
 */
import { originalQueryFor } from '../learning';
import type { Session } from '../session';
import {
  EVERY_SONG_LABEL,
  GET_MELODY_LABEL,
  NOT_NOW_LABEL,
  STOP_RECORDING_LABEL,
  describeSongReference,
  titleLooksKaraoke,
} from '../song-reference';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw and the intents it calls. */
export interface SongReferencePanelDeps {
  store: StateStore;
  session: Pick<
    Session,
    'getMelody' | 'declineReference' | 'setAutoReference' | 'stopCapture' | 'captureSupported' | 'settings'
  >;
}

/** The keys of the state the card is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = [
  'prepare',
  'capture',
  'reference',
  'key',
  'align',
  'mode',
  'songRef',
  'settingsRev',
  'takes',
  'song',
  'pickedResult',
];

/** Builds the card into `host`; the returned function takes it down. */
export const mountSongReferencePanel: MountPanel<SongReferencePanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];

  function make<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    testid: string,
    className = '',
  ): HTMLElementTagNameMap[K] {
    const el = doc.createElement(tag);
    el.dataset.testid = testid;
    if (className) el.className = className;
    return el;
  }
  function button(testid: string, text: string, onClick: () => void): HTMLButtonElement {
    const el = make('button', testid);
    el.type = 'button';
    el.textContent = text;
    el.addEventListener('click', onClick);
    cleanups.push(() => el.removeEventListener('click', onClick));
    return el;
  }

  const title = doc.createElement('h3');
  title.className = 'group-title';
  title.textContent = 'Song reference';
  // Where focus goes when the prompt's button that held it goes away.
  title.tabIndex = -1;
  const facts = make('ul', 'reference-facts', 'reference-facts song-meta');
  const melody = doc.createElement('li');
  melody.dataset.testid = 'reference-melody';
  const key = doc.createElement('li');
  key.dataset.testid = 'reference-key';
  facts.append(melody, key);
  const meaning = make('p', 'reference-meaning', 'song-meta');

  // The prompt: the question, its two answers and the setting it can turn on.
  const prompt = make('div', 'reference-prompt', 'reference-prompt');
  prompt.setAttribute('role', 'group');
  prompt.setAttribute('aria-label', 'Get the melody?');
  const promptText = make('p', 'reference-prompt-text');
  promptText.setAttribute('role', 'status');
  const everyLabel = doc.createElement('label');
  everyLabel.className = 'check';
  const every = make('input', 'reference-every-song');
  every.type = 'checkbox';
  // The tick only says what Get the melody should remember; nothing is
  // recorded until that button is pressed.
  const promptGet = button('reference-prompt-get', GET_MELODY_LABEL, () => {
    title.focus();
    if (every.checked && !session.settings.autoReference) session.setAutoReference(true);
    void session.getMelody();
  });
  const promptLater = button('reference-not-now', NOT_NOW_LABEL, () => {
    title.focus();
    session.declineReference();
  });
  const everyText = doc.createElement('span');
  everyText.textContent = EVERY_SONG_LABEL;
  everyLabel.append(every, everyText);
  prompt.append(promptText, promptGet, promptLater, everyLabel);

  const get = button('reference-get', GET_MELODY_LABEL, () => void session.getMelody());
  const stop = button('reference-stop', STOP_RECORDING_LABEL, () => void session.stopCapture());
  const steps = make('ul', 'reference-steps', 'prepare-steps song-meta');
  const note = make('p', 'reference-note', 'song-meta');
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const hint = make('p', 'reference-hint', 'song-meta');

  host.append(title, facts, meaning, prompt, get, stop, steps, note, hint);

  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  let stepsSignature = '';
  let promptShown = false;

  function render(state: AppState): void {
    const query = originalQueryFor(state);
    const view = describeSongReference({
      prepare: state.prepare,
      capture: state.capture,
      reference: state.reference,
      key: state.key,
      align: state.align,
      mode: state.mode,
      autoReference: session.settings.autoReference,
      songRef: state.songRef,
      titleKaraoke: titleLooksKaraoke(query.title, query.channel),
      takes: state.takes,
      captureSupported: session.captureSupported,
    });
    host.hidden = !view.visible;
    host.dataset.phase = state.prepare.phase;
    host.dataset.melody = view.melodySource;
    host.dataset.key = view.keySource;
    host.dataset.armed = String(state.songRef.armed);
    setText(melody, view.melody);
    setText(key, view.key);
    setText(meaning, view.meaning);
    meaning.hidden = view.meaning === '';

    prompt.hidden = !view.prompt.shown;
    setText(promptText, view.prompt.text);
    // The box starts from the setting each time the prompt opens, and is the
    // singer's own tick while it stays open.
    if (view.prompt.shown && !promptShown) every.checked = view.prompt.auto;
    promptShown = view.prompt.shown;

    get.hidden = !view.button.shown;
    get.disabled = view.button.disabled;
    get.dataset.help = view.button.title;
    setText(get, view.button.label);
    stop.hidden = !view.stop.shown;
    stop.disabled = view.stop.disabled;

    // Rebuilt only when a line changed, so a poll that repeats itself leaves
    // the list alone.
    const signature = view.lines.join('\n');
    if (signature !== stepsSignature) {
      stepsSignature = signature;
      steps.replaceChildren(
        ...view.lines.map((line) => {
          const item = doc.createElement('li');
          item.textContent = line;
          return item;
        }),
      );
    }
    steps.hidden = view.lines.length === 0;
    setText(note, view.note);
    note.hidden = view.note === '';
    setText(hint, view.hint);
    hint.hidden = view.hint === '';
  }

  cleanups.push(
    store.subscribe((state, changed) => {
      if (WATCHED.some((k) => changed.has(k))) render(state);
    }),
  );
  render(store.state);

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
