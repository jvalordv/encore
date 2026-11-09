/**
 * The search panel: the top of the song panel (the left bar), shown when no
 * song is loaded and reachable again through the Search button once one is,
 * with the YouTube link box and the drop zone below it. A box and
 * a chip (Karaoke versions or Originals) make a search; the results are a grid
 * of cards, each with a thumbnail, title, channel, length and a Karaoke or
 * Original badge; clicking a card loads it like a pasted link, and a karaoke
 * card also offers "Find the original". Below sit, until there is a key, the
 * steps to get one ("Set up in-app search"), and the field for the person's
 * own YouTube API key. Everything drawn is a function of `state.search` (see
 * src/app/search.ts) and whether a song is loaded; the controls call the
 * Session's intents and hold no logic of their own. The panel knows the search
 * only as results and messages, never which provider answered.
 */
import { formatDuration } from '../../search';
import type { SearchFilter, SearchResult } from '../../search';
import { describeResults, searchVisible, searchesExternally } from '../search';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw, the intents to call and the Search button. */
export interface SearchPanelDeps {
  store: StateStore;
  session: Pick<
    Session,
    'searchSongs' | 'findOriginal' | 'pickResult' | 'setSearchFilter' | 'setSearchOpen' | 'setSearchKey'
  >;
  /** The button in the song panel that brings the search back over a loaded song. */
  toggle: HTMLButtonElement;
}

/** The keys of the state the panel is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = ['search', 'song'];

const FILTERS: ReadonlyArray<{ filter: SearchFilter; label: string }> = [
  { filter: 'karaoke', label: 'Karaoke versions' },
  { filter: 'original', label: 'Originals' },
];

const BADGES = { karaoke: 'Karaoke', original: 'Original' } as const;

/** What is said above the box while nothing has been searched. */
export const HINT_WITH_KEY = 'Search for a song, then pick a result to load it.';
export const HINT_WITHOUT_KEY =
  "No API key is set, so Search opens YouTube's own search in a new tab: copy the link of the video you " +
  'pick into the link box. Paste a key below to search here.';

/** The steps of the setup box, in the words of README.md ("Search for songs"). */
export const SETUP_STEPS: readonly string[] = [
  'In the Google Cloud console, create or pick a project and enable YouTube Data API v3 for it ' +
    '(APIs & Services, Library).',
  'Create an API key (APIs & Services, Credentials, Create credentials, API key).',
  'Limit it to that API: under API restrictions choose YouTube Data API v3 only, and under ' +
    'Application restrictions choose Websites with the address of this page.',
  'Paste the key into the field below and press Save key. It stays in this browser and goes only to Google.',
];

/** Shown beside the button while no key is set (and in the title's help). */
export const KEYLESS_WARNING = "YouTube's own results include videos that will not play here.";

/** What the YouTube API key field is. */
export const KEY_HELP =
  'Your own YouTube Data API v3 key. It stays in this browser and goes only to Google. ' +
  'The free quota is about 100 searches a day; README.md says how to make a key.';

/** The search's explanation, by whether there is a key: the title's hover help and (i) note. */
export function helpText(keyless: boolean): string {
  return keyless ? `${HINT_WITHOUT_KEY} ${KEYLESS_WARNING}` : HINT_WITH_KEY;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  testid: string,
  className = '',
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.dataset.testid = testid;
  if (className) el.className = className;
  return el;
}

