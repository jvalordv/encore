/**
 * The karaoke panel, in the song panel under the Prepare group: how far the
 * song's karaoke track has got (the upload, the service's steps), the one line
 * that says what is missing when the service is away, what became of the
 * melody, and the mix. The mix is three joined buttons (Original, Karaoke,
 * Karaoke + vocal guide) and a slider for the guide's level that works while
 * the guide is chosen. Everything drawn is a function of `state.karaoke`,
 * `state.reference` and `state.mix` through `describeKaraoke`
 * (src/app/karaoke.ts); the buttons and the slider call the Session's `setMix`
 * and `setGuideLevel`. Under the melody line, Save melody (.mid) downloads the
 * notes as a MIDI file while a melody exists. While the song is matched to
 * its original (src/app/align.ts) its progress and result show under the melody line. Karaoke mode shows nothing here about the singing.
 */
import { describeAlign } from '../align';
import { describeKaraoke } from '../karaoke';
import { saveMelody } from '../melody-download';
import { MIX_CHOICES, MIX_LABELS } from '../mix';
import type { MixChoice } from '../mix';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw, and the two intents it calls. */
export interface KaraokePanelDeps {
  store: StateStore;
  session: Pick<Session, 'setMix' | 'setGuideLevel' | 'melodyForExport'> & Partial<Pick<Session, 'setBackingShown'>>;
}

/** The keys of the state the panel is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = ['karaoke', 'reference', 'mix', 'align', 'backing'];

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
export const mountKaraokePanel: MountPanel<KaraokePanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];

  const title = doc.createElement('h3');
  title.className = 'group-title';
  title.textContent = 'Karaoke track';
  const lines = element(doc, 'ul', 'karaoke-lines', 'karaoke-lines song-meta');
  const note = element(doc, 'p', 'karaoke-note', 'karaoke-note song-meta');
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const melody = element(doc, 'p', 'reference-status', 'karaoke-note song-meta');
  const matching = element(doc, 'p', 'align-progress', 'karaoke-note song-meta');
  matching.setAttribute('role', 'status');
  matching.setAttribute('aria-live', 'polite');

  const save = element(doc, 'button', 'save-melody');
  save.type = 'button';
  save.textContent = 'Save melody (.mid)';
  save.title = 'Download the melody as a MIDI file, to open in any MIDI player.';
  const onSave = (): void => {
    const melodyOut = session.melodyForExport();
    if (!melodyOut) return;
    if (withBacking.checked && melodyOut.backing) {
      saveMelody(doc, melodyOut.name, melodyOut.notes, melodyOut.backing);
    } else {
      saveMelody(doc, melodyOut.name, melodyOut.notes);
    }
  };
  save.addEventListener('click', onSave);
  cleanups.push(() => save.removeEventListener('click', onSave));

  // The backing notes (W0g): a toggle for the lane, and a choice for the file.
  const backingBox = element(doc, 'div', 'backing', 'karaoke-backing');
  const showLabel = doc.createElement('label');
  showLabel.className = 'field';
  showLabel.title = 'The backing music as grey notes behind the melody, and grey lit keys.';
  const showBacking = element(doc, 'input', 'backing-toggle');
  showBacking.type = 'checkbox';
  const onShow = (): void => session.setBackingShown?.(showBacking.checked);
  showBacking.addEventListener('change', onShow);
  cleanups.push(() => showBacking.removeEventListener('change', onShow));
  showLabel.append(showBacking, doc.createTextNode(' Backing notes'));
  const withLabel = doc.createElement('label');
  withLabel.className = 'field';
  withLabel.title = 'Save the backing as a second track in the .mid file.';
  const withBacking = element(doc, 'input', 'save-with-backing');
  withBacking.type = 'checkbox';
  withLabel.append(withBacking, doc.createTextNode(' with backing'));
  backingBox.append(showLabel, withLabel);

  const mixBox = element(doc, 'div', 'mix', 'karaoke-mix');
  const mixLabel = doc.createElement('span');
  mixLabel.className = 'field';
  mixLabel.id = 'mix-label';
  mixLabel.textContent = 'Mix';
  const mixButtons = element(doc, 'div', 'mix-choices', 'segmented');
  mixButtons.setAttribute('role', 'group');
  mixButtons.setAttribute('aria-labelledby', mixLabel.id);
  const buttons = new Map<MixChoice, HTMLButtonElement>();
  for (const choice of MIX_CHOICES) {
    const button = element(doc, 'button', `mix-${choice}`);
    button.type = 'button';
    button.textContent = MIX_LABELS[choice];
    button.setAttribute('aria-pressed', 'false');
    const onClick = (): void => session.setMix(choice);
    button.addEventListener('click', onClick);
    cleanups.push(() => button.removeEventListener('click', onClick));
    buttons.set(choice, button);
    mixButtons.append(button);
  }
  const guideLabel = doc.createElement('label');
  guideLabel.className = 'field';
  guideLabel.htmlFor = 'guide-level';
  guideLabel.textContent = 'Vocal guide level';
  const guide = element(doc, 'input', 'guide-level');
  guide.id = 'guide-level';
  guide.type = 'range';
  guide.min = '0';
  guide.max = '1';
  guide.step = '0.05';
  guide.title = 'How loud the original vocal is when Karaoke + vocal guide is chosen';
  const onGuide = (): void => session.setGuideLevel(guide.valueAsNumber);
  guide.addEventListener('input', onGuide);
  cleanups.push(() => guide.removeEventListener('input', onGuide));
  mixBox.append(mixLabel, mixButtons, guideLabel, guide);

  host.append(title, lines, note, melody, matching, save, backingBox, mixBox);

  let linesSignature = '';
  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

  function render(state: AppState): void {
    const view = describeKaraoke(state.karaoke, state.reference, state.mix);
    host.hidden = !view.visible;
    host.dataset.phase = state.karaoke.phase;

    const signature = view.lines.join('\n');
    if (signature !== linesSignature) {
      linesSignature = signature;
      lines.replaceChildren(
        ...view.lines.map((line) => {
          const item = doc.createElement('li');
          item.textContent = line;
          return item;
        }),
      );
    }
    lines.hidden = view.lines.length === 0;
    setText(note, view.note);
    note.hidden = view.note === '';
    setText(melody, view.melody);
    melody.hidden = view.melody === '';
    melody.dataset.phase = state.reference.phase;
    melody.dataset.notes = String(state.reference.notes);
    // Refusals and failures are said in the learning notice, beside Open.
    const working = state.align.phase === 'working' || state.align.phase === 'done';
    setText(matching, working ? describeAlign(state.align) : '');
    matching.hidden = !working;
    matching.dataset.phase = state.align.phase;
    save.hidden = state.reference.phase !== 'ready';
    save.disabled = state.reference.notes === 0;
    backingBox.hidden = state.backing.phase !== 'ready';
    backingBox.dataset.phase = state.backing.phase;
    backingBox.dataset.notes = String(state.backing.notes);
    showBacking.checked = state.backing.shown;

    mixBox.hidden = !view.mixVisible;
    for (const [choice, button] of buttons) {
      button.disabled = !view.mixEnabled;
      button.setAttribute('aria-pressed', String(state.mix.choice === choice));
    }
    guide.disabled = !view.mixEnabled || state.mix.choice !== 'guide';
    // Not rewritten while the singer drags it, which would fight the thumb.
    if (doc.activeElement !== guide) guide.value = String(state.mix.guideLevel);
  }

  cleanups.push(
    store.subscribe((state, changed) => {
      if (WATCHED.some((key) => changed.has(key))) render(state);
    }),
  );
  render(store.state);

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