/** Builds the panel into `host`; the returned function takes it down. */
export const mountSearchPanel: MountPanel<SearchPanelDeps> = (host, { store, session, toggle }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  const title = doc.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Find a song';
  title.dataset.testid = 'search-heading';
  title.dataset.info = '';

  const form = element(doc, 'form', 'search-form', 'search-bar');
  form.noValidate = true;
  const input = element(doc, 'input', 'search-input');
  input.type = 'search';
  input.placeholder = 'Song or artist';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search for a song');
  const chips = element(doc, 'div', 'search-chip', 'segmented');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Looking for');
  const chipButtons = new Map<SearchFilter, HTMLButtonElement>();
  for (const { filter, label } of FILTERS) {
    const button = element(doc, 'button', `search-chip-${filter}`);
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', 'false');
    listen(button, 'click', () => session.setSearchFilter(filter));
    chipButtons.set(filter, button);
    chips.append(button);
  }
  const go = element(doc, 'button', 'search-go');
  go.type = 'submit';
  go.textContent = 'Search';
  const close = element(doc, 'button', 'search-close');
  close.type = 'button';
  close.textContent = 'Close';
  close.dataset.help = 'Back to the song';
  listen(close, 'click', () => session.setSearchOpen(false));
  // Visible, not only in the title's help: it is the one place that says
  // YouTube's own results may not play here.
  const keylessLine = element(doc, 'p', 'search-keyless', 'search-keyless song-meta');
  keylessLine.textContent = KEYLESS_WARNING;
  form.append(input, chips, go, close, keylessLine);
  listen(form, 'submit', (ev) => {
    ev.preventDefault();
    // Straight from the submit, so the new tab a keyless search opens is allowed.
    session.searchSongs(input.value);
  });

  const status = element(doc, 'p', 'search-status', 'search-status song-meta');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = element(doc, 'ul', 'search-results', 'search-results');

  const keyBox = element(doc, 'details', 'search-key-box', 'search-key-box');
  const keySummary = doc.createElement('summary');
  keyBox.append(keySummary);
  const keyForm = element(doc, 'form', 'search-key-form', 'search-bar');
  keyForm.noValidate = true;
  const keyInput = element(doc, 'input', 'search-key');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.setAttribute('aria-label', 'YouTube API key');
  const keySave = element(doc, 'button', 'search-key-save');
  keySave.type = 'submit';
  keySave.textContent = 'Save key';
  const keyForget = element(doc, 'button', 'search-key-forget');
  keyForget.type = 'button';
  keyForget.textContent = 'Forget key';
  keyForm.append(keyInput, keySave, keyForget);
  // The note stays visible inside the box: the quota and the README pointer
  // must be readable without hover help.
  keyInput.dataset.help = 'Paste your YouTube Data API v3 key';
  const keyNote = doc.createElement('p');
  keyNote.className = 'song-meta';
  keyNote.textContent = KEY_HELP;
  keyBox.append(keyForm, keyNote);
  listen(keyForm, 'submit', (ev) => {
    ev.preventDefault();
    if (session.setSearchKey(keyInput.value)) keyInput.value = '';
  });
  listen(keyForget, 'click', () => {
    keyInput.value = '';
    session.setSearchKey('');
  });

  // Shown while there is no key: the way to in-app search, with YouTube's own
  // results (the Search button above) as the way around it.
  const setup = element(doc, 'details', 'search-setup', 'search-setup');
  setup.open = true;
  const setupSummary = doc.createElement('summary');
  setupSummary.textContent = 'Set up in-app search';
  const setupSteps = doc.createElement('ol');
  for (const step of SETUP_STEPS) {
    const li = doc.createElement('li');
    li.textContent = step;
    setupSteps.append(li);
  }
  const consoleLink = element(doc, 'a', 'search-setup-link');
  consoleLink.href = 'https://console.cloud.google.com/';
  consoleLink.target = '_blank';
  consoleLink.rel = 'noopener';
  consoleLink.textContent = 'Open the Google Cloud console';
  setup.append(setupSummary, setupSteps, consoleLink);

  host.append(title, form, status, list, setup, keyBox);

  listen(toggle, 'click', () => {
    const opening = host.hidden;
    session.setSearchOpen(opening);
    if (opening) input.focus();
  });

  function card(result: SearchResult): HTMLLIElement {
    const item = doc.createElement('li');
    item.className = 'search-card';
    item.dataset.testid = 'search-result';
    item.dataset.videoId = result.videoId;
    item.dataset.kind = result.kind;
    const pick = element(doc, 'button', 'search-pick', 'search-pick');
    pick.type = 'button';
    pick.dataset.help = `Load: ${result.title}`;
    const frame = doc.createElement('span');
    frame.className = 'search-thumb';
    if (result.thumbnailUrl !== '') {
      const image = doc.createElement('img');
      image.src = result.thumbnailUrl;
      image.alt = '';
      image.loading = 'lazy';
      frame.append(image);
    }
    const length = formatDuration(result.durationS);
    if (length !== '') {
      const time = element(doc, 'span', 'search-duration', 'search-duration');
      time.textContent = length;
      frame.append(time);
    }
    const name = element(doc, 'span', 'search-title', 'search-title');
    name.textContent = result.title;
    const channel = element(doc, 'span', 'search-channel', 'search-channel song-meta');
    channel.textContent = result.channel;
    pick.append(frame, name, channel);
    listen(pick, 'click', () => void session.pickResult(result.videoId));
    const foot = doc.createElement('span');
    foot.className = 'search-foot';
    const badge = element(doc, 'span', 'search-badge', 'search-badge');
    badge.dataset.kind = result.kind;
    badge.textContent = BADGES[result.kind];
    foot.append(badge);
    if (result.kind === 'karaoke') {
      const original = element(doc, 'button', 'search-find-original', 'compact');
      original.type = 'button';
      original.textContent = 'Find the original';
      listen(original, 'click', () => session.findOriginal(result));
      foot.append(original);
    }
    item.append(pick, foot);
    return item;
  }

  let shownResults: SearchResult[] | null = null;
  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

  function render(state: AppState): void {
    const { search } = state;
    const hasSong = state.song !== null;
    const visible = searchVisible(hasSong, search);
    host.hidden = !visible;
    toggle.hidden = !hasSong;
    toggle.setAttribute('aria-expanded', String(visible));
    close.hidden = !hasSong;

    chipButtons.forEach((button, filter) =>
      button.setAttribute('aria-pressed', String(search.filter === filter)),
    );
    form.dataset.phase = search.phase;
    go.textContent = searchesExternally(search) ? 'Search on YouTube' : 'Search';
    // What used to be two lines under the box is now the title's help: hover
    // for it, or press the (i) beside the title (src/app/panels/left-panel.ts).
    const keyless = searchesExternally(search);
    title.dataset.help = helpText(keyless);
    go.dataset.help = keyless ? "Open YouTube's own search in a new tab" : 'Search for this song';
    input.dataset.help = 'A song or an artist';
    keylessLine.hidden = !keyless;

    setText(status, search.message !== '' ? search.message : describeResults(search));
    status.hidden = status.textContent === '';
    status.dataset.code = search.errorCode ?? '';

    if (search.results !== shownResults) {
      shownResults = search.results;
      list.replaceChildren(...search.results.map(card));
    }
    list.hidden = search.results.length === 0;

    setText(keySummary, search.hasKey ? 'YouTube API key (saved)' : 'YouTube API key (not set)');
    setup.hidden = search.hasKey;
    keyForget.hidden = !search.hasKey;
    keyInput.placeholder = search.hasKey ? 'Paste a new key to replace it' : 'Paste your key';
    // Open for a first key; once there is one the person decides.
    if (!search.hasKey) keyBox.open = true;
  }

  render(store.state);
  cleanups.push(
    store.subscribe((state, changed) => {
      if (WATCHED.some((key) => changed.has(key))) render(state);
    }),
  );

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
